import { Router } from 'express';
import { driverFor, dropDriver } from '../db/manager.js';
import type { ConnectionInput, ConnectionRecord } from '../db/types.js';
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  toPublic,
  updateConnection,
} from '../store/connections.js';
import { HttpError, asyncRoute, connectionFrom, driverFrom, optionalString, param } from './helpers.js';
import { randomUUID } from 'node:crypto';

export const connectionsRouter = Router();

connectionsRouter.get('/', (_req, res) => {
  res.json({ connections: listConnections().map(toPublic) });
});

connectionsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const record = createConnection(req.body as ConnectionInput);
    res.status(201).json({ connection: toPublic(record) });
  }),
);

connectionsRouter.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const record = updateConnection(param(req, 'id'), req.body as Partial<ConnectionInput>);
    await dropDriver(record.id);
    res.json({ connection: toPublic(record) });
  }),
);

connectionsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    await dropDriver(id);
    const removed = deleteConnection(id);
    res.json({ removed });
  }),
);

interface TestPayload extends Partial<ConnectionInput> {
  id?: string;
}

connectionsRouter.post(
  '/test',
  asyncRoute(async (req, res) => {
    const payload = req.body as TestPayload;
    const stored = payload.id ? getConnection(payload.id) : undefined;
    if (payload.id && !stored) throw new HttpError(404, '连接不存在');

    const now = new Date().toISOString();
    const draft: ConnectionRecord = {
      id: stored?.id ?? `test-${randomUUID()}`,
      name: stored?.name ?? payload.name ?? 'test',
      kind: (payload.kind ?? stored?.kind) as ConnectionRecord['kind'],
      host: payload.host ?? stored?.host ?? '127.0.0.1',
      port: Number(payload.port ?? stored?.port ?? 3306),
      user: payload.user ?? stored?.user ?? 'root',
      password: typeof payload.password === 'string' && payload.password.length > 0 ? payload.password : stored?.password,
      database: optionalString(payload.database) ?? stored?.database,
      ssl: payload.ssl ?? stored?.ssl,
      safeMode: true,
      createdAt: now,
      updatedAt: now,
    };
    if (!draft.kind) throw new HttpError(400, '请选择数据库类型');

    const driver = driverFor(draft);
    try {
      const sql = draft.kind === 'postgres' ? 'SHOW server_version' : 'SELECT VERSION()';
      const results = await driver.run(draft.database ?? null, sql);
      const version = results[0]?.rows?.[0]?.[0];
      const databases = await driver.listDatabases();
      res.json({
        ok: true,
        version: version === undefined || version === null ? null : String(version),
        databaseCount: databases.length,
      });
    } finally {
      if (!stored) await dropDriver(draft.id);
    }
  }),
);

connectionsRouter.get(
  '/:id/databases',
  asyncRoute(async (req, res) => {
    const { driver } = driverFrom(req);
    res.json({ databases: await driver.listDatabases() });
  }),
);

connectionsRouter.get(
  '/:id/tables',
  asyncRoute(async (req, res) => {
    const { driver } = driverFrom(req);
    const db = typeof req.query.db === 'string' ? req.query.db : null;
    res.json({ tables: await driver.listTables(db) });
  }),
);

connectionsRouter.get(
  '/:id/columns',
  asyncRoute(async (req, res) => {
    const { driver } = driverFrom(req);
    const db = typeof req.query.db === 'string' ? req.query.db : null;
    const table = typeof req.query.table === 'string' ? req.query.table : '';
    if (!table) throw new HttpError(400, '缺少表名');
    const schema = typeof req.query.schema === 'string' && req.query.schema.length ? req.query.schema : null;
    res.json({ columns: await driver.listColumns(db, { schema, table }) });
  }),
);

connectionsRouter.get(
  '/:id/schema',
  asyncRoute(async (req, res) => {
    const { driver } = driverFrom(req);
    const db = typeof req.query.db === 'string' && req.query.db.length ? req.query.db : null;
    res.json({ schema: await driver.listSchemaMap(db) });
  }),
);

connectionsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json({ connection: toPublic(connectionFrom(req)) });
  }),
);
