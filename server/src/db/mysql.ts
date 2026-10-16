import mysql from 'mysql2/promise';
import type {
  ColumnInfo,
  ConnectionRecord,
  DatabaseInfo,
  Driver,
  FetchRowsOptions,
  FetchRowsResult,
  ResultSet,
  RowChange,
  TableInfo,
  TableRef,
} from './types.js';
import { MAX_RESULT_ROWS } from './types.js';
import { quoteMysqlIdent } from '../util/sql.js';

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

type Pool = ReturnType<typeof mysql.createPool>;

function isResultHeader(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'affectedRows')
  );
}

export function createMysqlDriver(conn: ConnectionRecord): Driver {
  const pools = new Map<string, Pool>();

  function poolFor(db: string | null): Pool {
    const key = db ?? conn.database ?? '';
    let pool = pools.get(key);
    if (!pool) {
      pool = mysql.createPool({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password ?? '',
        database: key || undefined,
        waitForConnections: true,
        connectionLimit: 4,
        maxIdle: 4,
        idleTimeout: 60000,
        queueLimit: 0,
        connectTimeout: 10000,
        multipleStatements: true,
        rowsAsArray: true,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      });
      pools.set(key, pool);
    }
    return pool;
  }

  function schemaName(db: string | null): string {
    const name = db ?? conn.database ?? '';
    if (!name) throw new Error('No database selected');
    return name;
  }

  function qualify(db: string | null, table: TableRef): string {
    return `${quoteMysqlIdent(table.schema || schemaName(db))}.${quoteMysqlIdent(table.table)}`;
  }

  function normalize(rows: unknown, fields: unknown): ResultSet[] {
    const fieldList = Array.isArray(fields) ? (fields as unknown[]) : [];
    const multi =
      Array.isArray(rows) &&
      (fieldList.some((f) => Array.isArray(f)) ||
        (rows.length > 0 && (rows as unknown[]).every(isResultHeader)));
    const entries: unknown[] = multi ? (rows as unknown[]) : [rows];

    return entries.map((entry, index) => {
      if (isResultHeader(entry)) {
        const header = entry as { affectedRows?: number; insertId?: number | string | null };
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          affectedRows: Number(header.affectedRows ?? 0),
          insertId: header.insertId ?? null,
          command: 'OK',
        };
      }
      const field = (multi ? (fieldList[index] as unknown[] | undefined) : fieldList) ?? [];
      const data = Array.isArray(entry) ? (entry as unknown[][]) : [];
      const limited = data.slice(0, MAX_RESULT_ROWS);
      return {
        columns: field.map((f) => String((f as { name?: unknown }).name ?? '')),
        rows: limited,
        rowCount: data.length,
        truncated: data.length > limited.length,
        affectedRows: null,
        insertId: null,
        command: 'SELECT',
      };
    });
  }

  return {
    kind: 'mysql',

    async ping() {
      await poolFor(null).query('SELECT 1');
    },

    async listDatabases(): Promise<DatabaseInfo[]> {
      const [rows] = await poolFor(null).query('SHOW DATABASES');
      return (rows as unknown as unknown[][]).map((row) => {
        const name = String(row[0]);
        return { name, system: SYSTEM_DATABASES.has(name.toLowerCase()) };
      });
    },

    async listTables(db: string | null): Promise<TableInfo[]> {
      const schema = db ?? conn.database ?? '';
      if (!schema) return [];
      const [rows] = await poolFor(db).query(
        `SELECT table_name, table_type, table_rows, table_comment
           FROM information_schema.tables
          WHERE table_schema = ?
          ORDER BY table_name`,
        [schema],
      );
      return (rows as unknown as unknown[][]).map((row) => {
        const rawType = String(row[1] ?? '').toUpperCase();
        const estimated = row[2] === null || row[2] === undefined ? null : Number(row[2]);
        return {
          name: String(row[0]),
          schema: null,
          type: rawType.includes('VIEW') ? 'view' : 'table',
          estimatedRows: estimated === null || Number.isNaN(estimated) ? null : estimated,
          comment: row[3] ? String(row[3]) : null,
        } satisfies TableInfo;
      });
    },

    async listColumns(db: string | null, table: TableRef): Promise<ColumnInfo[]> {
      const schema = table.schema || db || conn.database || '';
      const [rows] = await poolFor(db).query(
        `SELECT column_name, column_type, is_nullable, column_key, column_default, extra, column_comment
           FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ?
          ORDER BY ordinal_position`,
        [schema, table.table],
      );
      return (rows as unknown as unknown[][]).map((row) => {
        const extra = row[5] ? String(row[5]) : '';
        return {
          name: String(row[0]),
          dataType: String(row[1] ?? ''),
          nullable: String(row[2]).toUpperCase() === 'YES',
          primaryKey: String(row[3] ?? '').toUpperCase() === 'PRI',
          defaultValue: row[4] === null || row[4] === undefined ? null : String(row[4]),
          autoIncrement: /auto_increment/i.test(extra),
          comment: row[6] ? String(row[6]) : null,
        } satisfies ColumnInfo;
      });
    },

    async run(db: string | null, sql: string): Promise<ResultSet[]> {
      const [rows, fields] = await poolFor(db).query(sql);
      return normalize(rows, fields);
    },

    async fetchRows(db: string | null, table: TableRef, opts: FetchRowsOptions): Promise<FetchRowsResult> {
      const target = qualify(db, table);
      const filter = opts.where && opts.where.trim() ? ` WHERE ${opts.where}` : '';
      let sql = `SELECT * FROM ${target}${filter}`;
      if (opts.orderBy) {
        sql += ` ORDER BY ${quoteMysqlIdent(opts.orderBy.column)} ${opts.orderBy.dir === 'desc' ? 'DESC' : 'ASC'}`;
      }
      sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))} OFFSET ${Math.max(0, Math.floor(opts.offset))}`;

      const pool = poolFor(db);
      const [rows, fields] = await pool.query(sql);
      const columnNames = (Array.isArray(fields) ? (fields as unknown[]) : []).map((f) =>
        String((f as { name?: unknown }).name ?? ''),
      );
      const columns = await this.listColumns(db, table);
      const byName = new Map(columns.map((c) => [c.name, c]));
      const ordered = columnNames.map(
        (name) =>
          byName.get(name) ??
          ({ name, dataType: '', nullable: true, primaryKey: false, defaultValue: null, autoIncrement: false, comment: null } satisfies ColumnInfo),
      );

      let total: number | null = null;
      if (opts.withCount) {
        const [countRows] = await pool.query(`SELECT COUNT(*) FROM ${target}${filter}`);
        total = Number((countRows as unknown as unknown[][])[0]?.[0] ?? 0);
      }

      return { columns: ordered, rows: (rows as unknown as unknown[][]) ?? [], total };
    },

    async applyChanges(db: string | null, changes: RowChange[]) {
      const pool = poolFor(db);
      const client = await pool.getConnection();
      let applied = 0;
      try {
        await client.beginTransaction();
        for (const change of changes) {
          const target = qualify(db, change.table);
          if (change.type === 'insert') {
            const entries = Object.entries(change.values ?? {});
            if (!entries.length) continue;
            const sql = `INSERT INTO ${target} (${entries.map(([c]) => quoteMysqlIdent(c)).join(', ')})
                         VALUES (${entries.map(() => '?').join(', ')})`;
            const [result] = await client.query(sql, entries.map(([, v]) => v));
            applied += Number((result as { affectedRows?: number }).affectedRows ?? 0);
            continue;
          }
          const key = Object.entries(change.key ?? {});
          if (!key.length) throw new Error('Refusing to modify a row without an identifying key');
          const where = key.map(([c]) => `${quoteMysqlIdent(c)} <=> ?`).join(' AND ');
          const keyValues = key.map(([, v]) => v);
          if (change.type === 'delete') {
            const [result] = await client.query(`DELETE FROM ${target} WHERE ${where}`, keyValues);
            applied += Number((result as { affectedRows?: number }).affectedRows ?? 0);
            continue;
          }
          const updates = Object.entries(change.values ?? {});
          if (!updates.length) continue;
          const sql = `UPDATE ${target} SET ${updates
            .map(([c]) => `${quoteMysqlIdent(c)} = ?`)
            .join(', ')} WHERE ${where}`;
          const values = [...updates.map(([, v]) => v), ...keyValues];
          const [result] = await client.query(sql, values);
          applied += Number((result as { affectedRows?: number }).affectedRows ?? 0);
        }
        await client.commit();
      } catch (error) {
        await client.rollback().catch(() => undefined);
        throw error;
      } finally {
        await client.release();
      }
      return { applied };
    },

    async dispose() {
      const all = [...pools.values()];
      pools.clear();
      await Promise.all(all.map((pool) => pool.end().catch(() => undefined)));
    },
  };
}
