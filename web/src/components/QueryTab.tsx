import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { MySQL, PostgreSQL, sql as sqlLang } from '@codemirror/lang-sql';
import { ApiError, api } from '../lib/api';
import { downloadText, formatDuration, formatNumber, toCsv, toJson } from '../lib/format';
import { statementAt } from '../lib/sql';
import type { Connection, DatabaseInfo, ResultSet } from '../lib/types';
import { Grid } from './Grid';

export interface SqlTabState {
  id: string;
  kind: 'sql';
  connectionId: string;
  db: string | null;
  sql: string;
  results: ResultSet[] | null;
  error: string | null;
  errorKind: 'error' | 'cancelled' | null;
  errorLine: number | null;
  errorColumn: number | null;
  durationMs: number | null;
  running: boolean;
  activeResult: number;
  /** Set by the sidebar to drop a table name into the editor at the caret. */
  insertText: { text: string; nonce: number } | null;
}

interface Props {
  connection: Connection;
  databases: DatabaseInfo[];
  tab: SqlTabState;
  visible: boolean;
  onPatch: (patch: Partial<SqlTabState>) => void;
  onNotify: (text: string, kind?: 'ok' | 'error') => void;
  onOpenHistory: () => void;
}

export function QueryTab({ connection, databases, tab, visible, onPatch, onNotify, onOpenHistory }: Props) {
  const [editorHeight, setEditorHeight] = useState(220);
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const queryIdRef = useRef<string | null>(null);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]> | null>(null);

  /** Jump to the line the driver blamed, so the caret lands on the problem. */
  useEffect(() => {
    if (!tab.errorLine) return;
    const view = editorRef.current?.view;
    if (!view) return;
    const lineNumber = Math.min(Math.max(1, tab.errorLine), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
    view.focus();
  }, [tab.errorLine, tab.error]);

  useEffect(() => {
    let cancelled = false;
    setSchemaMap(null);
    api
      .schemaMap(connection.id, tab.db)
      .then((result) => {
        if (!cancelled) setSchemaMap(result.schema);
      })
      .catch(() => {
        if (!cancelled) setSchemaMap({});
      });
    return () => {
      cancelled = true;
    };
  }, [connection.id, tab.db]);

  useEffect(() => {
    const payload = tab.insertText;
    if (!payload) return;
    const view = editorRef.current?.view;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: payload.text },
      selection: { anchor: from + payload.text.length },
    });
    view.focus();
  }, [tab.insertText]);

  const extensions = useMemo(
    () => [
      sqlLang({
        dialect: connection.kind === 'postgres' ? PostgreSQL : MySQL,
        ...(schemaMap ? { schema: schemaMap } : {}),
      }),
    ],
    [connection.kind, schemaMap],
  );

  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const result = tab.results?.[tab.activeResult] ?? null;

  async function run(confirmUnsafe = false, wholeScript = false) {
    if (tab.running) return;
    const view = editorRef.current?.view;
    const selection = view?.state.selection.main;
    let source = '';
    let offset = 0;

    if (wholeScript || !view || !selection) {
      source = tab.sql;
    } else if (!selection.empty) {
      source = view.state.sliceDoc(selection.from, selection.to);
      offset = selection.from;
    } else {
      const segment = statementAt(tab.sql, selection.head);
      source = segment?.text ?? tab.sql;
      offset = segment?.from ?? 0;
    }

    const statement = source.trim();
    if (!statement) {
      onNotify('光标所在位置没有可执行的 SQL', 'error');
      return;
    }
    // Trimming dropped leading whitespace; keep the offset aligned so the
    // reported error line still points at the real line in the editor.
    offset += source.length - source.trimStart().length;
    const queryId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    queryIdRef.current = queryId;
    onPatch({ running: true, error: null, errorKind: null, errorLine: null, errorColumn: null });
    try {
      const response = await api.query(connection.id, tab.db, statement, confirmUnsafe, queryId);
      onPatch({
        results: response.results,
        durationMs: response.durationMs,
        error: null,
        errorKind: null,
        running: false,
        activeResult: 0,
      });
      const rows = response.results.reduce((sum, entry) => sum + entry.rowCount, 0);
      const affected = response.results.reduce((sum, entry) => sum + (entry.affectedRows ?? 0), 0);
      onNotify(
        response.results.length > 1
          ? `执行完成 · ${response.results.length} 个结果集 · ${formatDuration(response.durationMs)}`
          : rows > 0
            ? `返回 ${formatNumber(rows)} 行 · ${formatDuration(response.durationMs)}`
            : `影响 ${formatNumber(affected)} 行 · ${formatDuration(response.durationMs)}`,
        'ok',
      );
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'unscoped_write') {
        const preview = (error.statements ?? []).map((statement) => statement.trim().slice(0, 160)).join('\n\n');
        const confirmed = window.confirm(
          `安全模式拦截：以下语句没有 WHERE 条件，会修改整张表。\n\n${preview}\n\n确认执行？`,
        );
        if (confirmed) {
          await run(true);
          return;
        }
        onPatch({ running: false });
        return;
      }
      if (error instanceof ApiError && error.code === 'QUERY_CANCELLED') {
        onPatch({
          running: false,
          results: null,
          error: '查询已取消',
          errorKind: 'cancelled',
          errorLine: null,
          errorColumn: null,
        });
        onNotify('已取消执行', 'error');
        return;
      }
      const location =
        error instanceof ApiError && error.position ? positionOf(tab.sql, offset + error.position) : null;
      onPatch({
        running: false,
        results: null,
        error: error instanceof Error ? error.message : String(error),
        errorKind: 'error',
        errorLine: location?.line ?? null,
        errorColumn: location?.column ?? null,
      });
    } finally {
      if (queryIdRef.current === queryId) queryIdRef.current = null;
    }
  }

  async function stop() {
    const queryId = queryIdRef.current;
    if (!queryId) return;
    try {
      await api.cancelQuery(connection.id, queryId);
    } catch {
      /* the statement may already have finished */
    }
  }

  function startResize(event: React.MouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = editorHeight;
    const move = (moveEvent: MouseEvent) => {
      setEditorHeight(Math.min(Math.max(90, startHeight + moveEvent.clientY - startY), window.innerHeight - 260));
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }

  return (
    <div className="workspace" style={visible ? undefined : { display: 'none' }}>
      <div className="toolbar">
        <select
          className="select"
          value={tab.db ?? ''}
          onChange={(event) => onPatch({ db: event.target.value || null })}
        >
          <option value="">（默认数据库）</option>
          {databases
            .filter((database) => !database.system)
            .map((database) => (
              <option key={database.name} value={database.name}>
                {database.name}
              </option>
            ))}
        </select>
        <button
          type="button"
          className={tab.running ? 'btn btn--danger' : 'btn btn--primary'}
          onClick={() => void (tab.running ? stop() : run())}
          title="执行选中内容；没有选中时执行光标所在语句"
        >
          {tab.running ? '■ 停止' : '▶ 运行'}
        </button>
        <button type="button" className="btn" onClick={() => void run(false, true)} disabled={tab.running}>
          全部执行
        </button>
        <span className="badge">Ctrl / ⌘ + Enter</span>
        {connection.safeMode && <span className="badge badge--ok">安全模式</span>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => onPatch({ sql: '' })}>
          清空
        </button>
        <button type="button" className="btn" onClick={onOpenHistory}>
          历史
        </button>
      </div>

      <div className="editor" style={{ height: editorHeight }}>
        <div
          style={{ height: '100%' }}
          onKeyDownCapture={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              void run();
            }
          }}
        >
          <CodeMirror
            ref={editorRef}
            value={tab.sql}
            height="100%"
            theme={theme}
            extensions={extensions}
            onChange={(value) => onPatch({ sql: value })}
            basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: true, autocompletion: true }}
            placeholder="在这里写 SQL，Ctrl / ⌘ + Enter 执行"
          />
        </div>
      </div>

      <div className="splitter" onMouseDown={startResize} />

      {tab.results && tab.results.length > 1 && (
        <div className="result-tabs">
          {tab.results.map((entry, index) => (
            <button
              type="button"
              key={index}
              className={index === tab.activeResult ? 'active' : undefined}
              onClick={() => onPatch({ activeResult: index })}
            >
              结果 {index + 1}
              {entry.columns.length > 0 ? ` (${entry.rowCount})` : ' (OK)'}
            </button>
          ))}
        </div>
      )}

      {tab.error && (
        <div className={tab.errorKind === 'cancelled' ? 'panel-message' : 'panel-message panel-message--error'}>
          <strong>{tab.errorKind === 'cancelled' ? '已取消' : '执行失败'}</strong>
          <pre>{tab.error}</pre>
          {tab.errorLine !== null && (
            <div className="panel-note">
              已定位到第 {tab.errorLine} 行{tab.errorColumn ? `第 ${tab.errorColumn} 列` : ''}
            </div>
          )}
        </div>
      )}

      {!tab.error && result && result.columns.length === 0 && (
        <div className="panel-message panel-message--ok">
          语句执行成功，影响 {formatNumber(result.affectedRows ?? 0)} 行
          {result.insertId !== null && result.insertId !== undefined ? `，新增记录自增 ID：${result.insertId}` : ''}
          {tab.durationMs !== null ? ` · 耗时 ${formatDuration(tab.durationMs)}` : ''}
        </div>
      )}

      {!tab.error && result && result.columns.length > 0 && (
        <>
          <div className="toolbar toolbar--sub">
            <span className="badge">返回 {formatNumber(result.rowCount)} 行</span>
            {tab.durationMs !== null && <span className="badge">耗时 {formatDuration(tab.durationMs)}</span>}
            {result.truncated && <span className="badge badge--danger">结果已截断，仅显示前 5000 行</span>}
            <span className="spacer" />
            <button
              type="button"
              className="btn"
              onClick={() => downloadText('result.csv', toCsv(result.columns, result.rows), 'text/csv;charset=utf-8')}
            >
              导出 CSV
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => downloadText('result.json', toJson(result.columns, result.rows), 'application/json;charset=utf-8')}
            >
              导出 JSON
            </button>
          </div>
          <Grid columns={result.columns.map((name) => ({ name }))} rows={result.rows} rowNumberBase={1} />
        </>
      )}

      {!tab.results && !tab.error && (
        <div className="panel-message" style={{ color: 'var(--text-faint)' }}>
          写一条 SQL 然后按 Ctrl / ⌘ + Enter。支持多条语句，结果会分成多个标签页显示。
        </div>
      )}
    </div>
  );
}

/** Converts a 1-based character offset from the driver into line / column numbers. */
function positionOf(sql: string, position: number): { line: number; column: number } {
  const before = sql.slice(0, Math.max(0, position - 1));
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 };
}
