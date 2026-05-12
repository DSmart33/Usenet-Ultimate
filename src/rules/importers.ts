/**
 * Ranked-Rules JSON Importer
 *
 * Parses ranked-rule JSON in the format popularized by community templates:
 *
 *   {
 *     "rankedRegexPatterns": [
 *       { "name": "REMUX boost", "pattern": "/\\bREMUX\\b/i", "score": 50 }
 *     ],
 *     "rankedStreamExpressions": [
 *       { "name": "4K HDR", "expression": "stream.resolution == '4k'", "score": 40 }
 *     ]
 *   }
 *
 * Some community payloads nest under a `config` key:
 *   { "config": { "rankedRegexPatterns": [...], "rankedStreamExpressions": [...] } }
 *
 * Both shapes are accepted. Missing fields are tolerated; unknown fields are
 * ignored; extra top-level keys are ignored. Malformed entries produce per-rule
 * warnings but don't abort the import.
 *
 * Pattern format: `/source/flags` is auto-stripped; bare source without slashes
 * is accepted as-is.
 */

import crypto from 'crypto';
import { compile as selCompile } from './sel.js';
import { validateUserRegex } from './safeRegex.js';
import type { RankedRegexRule, RankedSelRule } from '../types.js';

export interface ImportedRules {
  rankedRegexPatterns: RankedRegexRule[];
  rankedStreamExpressions: RankedSelRule[];
}

export interface ImportWarning {
  kind: 'regex' | 'sel' | 'shape';
  name: string;
  message: string;
}

export interface ImportResult {
  rules: ImportedRules;
  warnings: ImportWarning[];
  /** Synced URLs the caller should follow (for ranked-rules templates). */
  followUrls?: { regex: string[]; sel: string[] };
}

/** Ranked-rules template input metadata, stripped of server-side DSL. */
export interface TemplateInput {
  id: string;
  name: string;
  description?: string;
  type: 'select' | 'boolean' | 'alert' | 'socials';
  required?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
}

export interface TemplatePreview {
  name: string;
  description?: string;
  inputs: TemplateInput[];
  defaults: Record<string, unknown>;
}

const MAX_INPUT_BYTES = 1_048_576;     // 1MB
const MAX_RULES_PER_KIND = 1000;       // Match plan's DoS cap

function clampScore(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  if (v > 10_000) return 10_000;
  if (v < -10_000) return -10_000;
  return Math.trunc(v);
}

/** Strip /.../flags wrapping if present. Returns { pattern, flags }. */
function splitPatternLiteral(raw: string): { pattern: string; flags: string } {
  const m = /^\/(.+)\/([a-z]*)$/i.exec(raw);
  if (m) return { pattern: m[1], flags: m[2] };
  return { pattern: raw, flags: '' };
}

/**
 * Community templates sometimes include "marker" rules — score:0 entries with
 * fully-stylised unicode names (mathematical-monospace, fullwidth, etc.) that
 * serve as labels in their UI, not real rules. Skip them on import so our
 * list isn't polluted with zero-score no-op markers.
 *
 * Heuristic: any rule whose name contains characters in mathematical /
 * enclosed-alphanumeric / fullwidth Unicode blocks is presumed to be a marker.
 */
function isTemplateMarkerName(name: string): boolean {
  if (!name) return false;
  // U+1D400–U+1D7FF Mathematical Alphanumeric Symbols
  // U+FF00–U+FFEF Halfwidth and Fullwidth Forms
  return /[\u{1D400}-\u{1D7FF}\uFF00-\uFFEF]/u.test(name);
}

/** Detect ranked-rules template shape: has metadata + config, at least one of which uses the DSL. */
function isRankedTemplate(raw: any): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return typeof raw.metadata === 'object' && raw.metadata !== null
      && typeof raw.config === 'object' && raw.config !== null;
}

/**
 * Resolve a ranked-rules template config field against user-supplied input values.
 * Supports:
 *   - { __if: <inputKey>, __value: <val> } → val if input[key] truthy, else undefined
 *   - { __switch: <inputKey>, cases: {...}, default: <val> } → case[input[key]] or default
 *   - Plain literals / arrays / objects pass through (recursively resolving if they
 *     contain nested DSL markers)
 * Returns undefined when the field is gated off by a false __if.
 */
function resolveTemplateValue(node: any, inputs: Record<string, unknown>): any {
  if (node === null || typeof node !== 'object') return node;

  // Templates reference inputs with `inputs.<id>` syntax; strip the prefix
  // so our flat inputs map (keyed by id) resolves correctly.
  const lookupInput = (key: string): unknown => {
    const id = key.startsWith('inputs.') ? key.slice('inputs.'.length) : key;
    return inputs[id];
  };

  if ('__if' in node && '__value' in node) {
    const cond = Boolean(lookupInput((node as any).__if));
    if (!cond) return undefined;
    return resolveTemplateValue((node as any).__value, inputs);
  }

  if ('__switch' in node && 'cases' in node) {
    const key = String(lookupInput((node as any).__switch) ?? '');
    const cases = (node as any).cases ?? {};
    if (key in cases) return resolveTemplateValue(cases[key], inputs);
    if ('default' in node) return resolveTemplateValue((node as any).default, inputs);
    return undefined;
  }

  if (Array.isArray(node)) {
    return node.map(n => resolveTemplateValue(n, inputs)).filter(v => v !== undefined);
  }

  // Plain object — recurse (rare in practice; templates don't nest DSL deep)
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    const resolved = resolveTemplateValue(v, inputs);
    if (resolved !== undefined) out[k] = resolved;
  }
  return out;
}

/**
 * Walk a config subtree and collect every input ID referenced by an `__if`
 * or `__switch` DSL marker. Used to narrow the variant picker to only the
 * inputs that actually affect what gets loaded.
 *
 * Template convention: the __if/__switch value uses the `inputs.<id>`
 * prefix (e.g. "inputs.variant"). We strip that prefix so the resulting
 * set matches the bare IDs in `metadata.inputs`.
 */
function collectReferencedInputIds(node: any, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const stripPrefix = (v: string): string => v.startsWith('inputs.') ? v.slice('inputs.'.length) : v;
  if ('__if' in node && typeof node.__if === 'string') out.add(stripPrefix(node.__if));
  if ('__switch' in node && typeof node.__switch === 'string') out.add(stripPrefix(node.__switch));
  if (Array.isArray(node)) {
    for (const item of node) collectReferencedInputIds(item, out);
    return;
  }
  for (const v of Object.values(node)) collectReferencedInputIds(v, out);
}

/**
 * Inspect a ranked-rules template payload and surface the input schema (variants,
 * toggles, info alerts) to the UI. Does NOT resolve the config or follow URLs —
 * that happens in a second call once the user picks their inputs.
 *
 * Input schema is narrowed to only the inputs that actually affect what we
 * load — i.e. inputs referenced in the DSL of `syncedRankedRegexUrls`,
 * `syncedRankedStreamExpressionUrls`, `rankedRegexPatterns`, or
 * `rankedStreamExpressions`. Everything else in community templates
 * (formatter choice, TorBox tier, catalog addon lists, etc.) configures
 * behavior we don't consume, so those inputs are hidden.
 */
export function previewTemplate(raw: any): TemplatePreview | null {
  if (!isRankedTemplate(raw)) return null;
  const meta = raw.metadata;
  const inputsRaw = Array.isArray(meta.inputs) ? meta.inputs : [];

  // Scan the config fields we actually consume for DSL references.
  const cfg = raw.config ?? {};
  const relevant = new Set<string>();
  collectReferencedInputIds(cfg.syncedRankedRegexUrls, relevant);
  collectReferencedInputIds(cfg.syncedRankedStreamExpressionUrls, relevant);
  collectReferencedInputIds(cfg.rankedRegexPatterns, relevant);
  collectReferencedInputIds(cfg.rankedStreamExpressions, relevant);

  const defaults: Record<string, unknown> = {};
  const inputs: TemplateInput[] = [];
  for (const inp of inputsRaw) {
    if (!inp || typeof inp !== 'object') continue;
    if (typeof inp.id !== 'string') continue;
    // Always record the default so the second-phase resolver has it, even
    // for inputs we hide from the UI — otherwise a hidden `__if` gate could
    // silently drop a config field.
    if (inp.default !== undefined) defaults[inp.id] = inp.default;
    // Only surface inputs that actually affect the rules-loading paths.
    if (!relevant.has(inp.id)) continue;
    const entry: TemplateInput = {
      id: inp.id,
      name: typeof inp.name === 'string' ? inp.name : inp.id,
      description: typeof inp.description === 'string' ? inp.description : undefined,
      type: (['select', 'boolean', 'alert', 'socials'] as const).includes(inp.type) ? inp.type : 'alert',
      required: inp.required === true,
      default: inp.default,
      options: Array.isArray(inp.options)
        ? inp.options
            .filter((o: any) => o && typeof o === 'object' && typeof o.value === 'string')
            .map((o: any) => ({ value: o.value, label: typeof o.label === 'string' ? o.label : o.value }))
        : undefined,
    };
    inputs.push(entry);
  }
  return {
    name: typeof meta.name === 'string' ? meta.name : 'Imported template',
    description: typeof meta.description === 'string' ? meta.description : undefined,
    inputs,
    defaults,
  };
}

export function parseRankedRulesJson(text: string, inputs?: Record<string, unknown>): ImportResult {
  if (typeof text !== 'string') {
    throw new Error('Import body must be a string');
  }
  if (text.length > MAX_INPUT_BYTES) {
    throw new Error(`Import exceeds ${MAX_INPUT_BYTES} bytes`);
  }

  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Invalid JSON: ${e?.message ?? String(e)}`);
  }

  // Accept array-root (templates wrap in `[...]`)
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw new Error('Empty import (array was empty)');
    raw = raw[0];
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Import root must be a JSON object');
  }

  // Ranked-rules template detection
  const isTemplate = isRankedTemplate(raw);
  let configSrc: any;
  if (isTemplate) {
    // Resolve DSL using supplied inputs, falling back to template defaults
    const preview = previewTemplate(raw)!;
    const resolvedInputs = { ...preview.defaults, ...(inputs ?? {}) };
    configSrc = resolveTemplateValue(raw.config, resolvedInputs);
    if (!configSrc || typeof configSrc !== 'object') configSrc = {};
  } else {
    // Plain shape — accept either top-level or nested-under-"config"
    configSrc = raw.config && typeof raw.config === 'object' ? raw.config : raw;
  }

  const src = configSrc;

  const warnings: ImportWarning[] = [];
  const rankedRegexPatterns: RankedRegexRule[] = [];
  const rankedStreamExpressions: RankedSelRule[] = [];

  const regexSrc = Array.isArray(src.rankedRegexPatterns) ? src.rankedRegexPatterns : [];
  const selSrc   = Array.isArray(src.rankedStreamExpressions) ? src.rankedStreamExpressions : [];

  if (regexSrc.length > MAX_RULES_PER_KIND) {
    throw new Error(`Too many regex rules (${regexSrc.length} > ${MAX_RULES_PER_KIND})`);
  }
  if (selSrc.length > MAX_RULES_PER_KIND) {
    throw new Error(`Too many SEL rules (${selSrc.length} > ${MAX_RULES_PER_KIND})`);
  }

  for (const entry of regexSrc) {
    const name = typeof entry?.name === 'string' && entry.name ? entry.name : '(unnamed)';
    if (isTemplateMarkerName(name)) continue;  // template UI-label marker, not a real rule
    if (typeof entry?.pattern !== 'string') {
      warnings.push({ kind: 'shape', name, message: 'Skipped: pattern must be a string' });
      continue;
    }
    const { pattern, flags: litFlags } = splitPatternLiteral(entry.pattern);
    const flags = typeof entry.flags === 'string' ? entry.flags : litFlags || 'i';
    const err = validateUserRegex(pattern, flags);
    if (err) {
      warnings.push({ kind: 'regex', name, message: err.message });
      continue;
    }
    rankedRegexPatterns.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomUUID(),
      name,
      pattern,
      flags,
      score: clampScore(entry.score),
      enabled: entry.enabled !== false,
      mode: (entry.mode === 'keep' || entry.mode === 'drop') ? entry.mode : 'score',
    });
  }

  for (const entry of selSrc) {
    // Template convention: display name lives either in a `name` field OR
    // in leading `/* Name */` comments inside the expression. `/*# Ref */`
    // (hash-prefixed) are reference-only and ignored. Extract a display
    // name so rules don't all render as "(unnamed)" after import.
    let name = typeof entry?.name === 'string' && entry.name ? entry.name : '';
    if (!name && typeof entry?.expression === 'string') {
      const commentMatches = [...entry.expression.matchAll(/\/\*([^*]|\*(?!\/))*\*\//g)].map(m => m[0].slice(2, -2).trim());
      const displayComments = commentMatches.filter(c => !c.startsWith('#'));
      if (displayComments.length > 0) {
        name = displayComments.join(' — ');
      }
    }
    if (!name) name = '(unnamed)';
    if (isTemplateMarkerName(name)) continue;
    if (typeof entry?.expression !== 'string') {
      warnings.push({ kind: 'shape', name, message: 'Skipped: expression must be a string' });
      continue;
    }
    try {
      selCompile(entry.expression);
    } catch (e: any) {
      warnings.push({ kind: 'sel', name, message: e?.message ?? String(e) });
      continue;
    }
    rankedStreamExpressions.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : crypto.randomUUID(),
      name,
      expression: entry.expression,
      score: clampScore(entry.score),
      enabled: entry.enabled !== false,
    });
  }

  // Extract followUrls (synced remote rule sources) from the resolved config.
  // Only surface them when this was actually a template import.
  let followUrls: { regex: string[]; sel: string[] } | undefined;
  if (isTemplate) {
    const regexUrls = Array.isArray(src.syncedRankedRegexUrls)
      ? src.syncedRankedRegexUrls.filter((u: any) => typeof u === 'string' && u)
      : [];
    const selUrls = Array.isArray(src.syncedRankedStreamExpressionUrls)
      ? src.syncedRankedStreamExpressionUrls.filter((u: any) => typeof u === 'string' && u)
      : [];
    if (regexUrls.length > 0 || selUrls.length > 0) {
      followUrls = { regex: regexUrls, sel: selUrls };
    }
  }

  return {
    rules: { rankedRegexPatterns, rankedStreamExpressions },
    warnings,
    followUrls,
  };
}

/**
 * Validate rules coming in through `PUT /api/settings`. Throws on hard errors
 * (regex length/compile/ReDoS, SEL compile). Called before configData is
 * mutated so no partial state can persist.
 */
export function validateRulesBlock(rules: any): void {
  if (!rules || typeof rules !== 'object') return;

  if (rules.rankedRegexPatterns !== undefined) {
    if (!Array.isArray(rules.rankedRegexPatterns)) {
      throw new Error('filters.rules.rankedRegexPatterns must be an array');
    }
    if (rules.rankedRegexPatterns.length > MAX_RULES_PER_KIND) {
      throw new Error(`Too many regex rules (${rules.rankedRegexPatterns.length} > ${MAX_RULES_PER_KIND})`);
    }
    for (const r of rules.rankedRegexPatterns) {
      if (!r || typeof r !== 'object') throw new Error('Each regex rule must be an object');
      if (typeof r.pattern !== 'string') throw new Error(`Regex rule '${r.name ?? ''}' pattern must be a string`);
      const err = validateUserRegex(r.pattern, typeof r.flags === 'string' ? r.flags : '');
      if (err) throw new Error(`Regex rule '${r.name ?? ''}': ${err.message}`);
      if (r.mode !== undefined && r.mode !== 'score' && r.mode !== 'keep' && r.mode !== 'drop') {
        throw new Error(`Regex rule '${r.name ?? ''}' mode '${r.mode}' is invalid; expected 'score', 'keep', or 'drop'`);
      }
      // Empty pattern in filter modes would match everything (drop nukes the
      // pool; keep is a no-op). Reject early so users see the misconfiguration.
      if ((r.mode === 'drop' || r.mode === 'keep') && r.pattern === '') {
        throw new Error(`Regex rule '${r.name ?? ''}' has empty pattern in '${r.mode}' mode (would match every result). Provide a pattern or switch to 'score' mode.`);
      }
    }
  }

  if (rules.rankedStreamExpressions !== undefined) {
    if (!Array.isArray(rules.rankedStreamExpressions)) {
      throw new Error('filters.rules.rankedStreamExpressions must be an array');
    }
    if (rules.rankedStreamExpressions.length > MAX_RULES_PER_KIND) {
      throw new Error(`Too many SEL rules (${rules.rankedStreamExpressions.length} > ${MAX_RULES_PER_KIND})`);
    }
    for (const r of rules.rankedStreamExpressions) {
      if (!r || typeof r !== 'object') throw new Error('Each SEL rule must be an object');
      if (typeof r.expression !== 'string') throw new Error(`SEL rule '${r.name ?? ''}' expression must be a string`);
      try {
        selCompile(r.expression);
      } catch (e: any) {
        throw new Error(`SEL rule '${r.name ?? ''}': ${e?.message ?? String(e)}`);
      }
    }
  }
}
