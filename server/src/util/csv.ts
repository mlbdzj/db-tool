export const UTF8_BOM = '\uFEFF';

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'object') {
    const candidate = value as { toString?: () => string };
    text =
      value instanceof Date
        ? value.toISOString()
        : value instanceof Uint8Array
          ? Buffer.from(value).toString('hex')
          : typeof candidate.toString === 'function' && candidate.toString !== Object.prototype.toString
            ? String(value)
            : JSON.stringify(value);
  } else text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvCell).join(',') + '\r\n';
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  return value;
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.slice(0, 120) || 'export';
}
