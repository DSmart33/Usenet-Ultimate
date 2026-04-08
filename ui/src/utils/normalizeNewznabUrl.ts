/** Ensure a Newznab URL ends with /api (the standard endpoint).
 *  Users often paste just the base URL when they mean to include /api. */
export function normalizeNewznabUrl(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.replace(/\/+$/, '');
  if (/\/api$/i.test(trimmed)) return trimmed;
  try {
    const { pathname } = new URL(trimmed);
    if (pathname !== '/' && pathname !== '') return trimmed;
  } catch {
    return trimmed;
  }
  return `${trimmed}/api`;
}
