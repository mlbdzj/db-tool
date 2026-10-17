#!/usr/bin/env node
/**
 * Drives the desktop window through the Chrome DevTools Protocol and checks
 * that the real UI renders, reacts to clicks, and runs SQL.
 *
 *   node_modules/.bin/electron . --remote-debugging-port=9222
 *   SMOKE_MYSQL_PASSWORD=... node scripts/desktop-e2e.mjs
 */

const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9222);
const SEED_NAME = '自检连接 MySQL';
const MYSQL = {
  name: SEED_NAME,
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
const consoleErrors = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* the app is still starting */
    }
    await sleep(1000);
  }
  throw new Error('找不到渲染进程，请先用 --remote-debugging-port 启动应用');
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const dialogs = [];
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Page.javascriptDialogOpening') {
      dialogs.push({ type: message.params?.type ?? '', message: message.params?.message ?? '' });
      // Decline by default so a stray confirm cannot freeze the run.
      socket.send(JSON.stringify({ id: nextId++, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params?.exceptionDetails?.exception?.description ?? 'exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      consoleErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description).join(' '));
    }
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('调试连接失败')));
  });

  return {
    ready,
    close: () => socket.close(),
    dialogs,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

/** Expression fragments, scoped to the tab the user can actually see. */
const VISIBLE_WORKSPACE = `[...document.querySelectorAll('.workspace')].find((node) => node.offsetParent !== null)`;
const VISIBLE_EDITOR = `(() => { const w = ${VISIBLE_WORKSPACE}; return Boolean(w && w.querySelector('.grid input.cell-input')); })()`;
const VISIBLE_GRID_ROWS = `(() => { const w = ${VISIBLE_WORKSPACE}; return w ? w.querySelectorAll('.grid tbody tr:not(.spacer-row)').length : -1; })()`;
const VISIBLE_TEXT = `(() => { const w = ${VISIBLE_WORKSPACE}; return w ? w.innerText : ''; })()`;

async function main() {
  const page = await findPage();
  console.log(`\n窗口: ${page.url}\n`);
  const client = connect(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  // Synthetic input only reaches the renderer reliably while its window is the
  // active one, so claim focus before driving clicks and keystrokes.
  await client.send('Page.bringToFront');
  // When the app window sits behind other windows, the renderer refuses to
  // take focus and silently drops dispatched input. Focus emulation makes the
  // page behave as if it were frontmost, which is what automation needs.
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  async function evaluate(expression) {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败');
    }
    return result.result.value;
  }

  /** UI updates are asynchronous; poll the real state instead of guessing delays. */
  async function waitFor(expression, timeout = 6000, interval = 150) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await evaluate(expression);
      if (value) return value;
      if (Date.now() > deadline) return value;
      await sleep(interval);
    }
  }

  async function clickAt(point, clickCount = 1) {
    // `buttons` must drop to 0 on release, otherwise Chromium will not
    // complete the click sequence and never synthesises a dblclick.
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount,
      buttons: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount,
      buttons: 0,
    });
  }

  async function pressEnter(modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers,
      });
    }
  }

  async function selectAllInEditor() {
    for (const type of ['keyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type,
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: 2,
      });
    }
  }

  async function clickByText(text) {
    return evaluate(`(() => {
      const target = [...document.querySelectorAll('button, .tree__row, .conn')]
        .find((node) => node.innerText.trim() === ${JSON.stringify(text)});
      if (!target) return false;
      target.click();
      return true;
    })()`);
  }

  /** React tracks input values internally, so write through the native setter. */
  async function setField(selector, value) {
    return evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  async function pickOption(selector, value) {
    return evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      if (!select) return false;
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  console.log('启动状态');
  const title = await evaluate('document.title');
  check('页面标题正确', title.includes('DB Tool'), title);
  check(
    '界面骨架已渲染',
    await evaluate("Boolean(document.querySelector('.sidebar') && document.querySelector('.statusbar'))"),
  );
  const existingConnections = await evaluate("document.querySelectorAll('.conn').length");
  const bodyText = await evaluate('document.body.innerText');
  if (existingConnections === 0) {
    check('未连接时显示引导', bodyText.includes('先连接一个数据库'));
  } else {
    check(
      '启动时列出已保存的连接',
      await evaluate("[...document.querySelectorAll('.conn')].every((node) => node.innerText.trim().length > 0)"),
      existingConnections,
    );
  }

  console.log('\n准备一个连接');
  const seeded = await evaluate(`(async () => {
    const token = localStorage.getItem('db-tool-token') ?? '';
    const headers = { 'content-type': 'application/json', 'x-db-tool-token': token };
    const list = await (await fetch('/api/connections', { headers })).json();
    for (const connection of list.connections ?? []) {
      if (connection.name === ${JSON.stringify(SEED_NAME)}) {
        await fetch('/api/connections/' + connection.id, { method: 'DELETE', headers });
      }
    }
    const created = await fetch('/api/connections', {
      method: 'POST',
      headers,
      body: ${JSON.stringify(JSON.stringify(MYSQL))},
    });
    return created.status;
  })()`);
  check('通过界面同源接口创建连接', seeded === 201, seeded);

  await client.send('Page.reload');
  await sleep(1200);

  console.log('\n侧边栏交互');
  const seedRowVisible = `[...document.querySelectorAll('.conn')].some((node) => node.innerText.includes(${JSON.stringify(SEED_NAME)}))`;
  check('连接出现在侧边栏', Boolean(await waitFor(seedRowVisible)));
  check('连接名称中文正常', (await evaluate('document.body.innerText')).includes(SEED_NAME));

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.conn')].find((node) => node.innerText.includes(${JSON.stringify(SEED_NAME)}));
    if (row) row.click();
    return Boolean(row);
  })()`);
  const database = await waitFor(
    "[...document.querySelectorAll('.sidebar__scroll .tree__row')].map((row) => row.innerText.trim()).find((label) => label === 'db_tool_selftest')",
  );
  check('数据库列表已加载', database === 'db_tool_selftest');
  check(
    '默认隐藏系统库',
    !(
      await evaluate("[...document.querySelectorAll('.sidebar__scroll .tree__row')].map((row) => row.innerText.trim())")
    ).includes('information_schema'),
  );

  await clickByText('db_tool_selftest');
  check(
    '表和视图已列出',
    Boolean(
      await waitFor(
        "[...document.querySelectorAll('.sidebar__scroll .tree__row')].some((row) => row.innerText.includes('users'))",
      ),
    ),
  );
  check(
    '视图单独标记',
    await evaluate(
      "[...document.querySelectorAll('.sidebar__scroll .tree__row')].some((row) => row.innerText.includes('active_users'))",
    ),
  );

  console.log('\n打开数据表');
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.sidebar__scroll .tree__row')]
      .find((candidate) => candidate.innerText.includes('users') && !candidate.innerText.includes('active_users'));
    if (row) row.click();
    return Boolean(row);
  })()`);
  check('打开了数据表标签页', Boolean(await waitFor("document.body.innerText.includes('▤ users')")));
  check('表格渲染出数据行', (await waitFor(VISIBLE_GRID_ROWS)) >= 3, await evaluate(VISIBLE_GRID_ROWS));
  check('显示了总行数', (await evaluate(VISIBLE_TEXT)).includes('共'));
  check('主键列有标记', (await evaluate(VISIBLE_TEXT)).includes('🔑'));
  check('有主键的表可编辑', (await evaluate(VISIBLE_TEXT)).includes('新增行'));

  console.log('\n单元格编辑');
  const target = await evaluate(`(() => {
    const workspace = ${VISIBLE_WORKSPACE};
    const cell = [...(workspace ? workspace.querySelectorAll('.grid tbody tr td') : [])].find(
      (node) => !node.className.includes('rownum'),
    );
    if (!cell) return null;
    const box = cell.getBoundingClientRect();
    return { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2), text: cell.innerText };
  })()`);
  check('找到可编辑的单元格', Boolean(target), target);

  if (target) {
    await evaluate(`(() => { window.__dbl = 0; document.addEventListener('dblclick', () => { window.__dbl += 1; }, true); return true; })()`);
    let editorOpen = false;
    for (let attempt = 0; attempt < 3 && !editorOpen; attempt++) {
      await clickAt(target, 1);
      await clickAt(target, 2);
      editorOpen = Boolean(await waitFor(VISIBLE_EDITOR, 1500));
    }
    const diagnostics = await evaluate(`({
      dblclickEvents: window.__dbl,
      hitTarget: (() => {
        const node = document.elementFromPoint(${target.x}, ${target.y});
        return node ? node.tagName + '.' + node.className + ':' + (node.innerText || '').slice(0, 12) : null;
      })(),
      anyEditor: Boolean(document.querySelector('.grid input.cell-input')),
      focused: document.activeElement.tagName + '.' + document.activeElement.className,
    })`);
    check('双击后单元格变成输入框', editorOpen, diagnostics);

    if (editorOpen) {
      await evaluate(`(() => { const w = ${VISIBLE_WORKSPACE}; const input = w && w.querySelector('.grid input.cell-input'); if (input) input.focus(); return Boolean(input); })()`);
      await sleep(150);
      await client.send('Input.insertText', { text: 'X' });
      check(
        '输入内容进入编辑框',
        Boolean(
          await waitFor(
            "Boolean(document.querySelector('.grid input.cell-input') && document.querySelector('.grid input.cell-input').value.endsWith('X'))",
          ),
        ),
      );
      await pressEnter();
      check('回车后输入框收起', Boolean(await waitFor(`!${VISIBLE_EDITOR}`, 3000)));
      check('改动被标记为未提交', Boolean(await waitFor(`(${VISIBLE_TEXT}).includes('未提交的改动')`)));
      check(
        '单元格显示新值',
        await evaluate(
          `[...(${VISIBLE_WORKSPACE} ? ${VISIBLE_WORKSPACE}.querySelectorAll('.grid tbody tr td') : [])].some((cell) => cell.innerText.endsWith('X'))`,
        ),
      );

      const untouched = await evaluate(`(async () => {
        const token = localStorage.getItem('db-tool-token') ?? '';
        const headers = { 'content-type': 'application/json', 'x-db-tool-token': token };
        const list = await (await fetch('/api/connections', { headers })).json();
        const connection = (list.connections ?? []).find((entry) => entry.name === ${JSON.stringify(SEED_NAME)});
        const response = await fetch('/api/connections/' + connection.id + '/query', {
          method: 'POST',
          headers,
          body: JSON.stringify({ db: ${JSON.stringify(MYSQL.database)}, sql: ${JSON.stringify(
            "SELECT COUNT(*) FROM users WHERE name LIKE '%X'",
          )} }),
        });
        const payload = await response.json();
        return payload.results[0].rows[0][0];
      })()`);
      check('未提交前数据库未被改动', untouched === '0', untouched);
    }
  }

  console.log('\n未提交改动守卫');
  check(
    '标签页标出未提交改动',
    Boolean(await waitFor("Boolean(document.querySelector('.tab .tab__dot--dirty'))")),
  );
  const dialogBefore = client.dialogs.length;
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((node) => node.innerText.includes('users'));
    const close = tab ? tab.querySelector('.tab__close') : null;
    if (close) close.click();
    return Boolean(close);
  })()`);
  await sleep(700);
  const guardDialog = client.dialogs[dialogBefore];
  check('关闭标签页前弹出确认', Boolean(guardDialog) && guardDialog.message.includes('未提交'), guardDialog);
  check('取消后标签页仍然存在', await evaluate("document.body.innerText.includes('▤ users')"));
  check('改动仍标记为未提交', await evaluate("Boolean(document.querySelector('.tab .tab__dot--dirty'))"));

  console.log('\nSQL 查询标签页');
  await clickByText('新建 SQL 查询');
  check('打开了 SQL 标签页', Boolean(await waitFor(`(${VISIBLE_TEXT}).includes('运行')`)));
  check('编辑器已挂载', Boolean(await waitFor(`Boolean(${VISIBLE_WORKSPACE} && ${VISIBLE_WORKSPACE}.querySelector('.cm-editor'))`)));

  console.log('\n在界面里执行 SQL');
  const editorPoint = await evaluate(`(() => {
    const workspace = ${VISIBLE_WORKSPACE};
    const content = workspace && workspace.querySelector('.cm-content');
    if (!content) return null;
    const box = content.getBoundingClientRect();
    return { x: Math.round(box.x + 80), y: Math.round(box.y + 16) };
  })()`);
  check('定位到 SQL 编辑器', Boolean(editorPoint), editorPoint);

  if (editorPoint) {
    let typed = false;
    for (let attempt = 0; attempt < 3 && !typed; attempt++) {
      await clickAt(editorPoint, 1);
      await sleep(250);
      await client.send('Input.insertText', { text: 'SELECT id, name, score FROM users ORDER BY id;' });
      typed = Boolean(await waitFor(`(${VISIBLE_TEXT}).includes('SELECT id, name, score')`, 1500));
    }
    check('SQL 已输入编辑器', typed);

    if (typed) {
      await pressEnter(2); // Ctrl + Enter
      check('查询结果渲染成表格', (await waitFor(VISIBLE_GRID_ROWS, 8000)) >= 3, await evaluate(VISIBLE_GRID_ROWS));
      check('结果区显示返回行数', Boolean(await waitFor(`(${VISIBLE_TEXT}).includes('返回')`)));

      await client.send('Input.insertText', { text: ' SELECT * FROM nope_missing_table;' });
      await sleep(300);
      await pressEnter(2);
      check('错误 SQL 在界面里报错', Boolean(await waitFor(`(${VISIBLE_TEXT}).includes('执行失败')`, 8000)));

      // A runaway statement must be stoppable from the toolbar.
      await selectAllInEditor();
      await sleep(200);
      await client.send('Input.insertText', { text: 'SELECT SLEEP(30);' });
      await sleep(300);
      await clickByText('▶ 运行');
      check('运行中按钮变成停止', Boolean(await waitFor(`(${VISIBLE_TEXT}).includes('停止')`, 5000)));
      await sleep(1200);
      await clickByText('■ 停止');
      check(
        '停止后显示已取消',
        Boolean(await waitFor(`(${VISIBLE_TEXT}).includes('已取消')`, 8000)),
        await evaluate(VISIBLE_TEXT),
      );
    }
  }

  console.log('\n控制台');
  check('渲染进程没有报错', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  check(
    '桌面桥接已注入（关窗守卫可用）',
    (await evaluate("typeof window.dbToolShell?.setDirtyState")) === 'function',
    await evaluate("typeof window.dbToolShell?.setDirtyState"),
  );

  console.log('\n新建连接对话框');
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.sidebar__head button')]
      .find((node) => node.getAttribute('title') === '新建连接');
    if (button) button.click();
    return Boolean(button);
  })()`);
  check('对话框已打开', Boolean(await waitFor("Boolean(document.querySelector('.overlay #conn-name'))")));
  check(
    '新建时连接名称已预填',
    (await evaluate("document.querySelector('.overlay #conn-name').value")) === '本地 MySQL',
    await evaluate("document.querySelector('.overlay #conn-name').value"),
  );

  await pickOption('.overlay #conn-kind', 'postgres');
  await sleep(250);
  check(
    '切到 PostgreSQL 后用户名建议为 postgres',
    (await evaluate("document.querySelector('.overlay #conn-user').value")) === 'postgres',
    await evaluate("document.querySelector('.overlay #conn-user').value"),
  );
  check(
    '端口同步为 5432',
    (await evaluate("document.querySelector('.overlay #conn-port').value")) === '5432',
    await evaluate("document.querySelector('.overlay #conn-port').value"),
  );
  check(
    '名称跟着类型变为 本地 PostgreSQL',
    (await evaluate("document.querySelector('.overlay #conn-name').value")) === '本地 PostgreSQL',
    await evaluate("document.querySelector('.overlay #conn-name').value"),
  );

  await setField('#conn-user', 'dba');
  await setField('#conn-name', '生产库');
  await pickOption('.overlay #conn-kind', 'mysql');
  await sleep(250);
  check(
    '手填的用户名不会被切换覆盖',
    (await evaluate("document.querySelector('.overlay #conn-user').value")) === 'dba',
    await evaluate("document.querySelector('.overlay #conn-user').value"),
  );
  check(
    '手填的名称不会被切换覆盖',
    (await evaluate("document.querySelector('.overlay #conn-name').value")) === '生产库',
    await evaluate("document.querySelector('.overlay #conn-name').value"),
  );
  check(
    '端口随类型回到 3306',
    (await evaluate("document.querySelector('.overlay #conn-port').value")) === '3306',
    await evaluate("document.querySelector('.overlay #conn-port').value"),
  );

  await setField('#conn-name', '');
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.overlay .modal__foot button')]
      .find((node) => node.innerText.trim() === '保存');
    if (button) button.click();
    return Boolean(button);
  })()`);
  await sleep(700);
  check(
    '名称为空时在字段下方提示',
    (await evaluate(`(() => { const node = document.querySelector('.overlay .field-error'); return node ? node.innerText.trim() : null; })()`)) ===
      '连接名称不能为空',
    await evaluate(`(() => { const node = document.querySelector('.overlay .field-error'); return node ? node.innerText.trim() : null; })()`),
  );
  check(
    '没有把空名称提交到服务端',
    (await evaluate("Boolean(document.querySelector('.overlay .panel-message--error'))")) === false,
  );
  check('焦点落到出错的字段', (await evaluate('document.activeElement.id')) === 'conn-name', await evaluate('document.activeElement.id'));
  check('对话框保持打开', await evaluate("Boolean(document.querySelector('.overlay'))"));

  await evaluate("document.querySelector('.overlay .modal__head button').click()");
  check('对话框可以关闭', Boolean(await waitFor("!document.querySelector('.overlay')", 3000)));

  console.log('\n清理');
  const cleaned = await evaluate(`(async () => {
    const token = localStorage.getItem('db-tool-token') ?? '';
    const headers = { 'content-type': 'application/json', 'x-db-tool-token': token };
    const list = await (await fetch('/api/connections', { headers })).json();
    let removed = 0;
    for (const connection of list.connections ?? []) {
      if (connection.name !== ${JSON.stringify(SEED_NAME)}) continue;
      await fetch('/api/connections/' + connection.id + '/history', { method: 'DELETE', headers });
      await fetch('/api/connections/' + connection.id, { method: 'DELETE', headers });
      removed += 1;
    }
    return removed;
  })()`);
  check('自检连接已清理', cleaned >= 1, cleaned);

  client.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\n桌面端检查失败:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
