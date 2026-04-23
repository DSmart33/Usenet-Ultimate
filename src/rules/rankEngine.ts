/**
 * Ranked Rule Engine — community-template-aligned model
 *
 * Two-pass evaluation over the candidate pool:
 *
 *   Pass 1 — Regex rules tag streams.
 *     Each rule's pattern is tested against each candidate's title. A match
 *     attaches the rule's name to the candidate's tag list (`_rankRegexTags`).
 *     If the rule also carries a non-zero `score`, that score contributes
 *     directly to `_rankRegexScore` (this is a backward-compat convenience
 *     for user-authored rules; imported community templates typically carry
 *     `score: 0` and rely on expressions for scoring).
 *
 *   Pass 2 — SEL expressions score the tagged pool.
 *     Each expression runs ONCE against the full pool (not per-stream) and
 *     returns an array of streams. The expression's score is added to every
 *     returned stream's `_rankSeScore`. This set-level scoring model is
 *     essential for templates where the regex layer tags and the SEL layer
 *     translates tags into scores.
 *
 * Safety:
 *   - `??` for score, `!== false` for enabled. Never `||`.
 *   - Compile cache keyed by rulesHash; LRU-capped at 16 entries.
 *   - Per-request wallclock budget (500ms) for regex evaluation.
 *   - Title length cap (1000 chars) before `regex.test()`.
 *   - Score clamps: per-rule ±10_000, per-candidate total ±100_000.
 *   - Unknown functions in SEL return `[]` (fail-open), not exceptions.
 */

import { compile as selCompile, evaluate as selEvaluate, type CompiledExpr, type StreamContext, type StreamRef, type EvalContext } from './sel.js';
import { BUILTIN_FUNCTIONS } from './selFunctions.js';
import { rulesHash } from './rulesHash.js';
import type { FilterConfig, RankedRegexRule, RankedSelRule } from '../types.js';

// ─── Limits ──────────────────────────────────────────────────────────

const REQUEST_REGEX_BUDGET_MS = 500;
const PER_RULE_SCORE_CLAMP    = 10_000;
const PER_CANDIDATE_CLAMP     = 100_000;
const TITLE_LENGTH_CAP        = 1000;

// ─── Compiled rule shape ─────────────────────────────────────────────

interface CompiledRegexRule {
  id: string;
  name: string;
  score: number;
  enabled: boolean;
  regex?: RegExp;
  compileError?: string;
}

interface CompiledSelRule {
  id: string;
  name: string;
  score: number;
  enabled: boolean;
  expr?: CompiledExpr;
  compileError?: string;
}

interface CompiledRules {
  hash: string;
  regex: CompiledRegexRule[];
  sel:   CompiledSelRule[];
  compileErrors: RuleError[];
}

export interface RuleError {
  ruleId: string;
  ruleName: string;
  kind: 'regex' | 'sel';
  message: string;
}

export interface MatchedRule {
  ruleId: string;
  ruleName: string;
  kind: 'regex' | 'sel';
  score: number;
}

// ─── Compile cache ───────────────────────────────────────────────────

const compileCache = new Map<string, CompiledRules>();

function clampScore(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  if (n > PER_RULE_SCORE_CLAMP) return PER_RULE_SCORE_CLAMP;
  if (n < -PER_RULE_SCORE_CLAMP) return -PER_RULE_SCORE_CLAMP;
  return n;
}

function compileRegexRule(r: RankedRegexRule): CompiledRegexRule {
  const base: CompiledRegexRule = {
    id: r.id,
    name: r.name,
    score: clampScore(r.score),
    enabled: r.enabled !== false,
  };
  if (!base.enabled) return base;
  try {
    base.regex = new RegExp(r.pattern, r.flags ?? 'i');
  } catch (e: any) {
    base.compileError = e?.message ?? String(e);
  }
  return base;
}

function compileSelRule(r: RankedSelRule): CompiledSelRule {
  const base: CompiledSelRule = {
    id: r.id,
    name: r.name,
    score: clampScore(r.score),
    enabled: r.enabled !== false,
  };
  if (!base.enabled) return base;
  try {
    base.expr = selCompile(r.expression);
  } catch (e: any) {
    base.compileError = e?.message ?? String(e);
  }
  return base;
}

export function getCompiledRules(rules: FilterConfig['rules'] | undefined): CompiledRules {
  const hash = rulesHash(rules);
  const cached = compileCache.get(hash);
  if (cached) return cached;

  const compiled: CompiledRules = {
    hash,
    regex: (rules?.rankedRegexPatterns ?? []).map(compileRegexRule),
    sel:   (rules?.rankedStreamExpressions ?? []).map(compileSelRule),
    compileErrors: [],
  };
  for (const r of compiled.regex) {
    if (r.compileError) compiled.compileErrors.push({ ruleId: r.id, ruleName: r.name, kind: 'regex', message: r.compileError });
  }
  for (const r of compiled.sel) {
    if (r.compileError) compiled.compileErrors.push({ ruleId: r.id, ruleName: r.name, kind: 'sel', message: r.compileError });
  }

  if (compileCache.size >= 16) {
    const firstKey = compileCache.keys().next().value;
    if (firstKey !== undefined) compileCache.delete(firstKey);
  }
  compileCache.set(hash, compiled);
  return compiled;
}

export function invalidateCompiledRules(hash: string): void { compileCache.delete(hash); }
export function clearCompiledRules(): void { compileCache.clear(); }

// ─── Stream context builder ──────────────────────────────────────────

/**
 * Build the per-stream attribute map SEL expressions use for legacy
 * `stream.codec == '...'`-style access. `stream.seeders` is pinned to null
 * on usenet so authors get predictable behavior.
 */
export function buildStreamContext(parsed: {
  title?: string;
  filename?: string;
  size?: number;
  indexer?: string;
  age?: number;
  resolution?: string;
  codec?: string;
  releaseGroup?: string;
  visualTag?: string;
  audioTag?: string;
  videoTag?: string;
  edition?: string;
  language?: string;
  seeders?: number | null;
}): StreamContext {
  return {
    title: parsed.title ?? '',
    filename: parsed.filename ?? parsed.title ?? '',
    size: parsed.size ?? 0,
    indexer: parsed.indexer ?? '',
    age: parsed.age ?? 0,
    resolution: parsed.resolution ?? '',
    codec: parsed.codec ?? '',
    releaseGroup: parsed.releaseGroup ?? '',
    visualTag: parsed.visualTag ?? '',
    audioTag: parsed.audioTag ?? '',
    videoTag: parsed.videoTag ?? '',
    edition: parsed.edition ?? '',
    language: parsed.language ?? '',
    seeders: parsed.seeders ?? null,
  };
}

// ─── Pool evaluation ─────────────────────────────────────────────────

/** A candidate ready for ranked-rule evaluation. */
export interface RankableCandidate {
  /** Opaque identity (the raw result object). */
  ref: unknown;
  /** Parsed attributes used by SEL attribute access and filter functions. */
  attrs: StreamContext;
  /** Title to match regex rules against (usually the release name). */
  title: string;
}

export interface PoolRankOptions {
  /** Compiled rules set. */
  compiled: CompiledRules;
  /** Candidates to rank. Mutated in place via ref-keyed output. */
  candidates: RankableCandidate[];
  /** Query context passed to SEL via `queryType`. 'movie' | 'series' | 'anime.series'. */
  queryType?: string;
  /** Additional constants exposed to SEL via bare identifier access. */
  constants?: Record<string, unknown>;
}

export interface RankDecorations {
  regexScore: number;
  seScore: number;
  totalScore: number;
  matched: MatchedRule[];
  tags: string[];
}

export interface PoolRankResult {
  /** Per-candidate decoration, keyed by ref. */
  decorations: Map<unknown, RankDecorations>;
  /** Rule compile errors surfaced once per request. */
  errors: RuleError[];
  /** Candidate refs that should be excluded from results (unused in the new
   *  model — exclusion lives elsewhere — but preserved for API stability). */
  excluded: Set<unknown>;
}

function applyDelta(current: number, delta: number): number {
  const next = current + delta;
  if (next > PER_CANDIDATE_CLAMP) return PER_CANDIDATE_CLAMP;
  if (next < -PER_CANDIDATE_CLAMP) return -PER_CANDIDATE_CLAMP;
  return next;
}

function capTitle(title: string): string {
  return title.length > TITLE_LENGTH_CAP ? title.slice(0, TITLE_LENGTH_CAP) : title;
}

/**
 * Evaluate the full candidate pool against compiled rules.
 *   - Pass 1: run each enabled regex rule across all candidates; record tags
 *     and, if the rule's score ≠ 0, accumulate regexScore deltas.
 *   - Pass 2: run each enabled SEL expression once against the tagged pool;
 *     every stream returned gets the expression's score added to seScore.
 */
export function rankPool(opts: PoolRankOptions): PoolRankResult {
  const { compiled, candidates, queryType, constants } = opts;
  const errors: RuleError[] = [...compiled.compileErrors];

  // Initialise decoration
  const deco = new Map<unknown, RankDecorations>();
  const streamRefs: StreamRef[] = [];
  for (const c of candidates) {
    const dec: RankDecorations = { regexScore: 0, seScore: 0, totalScore: 0, matched: [], tags: [] };
    deco.set(c.ref, dec);
    streamRefs.push({ ref: c.ref, attrs: c.attrs, tags: dec.tags });
  }

  // ── Pass 1: regex → tags + optional score ───────────────────────────
  let budgetMs = REQUEST_REGEX_BUDGET_MS;
  let overBudget = false;

  for (const rule of compiled.regex) {
    if (!rule.enabled || !rule.regex) continue;
    if (overBudget) break;

    for (const c of candidates) {
      if (overBudget) break;
      const before = Date.now();
      let hit = false;
      try {
        hit = rule.regex.test(capTitle(c.title));
      } catch (e: any) {
        errors.push({ ruleId: rule.id, ruleName: rule.name, kind: 'regex', message: e?.message ?? String(e) });
        continue;
      }
      budgetMs -= Date.now() - before;
      if (budgetMs <= 0) {
        overBudget = true;
        console.warn(`⚠️  Regex rule budget exhausted on rule '${rule.name}'`);
        break;
      }
      if (!hit) continue;

      const dec = deco.get(c.ref)!;
      dec.tags.push(rule.name);
      if (rule.score !== 0) {
        dec.regexScore = applyDelta(dec.regexScore, rule.score);
        dec.matched.push({ ruleId: rule.id, ruleName: rule.name, kind: 'regex', score: rule.score });
      }
    }
  }

  // ── Pass 2: SEL expressions → set-level scoring ─────────────────────
  const seConstants: Record<string, unknown> = {
    queryType: queryType ?? '',
    isAnime: false,
    ...(constants ?? {}),
  };

  for (const rule of compiled.sel) {
    if (!rule.enabled || !rule.expr) continue;

    const ctx: EvalContext = {
      streams: streamRefs,
      constants: seConstants,
      functions: BUILTIN_FUNCTIONS,
    };

    let result: unknown;
    try {
      result = selEvaluate(rule.expr, ctx);
    } catch (e: any) {
      errors.push({ ruleId: rule.id, ruleName: rule.name, kind: 'sel', message: e?.message ?? String(e) });
      continue;
    }

    // Set-level: result is an array of StreamRefs → score each
    if (Array.isArray(result)) {
      const refs = result as StreamRef[];
      for (const sr of refs) {
        const dec = deco.get(sr.ref);
        if (!dec) continue;
        if (rule.score !== 0) {
          dec.seScore = applyDelta(dec.seScore, rule.score);
          dec.matched.push({ ruleId: rule.id, ruleName: rule.name, kind: 'sel', score: rule.score });
        }
      }
    }
    // Boolean: legacy shape — evaluate per stream is not supported in the
    // pool model (the expression was evaluated once without a `stream` ctx).
    // If the user wants per-stream booleans they should wrap them in a
    // function call (e.g. encode(streams, 'hevc')).
  }

  // ── Finalise totals ─────────────────────────────────────────────────
  for (const dec of deco.values()) {
    dec.totalScore = applyDelta(dec.regexScore, dec.seScore);
  }

  return { decorations: deco, errors, excluded: new Set() };
}

// ─── Pipeline adapter ────────────────────────────────────────────────

/**
 * Apply ranked rules to a candidate pool. Decorates each candidate with
 * `_rankRegexScore`, `_rankSeScore`, `_rankTotalScore`, `_rankMatched`,
 * `_rankRegexTags`. Returns the candidates unchanged (no exclusion in the
 * new model — use attribute filters to exclude).
 */
export function applyRules(
  candidates: any[],
  filterConfig: FilterConfig | undefined,
  buildContext: (r: any) => StreamContext,
  queryType?: string,
): any[] {
  if (!filterConfig?.rules) {
    // Clear any lingering decoration from a previous rules-enabled request.
    for (const r of candidates) {
      if (r._rankTotalScore !== undefined) {
        delete r._rankRegexScore; delete r._rankSeScore; delete r._rankTotalScore;
        delete r._rankMatched; delete r._rankRegexTags; delete r._rankErrors;
      }
    }
    return candidates;
  }

  const compiled = getCompiledRules(filterConfig.rules);
  if (compiled.regex.length === 0 && compiled.sel.length === 0) return candidates;

  // Build RankableCandidates
  const rankables: RankableCandidate[] = candidates.map(r => ({
    ref: r,
    attrs: buildContext(r),
    title: String(r.title ?? ''),
  }));

  const result = rankPool({ compiled, candidates: rankables, queryType });

  // Decorate the original candidate objects
  for (const c of candidates) {
    const dec = result.decorations.get(c);
    if (!dec) continue;
    c._rankRegexScore = dec.regexScore;
    c._rankSeScore    = dec.seScore;
    c._rankTotalScore = dec.totalScore;
    c._rankMatched    = dec.matched;
    c._rankRegexTags  = dec.tags;
    if (result.errors.length > 0) c._rankErrors = result.errors;
  }

  return candidates;
}

// ─── Single-candidate preview (used by the API preview endpoint) ─────

export interface PreviewResult {
  regexScore: number;
  seScore: number;
  totalScore: number;
  matched: MatchedRule[];
  tags: string[];
  errors: RuleError[];
}

/**
 * Evaluate a single title against the compiled rules. Used by the live
 * test field. Builds a 1-element pool so set-level functions still work.
 */
export function previewSingle(
  compiled: CompiledRules,
  title: string,
  attrs: StreamContext,
  queryType?: string,
): PreviewResult {
  const cand: RankableCandidate = { ref: { title }, attrs, title };
  const result = rankPool({ compiled, candidates: [cand], queryType });
  const dec = result.decorations.get(cand.ref);
  return {
    regexScore: dec?.regexScore ?? 0,
    seScore: dec?.seScore ?? 0,
    totalScore: dec?.totalScore ?? 0,
    matched: dec?.matched ?? [],
    tags: dec?.tags ?? [],
    errors: result.errors,
  };
}
