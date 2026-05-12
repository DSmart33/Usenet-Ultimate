/**
 * Stable short hash of a FilterConfig.rules block.
 *
 * Used as a cache key for compiled regex + SEL expressions so edits
 * invalidate the cache without needing reference equality (config reload
 * creates a new object each time).
 */

import crypto from 'crypto';
import type { FilterConfig } from '../types.js';

export function rulesHash(rules: FilterConfig['rules'] | undefined): string {
  if (!rules) return 'empty';
  // Sort keys inside each rule so non-semantic ordering differences (from JSON
  // parse order, for example) don't cause false invalidations.
  const normalized = {
    regex: (rules.rankedRegexPatterns ?? []).map(r => ({
      id: r.id, name: r.name, pattern: r.pattern, flags: r.flags ?? '', score: r.score ?? 0, enabled: r.enabled !== false, mode: r.mode ?? 'score',
    })),
    sel: (rules.rankedStreamExpressions ?? []).map(r => ({
      id: r.id, name: r.name, expression: r.expression, score: r.score ?? 0, enabled: r.enabled !== false,
    })),
    remoteRegex: rules.remoteRankedRegexUrls ?? [],
    remoteSel: rules.remoteRankedStreamExpressionUrls ?? [],
  };
  const h = crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
  return h.slice(0, 12);
}
