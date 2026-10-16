# DB Tool

一个本地优先的数据库管理工具，同时支持 **MySQL / MariaDB** 与 **PostgreSQL**。
可以当成网页应用在浏览器里用，也可以打包成 Windows 桌面客户端（Electron）。

## 功能

- **连接管理**：多套连接并存，密码用本机密钥加密后保存在本地，界面里永远不回显。
- **库表浏览**：数据库 → 表 / 视图 → 字段结构，带主键、自增、注释标记。
- **SQL 编辑器**：语法高亮、`Ctrl / ⌘ + Enter` 执行、多语句分结果集、行数与耗时统计、查询历史。
- **表数据浏览与编辑**：分页、排序、`WHERE` 过滤、双击单元格改值、新增行、删除行，改动在一个事务里提交。
- **导出**：结果集或整张表导出 CSV（带 UTF-8 BOM，Excel 直接可读）/ JSON，大表分块流式写出。
- **安全模式**：拦截没有 `WHERE` 的 `UPDATE / DELETE / DROP / TRUNCATE`，确认后才执行；可按连接关闭。

## 环境要求

- Node.js 20 以上（开发用 Node 24 验证）
- 目标数据库：MySQL 5.7+/8.x 或 PostgreSQL 10+

## 快速开始（浏览器里用）

```bash
npm install
npm run build
npm start
```

然后打开 http://127.0.0.1:4173 。

## 开发模式

```bash
npm run dev          # 后端 4173 热重启 + 前端 5173 热更新
```

前端访问 http://127.0.0.1:5173 ，`/api` 会代理到后端。

## 桌面客户端

```bash
npm run desktop      # 构建后用 Electron 打开
npm run dist         # 打包出安装包与免安装版，产物在 release/
```

`npm run dist` 会生成：

- `DB Tool-0.1.0-setup.exe`：NSIS 安装包，可自选安装目录、创建桌面快捷方式
- `DB Tool-0.1.0-portable.exe`：免安装单文件

桌面版启动时会在本机随机端口拉起一个只监听 `127.0.0.1` 的服务，并带一次性访问令牌；数据目录固定在系统用户数据目录，与开发模式互不影响。

### 关于未签名安装包

打包产物是**未签名**的。如果运行构建的机器启用了 Smart App Control（`设置 → 隐私和安全性 →
Windows 安全中心 → 应用和浏览器控制 → 智能应用控制`），Windows 会直接拦截这两个 exe，报
`An Application Control policy has blocked this file`。可选的出路：

- 给构建产物做代码签名（electron-builder 的 `win.certificateFile` / `win.certificatePassword`）；
- 或者直接用 `release/win-unpacked/` 里的解包目录，主程序继承了 Electron 的已知信誉，通常不会被拦；
- 关闭 Smart App Control 要谨慎：一旦关闭，只能通过重装系统才能重新打开。

这个策略是按机器生效的，在没启用该策略的机器上安装包可以直接双击运行。

## 自检

```bash
# 接口层端到端（需要一个可连的 MySQL）
SMOKE_MYSQL_PASSWORD=你的密码 npm run smoke

# 桌面界面端到端（真实点击、真实执行 SQL）
node_modules/.bin/electron . --remote-debugging-port=9222
SMOKE_MYSQL_PASSWORD=你的密码 node scripts/desktop-e2e.mjs
```

脚本里的连接名固定为 `自检连接 MySQL`，跑完会自动清理，不会留下垃圾连接。

## 目录结构

```
server/   本地 API：连接管理、SQL 执行、表结构读取、行编辑、导出
web/      React 界面：侧边栏、SQL 编辑器、数据表格（虚拟滚动）
electron/ 桌面外壳：负责拉起本地服务并打开窗口
scripts/  自检脚本与图标生成
build/    打包用图标资源
```

## 数据与安全

- 保存的连接在 `<用户数据目录>/connections.json`，密码字段用 AES-256-GCM 加密，密钥是同目录下的 `secret.key`。
  **请勿把 `data/` 或 `secret.key` 提交到版本库或分享出去。**
- 服务只绑定 `127.0.0.1`，局域网内其他机器访问不到。
- 连接信息与查询历史都不出本机，没有任何遥测。

## 构建脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 前后端开发模式 |
| `npm run build` | 编译后端 + 打包前端 |
| `npm start` | 启动已编译的服务（同时托管前端） |
| `npm run desktop` | 构建并启动桌面应用 |
| `npm run dist` | 生成 Windows 安装包 / 免安装版 |
| `npm run typecheck` | 前后端类型检查 |
| `npm run smoke` | 接口端到端自检 |
| `npm run icon` | 重新生成应用图标 |
