/** Identifier quoting + a conservative guard against runaway write statements. */

export function quoteMysqlIdent(name: string): string {
  assertIdent(name);
  return '`' + name.replace(/`/g, '``') + '`';
}

export function quotePgIdent(name: string): string {
  assertIdent(name);
  return '"' + name.replace(/"/g, '""') + '"';
}

function assertIdent(name: string): void {
  if (typeof name !== 'string' || name.length === 0) throw new Error('Empty identifier');
  if (name.includes('\0')) throw new Error('Identifier contains a NUL byte');
}

/**
 * Blanks out string literals and comments so keyword scanning cannot be fooled
 * by text that merely looks like SQL.
 */
export function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (sql[i] === '\\' && quote !== '"') {
          i += 2;
          continue;
        }
        i++;
      }
      out += " '' ";
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        i = end === -1 ? sql.length : end + marker.length;
        out += " '' ";
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function splitStatements(sql: string): string[] {
  const clean = stripSqlNoise(sql);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === ';') {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const UNSAFE_START = /^(update|delete|drop|truncate|alter)\b/i;

/**
 * Returns the statements that would mutate data without any WHERE clause.
 * The UI turns this into a confirmation prompt instead of silently allowing it.
 */
export function findUnscopedWrites(sql: string): string[] {
  const clean = stripSqlNoise(sql);
  const raw = splitStatements(sql);
  const cleaned = splitStatements(clean);
  const flagged: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const statement = raw[i]!;
    const shape = cleaned[i] ?? '';
    if (!UNSAFE_START.test(shape)) continue;
    if (/^(drop|truncate|alter)\b/i.test(shape)) {
      flagged.push(statement);
      continue;
    }
    if (!/\bwhere\b/i.test(shape)) flagged.push(statement);
  }
  return flagged;
}

export function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
