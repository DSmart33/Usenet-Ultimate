// What this does:
//   TTL (Time To Live) formatting and decomposition utilities

export function formatTTL(seconds: number): string {
  if (seconds === 0) return 'Disabled';
  const parts: string[] = [];
  const days = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) parts.push(`${days} Day${days !== 1 ? 's' : ''}`);
  if (hrs > 0) parts.push(`${hrs} Hour${hrs !== 1 ? 's' : ''}`);
  if (mins > 0) parts.push(`${mins} Minute${mins !== 1 ? 's' : ''}`);
  if (secs > 0) parts.push(`${secs} Second${secs !== 1 ? 's' : ''}`);
  return parts.join(' ') || 'Disabled';
}

export function decomposeTTL(totalSeconds: number) {
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

export function composeTTL(d: number, h: number, m: number, s: number): number {
  return d * 86400 + h * 3600 + m * 60 + s;
}
