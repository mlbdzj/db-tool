#!/usr/bin/env node
/**
 * End-to-end check of the local API against a running server.
 *
 *   node scripts/smoke-test.mjs [baseUrl]
 *
 * Requires a reachable MySQL instance. Provide credentials through the
 * environment so no secrets live in the repository:
 *   SMOKE_MYSQL_PASSWORD=... node scripts/smoke-test.mjs
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000/api';
const MYSQL = {
  name: '自检连接 MySQL',
  kind: 'mysql',
  host: process.env.SMOKE_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.SMOKE_MYSQL_PORT ?? 3306),
  user: process.env.SMOKE_MYSQL_USER ?? 'root',
  password: process.env.SMOKE_MYSQL_PASSWORD ?? '',
  database: process.env.SMOKE_MYSQL_DB ?? 'db_tool_selftest',
  safeMode: true,
};

let passed = 0;
let failed = 0;

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, text, bytes };
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  section('服务');
  const health = await call('GET', '/health');
  check('health endpoint responds', health.status === 200 && health.body?.ok === true, health.body);

  section('连接管理');
  const existing = await call('GET', '/connections');
  for (const connection of existing.body?.connections ?? []) {
    if (connection.name === MYSQL.name) await call('DELETE', `/connections/${connection.id}`);
  }
  const created = await call('POST', '/connections', MYSQL);
  check('connection created', created.status === 201, created.body);
  const id = created.body?.connection?.id;
  check('utf-8 name preserved', created.body?.connection?.name === MYSQL.name, created.body?.connection?.name);
  check('password stored but not returned', created.body?.connection?.hasPassword === true && created.body?.connection?.password === undefined);
  if (!id) throw new Error('cannot continue without a connection id');

  const tested = await call('POST', '/connections/test', { id });
  check('connection test reports server version', tested.status === 200 && Boolean(tested.body?.version), tested.body);
  console.log(`       server: ${tested.body?.version}`);

  const databases = await call('GET', `/connections/${id}/databases`);
  const names = (databases.body?.databases ?? []).map((entry) => entry.name);
  check('databases listed', names.includes(MYSQL.database), names);

  const tables = await call('GET', `/connections/${id}/tables?db=${encodeURIComponent(MYSQL.database)}`);
  const tableNames = (tables.body?.tables ?? []).map((entry) => `${entry.name}:${entry.type}`);
  check('tables and views listed', tableNames.includes('users:table') && tableNames.includes('active_users:view'), tableNames);

  const columns = await call('GET', `/connections/${id}/columns?db=${MYSQL.database}&table=users`);
  const idColumn = (columns.body?.columns ?? []).find((column) => column.name === 'id');
  check('primary key metadata', idColumn?.primaryKey === true && idColumn?.autoIncrement === true, idColumn);

  section('SQL 查询');
  const single = await call('POST', `/connections/${id}/query`, {
    db: MYSQL.database,
    sql: 'SELECT id, name, score FROM users ORDER BY id',
  });
  check('select returns rows', single.status === 200 && single.body?.results?.[0]?.rowCount === 3, single.body?.results?.[0]);
  console.log(`       first row: ${JSON.stringify(single.body?.results?.[0]?.rows?.[0])}`);

  const multi = await call('POST', `/connections/${id}/query`, {
    db: MYSQL.database,
    sql: 'SELECT 1 AS a; SELECT 2 AS b UNION SELECT 3;',
  });
  check('multi statement returns two result sets', multi.body?.results?.length === 2, multi.body?.results?.length);

  const withComment = await call('POST', `/connections/${id}/query`, {
    db: MYSQL.database,
    sql: "-- a comment with a ; semicolon\nSELECT 'a;b' AS literal",
  });
  check('semicolons inside literals and comments are safe', withComment.status === 200 && withComment.body?.results?.[0]?.rows?.[0]?.[0] === 'a;b', withComment.body);

  const bad = await call('POST', `/connections/${id}/query`, {
    db: MYSQL.database,
    sql: 'SELECT * FROM does_not_exist_xyz',
  });
  check('sql errors surface as a message', bad.status === 400 && typeof bad.body?.error === 'string', bad.body);
  console.log(`       error: ${bad.body?.error}`);

  section('写保护');
  const unscoped = await call('POST', `/connections/${id}/query`, {
    db: MYSQL.database,
    sql: 'DELETE FROM users',
  });
  check('unscoped delete is refused with 409', unscoped.status === 409 && unscoped.body?.error === 'unscoped_write', unscoped.body);

  section('表数据');
  const page = await call('POST', `/connections/${id}/rows/fetch`, {
    db: MYSQL.database,
    table: { table: 'users' },
    limit: 2,
    offset: 0,
    orderBy: { column: 'id', dir: 'desc' },
  });
  check('paged fetch returns requested window', page.status === 200 && page.body?.rows?.length === 2 && page.body?.total === 3, {
    rows: page.body?.rows?.length,
    total: page.body?.total,
  });
  check('fetch is ordered descending', page.body?.rows?.[0]?.[0] > page.body?.rows?.[1]?.[0], page.body?.rows?.map((row) => row[0]));

  const filtered = await call('POST', `/connections/${id}/rows/fetch`, {
    db: MYSQL.database,
    table: { table: 'users' },
    limit: 10,
    offset: 0,
    where: 'score > 90',
  });
  check('where filter is honoured', filtered.body?.total === 1, filtered.body?.total);

  section('增删改（事务）');
  const inserted = await call('POST', `/connections/${id}/rows/apply`, {
    db: MYSQL.database,
    changes: [{ type: 'insert', table: { table: 'users' }, values: { name: '冒烟测试', email: 'smoke@example.com', score: 66.5 } }],
  });
  check('insert applied', inserted.status === 200 && inserted.body?.applied === 1, inserted.body);

  const findInserted = await call('POST', `/connections/${id}/rows/fetch`, {
    db: MYSQL.database,
    table: { table: 'users' },
    limit: 5,
    offset: 0,
    where: "email = 'smoke@example.com'",
    withCount: false,
  });
  const newRow = findInserted.body?.rows?.[0];
  check('inserted row is readable with correct encoding', newRow?.[1] === '冒烟测试', newRow);

  const updated = await call('POST', `/connections/${id}/rows/apply`, {
    db: MYSQL.database,
    changes: [
      { type: 'update', table: { table: 'users' }, key: { id: newRow?.[0] }, values: { score: 77.75, note: '已更新' } },
      { type: 'update', table: { table: 'users' }, key: { id: newRow?.[0] }, values: { email: null } },
    ],
  });
  check('updates applied in one transaction', updated.status === 200 && updated.body?.applied === 2, updated.body);

  const afterUpdate = await call('POST', `/connections/${id}/rows/fetch`, {
    db: MYSQL.database,
    table: { table: 'users' },
    limit: 5,
    offset: 0,
    where: `id = ${Number(newRow?.[0])}`,
    withCount: false,
  });
  const updatedRow = afterUpdate.body?.rows?.[0];
  check('null assignment round-trips', updatedRow?.[2] === null, updatedRow);
  check('numeric update round-trips', String(updatedRow?.[3]) === '77.75', updatedRow?.[3]);

  const removed = await call('POST', `/connections/${id}/rows/apply`, {
    db: MYSQL.database,
    changes: [{ type: 'delete', table: { table: 'users' }, key: { id: newRow?.[0] } }],
  });
  check('delete applied', removed.status === 200 && removed.body?.applied === 1, removed.body);

  const afterDelete = await call('POST', `/connections/${id}/rows/fetch`, {
    db: MYSQL.database,
    table: { table: 'users' },
    limit: 5,
    offset: 0,
    where: "email = 'smoke@example.com'",
    withCount: false,
  });
  check('row is gone after delete', afterDelete.body?.rows?.length === 0, afterDelete.body?.rows);

  const guarded = await call('POST', `/connections/${id}/rows/apply`, {
    db: MYSQL.database,
    changes: [{ type: 'update', table: { table: 'users' }, values: { score: 0 } }],
  });
  check('row updates without a key are refused', guarded.status >= 400, guarded.body);

  section('导出');
  const csv = await call('POST', `/connections/${id}/export`, {
    db: MYSQL.database,
    format: 'csv',
    table: { table: 'users' },
    filename: 'users',
  });
  // fetch's text() strips a leading BOM, so inspect the raw bytes for Excel compatibility.
  check('csv export starts with a utf-8 bom', csv.bytes[0] === 0xef && csv.bytes[1] === 0xbb && csv.bytes[2] === 0xbf, Array.from(csv.bytes.slice(0, 4)));
  check('csv export header lists columns', csv.text.startsWith('id,name,email,score'), csv.text.slice(0, 40));
  check('csv export contains every row', csv.text.trim().split('\n').length >= 4, csv.text.trim().split('\n').length);

  const json = await call('POST', `/connections/${id}/export`, {
    db: MYSQL.database,
    format: 'json',
    table: { table: 'users' },
    filename: 'users',
  });
  let jsonOk = false;
  try {
    const parsed = JSON.parse(json.text);
    jsonOk = Array.isArray(parsed.columns) && Array.isArray(parsed.rows) && parsed.rows.length >= 3;
  } catch {
    jsonOk = false;
  }
  check('json export parses', jsonOk, json.text.slice(0, 80));

  section('历史');
  const history = await call('GET', `/connections/${id}/history`);
  check('query history recorded', (history.body?.entries ?? []).length > 0, history.body?.entries?.length);

  section('清理');
  const cleaned = await call('DELETE', `/connections/${id}`);
  check('connection removed', cleaned.status === 200 && cleaned.body?.removed === true, cleaned.body);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\nsmoke test crashed:', error);
  process.exitCode = 1;
});
