import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cellText, parseCellInput } from '../lib/format';

export interface GridColumn {
  name: string;
  type?: string | null;
  primaryKey?: boolean;
  numeric?: boolean;
}

interface GridProps {
  columns: GridColumn[];
  rows: unknown[][];
  editable?: boolean;
  rowFlags?: (rowIndex: number) => 'new' | 'edited' | null;
  pendingCells?: Map<string, unknown>;
  onCellCommit?: (rowIndex: number, columnIndex: number, value: unknown) => void;
  selectedRow?: number | null;
  onSelectRow?: (rowIndex: number) => void;
  sort?: { column: string; dir: 'asc' | 'desc' } | null;
  onSort?: (column: string) => void;
  rowNumberBase?: number;
  emptyText?: string;
}

const ROW_HEIGHT = 28;
const OVERSCAN = 8;

function cellKey(rowIndex: number, columnIndex: number): string {
  return `${rowIndex}:${columnIndex}`;
}

export function Grid({
  columns,
  rows,
  editable = false,
  rowFlags,
  pendingCells,
  onCellCommit,
  selectedRow,
  onSelectRow,
  sort,
  onSort,
  rowNumberBase = 1,
  emptyText = '没有数据',
}: GridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [editing, setEditing] = useState<{ row: number; column: number } | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const widths = useMemo(
    () =>
      columns.map((column, index) => {
        let widest = column.name.length * 8 + 40;
        const sample = Math.min(rows.length, 150);
        for (let row = 0; row < sample; row++) {
          const text = cellText(rows[row]?.[index]);
          widest = Math.max(widest, Math.min(text.length, 42) * 7.4 + 22);
        }
        return Math.min(Math.max(88, Math.round(widest)), 420);
      }),
    [columns, rows],
  );

  const numericColumns = useMemo(
    () =>
      columns.map((column, index) => {
        if (column.numeric !== undefined) return column.numeric;
        const sample = Math.min(rows.length, 30);
        for (let row = 0; row < sample; row++) {
          const value = rows[row]?.[index];
          if (value === null || value === undefined) continue;
          return typeof value === 'number';
        }
        return false;
      }),
    [columns, rows],
  );

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(rows.length, start + visibleCount);
  const slice = rows.slice(start, end);

  const commit = useCallback(
    (rowIndex: number, columnIndex: number) => {
      if (!editing) return;
      const original = pendingCells?.get(cellKey(rowIndex, columnIndex)) ?? rows[rowIndex]?.[columnIndex];
      const next = parseCellInput(draft, original);
      if (next !== original) onCellCommit?.(rowIndex, columnIndex, next);
      setEditing(null);
    },
    [draft, editing, onCellCommit, pendingCells, rows],
  );

  return (
    <div
      className="grid"
      ref={containerRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {rows.length === 0 ? (
        <div className="panel-message">{emptyText}</div>
      ) : (
        <table>
          <colgroup>
            <col style={{ width: 56 }} />
            {widths.map((width, index) => (
              <col key={columns[index]?.name ?? index} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="rownum">#</th>
              {columns.map((column, index) => (
                <th
                  key={column.name + index}
                  className={onSort ? 'sortable' : undefined}
                  title={`${column.name}${column.type ? ` · ${column.type}` : ''}`}
                  onClick={onSort ? () => onSort(column.name) : undefined}
                >
                  {column.primaryKey ? '🔑 ' : ''}
                  {column.name}
                  {sort && sort.column === column.name ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {start > 0 && (
              <tr className="spacer-row" aria-hidden>
                <td colSpan={columns.length + 1} style={{ height: start * ROW_HEIGHT }} />
              </tr>
            )}
            {slice.map((row, offset) => {
              const rowIndex = start + offset;
              const flag = rowFlags?.(rowIndex) ?? null;
              const className = flag === 'new' ? 'row--new' : flag === 'edited' ? 'row--edited' : undefined;
              return (
                <tr key={rowIndex} className={className}>
                  <td
                    className="rownum"
                    onClick={() => onSelectRow?.(rowIndex)}
                    style={onSelectRow ? { cursor: 'pointer' } : undefined}
                  >
                    {selectedRow === rowIndex ? '▶ ' : ''}
                    {rowNumberBase + rowIndex}
                  </td>
                  {columns.map((column, columnIndex) => {
                    const isEditing = editable && editing?.row === rowIndex && editing.column === columnIndex;
                    const pending = pendingCells?.get(cellKey(rowIndex, columnIndex));
                    const hasPending = pendingCells?.has(cellKey(rowIndex, columnIndex)) ?? false;
                    const value = hasPending ? pending : row[columnIndex];
                    const text = cellText(value);
                    const classes = [
                      numericColumns[columnIndex] ? 'num' : '',
                      value === null || value === undefined ? 'null' : '',
                      hasPending ? 'cell--edited' : '',
                      column.primaryKey ? 'cell--pk' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <td
                        key={column.name + columnIndex}
                        className={classes}
                        title={text}
                        onDoubleClick={
                          editable
                            ? () => {
                                setEditing({ row: rowIndex, column: columnIndex });
                                setDraft(value === null || value === undefined ? '' : text);
                              }
                            : undefined
                        }
                        onClick={onSelectRow ? () => onSelectRow(rowIndex) : undefined}
                      >
                        {isEditing ? (
                          <input
                            className="cell-input"
                            autoFocus
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => commit(rowIndex, columnIndex)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                commit(rowIndex, columnIndex);
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                setEditing(null);
                              }
                            }}
                          />
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {end < rows.length && (
              <tr className="spacer-row" aria-hidden>
                <td colSpan={columns.length + 1} style={{ height: (rows.length - end) * ROW_HEIGHT }} />
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
