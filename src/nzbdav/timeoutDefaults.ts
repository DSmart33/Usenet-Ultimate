/**
 * Ultimate Fallback Timeout Defaults & Shared Selector
 *
 * Default per-content wait times for Ultimate Fallback's nzbdav job-completion
 * step, plus the helper that selects the right timeout based on content type
 * and season-pack status.
 */

export interface TimeoutSet {
  movies: number;
  tv: number;
  seasonPack: number;
}

export const UF_TIMEOUT_DEFAULTS = {
  priority: { movies: 30, tv: 15, seasonPack: 30 },
  speed:    { movies: 20, tv: 10, seasonPack: 20 },
} satisfies Record<'priority' | 'speed', TimeoutSet>;

export function selectTimeoutMs(
  set: TimeoutSet,
  contentType: string | undefined,
  isSeasonPack: boolean,
): number {
  const seconds = contentType === 'series'
    ? (isSeasonPack ? set.seasonPack : set.tv)
    : set.movies;
  return seconds * 1000;
}

/** Format a timeout-seconds value for log/UI display. 0 renders as ∞. */
export function formatTimeoutSeconds(seconds: number): string {
  return seconds === 0 ? '∞' : `${seconds}s`;
}
