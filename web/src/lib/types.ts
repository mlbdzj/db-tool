export type DbKind = 'mysql' | 'postgres';

export interface Connection {
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

export interface ConnectionDraft {
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  password?: string | null;
  database?: string;
  ssl?: boolean;
  safeMode?: boolean;
}

export interface DatabaseInfo {
  name: string;
  system: boolean;
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

export interface FetchRowsResult {
  columns: ColumnInfo[];
  rows: unknown[][];
  total: number | null;
}

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

export interface RowChange {
  type: 'insert' | 'update' | 'delete';
  table: { schema?: string | null; table: string };
  key?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

export interface TestResult {
  ok: boolean;
  version: string | null;
  databaseCount: number;
}

declare global {
  interface Window {
    /** Injected by the Electron preload script; absent when running in a browser. */
    dbToolShell?: {
      setDirtyState?: (dirty: boolean) => void;
    };
  }
}
