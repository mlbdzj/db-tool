import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { historyFile } from '../config.js';

export interface HistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string | null;
  sql: string;
  ok: boolean;
  durationMs: number;
  rowCount: number;
  error: string | null;
  ranAt: string;
}

const LIMIT = 300;
let cache: HistoryEntry[] | null = null;

function load(): HistoryEntry[] {
  if (cache) return cache;
  if (!existsSync(historyFile)) {
    cache = [];
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(historyFile, 'utf8')) as { entries?: HistoryEntry[] };
    cache = parsed.entries ?? [];
  } catch {
    cache = [];
  }
  return cache;
}

export function listHistory(connectionId?: string): HistoryEntry[] {
  const entries = load();
  const filtered = connectionId ? entries.filter((entry) => entry.connectionId === connectionId) : entries;
  return filtered.slice(0, LIMIT);
}

export function pushHistory(entry: Omit<HistoryEntry, 'id' | 'ranAt'>): HistoryEntry {
  const record: HistoryEntry = { ...entry, id: randomUUID(), ranAt: new Date().toISOString() };
  const next = [record, ...load()].slice(0, LIMIT);
  cache = next;
  writeFileSync(historyFile, JSON.stringify({ version: 1, entries: next }, null, 2), { mode: 0o600 });
  return record;
}

export function clearHistory(connectionId?: string): void {
  const next = connectionId ? load().filter((entry) => entry.connectionId !== connectionId) : [];
  cache = next;
  writeFileSync(historyFile, JSON.stringify({ version: 1, entries: next }, null, 2), { mode: 0o600 });
}
