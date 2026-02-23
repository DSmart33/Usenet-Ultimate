/**
 * In-memory log buffer that intercepts console output
 * and provides it via API/SSE for the dashboard log viewer.
 */

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const MAX_BUFFER_SIZE = 1000;
const logBuffer: LogEntry[] = [];
const sseClients: Set<(entry: LogEntry) => void> = new Set();

function pushLines(level: LogEntry['level'], args: unknown[]) {
  const raw = args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ');

  // Split on newlines so blank lines become spacer entries
  const lines = raw.split('\n');
  const timestamp = new Date().toISOString();

  for (const line of lines) {
    const entry: LogEntry = { timestamp, level, message: line };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_BUFFER_SIZE) {
      logBuffer.shift();
    }
    for (const cb of sseClients) {
      cb(entry);
    }
  }
}

// Intercept console methods
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

console.log = (...args: unknown[]) => {
  originalLog(...args);
  pushLines('info', args);
};

console.warn = (...args: unknown[]) => {
  originalWarn(...args);
  pushLines('warn', args);
};

console.error = (...args: unknown[]) => {
  originalError(...args);
  pushLines('error', args);
};

export function getLogBuffer(): LogEntry[] {
  return [...logBuffer];
}

export function subscribeToLogs(cb: (entry: LogEntry) => void): () => void {
  sseClients.add(cb);
  return () => { sseClients.delete(cb); };
}
