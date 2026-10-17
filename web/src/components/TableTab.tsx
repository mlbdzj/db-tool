import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadExport } from '../lib/api';
import { formatNumber } from '../lib/format';
import type { ColumnInfo, Connection, RowChange } from '../lib/types';
import { Grid, type GridColumn } from './Grid';

export interface TableTabState {
  id: string;
  kind: 'table';
  connectionId: string;
  db: string | null;
  table: { schema: string | null; table: string };
  title: string;
}

interface Props {
  connection: Connection;
  tab: TableTabState;
  visible: boolean;
  onNotify: (text: string, kind?: 'ok' | 'error') => void;
  /** Lets the shell warn before a tab or the window is closed with edits in flight. */
  onDirtyChange?: (dirty: boolean) => void;
}

interface InsertedRow {
  id: string;
  values: Record<number, unknown>;
}

const PAGE_SIZES = [50, 100, 200, 500];

function isNumericType(dataType: string): boolean {
  return /int|numeric|decimal|real|double|float|serial|money|bit/i.test(dataType);
}

export function TableTab({ connection, tab, visible, onNotify, onDirtyChange }: Props) {
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [baseRows, setBaseRows] = useState<unknown[][]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [whereInput, setWhereInput] = useState('');
  const [where, setWhere] = useState<string | null>(null);
  const [edits, setEdits] = useState<Map<string, Record<number, unknown>>>(new Map());
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [inserted, setInserted] = useState<InsertedRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const pkIndexes = useMemo(
    () => columns.map((column, index) => (column.primaryKey ? index : -1)).filter((index) => index >= 0),
    [columns],
  );

  const signatureOf = useCallback(
    (row: unknown[]): string =>
      pkIndexes.length > 0 ? JSON.stringify(pkIndexes.map((index) => row[index])) : JSON.stringify(row),
    [pkIndexes],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.fetchRows(connection.id, {
        db: tab.db,
        table: tab.table,
        limit: pageSize,
        offset: page * pageSize,
        orderBy: sort,
        where,
        withCount: true,
      });
      setColumns(result.columns);
      setBaseRows(result.rows);
      setTotal(result.total);
      setEdits(new Map());
      setDeleted(new Set());
      setInserted([]);
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setColumns([]);
      setBaseRows([]);
      setTotal(null);
    } finally {
      setLoading(false);
    }
  }, [connection.id, tab.db, tab.table, page, pageSize, sort, where]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleBase = useMemo(
    () => baseRows.filter((row) => !deleted.has(signatureOf(row))),
    [baseRows, deleted, signatureOf],
  );

  const displayRows = useMemo<unknown[][]>(
    () => [
      ...visibleBase,
      ...inserted.map((entry) => columns.map((_, index) => (index in entry.values ? entry.values[index] : null))),
    ],
    [visibleBase, inserted, columns],
  );

  const pendingCells = useMemo(() => {
    const map = new Map<string, unknown>();
    visibleBase.forEach((row, index) => {
      const rowEdits = edits.get(signatureOf(row));
      if (!rowEdits) return;
      for (const [columnIndex, value] of Object.entries(rowEdits)) map.set(`${index}:${columnIndex}`, value);
    });
    inserted.forEach((entry, offset) => {
      const index = visibleBase.length + offset;
      for (const [columnIndex, value] of Object.entries(entry.values)) map.set(`${index}:${columnIndex}`, value);
    });
    return map;
  }, [edits, inserted, visibleBase, signatureOf]);

  const pendingCount = edits.size + deleted.size + inserted.length;
  const editable = columns.length > 0 && pkIndexes.length > 0;

  const notifyDirty = useRef(onDirtyChange);
  notifyDirty.current = onDirtyChange;
  useEffect(() => {
    notifyDirty.current?.(pendingCount > 0);
  }, [pendingCount]);

  function handleCellCommit(rowIndex: number, columnIndex: number, value: unknown) {
    if (rowIndex >= visibleBase.length) {
      const offset = rowIndex - visibleBase.length;
      setInserted((current) =>
        current.map((entry, index) => (index === offset ? { ...entry, values: { ...entry.values, [columnIndex]: value } } : entry)),
      );
      return;
    }
    const row = visibleBase[rowIndex]!;
    const signature = signatureOf(row);
    const original = row[columnIndex];
    setEdits((current) => {
      const next = new Map(current);
      const rowEdits = { ...(next.get(signature) ?? {}) };
      if (value === original) delete rowEdits[columnIndex];
      else rowEdits[columnIndex] = value;
      if (Object.keys(rowEdits).length > 0) next.set(signature, rowEdits);
      else next.delete(signature);
      return next;
    });
  }

  function revert() {
    setEdits(new Map());
    setDeleted(new Set());
    setInserted([]);
    setSelected(null);
  }

  function addRow() {
    setInserted((current) => [...current, { id: `${Date.now()}-${current.length}`, values: {} }]);
  }

  function removeSelected() {
    if (selected === null) {
      onNotify('先点一下行号选中要删除的行', 'error');
      return;
    }
    if (selected >= visibleBase.length) {
      const offset = selected - visibleBase.length;
      setInserted((current) => current.filter((_, index) => index !== offset));
      setSelected(null);
      return;
    }
    const row = visibleBase[selected]!;
    setDeleted((current) => new Set(current).add(signatureOf(row)));
    setSelected(null);
  }

  async function save() {
    if (pendingCount === 0) return;
    const changes: RowChange[] = [];
    const table = { schema: tab.table.schema, table: tab.table.table };

    for (const signature of deleted) {
      const row = baseRows.find((candidate) => signatureOf(candidate) === signature);
      if (!row) continue;
      changes.push({
        type: 'delete',
        table,
        key: Object.fromEntries(pkIndexes.map((index) => [columns[index]!.name, row[index]])),
      });
    }

    for (const [signature, rowEdits] of edits) {
      if (deleted.has(signature)) continue;
      const row = baseRows.find((candidate) => signatureOf(candidate) === signature);
      if (!row) continue;
      changes.push({
        type: 'update',
        table,
        key: Object.fromEntries(pkIndexes.map((index) => [columns[index]!.name, row[index]])),
        values: Object.fromEntries(
          Object.entries(rowEdits).map(([columnIndex, value]) => [columns[Number(columnIndex)]!.name, value]),
        ),
      });
    }

    for (const entry of inserted) {
      const values = Object.fromEntries(
        Object.entries(entry.values).map(([columnIndex, value]) => [columns[Number(columnIndex)]!.name, value]),
      );
      if (Object.keys(values).length === 0) continue;
      changes.push({ type: 'insert', table, values });
    }

    if (changes.length === 0) {
      onNotify('新增的行还是空的，先填几个字段', 'error');
      return;
    }

    setSaving(true);
    try {
      const outcome = await api.applyChanges(connection.id, tab.db, changes);
      onNotify(`已提交 ${changes.length} 项改动，影响 ${outcome.applied} 行`, 'ok');
      await load();
    } catch (cause) {
      onNotify(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function exportAs(format: 'csv' | 'json') {
    try {
      await downloadExport(connection.id, {
        db: tab.db,
        format,
        table: tab.table,
        where,
        orderBy: sort,
        filename: `${tab.table.schema ? `${tab.table.schema}.` : ''}${tab.table.table}`,
      });
      onNotify('导出已完成', 'ok');
    } catch (cause) {
      onNotify(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  const gridColumns: GridColumn[] = columns.map((column) => ({
    name: column.name,
    type: column.dataType,
    primaryKey: column.primaryKey,
    numeric: isNumericType(column.dataType),
  }));

  const pageCount = total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  const rowNumberBase = page * pageSize + 1;

  return (
    <div className="workspace" style={visible ? undefined : { display: 'none' }}>
      <div className="toolbar">
        <span className="badge">
          {tab.table.schema ? `${tab.table.schema}.` : ''}
          {tab.table.table}
        </span>
        <input
          className="input input--mono"
          style={{ flex: '1 1 260px' }}
          placeholder="WHERE 条件，例如 status = 1 AND created_at > '2026-01-01'"
          value={whereInput}
          onChange={(event) => setWhereInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setWhere(whereInput.trim() || null);
              setPage(0);
            }
          }}
        />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setWhere(whereInput.trim() || null);
            setPage(0);
          }}
        >
          应用筛选
        </button>
        {where && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setWhereInput('');
              setWhere(null);
              setPage(0);
            }}
          >
            清除
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
        <button type="button" className="btn" onClick={() => void exportAs('csv')}>
          导出 CSV
        </button>
        <button type="button" className="btn" onClick={() => void exportAs('json')}>
          导出 JSON
        </button>
      </div>

      <div className="toolbar toolbar--sub">
        {editable ? (
          <>
            <button type="button" className="btn" onClick={addRow}>
              ＋ 新增行
            </button>
            <button type="button" className="btn btn--danger" onClick={removeSelected}>
              删除选中行
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void save()}
              disabled={pendingCount === 0 || saving}
            >
              {saving ? '提交中…' : `提交改动${pendingCount ? ` (${pendingCount})` : ''}`}
            </button>
            <button type="button" className="btn" onClick={revert} disabled={pendingCount === 0 || saving}>
              撤销
            </button>
          </>
        ) : (
          <span className="badge badge--danger">
            {columns.length === 0 ? '未加载' : '该表没有主键，为避免误改数据，这里只能查看'}
          </span>
        )}
        <span className="spacer" />
        <span className="badge">共 {total === null ? '—' : formatNumber(total)} 行</span>
        <select
          className="select"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(0);
          }}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              每页 {size}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={page === 0 || loading} onClick={() => setPage((value) => value - 1)}>
          上一页
        </button>
        <span className="badge">
          第 {page + 1}
          {pageCount === null ? '' : ` / ${pageCount}`} 页
        </span>
        <button
          type="button"
          className="btn"
          disabled={loading || (pageCount !== null && page + 1 >= pageCount)}
          onClick={() => setPage((value) => value + 1)}
        >
          下一页
        </button>
      </div>

      {error && <div className="panel-message panel-message--error">{error}</div>}
      {!error && editable && pendingCount > 0 && (
        <div className="panel-message panel-message--ok" style={{ marginBottom: 0 }}>
          有 {pendingCount} 项未提交的改动，提交后会在同一个事务里执行；双击单元格可以修改内容。
        </div>
      )}

      {!error && (
        <Grid
          columns={gridColumns}
          rows={displayRows}
          editable={editable}
          pendingCells={pendingCells}
          rowFlags={(rowIndex) =>
            rowIndex >= visibleBase.length ? 'new' : edits.has(signatureOf(visibleBase[rowIndex]!)) ? 'edited' : null
          }
          onCellCommit={handleCellCommit}
          selectedRow={selected}
          onSelectRow={setSelected}
          sort={sort}
          onSort={(column) =>
            setSort((current) =>
              current?.column === column ? { column, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' },
            )
          }
          rowNumberBase={rowNumberBase}
          emptyText={where ? '这个条件下没有数据' : '表里还没有数据'}
        />
      )}
    </div>
  );
}
