/**
 * Per-task search log buffering. When a search task runs inside `withBuffer`,
 * any `slog(line)` calls inside it (including across `await` boundaries and
 * concurrent `Promise.all` children) are appended to the task's own buffer
 * instead of going straight to stdout. The orchestrator flushes buffers in
 * stable order after `Promise.all` settles, producing contiguous per-task
 * log blocks instead of interleaved noise.
 *
 * Buffers are tree-structured: each entry is either a raw string from `slog`
 * or a sub-block created by `withSubBuffer`. Sub-blocks reserve their slot in
 * the parent buffer at *insertion* time (synchronously, before the inner task
 * starts running), so child blocks render in the order they were launched
 * regardless of which one's HTTP response returned first.
 *
 * Outside any `withBuffer` scope, `slog` falls back to `console.log` so
 * standalone callers and unit tests behave normally.
 */

import { AsyncLocalStorage } from 'async_hooks';

export type LogEntry = string | LogBlock;
export interface LogBlock {
  __sub: true;
  label: string;
  lines: LogEntry[];
}

const storage = new AsyncLocalStorage<LogEntry[]>();

export function slog(line: string): void {
  const buf = storage.getStore();
  if (buf) buf.push(line);
  else console.log(line);
}

export async function withBuffer<T>(fn: () => Promise<T>): Promise<{ result: T; lines: LogEntry[] }> {
  const buffer: LogEntry[] = [];
  const result = await storage.run(buffer, fn);
  return { result, lines: buffer };
}

/**
 * Wraps an async task in a sub-block scoped to the active buffer. Reserves
 * the block's slot in the parent at insertion time so launch order, not
 * completion order, determines render order.
 */
export async function withSubBuffer<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  if (!parent) return fn();
  const block: LogBlock = { __sub: true, label, lines: [] };
  parent.push(block);
  return await storage.run(block.lines, fn);
}

function renderTree(entries: LogEntry[], prefix: string): void {
  for (const entry of entries) {
    if (typeof entry === 'string') {
      console.log(`${prefix}${entry}`);
    } else {
      console.log(`${prefix}  ┌─ ${entry.label} `);
      renderTree(entry.lines, `${prefix}  │ `);
      console.log(`${prefix}  └─`);
    }
  }
}

export function flushBuffer(entries: LogEntry[], label?: string): void {
  if (entries.length === 0) return;
  if (label) {
    console.log('');
    console.log(`═══ ${label} ${'═'.repeat(Math.max(3, 60 - label.length))}`);
  }
  renderTree(entries, '');
  if (label) console.log('');
}
