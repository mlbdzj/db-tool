import { Router } from 'express';
import type { OrderBy, RowChange, TableRef } from '../db/types.js';
import { MAX_EXPORT_ROWS } from '../db/types.js';
import { clearHistory, listHistory, pushHistory } from '../store/history.js';
import { clampLimit, findUnscopedWrites } from '../util/sql.js';
import { UTF8_BOM, csvLine, jsonReplacer, sanitizeFilename } from '../util/csv.js';
import type { Response } from 'express';
import { HttpError, asyncRoute, driverFrom, optionalString, requireString } from './helpers.js';

export const dataRouter = Router();

function tableRefOf(value: unknown): TableRef {
  if (!value || typeof value !== 'object') throw new HttpError(400, '缺少表信息');
  const raw = value as { schema?: unknown; table?: unknown };
  const table = requireString(raw.table, '表名');
  const schema = optionalString(raw.schema);
  return { schema, table };
}

function orderByOf(value: unknown): OrderBy | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { column?: unknown; dir?: unknown };
  const column = requireString(raw.column, '排序字段');
  return { column, dir: raw.dir === 'desc' ? 'desc' : 'asc' };
}

dataRouter.post(
  '/:id/query',
  asyncRoute(async (req, res) => {
    const { connection, driver } = driverFrom(req);
    const body = req.body as { db?: unknown; sql?: unknown; confirmUnsafe?: unknown };
    const sql = requireString(body.sql, 'SQL 语句');
    const db = optionalString(body.db);

    if (connection.safeMode !== false && body.confirmUnsafe !== true) {
      const flagged = findUnscopedWrites(sql);
      if (flagged.length) {
        res.status(409).json({
          error: 'unscoped_write',
          message: '检测到没有 WHERE 条件的写操作，需要确认后才会执行',
          statements: flagged,
        });
        return;
      }
    }

    const startedAt = Date.now();
    try {
      const results = await driver.run(db, sql);
      const durationMs = Date.now() - startedAt;
      pushHistory({
        connectionId: connection.id,
        connectionName: connection.name,
        database: db,
        sql,
        ok: true,
        durationMs,
        rowCount: results.reduce((sum, result) => sum + result.rowCount, 0),
        error: null,
      });
      res.json({ results, durationMs });
    } catch (error) {
      pushHistory({
        connectionId: connection.id,
        connectionName: connection.name,
        database: db,
        sql,
        ok: false,
        durationMs: Date.now() - startedAt,
        rowCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }),
);

dataRouter.post(
  '/:id/rows/fetch',
  asyncRoute(async (req, res) => {
    const { driver } = driverFrom(req);
    const body = req.body as Record<string, unknown>;
    const db = optionalString(body.db);
    const table = tableRefOf(body.table);
    const result = await driver.fetchRows(db, table, {
      limit: clampLimit(body.limit, 100, 2000),
      offset: Math.max(0, Math.floor(Number(body.offset) || 0)),
      orderBy: orderByOf(body.orderBy),
      where: optionalString(body.where),
      withCount: body.withCount !== false,
    });
    res.json(result);
  }),
);

dataRouter.post(
  '/:id/rows/apply',
  asyncRoute(async (req, res) => {
    const { driver } = driverFrom(req);
    const body = req.body as { db?: unknown; changes?: unknown };
    const db = optionalString(body.db);
    if (!Array.isArray(body.changes) || body.changes.length === 0) {
      throw new HttpError(400, '没有需要提交的改动');
    }
    const changes: RowChange[] = body.changes.map((raw) => {
      const entry = raw as { type?: unknown; table?: unknown; key?: unknown; values?: unknown };
      const type = entry.type;
      if (type !== 'insert' && type !== 'update' && type !== 'delete') {
        throw new HttpError(400, '未知的改动类型');
      }
      return {
        type,
        table: tableRefOf(entry.table),
        key: entry.key && typeof entry.key === 'object' ? (entry.key as Record<string, unknown>) : undefined,
        values: entry.values && typeof entry.values === 'object' ? (entry.values as Record<string, unknown>) : undefined,
      };
    });
    const outcome = await driver.applyChanges(db, changes);
    res.json(outcome);
  }),
);

dataRouter.post(
  '/:id/export',
  asyncRoute(async (req, res) => {
    const { driver } = driverFrom(req);
    const body = req.body as Record<string, unknown>;
    const db = optionalString(body.db);
    const format = body.format === 'json' ? 'json' : 'csv';
    const filename = sanitizeFilename(optionalString(body.filename) ?? 'export');
    const extension = format === 'json' ? 'json' : 'csv';

    res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}.${extension}"; filename*=UTF-8''${encodeURIComponent(`${filename}.${extension}`)}`,
    );

    const writer = createExportWriter(res, format);

    if (typeof body.sql === 'string' && body.sql.trim()) {
      const results = await driver.run(db, body.sql);
      const result = results.find((entry) => entry.columns.length > 0);
      if (!result) throw new HttpError(400, '该语句没有返回结果集');
      writer.begin(result.columns);
      for (const row of result.rows) writer.row(row);
      writer.end();
      return;
    }

    const table = tableRefOf(body.table);
    const where = optionalString(body.where);
    const orderBy = orderByOf(body.orderBy);
    const chunk = 2000;
    let offset = 0;

    for (;;) {
      const page = await driver.fetchRows(db, table, { limit: chunk, offset, orderBy, where, withCount: false });
      if (!writer.started) writer.begin(page.columns.map((column) => column.name));
      for (const row of page.rows) writer.row(row);
      offset += page.rows.length;
      if (page.rows.length < chunk || offset >= MAX_EXPORT_ROWS) break;
    }
    writer.end();
  }),
);

interface ExportWriter {
  started: boolean;
  begin: (columns: string[]) => void;
  row: (values: unknown[]) => void;
  end: () => void;
}

function createExportWriter(res: Response, format: 'csv' | 'json'): ExportWriter {
  let anyRow = false;
  const writer: ExportWriter = {
    started: false,
    begin(columns) {
      writer.started = true;
      if (format === 'csv') res.write(UTF8_BOM + csvLine(columns));
      else res.write(`{\n"columns": ${JSON.stringify(columns)},\n"rows": [\n`);
    },
    row(values) {
      if (!writer.started) return;
      if (format === 'csv') {
        res.write(csvLine(values));
        return;
      }
      res.write((anyRow ? ',\n  ' : '  ') + JSON.stringify(values, jsonReplacer));
      anyRow = true;
    },
    end() {
      if (!writer.started) {
        res.write(format === 'csv' ? UTF8_BOM : '{\n"columns": [],\n"rows": []}\n');
      } else if (format === 'json') {
        res.write('\n]}\n');
      }
      res.end();
    },
  };
  return writer;
}

dataRouter.get(
  '/:id/history',
  asyncRoute(async (req, res) => {
    const { connection } = driverFrom(req);
    res.json({ entries: listHistory(connection.id) });
  }),
);

dataRouter.delete(
  '/:id/history',
  asyncRoute(async (req, res) => {
    const { connection } = driverFrom(req);
    clearHistory(connection.id);
    res.json({ ok: true });
  }),
);
