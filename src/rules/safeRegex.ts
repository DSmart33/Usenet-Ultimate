/**
 * Regex safety validator for user-supplied patterns.
 *
 * Rejects patterns likely to cause catastrophic backtracking (ReDoS) via a
 * conservative heuristic. Doesn't catch every case — at runtime the rank
 * engine adds a 500ms per-request wallclock budget and a 1000-char title
 * cap as secondary defenses.
 *
 * Heuristics rejected:
 *  - Pattern length exceeds MAX_PATTERN_LEN (default 500 chars)
 *  - Pattern fails to compile as a JS RegExp
 *  - Nested unbounded quantifiers: (a+)+, (a*)*, (a+)*, (a?)+, etc.
 *  - The classic "capture-with-quantifier wrapped in a quantifier" shape
 */

// Long alternation lists (release-group rosters in community ranked-rules
// templates) routinely exceed 1000 chars. 2000 gives comfortable headroom
// without giving up the sanity bound — nested quantifier detection is the
// real ReDoS guard, not raw length.
const MAX_PATTERN_LEN = 2000;

// Matches a parenthesized group whose body contains '+' '*' or '?' and is
// immediately followed by another unbounded quantifier. Catches (a+)+ / (a*)* /
// (.+)* / (a|b+)+  — the common ReDoS shapes.
//
// Regex-on-regex isn't bulletproof (escape-aware parsing would be), but it
// covers the practical attack surface for user-supplied rules.
const NESTED_QUANTIFIER_RE = /\([^()]*[+*?][^()]*\)[+*]|\([^()]*[+*?][^()]*\)\{\d*,?\}/;

export interface RegexValidationError {
  kind: 'length' | 'compile' | 'nested-quantifier';
  message: string;
}

export function validateUserRegex(pattern: string, flags?: string): RegexValidationError | null {
  if (typeof pattern !== 'string') {
    return { kind: 'compile', message: 'Pattern must be a string' };
  }
  if (pattern.length > MAX_PATTERN_LEN) {
    return { kind: 'length', message: `Pattern exceeds ${MAX_PATTERN_LEN} characters` };
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return {
      kind: 'nested-quantifier',
      message: 'Pattern contains nested quantifiers (likely ReDoS — e.g. (a+)+, (.*)*). Rewrite without nested + / * / {n,}.',
    };
  }
  try {
    new RegExp(pattern, flags ?? '');
  } catch (e: any) {
    return { kind: 'compile', message: `Invalid regex: ${e?.message ?? String(e)}` };
  }
  return null;
}
