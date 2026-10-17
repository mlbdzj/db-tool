export type DbKind = 'mysql' | 'postgres';

export interface ConnectionInput {
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  password?: string;
  /** default database (mysql) / database (postgres) */
  database?: string;
  ssl?: boolean;
  /** refuse unscoped UPDATE/DELETE without an explicit confirmation */
  safeMode?: boolean;
  color?: string;
}

export interface ConnectionRecord extends ConnectionInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicConnection {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  database?: string;
  ssl: boolean;
  safeMode: boolean;
  color?: string;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseInfo {
  name: string;
  system: boolean;
}

export interface TableRef {
  schema?: string | null;
  table: string;
}

export interface TableInfo {
  name: string;
  schema: string | null;
  type: 'table' | 'view' | 'materialized view';
  estimatedRows: number | null;
  comment: string | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  comment: string | null;
}

export interface ResultSet {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  affectedRows: number | null;
  insertId: string | number | null;
  command: string;
}

export interface QueryResponse {
  results: ResultSet[];
  durationMs: number;
}

export interface OrderBy {
  column: string;
  dir: 'asc' | 'desc';
}

export interface FetchRowsOptions {
  limit: number;
  offset: number;
  orderBy?: OrderBy | null;
  where?: string | null;
  withCount?: boolean;
}

export interface FetchRowsResult {
  columns: ColumnInfo[];
  rows: unknown[][];
  total: number | null;
}

export interface RowChange {
  type: 'insert' | 'update' | 'delete';
  table: TableRef;
  key?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

export interface RunOptions {
  /** Aborts the statement server-side without dropping the connection. */
  signal?: AbortSignal;
}

export interface Driver {
  readonly kind: DbKind;
  ping(): Promise<void>;
  listDatabases(): Promise<DatabaseInfo[]>;
  listTables(db: string | null): Promise<TableInfo[]>;
  listColumns(db: string | null, table: TableRef): Promise<ColumnInfo[]>;
  run(db: string | null, sql: string, options?: RunOptions): Promise<ResultSet[]>;
  fetchRows(db: string | null, table: TableRef, opts: FetchRowsOptions): Promise<FetchRowsResult>;
  applyChanges(db: string | null, changes: RowChange[]): Promise<{ applied: number }>;
  dispose(): Promise<void>;
}

/** Hard ceiling so a careless `SELECT *` cannot lock up the renderer. */
export const MAX_RESULT_ROWS = 5000;
export const MAX_EXPORT_ROWS = 500000;
