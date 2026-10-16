export function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

export function cellText(value: unknown): string {
  if (isNullish(value)) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('zh-CN');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(then).toLocaleString('zh-CN', { hour12: false });
}

/**
 * The grid works with raw JSON values, so editing needs a value that keeps
 * numbers as numbers and everything else as text.
 */
export function parseCellInput(input: string, original: unknown): unknown {
  if (input === '') return original === null ? null : '';
  if (typeof original === 'number' || typeof original === 'boolean') {
    const numeric = Number(input);
    return Number.isFinite(numeric) ? numeric : input;
  }
  if (input.toLowerCase() === 'null' && typeof original === 'string') {
    const trimmed = input.trim().toLowerCase();
    if (trimmed === 'null') return null;
  }
  return input;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (value: unknown) => {
    const text = isNullish(value) ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function toJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    { columns, rows: rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]))) },
    null,
    2,
  );
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function compactSql(sql: string, limit = 90): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}
