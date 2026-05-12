/**
 * Rules routes — /api/rules/*
 *
 * POST /api/rules/import   — Parse ranked-rules content, returning either:
 *                              (a) a template preview (for template payloads
 *                                  with `metadata.inputs` requiring user selection), or
 *                              (b) final rules + warnings for the UI's import dialog.
 *                            Accepts { json, preview?, inputs? } or { url }.
 *                            Does NOT persist — the UI decides merge vs. replace
 *                            and saves via PUT /api/settings.
 * POST /api/rules/preview  — Evaluate a sample release title against a supplied
 *                            set of rules. Returns per-rule match/score so the
 *                            UI can render a live preview without round-tripping
 *                            to the persisted config.
 */

import { Router } from 'express';
import { parseRankedRulesJson, previewTemplate, type ImportResult, type ImportWarning } from '../rules/importers.js';
import { getCompiledRules, previewSingle, buildStreamContext } from '../rules/rankEngine.js';
import { fetchRemoteJson, RemoteFetchError } from '../rules/remoteFetch.js';
import { parseMetadata, parseSeasonPack } from '../parsers/metadataParsers.js';

const MAX_PREVIEW_RULES = 1000;

export function createRulesRoutes(): Router {
  const router = Router();

  router.post('/import', async (req, res) => {
    try {
      const { json, url, inputs, preview } = req.body ?? {};

      // --- Source the raw JSON body ---
      // URL and JSON paths are unified: once we have the body, template detection,
      // phase 1/2 flow, and follow-URL chase all apply identically.
      let body: string;
      if (typeof url === 'string' && url) {
        try {
          body = await fetchRemoteJson(url);
        } catch (e: any) {
          const status = e instanceof RemoteFetchError ? Math.min(Math.max(e.status, 400), 502) : 400;
          return res.status(status).json({ error: e?.message ?? String(e) });
        }
      } else if (typeof json === 'string' && json) {
        body = json;
      } else {
        return res.status(400).json({ error: 'Body must be { json: string } or { url: string }' });
      }

      // If the payload is a ranked-rules template AND the client didn't supply inputs,
      // return a preview so the UI can prompt for variant selection.
      let rawForPreview: any;
      try {
        rawForPreview = JSON.parse(body);
        if (Array.isArray(rawForPreview)) rawForPreview = rawForPreview[0];
      } catch {
        /* fall through to parseRankedRulesJson which will surface a clearer error */
      }

      const wantsPreview = preview === true || (preview !== false && !inputs);
      const templateInfo = previewTemplate(rawForPreview);
      if (templateInfo && wantsPreview) {
        return res.json({
          success: true,
          template: { name: templateInfo.name, description: templateInfo.description, inputs: templateInfo.inputs },
          defaults: templateInfo.defaults,
        });
      }

      // Resolve the template with user-supplied inputs (or standard flat-JSON parse).
      const userInputs = inputs && typeof inputs === 'object' ? inputs as Record<string, unknown> : undefined;
      const result = parseRankedRulesJson(body, userInputs);

      // Follow synced URLs if the resolved template asked for any.
      if (result.followUrls && (result.followUrls.regex.length > 0 || result.followUrls.sel.length > 0)) {
        await followSyncedUrls(result);
      }

      const { followUrls: _followUrls, ...publicResult } = result;
      res.json({ success: true, ...publicResult });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? String(e) });
    }
  });

  router.post('/preview', (req, res) => {
    try {
      const { sample, rules } = req.body ?? {};
      if (typeof sample !== 'string' || !sample) {
        return res.status(400).json({ error: 'Body must be { sample: string, rules: {...} }' });
      }
      if (!rules || typeof rules !== 'object') {
        return res.status(400).json({ error: 'rules must be an object' });
      }
      const regexCount = Array.isArray(rules.rankedRegexPatterns) ? rules.rankedRegexPatterns.length : 0;
      const selCount = Array.isArray(rules.rankedStreamExpressions) ? rules.rankedStreamExpressions.length : 0;
      if (regexCount > MAX_PREVIEW_RULES || selCount > MAX_PREVIEW_RULES) {
        return res.status(400).json({ error: `Rule count exceeds ${MAX_PREVIEW_RULES}` });
      }

      const compiled = getCompiledRules(rules);
      const parsed = parseMetadata(sample);
      const stream = buildStreamContext({
        title: sample,
        filename: sample,
        size: 0,
        indexer: '',
        age: 0,
        resolution: parsed.resolution,
        codec: parsed.codec,
        releaseGroup: parsed.releaseGroup,
        visualTag: parsed.visualTag,
        audioTag: parsed.audioTag,
        videoTag: parsed.source,
        edition: parsed.edition,
        language: parsed.language,
        seeders: null,
        // Derived from the sample title via parse-torrent-title so SEL
        // seasonPack() filters can be live-tested. Other context-dependent
        // attrs (size, age, bitrate) can't be synthesized from a title alone
        // and remain at their zero/null defaults. Rules using those
        // functions need to be tested against real search results.
        seasonPack: parseSeasonPack(sample),
      });
      // Query context lets SEL expressions branch on `queryType == 'movie'`.
      // Default to 'movie' for preview; the UI can pass its own if needed.
      const queryType = typeof req.body?.queryType === 'string' ? req.body.queryType : 'movie';
      const result = previewSingle(compiled, sample, stream, queryType);

      res.json({
        success: true,
        sample,
        regexScore: result.regexScore,
        seScore: result.seScore,
        totalScore: result.totalScore,
        excluded: result.excluded,
        matched: result.matched,
        tags: result.tags,
        compileErrors: compiled.compileErrors,
        evalErrors: result.errors.filter((e: any) => !compiled.compileErrors.some((ce: any) => ce.ruleId === e.ruleId)),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  return router;
}

/**
 * Follow the synced URLs that a ranked-rules template asked us to fetch.
 * Each URL returns a flat rule array; we feed each body through parseRankedRulesJson
 * and merge the results into the top-level ImportResult. Failures (SSRF block,
 * timeout, parse error) become warnings — one bad URL doesn't abort the whole import.
 */
async function followSyncedUrls(result: ImportResult): Promise<void> {
  const follow = result.followUrls;
  if (!follow) return;

  const aggregateWarnings: ImportWarning[] = [];
  const fetchAndMerge = async (url: string, kind: 'regex' | 'sel') => {
    try {
      const body = await fetchRemoteJson(url);
      // Synced URLs typically point at a flat array of `{name, pattern, score}`
      // (regex) or `{name, expression, score}` (sel). Wrap accordingly before
      // handing to parseRankedRulesJson so it sees a recognised shape.
      let wrapped = body;
      try {
        const parsedBody = JSON.parse(body);
        if (Array.isArray(parsedBody)) {
          wrapped = kind === 'regex'
            ? JSON.stringify({ rankedRegexPatterns: parsedBody })
            : JSON.stringify({ rankedStreamExpressions: parsedBody });
        }
      } catch {
        /* parseRankedRulesJson will surface JSON errors */
      }
      const sub = parseRankedRulesJson(wrapped);
      if (kind === 'regex') {
        result.rules.rankedRegexPatterns.push(...sub.rules.rankedRegexPatterns);
      } else {
        result.rules.rankedStreamExpressions.push(...sub.rules.rankedStreamExpressions);
      }
      for (const w of sub.warnings) aggregateWarnings.push(w);
    } catch (e: any) {
      aggregateWarnings.push({
        kind,
        name: url,
        message: `Failed to fetch synced URL: ${e?.message ?? String(e)}`,
      });
    }
  };

  // Kick off in parallel; all fetches bounded by the per-request fetch timeout.
  await Promise.all([
    ...follow.regex.map(u => fetchAndMerge(u, 'regex')),
    ...follow.sel.map(u => fetchAndMerge(u, 'sel')),
  ]);

  result.warnings.push(...aggregateWarnings);
}
