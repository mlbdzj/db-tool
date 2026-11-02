# DB Tool

[English](README.md) · [简体中文](README.zh-CN.md)

一个本地优先的**桌面**数据库客户端，同时支持 **MySQL / MariaDB** 与 **PostgreSQL**。

界面是随应用打包的 Electron 窗口：UI 通过私有的 `app://` 协议加载，本地服务只在 `127.0.0.1`
上提供 HTTP API。项目**没有网页版**——用普通浏览器打开服务地址只会看到空内容，而且每个接口
都要求一个只有应用自己知道的一次性令牌。

## 功能

- **连接管理**：多套连接并存，密码用本机密钥加密后保存在本地，接口里永远不回显。
- **库表浏览**：数据库 → 表 / 视图 → 字段结构，带主键、自增、注释标记。
- **SQL 编辑器**：语法高亮、`Ctrl / ⌘ + Enter` 执行、多语句分结果集、行数与耗时统计、可取消的查询、查询历史。
- **表数据浏览与编辑**：分页、排序、`WHERE` 过滤、双击单元格改值、新增行、删除行，改动在一个事务里提交。
- **导出**：结果集或整张表导出 CSV（带 UTF-8 BOM，Excel 直接可读）/ JSON，大表分块流式写出。
- **安全模式**：拦截没有 `WHERE` 的 `UPDATE / DELETE / DROP / TRUNCATE`，确认后才执行；可按连接关闭。

## 环境要求

- Node.js 20 以上（开发用 Node 24 验证）
- 目标数据库：MySQL 5.7+/8.x 或 PostgreSQL 10+

## 运行应用

```bash
npm install
npm run desktop      # 构建服务与界面，然后打开窗口
```

打包安装包：

```bash
npm run dist         # 产物在 release/
```

`npm run dist` 会生成：

- `DB Tool-0.1.0-setup.exe`：NSIS 安装包，可自选安装目录、创建桌面快捷方式
- `DB Tool-0.1.0-portable.exe`：免安装单文件

## 开发模式

```bash
npm run dev:desktop  # 接口热重启 + 界面热更新，然后拉起 Electron
```

它实际会跑 `npm run dev:server`（tsx watch 跑接口）和 `npm run dev:web`（Vite 跑在
`127.0.0.1:5173`），再带上 `DB_TOOL_DEV_URL` 启动 Electron：窗口加载开发服务器，
接口请求走它的 `/api` 代理。

接口端口由 `DB_TOOL_PORT` 控制（默认 `3000`，填 `0` 表示由系统分配空闲端口）；
开发代理目标由 `DB_TOOL_API` 控制（默认 `http://127.0.0.1:3000`）。

## 窗口如何连到服务

启动时应用会在系统分配的空闲端口上拉起编译好的服务，只监听 `127.0.0.1`，同时生成一次性访问
令牌，并通过 preload 桥（`window.dbToolShell`）交给渲染层。窗口本身始终从 `app://db-tool`
加载，不经过服务，所以服务端没有界面可托管，也就不存在浏览器客户端。

数据目录固定在系统用户数据目录，与开发模式互不影响。

### 关于未签名安装包

打包产物是**未签名**的。如果运行它的机器启用了 Smart App Control（`设置 → 隐私和安全性 →
Windows 安全中心 → 应用和浏览器控制 → 智能应用控制`），Windows 会直接拦截这两个 exe，报
`An Application Control policy has blocked this file`。可选的出路：

- 给构建产物做代码签名（electron-builder 的 `win.certificateFile` / `win.certificatePassword`）；
- 或者直接用 `release/win-unpacked/` 里的解包目录，主程序继承了 Electron 的已知信誉，通常不会被拦；
- 关闭 Smart App Control 要谨慎：一旦关闭，只能通过重装系统才能重新打开。

这个策略是按机器生效的，在没启用该策略的机器上安装包可以直接双击运行。

## 自检

```bash
# 接口层端到端（需要一个可连的 MySQL，且 :3000 上有服务在跑）
SMOKE_MYSQL_PASSWORD=你的密码 npm run smoke

# 桌面界面端到端（真实点击、真实执行 SQL）
node_modules/.bin/electron . --remote-debugging-port=9222
SMOKE_MYSQL_PASSWORD=你的密码 node scripts/desktop-e2e.mjs
```

两个脚本里的连接名固定为 `自检连接 MySQL`，跑完会自动清理，不会留下垃圾连接。

## 目录结构

```
server/   本地 API：连接管理、SQL 执行、表结构读取、行编辑、导出
web/      React 渲染层：侧边栏、SQL 编辑器、数据表格（虚拟滚动）
electron/ 桌面外壳：app:// 加载界面、拉起本地服务、IPC 桥
scripts/  开发启动器与自检脚本
build/    打包用图标资源
```

## 数据与安全

- 保存的连接在 `<用户数据目录>/connections.json`，密码字段用 AES-256-GCM 加密，密钥是同目录下的 `secret.key`。
  **请勿把 `data/` 或 `secret.key` 提交到版本库或分享出去。**
- 服务只绑定 `127.0.0.1`，局域网内其他机器访问不到。
- 窗口从不通过 HTTP 加载界面，接口会拒绝没有本次启动令牌的请求。
- 连接信息与查询历史都不出本机，没有任何遥测。

## 构建脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev:desktop` | 桌面应用开发模式 |
| `npm run desktop` | 构建并启动桌面应用 |
| `npm run dist` | 生成 Windows 安装包 / 免安装版 |
| `npm run build` | 编译接口 + 打包界面 |
| `npm start` | 只跑编译后的接口（不开窗口） |
| `npm run typecheck` | 接口与界面类型检查 |
| `npm run smoke` | 接口端到端自检 |
| `npm run icon` | 重新生成应用图标 |

---

要加别的语言？复制一份 `README.md` 翻译，然后在每个 README 顶部的语言切换行里补上链接。
