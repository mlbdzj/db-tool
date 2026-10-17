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

const LAST_CONNECTION_KEY = 'db-tool-last-connection';
/** The selected database is remembered per connection: names rarely overlap. */
const dbMemoryKey = (connectionId: string) => `db-tool-last-db:${connectionId}`;

function readLastConnectionId(): string | null {
  try {
    return localStorage.getItem(LAST_CONNECTION_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [activeDb, setActiveDb] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{ connection: Connection | null } | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const tabsRef = useRef<TabState[]>([]);
  tabsRef.current = tabs;
  const dirtyIdsRef = useRef<Set<string>>(new Set());
  dirtyIdsRef.current = dirtyIds;

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

  /** Table tabs report their uncommitted edits here so tab close can be guarded. */
  const setTabDirty = useCallback((tabId: string, dirty: boolean) => {
    setDirtyIds((current) => {
      if (current.has(tabId) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);

  useEffect(() => {
    window.dbToolShell?.setDirtyState?.(dirtyIds.size > 0);
    // In the desktop shell the main process owns the close prompt. Registering
    // beforeunload there would cancel the close silently instead of prompting.
    if (window.dbToolShell || dirtyIds.size === 0) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirtyIds]);

  useEffect(() => {
    api
      .listConnections()
      .then((result) => {
        setConnections(result.connections);
        setConnectionsLoaded(true);
        const stored = readLastConnectionId();
        if (stored && result.connections.some((entry) => entry.id === stored)) {
          setActiveConnectionId(stored);
        }
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), 'error'));
  }, [notify]);

  useEffect(() => {
    if (!activeConnectionId) return;
    try {
      localStorage.setItem(LAST_CONNECTION_KEY, activeConnectionId);
    } catch {
      /* storage may be unavailable */
    }
  }, [activeConnectionId]);

  /** Remember a database only after it is known to belong to the active connection. */
  const selectDatabase = useCallback(
    (db: string) => {
      setActiveDb(db);
      if (!activeConnectionId) return;
      try {
        localStorage.setItem(dbMemoryKey(activeConnectionId), db);
      } catch {
        /* storage may be unavailable */
      }
    },
    [activeConnectionId],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId]);

  /** The status bar describes what is in front of the user, not the connection list. */
  const activeStatus = useMemo(() => {
    if (!activeTab) return '就绪';
    if (activeTab.kind === 'table') {
      return dirtyIds.has(activeTab.id) ? `${activeTab.title} · 有未提交改动` : `${activeTab.title} · 已同步`;
    }
    if (activeTab.running) return '查询执行中';
    if (activeTab.error) {
      return `上次执行失败${activeTab.errorLine ? ` · 第 ${activeTab.errorLine} 行` : ''}`;
    }
    if (activeTab.results) {
      const rows = activeTab.results.reduce((sum, entry) => sum + entry.rowCount, 0);
      const affected = activeTab.results.reduce((sum, entry) => sum + (entry.affectedRows ?? 0), 0);
      return rows > 0 ? `返回 ${formatNumber(rows)} 行` : `影响 ${formatNumber(affected)} 行`;
    }
    return '未执行';
  }, [activeTab, dirtyIds]);

  const loadDatabases = useCallback(
    async (connection: Connection) => {
      try {
        const result = await api.listDatabases(connection.id);
        setDatabases(result.databases);
        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem(dbMemoryKey(connection.id));
        } catch {
          remembered = null;
        }
        const exists = (name: string | null | undefined) =>
          Boolean(name) && result.databases.some((database) => database.name === name);
        // Prefer this connection's remembered database, then its configured
        // default, then the first non-system database.
        const chosen =
          [remembered, connection.database].find(exists) ??
          result.databases.find((database) => !database.system)?.name ??
          result.databases[0]?.name ??
          null;
        setActiveDb(chosen);
        if (chosen) {
          try {
            localStorage.setItem(dbMemoryKey(connection.id), chosen);
          } catch {
            /* storage may be unavailable */
          }
        }
      } catch (error) {
        setDatabases([]);
        setActiveDb(null);
        notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
    [notify],
  );

  useEffect(() => {
    // Drop the previous connection's database first: leaving it in place sends
    // requests for a database that may not exist on the server we just switched
    // to, which surfaces as a confusing "database does not exist" error.
    setActiveDb(null);
    setDatabases([]);
    setTables([]);
    if (activeConnection) void loadDatabases(activeConnection);
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
          errorKind: null,
          errorLine: null,
          errorColumn: null,
          durationMs: null,
          running: false,
          activeResult: 0,
          insertText: null,
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

  /** Double-clicking a table in the sidebar drops its (quoted) name at the caret. */
  const insertTableName = useCallback(
    (table: TableInfo) => {
      if (!activeConnection) return;
      const quoted =
        activeConnection.kind === 'postgres'
          ? `"${table.name.replace(/"/g, '""')}"`
          : `\`${table.name.replace(/`/g, '``')}\``;
      const text = `${quoted} `;
      const active = tabs.find((tab) => tab.id === activeTabId && tab.kind === 'sql');
      const target =
        active ??
        [...tabs].reverse().find((tab) => tab.kind === 'sql' && tab.connectionId === activeConnection.id);
      if (target && target.kind === 'sql') {
        setActiveTabId(target.id);
        patchTab(target.id, { insertText: { text, nonce: Date.now() } });
        return;
      }
      openQueryTab(activeConnection, activeDb, text);
    },
    [activeConnection, activeDb, activeTabId, tabs, patchTab, openQueryTab],
  );

  const closeTab = useCallback((id: string) => {
    if (dirtyIdsRef.current.has(id)) {
      const confirmed = window.confirm('这个标签页里还有未提交的改动，关闭后这些改动会丢失。确定关闭？');
      if (!confirmed) return;
    }
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.id === id);
    const next = current.filter((tab) => tab.id !== id);
    setTabs(next);
    setDirtyIds((dirty) => {
      if (!dirty.has(id)) return dirty;
      const updated = new Set(dirty);
      updated.delete(id);
      return updated;
    });
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
        onSelectDb={selectDatabase}
        tables={tables}
        tablesLoading={tablesLoading}
        onOpenTable={(table) => activeConnection && openTableTab(activeConnection, activeDb, table)}
        onInsertTable={insertTableName}
        onOpenQuery={() => activeConnection && openQueryTab(activeConnection, activeDb)}
        onRefresh={() => {
          if (activeConnection) void loadDatabases(activeConnection);
          void loadTables();
        }}
        showSystem={showSystem}
        onToggleSystem={setShowSystem}
        activeTableKey={activeTableKey}
        theme={theme}
        onToggleTheme={() =>
          setTheme((current) => {
            const next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem('db-tool-theme', next);
            return next;
          })
        }
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
              {tab.kind === 'sql' && tab.running && <span className="tab__dot tab__dot--running" title="正在执行" />}
              {tab.kind === 'table' && dirtyIds.has(tab.id) && (
                <span className="tab__dot tab__dot--dirty" title="有未提交的改动" />
              )}
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

        {connectionsLoaded && !activeConnection && (
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
                onDirtyChange={(dirty) => setTabDirty(tab.id, dirty)}
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
              <span className="statusbar__sep">·</span>
              <span>{activeStatus}</span>
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
