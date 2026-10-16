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
  const message =
    (typeof source.sqlMessage === 'string' && source.sqlMessage) ||
    (error instanceof Error && error.message) ||
    (typeof source.message === 'string' && source.message) ||
    String(error);
  return {
    error: message,
    code: typeof source.code === 'string' ? source.code : null,
    detail: typeof source.detail === 'string' ? source.detail : null,
    hint: typeof source.hint === 'string' ? source.hint : null,
    position: typeof source.position === 'number' ? source.position : null,
    sqlState: typeof source.sqlState === 'string' ? source.sqlState : null,
    errno: typeof source.errno === 'number' ? source.errno : null,
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
