export interface SqlSegment {
  from: number;
  to: number;
  text: string;
}

/**
 * Splits SQL on semicolons while ignoring quotes, comments and dollar-quoted
 * bodies, so "run the statement under the cursor" stays predictable.
 */
export function splitSql(sql: string): SqlSegment[] {
  const segments: SqlSegment[] = [];
  let start = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index++;
      continue;
    }
    if (char === '#') {
      while (index < sql.length && sql[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index++;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index++;
      while (index < sql.length) {
        if (sql[index] === '\\' && quote !== '"') {
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index));
      if (tag) {
        const marker = tag[0];
        const end = sql.indexOf(marker, index + marker.length);
        index = end === -1 ? sql.length : end + marker.length;
        continue;
      }
    }
    if (char === ';') {
      segments.push({ from: start, to: index + 1, text: sql.slice(start, index + 1) });
      start = index + 1;
    }
    index++;
  }

  if (start < sql.length) segments.push({ from: start, to: sql.length, text: sql.slice(start) });
  return segments;
}

/** The statement containing the caret, falling back to the nearest non-empty one. */
export function statementAt(sql: string, position: number): { from: number; to: number; text: string } | null {
  const nonEmpty = splitSql(sql).filter((segment) => segment.text.trim().length > 0);
  if (nonEmpty.length === 0) return null;
  const hit = nonEmpty.find((segment) => position >= segment.from && position <= segment.to);
  if (hit) return hit;
  return [...nonEmpty].reverse().find((segment) => segment.to <= position) ?? nonEmpty[0]!;
}
