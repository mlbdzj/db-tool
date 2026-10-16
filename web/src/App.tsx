import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './lib/api';
import { formatNumber } from './lib/format';
import type { Connection, DatabaseInfo, TableInfo } from './lib/types';
import { ConnectionDialog } from './components/ConnectionDialog';
import { HistoryDialog } from './components/HistoryDialog';
import { QueryTab, type SqlTabState } from './components/QueryTab';
import { Sidebar } from './components/Sidebar';
import { TableTab, type TableTabState } from './components/TableTab';

type TabState = SqlTabState | TableTabState;

interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}

let tabSequence = 0;
function nextTabId(prefix: string): string {
  tabSequence += 1;
  return `${prefix}-${tabSequence}`;
}

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [activeDb, setActiveDb] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ connection: Connection | null } | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const tabsRef = useRef<TabState[]>([]);
  tabsRef.current = tabs;

  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === activeConnectionId) ?? null,
    [connections, activeConnectionId],
  );

  const notify = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((current) => [...current, { id, text, kind }].slice(-4));
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);

  useEffect(() => {
    api
      .listConnections()
      .then((result) => setConnections(result.connections))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error'));
  }, [notify]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('db-tool-theme', theme);
  }, [theme]);

  const loadDatabases = useCallback(
    async (connection: Connection) => {
      try {
        const result = await api.listDatabases(connection.id);
        setDatabases(result.databases);
        setActiveDb((current) => {
          if (current && result.databases.some((database) => database.name === current)) return current;
          if (connection.database && result.databases.some((database) => database.name === connection.database)) {
            return connection.database;
          }
          return result.databases.find((database) => !database.system)?.name ?? result.databases[0]?.name ?? null;
        });
      } catch (error) {
        setDatabases([]);
        setActiveDb(null);
        notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
    [notify],
  );

  useEffect(() => {
    if (activeConnection) void loadDatabases(activeConnection);
    else {
      setDatabases([]);
      setActiveDb(null);
    }
  }, [activeConnection, loadDatabases]);

  const loadTables = useCallback(async () => {
    if (!activeConnection || !activeDb) {
      setTables([]);
      return;
    }
    setTablesLoading(true);
    try {
      const result = await api.listTables(activeConnection.id, activeDb);
      setTables(result.tables);
    } catch (error) {
      setTables([]);
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setTablesLoading(false);
    }
  }, [activeConnection, activeDb, notify]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  const openQueryTab = useCallback(
    (connection: Connection, db: string | null, sql = '') => {
      const existing = tabs.find((tab) => tab.kind === 'sql' && tab.connectionId === connection.id && tab.db === db);
      if (existing && sql === '') {
        setActiveTabId(existing.id);
        return;
      }
      const id = nextTabId('sql');
      setTabs((current) => [
        ...current,
        {
          id,
          kind: 'sql',
          connectionId: connection.id,
          db,
          sql,
          results: null,
          error: null,
          durationMs: null,
          running: false,
          activeResult: 0,
        },
      ]);
      setActiveTabId(id);
    },
    [tabs],
  );

  const openTableTab = useCallback(
    (connection: Connection, db: string | null, table: TableInfo) => {
      const existing = tabs.find(
        (tab) =>
          tab.kind === 'table' &&
          tab.connectionId === connection.id &&
          tab.db === db &&
          tab.table.table === table.name &&
          (tab.table.schema ?? null) === (table.schema ?? null),
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const id = nextTabId('table');
      setTabs((current) => [
        ...current,
        {
          id,
          kind: 'table',
          connectionId: connection.id,
          db,
          table: { schema: table.schema, table: table.name },
          title: table.name,
        },
      ]);
      setActiveTabId(id);
    },
    [tabs],
  );

  const patchTab = useCallback((id: string, patch: Partial<SqlTabState>) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id && tab.kind === 'sql' ? ({ ...tab, ...patch } as TabState) : tab)),
    );
  }, []);

  const closeTab = useCallback((id: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.id === id);
    const next = current.filter((tab) => tab.id !== id);
    setTabs(next);
    setActiveTabId((active) => (active === id ? (next[index]?.id ?? next[index - 1]?.id ?? null) : active));
  }, []);

  const activeTableKey = useMemo(() => {
    const tab = tabs.find((entry) => entry.id === activeTabId);
    if (!tab || tab.kind !== 'table') return null;
    return `${tab.table.schema ?? ''}.${tab.table.table}`;
  }, [tabs, activeTabId]);

  const connectionTabs = useMemo(
    () => tabs.filter((tab) => tab.connectionId === activeConnectionId),
    [tabs, activeConnectionId],
  );

  return (
    <div className="app">
      <Sidebar
        connections={connections}
        activeConnection={activeConnection}
        onSelectConnection={(connection) => {
          setActiveConnectionId(connection.id);
          setActiveTabId(null);
        }}
        onNewConnection={() => setDialog({ connection: null })}
        onEditConnection={(connection) => setDialog({ connection })}
        databases={databases}
        activeDb={activeDb}
        onSelectDb={setActiveDb}
        tables={tables}
        tablesLoading={tablesLoading}
        onOpenTable={(table) => activeConnection && openTableTab(activeConnection, activeDb, table)}
        onOpenQuery={() => activeConnection && openQueryTab(activeConnection, activeDb)}
        onRefresh={() => {
          if (activeConnection) void loadDatabases(activeConnection);
          void loadTables();
        }}
        showSystem={showSystem}
        onToggleSystem={setShowSystem}
        activeTableKey={activeTableKey}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
      />

      <main className="main">
        <div className="tabbar">
          {connectionTabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={tab.id === activeTabId ? 'tab tab--active' : 'tab'}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="tab__label">
                {tab.kind === 'sql' ? `SQL · ${tab.db ?? '默认库'}` : `▤ ${tab.title}`}
              </span>
              {tab.kind === 'sql' && tab.running && <span className="tab__dot" />}
              <span
                className="tab__close"
                role="button"
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ✕
              </span>
            </button>
          ))}
        </div>

        {!activeConnection && (
          <div className="placeholder">
            <h2>先连接一个数据库</h2>
            <div>
              左侧选择一个连接，或者点 ＋ 新建。支持 MySQL 与 PostgreSQL，
              可以管理多套数据库、写 SQL、直接编辑表数据、导出结果。
            </div>
            <div style={{ marginTop: 14 }}>
              <button type="button" className="btn btn--primary" onClick={() => setDialog({ connection: null })}>
                新建连接
              </button>
            </div>
          </div>
        )}

        {activeConnection && connectionTabs.length === 0 && (
          <div className="placeholder">
            <h2>{activeConnection.name}</h2>
            <div>
              {activeDb
                ? `当前数据库：${activeDb}。从左侧点开一张表，或者新建一个 SQL 查询。`
                : '从左侧选择一个数据库开始。'}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => openQueryTab(activeConnection, activeDb)}
              >
                新建 SQL 查询
              </button>
              <button type="button" className="btn" onClick={() => void loadTables()}>
                刷新表列表
              </button>
            </div>
          </div>
        )}

        {activeConnection &&
          tabs.map((tab) => {
            if (tab.connectionId !== activeConnection.id) return null;
            const visible = tab.id === activeTabId;
            return tab.kind === 'sql' ? (
              <QueryTab
                key={tab.id}
                connection={activeConnection}
                databases={databases}
                tab={tab}
                visible={visible}
                onPatch={(patch) => patchTab(tab.id, patch)}
                onNotify={notify}
                onOpenHistory={() => setHistoryFor(activeConnection.id)}
              />
            ) : (
              <TableTab
                key={tab.id}
                connection={activeConnection}
                tab={tab}
                visible={visible}
                onNotify={notify}
              />
            );
          })}

        <div className="statusbar">
          {activeConnection ? (
            <>
              <span>{activeConnection.name}</span>
              <span>
                {activeConnection.kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} {activeConnection.host}:
                {activeConnection.port}
              </span>
              <span>{activeDb ? `库 ${activeDb}` : '未选择数据库'}</span>
              <span>{formatNumber(tables.length)} 张表</span>
              <span className="spacer" />
              <span>{activeConnection.safeMode ? '安全模式已开启' : '安全模式关闭'}</span>
            </>
          ) : (
            <span>未连接</span>
          )}
        </div>
      </main>

      {dialog && (
        <ConnectionDialog
          connection={dialog.connection}
          onClose={() => setDialog(null)}
          onNotify={notify}
          onSaved={(connection, isNew) => {
            setConnections((current) =>
              isNew ? [...current, connection] : current.map((entry) => (entry.id === connection.id ? connection : entry)),
            );
            if (isNew) setActiveConnectionId(connection.id);
            else if (connection.id === activeConnectionId) void loadDatabases(connection);
          }}
          onDeleted={(id) => {
            setConnections((current) => current.filter((entry) => entry.id !== id));
            setTabs((current) => current.filter((tab) => tab.connectionId !== id));
            if (activeConnectionId === id) setActiveConnectionId(null);
          }}
        />
      )}

      {historyFor && (
        <HistoryDialog
          connectionId={historyFor}
          onClose={() => setHistoryFor(null)}
          onPick={(entry) => {
            const connection = connections.find((candidate) => candidate.id === entry.connectionId);
            if (connection) openQueryTab(connection, entry.database, entry.sql);
          }}
        />
      )}

      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={toast.kind === 'error' ? 'toast toast--error' : 'toast toast--ok'}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
