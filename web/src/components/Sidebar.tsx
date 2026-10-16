import { useMemo, useState } from 'react';
import { formatNumber } from '../lib/format';
import type { Connection, DatabaseInfo, TableInfo } from '../lib/types';

interface Props {
  connections: Connection[];
  activeConnection: Connection | null;
  onSelectConnection: (connection: Connection) => void;
  onNewConnection: () => void;
  onEditConnection: (connection: Connection) => void;
  databases: DatabaseInfo[];
  activeDb: string | null;
  onSelectDb: (db: string) => void;
  tables: TableInfo[];
  tablesLoading: boolean;
  onOpenTable: (table: TableInfo) => void;
  onOpenQuery: () => void;
  onRefresh: () => void;
  showSystem: boolean;
  onToggleSystem: (value: boolean) => void;
  activeTableKey: string | null;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

function tableKey(table: TableInfo): string {
  return `${table.schema ?? ''}.${table.name}`;
}

export function Sidebar({
  connections,
  activeConnection,
  onSelectConnection,
  onNewConnection,
  onEditConnection,
  databases,
  activeDb,
  onSelectDb,
  tables,
  tablesLoading,
  onOpenTable,
  onOpenQuery,
  onRefresh,
  showSystem,
  onToggleSystem,
  activeTableKey,
  theme,
  onToggleTheme,
}: Props) {
  const [filter, setFilter] = useState('');

  const visibleDatabases = useMemo(
    () => databases.filter((database) => showSystem || !database.system),
    [databases, showSystem],
  );

  const grouped = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    const matched = keyword ? tables.filter((table) => table.name.toLowerCase().includes(keyword)) : tables;
    const groups = new Map<string, TableInfo[]>();
    for (const table of matched) {
      const key = table.schema ?? '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(table);
      else groups.set(key, [table]);
    }
    return [...groups.entries()];
  }, [tables, filter]);

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <div className="brand">
          <span className="brand__dot" />
          DB Tool
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="btn btn--ghost" title="切换主题" onClick={onToggleTheme}>
            {theme === 'dark' ? '☾' : '☀'}
          </button>
          <button type="button" className="btn btn--ghost" title="新建连接" onClick={onNewConnection}>
            ＋
          </button>
        </div>
      </div>

      <div className="sidebar__section">连接</div>
      <div className="sidebar__scroll">
        {connections.length === 0 && (
          <div className="panel-message" style={{ margin: '4px 12px' }}>
            还没有连接，点右上角 ＋ 添加一个数据库。
          </div>
        )}
        {connections.map((connection) => (
          <div
            key={connection.id}
            className={connection.id === activeConnection?.id ? 'conn conn--active' : 'conn'}
            onClick={() => onSelectConnection(connection)}
            onDoubleClick={() => onEditConnection(connection)}
            title="单击选中，双击编辑"
          >
            <span className={`swatch ${connection.kind === 'postgres' ? 'swatch--pg' : 'swatch--my'}`} />
            <span className="conn__main">
              <span className="conn__name">{connection.name}</span>
              <span className="conn__meta">
                {connection.kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} · {connection.host}:{connection.port}
              </span>
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              title="编辑连接"
              onClick={(event) => {
                event.stopPropagation();
                onEditConnection(connection);
              }}
            >
              ⚙
            </button>
          </div>
        ))}

        {activeConnection && (
          <>
            <div className="sidebar__section" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>数据库</span>
              <span className="spacer" />
              <button type="button" className="btn btn--ghost" title="刷新" onClick={onRefresh}>
                ⟳
              </button>
            </div>
            <div style={{ padding: '0 12px 6px' }}>
              <label className="checkline" style={{ fontSize: 11.5 }}>
                <input type="checkbox" checked={showSystem} onChange={(event) => onToggleSystem(event.target.checked)} />
                显示系统库
              </label>
            </div>
            {visibleDatabases.map((database) => (
              <button
                type="button"
                key={database.name}
                className={database.name === activeDb ? 'tree__row tree__row--active' : 'tree__row'}
                onClick={() => onSelectDb(database.name)}
              >
                <span className="tree__label">{database.name}</span>
              </button>
            ))}

            {activeDb && (
              <>
                <div className="sidebar__section">表与视图</div>
                <div style={{ padding: '0 12px 8px' }}>
                  <input
                    className="input"
                    style={{ width: '100%' }}
                    placeholder="筛选表名…"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </div>
                <div style={{ padding: '0 10px 8px' }}>
                  <button type="button" className="btn btn--primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onOpenQuery}>
                    新建 SQL 查询
                  </button>
                </div>
                {tablesLoading && <div className="panel-message" style={{ margin: '4px 12px' }}>加载中…</div>}
                {!tablesLoading && tables.length === 0 && (
                  <div className="panel-message" style={{ margin: '4px 12px' }}>
                    这个库里还没有表。
                  </div>
                )}
                {grouped.map(([schema, list]) => (
                  <div key={schema || 'default'}>
                    {schema && <div className="sidebar__section">{schema}</div>}
                    {list.map((table) => (
                      <button
                        type="button"
                        key={tableKey(table)}
                        className={
                          tableKey(table) === activeTableKey ? 'tree__row tree__row--active' : 'tree__row'
                        }
                        onClick={() => onOpenTable(table)}
                        title={table.comment ?? table.name}
                      >
                        <span className="tree__label">
                          {table.type === 'table' ? '▤' : '◫'} {table.name}
                        </span>
                        {table.estimatedRows !== null && (
                          <span className="tree__hint">≈{formatNumber(table.estimatedRows)}</span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
