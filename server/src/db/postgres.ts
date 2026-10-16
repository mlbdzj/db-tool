import pg from 'pg';
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
import { quotePgIdent } from '../util/sql.js';

const { Pool, types } = pg;
type PgPool = InstanceType<typeof Pool>;

/**
 * A database tool should show exactly what the server holds. These parsers keep
 * high-precision numbers and temporal values as text instead of letting the
 * driver reinterpret them.
 */
const TEXT_PASSTHROUGH_OIDS = [
  20, // int8
  1700, // numeric
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1186, // interval
  1266, // timetz
];
for (const oid of TEXT_PASSTHROUGH_OIDS) {
  types.setTypeParser(oid, (value: string) => value);
}

const SYSTEM_SCHEMAS = `('pg_catalog', 'information_schema')`;

function toArrayRow(row: unknown, columns: string[]): unknown[] {
  if (Array.isArray(row)) return row;
  if (row && typeof row === 'object') {
    const record = row as Record<string, unknown>;
    return columns.map((name) => record[name]);
  }
  return [row];
}

function toColumnInfo(row: {
  column_name: string;
  udt_name: string;
  character_maximum_length: number | null;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  is_pk: boolean;
  comment: string | null;
}): ColumnInfo {
  const length = row.character_maximum_length;
  const dataType = length ? `${row.udt_name}(${length})` : row.udt_name;
  const defaultValue = row.column_default;
  return {
    name: row.column_name,
    dataType,
    nullable: row.is_nullable === 'YES',
    primaryKey: Boolean(row.is_pk),
    defaultValue,
    autoIncrement: Boolean(defaultValue && /^nextval\(/i.test(defaultValue)) || row.is_identity === 'YES',
    comment: row.comment ?? null,
  };
}

export function createPostgresDriver(conn: ConnectionRecord): Driver {
  const pools = new Map<string, PgPool>();

  function poolFor(db: string | null): PgPool {
    const key = db ?? conn.database ?? '';
    let pool = pools.get(key);
    if (!pool) {
      pool = new Pool({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password ?? '',
        database: key || 'postgres',
        max: 4,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 10000,
        ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      });
      pool.on('error', () => undefined);
      pools.set(key, pool);
    }
    return pool;
  }

  function schemaOf(table: TableRef): string {
    return table.schema || 'public';
  }

  function qualify(table: TableRef): string {
    return `${quotePgIdent(schemaOf(table))}.${quotePgIdent(table.table)}`;
  }

  async function listColumns(db: string | null, table: TableRef): Promise<ColumnInfo[]> {
    const result = await poolFor(db).query(
      `SELECT c.column_name,
              c.udt_name,
              c.character_maximum_length,
              c.is_nullable,
              c.column_default,
              c.is_identity,
              (pk.column_name IS NOT NULL) AS is_pk,
              col_description(cl.oid, c.ordinal_position) AS comment
         FROM information_schema.columns c
         JOIN pg_class cl
           ON cl.relname = c.table_name
         JOIN pg_namespace n
           ON n.oid = cl.relnamespace AND n.nspname = c.table_schema
         LEFT JOIN (
              SELECT kcu.table_schema, kcu.table_name, kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON kcu.constraint_name = tc.constraint_name
                 AND kcu.table_schema = tc.table_schema
               WHERE tc.constraint_type = 'PRIMARY KEY'
         ) pk
           ON pk.table_schema = c.table_schema
          AND pk.table_name = c.table_name
          AND pk.column_name = c.column_name
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`,
      [schemaOf(table), table.table],
    );
    return result.rows.map((row) => toColumnInfo(row));
  }

  return {
    kind: 'postgres',

    async ping() {
      await poolFor(null).query('SELECT 1');
    },

    async listDatabases(): Promise<DatabaseInfo[]> {
      const result = await poolFor(null).query(
        `SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname`,
      );
      return result.rows.map((row: { datname: string }) => ({
        name: row.datname,
        system: row.datname === 'postgres',
      }));
    },

    async listTables(db: string | null): Promise<TableInfo[]> {
      const result = await poolFor(db).query(
        `SELECT n.nspname AS schema_name,
                c.relname AS table_name,
                c.relkind AS relkind,
                c.reltuples::bigint AS estimated_rows,
                obj_description(c.oid, 'pg_class') AS comment
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
            AND n.nspname NOT LIKE 'pg_toast%'
            AND n.nspname NOT LIKE 'pg_temp%'
          ORDER BY n.nspname, c.relname`,
      );
      return result.rows.map((row: Record<string, unknown>) => {
        const relkind = String(row.relkind);
        const estimated = Number(row.estimated_rows);
        return {
          name: String(row.table_name),
          schema: String(row.schema_name),
          type: relkind === 'v' ? 'view' : relkind === 'm' ? 'materialized view' : 'table',
          estimatedRows: Number.isFinite(estimated) && estimated >= 0 ? estimated : null,
          comment: row.comment ? String(row.comment) : null,
        } satisfies TableInfo;
      });
    },

    listColumns,

    async run(db: string | null, sql: string): Promise<ResultSet[]> {
      const raw = (await poolFor(db).query({ text: sql, rowMode: 'array' })) as unknown;
      const list = Array.isArray(raw) ? (raw as unknown[]) : [raw];
      return list.map((entry) => {
        const result = entry as {
          command?: string;
          fields?: { name: string }[];
          rows?: unknown[];
          rowCount?: number | null;
        };
        const columns = (result.fields ?? []).map((f) => f.name);
        const isSelect = (result.command ?? '').toUpperCase() === 'SELECT';
        const rows = (result.rows ?? []).map((row) => toArrayRow(row, columns));
        const limited = rows.slice(0, MAX_RESULT_ROWS);
        return {
          columns,
          rows: limited,
          rowCount: isSelect ? rows.length : 0,
          truncated: isSelect && rows.length > limited.length,
          affectedRows: isSelect ? null : Number(result.rowCount ?? 0),
          insertId: null,
          command: result.command ?? 'OK',
        } satisfies ResultSet;
      });
    },

    async fetchRows(db: string | null, table: TableRef, opts: FetchRowsOptions): Promise<FetchRowsResult> {
      const target = qualify(table);
      const filter = opts.where && opts.where.trim() ? ` WHERE ${opts.where}` : '';
      let sql = `SELECT * FROM ${target}${filter}`;
      if (opts.orderBy) {
        sql += ` ORDER BY ${quotePgIdent(opts.orderBy.column)} ${opts.orderBy.dir === 'desc' ? 'DESC' : 'ASC'}`;
      }
      sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))} OFFSET ${Math.max(0, Math.floor(opts.offset))}`;

      const pool = poolFor(db);
      const raw = (await pool.query({ text: sql, rowMode: 'array' })) as unknown;
      const result = (Array.isArray(raw) ? raw[raw.length - 1] : raw) as {
        fields?: { name: string }[];
        rows?: unknown[];
      };
      const columnNames = (result.fields ?? []).map((f) => f.name);
      const rows = (result.rows ?? []).map((row) => toArrayRow(row, columnNames));
      const described = await listColumns(db, table);
      const byName = new Map(described.map((c) => [c.name, c]));
      const columns = columnNames.map(
        (name) =>
          byName.get(name) ??
          ({ name, dataType: '', nullable: true, primaryKey: false, defaultValue: null, autoIncrement: false, comment: null } satisfies ColumnInfo),
      );

      let total: number | null = null;
      if (opts.withCount) {
        const countResult = await pool.query(`SELECT COUNT(*) AS c FROM ${target}${filter}`);
        total = Number(countResult.rows[0]?.c ?? 0);
      }
      return { columns, rows, total };
    },

    async applyChanges(db: string | null, changes: RowChange[]) {
      const client = await poolFor(db).connect();
      let applied = 0;
      try {
        await client.query('BEGIN');
        for (const change of changes) {
          const target = qualify(change.table);
          if (change.type === 'insert') {
            const entries = Object.entries(change.values ?? {});
            if (!entries.length) continue;
            const sql = `INSERT INTO ${target} (${entries.map(([c]) => quotePgIdent(c)).join(', ')})
                         VALUES (${entries.map((_, i) => `$${i + 1}`).join(', ')})`;
            const result = await client.query(sql, entries.map(([, v]) => v ?? null));
            applied += result.rowCount ?? 0;
            continue;
          }
          const key = Object.entries(change.key ?? {});
          if (!key.length) throw new Error('Refusing to modify a row without an identifying key');
          const where = key
            .map(([c], i) => `${quotePgIdent(c)} IS NOT DISTINCT FROM $${i + 1}`)
            .join(' AND ');
          const keyValues = key.map(([, v]) => v ?? null);
          if (change.type === 'delete') {
            const result = await client.query(`DELETE FROM ${target} WHERE ${where}`, keyValues);
            applied += result.rowCount ?? 0;
            continue;
          }
          const updates = Object.entries(change.values ?? {});
          if (!updates.length) continue;
          const setClause = updates.map(([c], i) => `${quotePgIdent(c)} = $${i + 1}`).join(', ');
          const whereClause = key
            .map(([c], i) => `${quotePgIdent(c)} IS NOT DISTINCT FROM $${updates.length + i + 1}`)
            .join(' AND ');
          const result = await client.query(
            `UPDATE ${target} SET ${setClause} WHERE ${whereClause}`,
            [...updates.map(([, v]) => v ?? null), ...keyValues],
          );
          applied += result.rowCount ?? 0;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
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
