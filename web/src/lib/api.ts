import type {
  ColumnInfo,
  Connection,
  ConnectionDraft,
  DatabaseInfo,
  FetchRowsResult,
  HistoryEntry,
  QueryResponse,
  RowChange,
  TableInfo,
  TestResult,
} from './types';

const tokenFromUrl = new URLSearchParams(window.location.search).get('token') ?? '';
export const authToken = tokenFromUrl || localStorage.getItem('db-tool-token') || '';
if (tokenFromUrl) localStorage.setItem('db-tool-token', tokenFromUrl);

export class ApiError extends Error {
  status: number;
  code: string | null;
  detail: string | null;
  hint: string | null;
  position: number | null;
  statements?: string[];
  kind: 'unscoped_write' | 'generic';

  constructor(status: number, payload: Record<string, unknown>) {
    super(String(payload.message ?? payload.error ?? '请求失败'));
    this.status = status;
    this.code = typeof payload.code === 'string' ? payload.code : null;
    this.kind = payload.error === 'unscoped_write' ? 'unscoped_write' : 'generic';
    this.detail = typeof payload.detail === 'string' ? payload.detail : null;
    this.hint = typeof payload.hint === 'string' ? payload.hint : null;
    this.position = typeof payload.position === 'number' ? payload.position : null;
    this.statements = Array.isArray(payload.statements) ? (payload.statements as string[]) : undefined;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authToken ? { 'x-db-tool-token': authToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}

export const api = {
  listConnections: () => request<{ connections: Connection[] }>('GET', '/connections'),
  createConnection: (draft: ConnectionDraft) =>
    request<{ connection: Connection }>('POST', '/connections', draft),
  updateConnection: (id: string, draft: Partial<ConnectionDraft>) =>
    request<{ connection: Connection }>('PUT', `/connections/${id}`, draft),
  deleteConnection: (id: string) => request<{ removed: boolean }>('DELETE', `/connections/${id}`),
  testConnection: (draft: Partial<ConnectionDraft> & { id?: string }) =>
    request<TestResult>('POST', '/connections/test', draft),
  listDatabases: (id: string) => request<{ databases: DatabaseInfo[] }>('GET', `/connections/${id}/databases`),
  listTables: (id: string, db: string) =>
    request<{ tables: TableInfo[] }>('GET', `/connections/${id}/tables?db=${encodeURIComponent(db)}`),
  listColumns: (id: string, db: string | null, table: string, schema?: string | null) =>
    request<{ columns: ColumnInfo[] }>(
      'GET',
      `/connections/${id}/columns?db=${encodeURIComponent(db ?? '')}&table=${encodeURIComponent(table)}` +
        (schema ? `&schema=${encodeURIComponent(schema)}` : ''),
    ),
  schemaMap: (id: string, db: string | null) =>
    request<{ schema: Record<string, string[]> }>(
      'GET',
      `/connections/${id}/schema?db=${encodeURIComponent(db ?? '')}`,
    ),
  query: (id: string, db: string | null, sql: string, confirmUnsafe = false, queryId?: string) =>
    request<QueryResponse>('POST', `/connections/${id}/query`, { db, sql, confirmUnsafe, queryId }),
  cancelQuery: (id: string, queryId: string) =>
    request<{ cancelled: boolean }>('POST', `/connections/${id}/query/cancel`, { queryId }),
  fetchRows: (
    id: string,
    payload: {
      db: string | null;
      table: { schema?: string | null; table: string };
      limit: number;
      offset: number;
      orderBy?: { column: string; dir: 'asc' | 'desc' } | null;
      where?: string | null;
      withCount?: boolean;
    },
  ) => request<FetchRowsResult>('POST', `/connections/${id}/rows/fetch`, payload),
  applyChanges: (id: string, db: string | null, changes: RowChange[]) =>
    request<{ applied: number }>('POST', `/connections/${id}/rows/apply`, { db, changes }),
  history: (id: string) => request<{ entries: HistoryEntry[] }>('GET', `/connections/${id}/history`),
  clearHistory: (id: string) => request<{ ok: boolean }>('DELETE', `/connections/${id}/history`),
};

/** Triggers a browser download for an export endpoint that streams a file. */
export async function downloadExport(connectionId: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`/api/connections/${connectionId}/export`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { 'x-db-tool-token': authToken } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || '导出失败');
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const plain = /filename="([^"]+)"/.exec(disposition);
  const filename = encoded ? decodeURIComponent(encoded[1]!) : plain ? plain[1]! : 'export.csv';

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
