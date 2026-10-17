import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { driverFor } from '../db/manager.js';
import type { ConnectionRecord, Driver } from '../db/types.js';
import { getConnection } from '../store/connections.js';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function connectionFrom(req: Request): ConnectionRecord {
  const id = param(req, 'id');
  if (!id) throw new HttpError(400, '缺少连接 id');
  const record = getConnection(id);
  if (!record) throw new HttpError(404, '连接不存在或已被删除');
  return record;
}

/** Express 5 types params as `string | string[]`; a route param is always a single value here. */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

export function driverFrom(req: Request): { connection: ConnectionRecord; driver: Driver } {
  const connection = connectionFrom(req);
  return { connection, driver: driverFor(connection) };
}

export interface ApiErrorBody {
  error: string;
  code: string | null;
  detail: string | null;
  hint: string | null;
  position: number | null;
  sqlState: string | null;
  errno: number | null;
}

export function describeError(error: unknown): ApiErrorBody {
  const source = (error ?? {}) as Record<string, unknown>;
  const rawMessage =
    (typeof source.sqlMessage === 'string' && source.sqlMessage) ||
    (error instanceof Error && error.message) ||
    (typeof source.message === 'string' && source.message) ||
    String(error);
  const code = typeof source.code === 'string' ? source.code : null;
  const errno = typeof source.errno === 'number' ? source.errno : null;

  // MySQL 1049 / PostgreSQL 3D000 mean the configured default database is gone.
  // The driver text is not actionable (and MySQL may localise it), so say what
  // to do instead of echoing it.
  const missingDatabase = errno === 1049 || code === '3D000';
  // A server whose message catalog is not the connection charset returns bytes
  // that decode into replacement characters; show an honest fallback.
  const undecodable = /\uFFFD{2,}/.test(rawMessage);

  const message = missingDatabase
    ? '默认数据库不存在：请在连接设置里清空「默认数据库」，或改成该服务器上已有的库'
    : undecodable
      ? `数据库返回了无法解码的错误信息（错误码 ${errno ?? code ?? '未知'}），请检查连接设置`
      : rawMessage;

  return {
    error: message,
    code,
    detail: typeof source.detail === 'string' ? source.detail : null,
    hint: typeof source.hint === 'string' ? source.hint : null,
    position: typeof source.position === 'number' ? source.position : null,
    sqlState: typeof source.sqlState === 'string' ? source.sqlState : null,
    errno,
  };
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${label}不能为空`);
  }
  return value;
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? value : null;
}
