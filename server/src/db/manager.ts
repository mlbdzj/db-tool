import { createMysqlDriver } from './mysql.js';
import { createPostgresDriver } from './postgres.js';
import type { ConnectionRecord, Driver } from './types.js';

interface Entry {
  fingerprint: string;
  driver: Driver;
}

const entries = new Map<string, Entry>();

function fingerprintOf(conn: ConnectionRecord): string {
  return JSON.stringify([
    conn.kind,
    conn.host,
    conn.port,
    conn.user,
    conn.password ?? '',
    conn.database ?? '',
    Boolean(conn.ssl),
  ]);
}

export function driverFor(conn: ConnectionRecord): Driver {
  const fingerprint = fingerprintOf(conn);
  const existing = entries.get(conn.id);
  if (existing && existing.fingerprint === fingerprint) return existing.driver;
  if (existing) void existing.driver.dispose();
  const driver = conn.kind === 'postgres' ? createPostgresDriver(conn) : createMysqlDriver(conn);
  entries.set(conn.id, { fingerprint, driver });
  return driver;
}

export async function dropDriver(connectionId: string): Promise<void> {
  const existing = entries.get(connectionId);
  if (!existing) return;
  entries.delete(connectionId);
  await existing.driver.dispose();
}

export async function disposeAll(): Promise<void> {
  const all = [...entries.values()];
  entries.clear();
  await Promise.all(all.map((entry) => entry.driver.dispose()));
}
