import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { connectionsFile } from '../config.js';
import { decryptSecret, encryptSecret } from '../util/crypto.js';
import type { ConnectionInput, ConnectionRecord, DbKind, PublicConnection } from '../db/types.js';

interface StoredConnection {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  safeMode?: boolean;
  color?: string;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionFile {
  version: number;
  connections: StoredConnection[];
}

let cache: ConnectionRecord[] | null = null;

function load(): ConnectionRecord[] {
  if (cache) return cache;
  if (!existsSync(connectionsFile)) {
    cache = [];
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(connectionsFile, 'utf8')) as ConnectionFile;
    cache = (parsed.connections ?? []).map((stored) => ({
      ...stored,
      password: stored.password ? safeDecrypt(stored.password) : undefined,
    }));
  } catch {
    cache = [];
  }
  return cache;
}

function safeDecrypt(payload: string): string | undefined {
  try {
    return decryptSecret(payload);
  } catch {
    return undefined;
  }
}

function persist(list: ConnectionRecord[]): void {
  const payload: ConnectionFile = {
    version: 1,
    connections: list.map((conn) => ({
      id: conn.id,
      name: conn.name,
      kind: conn.kind,
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password ? encryptSecret(conn.password) : undefined,
      database: conn.database,
      ssl: conn.ssl,
      safeMode: conn.safeMode,
      color: conn.color,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
    })),
  };
  writeFileSync(connectionsFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1-65535 之间的整数');
  }
  return port;
}

function normalizeKind(value: unknown): DbKind {
  if (value === 'mysql' || value === 'postgres') return value;
  throw new Error('暂不支持的数据库类型');
}

function requireText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

export function toPublic(conn: ConnectionRecord): PublicConnection {
  return {
    id: conn.id,
    name: conn.name,
    kind: conn.kind,
    host: conn.host,
    port: conn.port,
    user: conn.user,
    database: conn.database,
    ssl: Boolean(conn.ssl),
    safeMode: conn.safeMode !== false,
    color: conn.color,
    hasPassword: Boolean(conn.password),
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

export function listConnections(): ConnectionRecord[] {
  return load();
}

export function getConnection(id: string): ConnectionRecord | undefined {
  return load().find((conn) => conn.id === id);
}

export function createConnection(input: ConnectionInput): ConnectionRecord {
  const now = new Date().toISOString();
  const record: ConnectionRecord = {
    id: randomUUID(),
    name: requireText(input.name, '连接名称'),
    kind: normalizeKind(input.kind),
    host: requireText(input.host, '主机地址'),
    port: normalizePort(input.port),
    user: requireText(input.user, '用户名'),
    password: typeof input.password === 'string' ? input.password : undefined,
    database: input.database?.trim() || undefined,
    ssl: Boolean(input.ssl),
    safeMode: input.safeMode !== false,
    color: input.color?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  const list = [...load(), record];
  cache = list;
  persist(list);
  return record;
}

export function updateConnection(id: string, input: Partial<ConnectionInput>): ConnectionRecord {
  const list = load();
  const index = list.findIndex((conn) => conn.id === id);
  if (index === -1) throw new Error('连接不存在');
  const current = list[index]!;
  const password =
    input.password === null
      ? undefined
      : typeof input.password === 'string' && input.password.length > 0
        ? input.password
        : current.password;

  const next: ConnectionRecord = {
    ...current,
    name: input.name === undefined ? current.name : requireText(input.name, '连接名称'),
    kind: input.kind === undefined ? current.kind : normalizeKind(input.kind),
    host: input.host === undefined ? current.host : requireText(input.host, '主机地址'),
    port: input.port === undefined ? current.port : normalizePort(input.port),
    user: input.user === undefined ? current.user : requireText(input.user, '用户名'),
    password,
    database: input.database === undefined ? current.database : input.database?.trim() || undefined,
    ssl: input.ssl === undefined ? current.ssl : Boolean(input.ssl),
    safeMode: input.safeMode === undefined ? current.safeMode : input.safeMode !== false,
    color: input.color === undefined ? current.color : input.color?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  const updated = [...list];
  updated[index] = next;
  cache = updated;
  persist(updated);
  return next;
}

export function deleteConnection(id: string): boolean {
  const list = load();
  const next = list.filter((conn) => conn.id !== id);
  if (next.length === list.length) return false;
  cache = next;
  persist(next);
  return true;
}
