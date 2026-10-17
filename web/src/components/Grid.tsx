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
  const [cursor, setCursor] = useState<{ row: number; column: number } | null>(null);
  const [copied, setCopied] = useState<{ row: number; column: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: number; column: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

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

  function valueAt(rowIndex: number, columnIndex: number): unknown {
    const key = cellKey(rowIndex, columnIndex);
    return pendingCells?.has(key) ? pendingCells.get(key) : rows[rowIndex]?.[columnIndex];
  }

  function startEdit(rowIndex: number, columnIndex: number) {
    const value = valueAt(rowIndex, columnIndex);
    setCursor({ row: rowIndex, column: columnIndex });
    setEditing({ row: rowIndex, column: columnIndex });
    setDraft(value === null || value === undefined ? '' : cellText(value));
  }

  function plainText(value: unknown): string {
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable: the selection still works */
    }
  }

  function copyCell(rowIndex: number, columnIndex: number) {
    void copyText(plainText(valueAt(rowIndex, columnIndex)));
    setCopied({ row: rowIndex, column: columnIndex });
    window.setTimeout(() => setCopied(null), 700);
  }

  function copyRow(rowIndex: number) {
    void copyText(columns.map((_, columnIndex) => plainText(valueAt(rowIndex, columnIndex))).join('\t'));
    setCopied({ row: rowIndex, column: -1 });
    window.setTimeout(() => setCopied(null), 700);
  }

  /** Keeps the cursor row inside the scroll viewport without jumping the page. */
  function revealRow(rowIndex: number) {
    const element = containerRef.current;
    if (!element) return;
    const top = rowIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (editing) return;
    const row = cursor?.row ?? 0;
    const column = cursor?.column ?? 0;
    const move = (nextRow: number, nextColumn: number) => {
      event.preventDefault();
      setCursor({ row: nextRow, column: nextColumn });
      revealRow(nextRow);
    };

    switch (event.key) {
      case 'ArrowDown':
        move(Math.min(rows.length - 1, row + 1), column);
        return;
      case 'ArrowUp':
        move(Math.max(0, row - 1), column);
        return;
      case 'ArrowRight':
        move(row, Math.min(columns.length - 1, column + 1));
        return;
      case 'ArrowLeft':
        move(row, Math.max(0, column - 1));
        return;
      case 'Enter':
      case 'F2':
        if (editable && rows.length > 0) {
          event.preventDefault();
          startEdit(row, column);
        }
        return;
      case 'Escape':
        setCursor(null);
        return;
      default:
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && rows.length > 0) {
          event.preventDefault();
          copyCell(row, column);
        }
    }
  }

  return (
    <div
      className="grid"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
        setMenu(null);
      }}
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
                      cursor?.row === rowIndex && cursor.column === columnIndex ? 'cell--cursor' : '',
                      copied?.row === rowIndex && (copied.column === columnIndex || copied.column === -1)
                        ? 'cell--copied'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <td
                        key={column.name + columnIndex}
                        className={classes}
                        title={text}
                        onDoubleClick={editable ? () => startEdit(rowIndex, columnIndex) : undefined}
                        onClick={() => {
                          setCursor({ row: rowIndex, column: columnIndex });
                          onSelectRow?.(rowIndex);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setCursor({ row: rowIndex, column: columnIndex });
                          setMenu({ x: event.clientX, y: event.clientY, row: rowIndex, column: columnIndex });
                        }}
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
      {menu && (
        <div
          className="grid-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              copyCell(menu.row, menu.column);
              setMenu(null);
            }}
          >
            复制单元格
          </button>
          <button
            type="button"
            onClick={() => {
              copyRow(menu.row);
              setMenu(null);
            }}
          >
            复制整行
          </button>
          {editable && (
            <button
              type="button"
              onClick={() => {
                startEdit(menu.row, menu.column);
                setMenu(null);
              }}
            >
              编辑此单元格
            </button>
          )}
          {editable && (
            <button
              type="button"
              onClick={() => {
                onCellCommit?.(menu.row, menu.column, null);
                setMenu(null);
              }}
            >
              设为 NULL
            </button>
          )}
        </div>
      )}
    </div>
  );
}
