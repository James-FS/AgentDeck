# AgentDeck

初期版本聚焦已有 MCP、插件和 Skill 的查看、来源/范围/配置状态、经验证的单项启停，以及变更预览、备份和恢复。没有原生依据的控制能力明确只读。组合分发、导入部署、主动诊断、安装更新、桌面壳、多平台和 SDK 初期不实现；详细范围见 [实施方案](docs/实施方案.md)和[开发任务清单](docs/开发任务清单.md)。

基础版现已支持 Codex 配置根独立 Skill 和已配置的本地市场插件整体开关，限定已检查的 CLI 0.159.2 / Windows、手动明确可写实例；复用预览、备份、冲突检测与精确恢复，不修改 Skill 原文或插件缓存。启动和支持范围见 [基础版使用与验收](docs/基础版使用与验收.md)。

## 快速开始

需要 Node.js 24.7.0 和 pnpm 11.22.0。在仓库根目录运行：

```sh
pnpm install
pnpm dev
```

开发服务只绑定本机：API 为 `127.0.0.1:4780`，网页为 `127.0.0.1:5173`。终端会打印一次性连接链接；打开它后，浏览器兑换本机会话，并用 CSRF token 保护写请求。

开发数据和默认扫描 home 位于 `work/dev-data` 与 `work/dev-data/home`，隔离演示文件位于 `work/demo`。可用 `AGENTDECK_DEV_HOME` 指定开发扫描 home。生产时用 `AGENTDECK_HOME` 指定管理器数据目录，或用 `USER_HOME` / `AGENTDECK_USER_HOME` 指定扫描 home。客户端自己的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`DSH_HOME` 等环境变量仍可选择客户端配置根目录。

首次打开资源页，点击“发现并扫描本机资源”读取当前用户的实际客户端配置；这会跳过开发模式默认的隔离扫描目录。扫描结果保存到本地索引，真实配置不会被改写。“重新扫描已登记实例”只刷新已经接入的目录。也可以载入隔离演示数据体验交互。

自动发现的实例只读。只有手动登记并明确勾选可写的 Codex 实例可生成受支持的独立 MCP 计划；演示目标使用独立文件。本机只读配置与插件缓存布局已经核对，见 [只读扫描兼容验证](docs/只读扫描兼容验证.md)。实际 Codex CLI 0.159.2 已在 Windows 隔离配置根完成独立用户级 STDIO MCP 的启停、原生复读与恢复验收，见 [客户端兼容与原生验收](docs/客户端兼容与原生验收.md)；用户真实配置仍未作为写入目标，运行时生效未验证。未匹配版本或范围的能力保持实验性或只读。原始计划字节和恢复快照可能包含秘密；当前保存为明文，没有额外加密或显式设置 Windows ACL，Windows 使用数据目录继承的系统 ACL。请将 `AGENTDECK_HOME` 放在仅当前用户可访问的位置，不要使用共享目录。

AgentDeck is a local web manager for viewing Agent configuration instances, projects, Skills, plugins, and MCP entries. The first release provides a Vue 3 interface, a Fastify local API, SQLite persistence, four read-only adapter scanners, and a guarded Codex MCP plan/apply/restore path.

Read-only configuration and plugin cache layouts have been checked on this Windows machine. Codex CLI 0.159.2 has additionally passed native configuration reread and toggle/restore validation for independent user STDIO MCP entries in isolated configuration roots; see [the native compatibility report](docs/客户端兼容与原生验收.md). Runtime activation remains unverified. Automatic discovery is read-only. A write plan is available only for an explicitly registered Codex configuration root marked writable, and only for a supported independent MCP entry. The demo has a separate, isolated Codex target. The app does not start Skills, plugins, or MCP processes. An explicit version check runs only the supported CLI's bounded `--version` command in an isolated environment.

插件缓存按市场、插件身份与版本建立父子索引。资源页可区分缓存、配置记录和本地文件；详情分别展示资源配置状态、关联配置证据、缓存状态与未知运行状态。登记项目后点击项目卡片的“扫描项目”，读取该项目范围的候选配置和 Skills；项目配置及插件资源保持只读。

实例页提供客户端兼容报告，区分已识别 CLI、未验证的可执行候选、仅有配置、未发现和隔离演示。显式检查版本后，证据按可执行路径及文件身份保存；替换、删除或检查失败使旧证据失效。静态扫描、夹具、原生配置和运行时证据分别展示。检查版本不会开放写入许可。机器可读验收矩阵位于 [docs/compatibility.json](docs/compatibility.json)。

## Requirements

- Node.js 24.7.0 (the workspace requires Node.js 22.12 or later)
- pnpm 11.22.0

Install the pinned workspace dependencies once:

```sh
pnpm install
```

## Development

Start the API and Vite UI together:

```sh
pnpm dev
```

The local API listens on `127.0.0.1:4780`; Vite listens on `127.0.0.1:5173`. The server prints a one-time startup link for the Vite page. Open that link to exchange its fragment ticket for a same-site HttpOnly session cookie. The browser then uses a CSRF token for writes.

Development state and the default scan home stay inside the repository at `work/dev-data` and `work/dev-data/home`. Set `AGENTDECK_DEV_HOME` to choose a different isolated development home. Do not point it at a real user home while testing.

The sample demo files are created under `work/demo`. If `AGENTDECK_HOME` is set, application data goes there and demo files are created in its `demo` directory. `POST /api/v1/demo` is idempotent and scans the actual sample files through the adapters, so the displayed toggle follows their current contents.

## Production build and start

Build the packages, server bundle, and Vue static files from the repository root:

```sh
pnpm build
pnpm start
```

The server binds to loopback only and serves the built UI and `/api/v1` from one origin. The default application data path follows the platform's local application-data directory. Set `AGENTDECK_HOME` to select an explicit state directory, and `USER_HOME` or `AGENTDECK_USER_HOME` to select the home directory used for an intentional discovery scan. `PORT` changes the local listen port; the default is `4780`.

## First-round API

The JSON API is under `/api/v1`. Useful routes are:

- `GET /health` — startup status and application version, without filesystem paths or credentials.
- `GET /api/v1/adapters` and `GET /api/v1/catalog` — adapter capabilities and the current local catalog.
- `GET /api/v1/compatibility` — client identity observations and capability evidence, including unregistered adapters.
- `POST /api/v1/instances/:id/version-check` with `{}` — explicitly query a supported CLI version in isolated state; command paths cannot be supplied by the browser.
- `POST /api/v1/instances` and `POST /api/v1/projects` — explicitly register a configuration root or project.
- `POST /api/v1/scans` — scan registered instances, optionally discover instances or select a project.
- `POST /api/v1/demo` — create or refresh the isolated example catalog.
- `POST /api/v1/plans` — prepare a Codex MCP toggle; the returned plan contains a redacted diff and digest.
- `POST /api/v1/plans/:id/apply` — apply the reviewed plan using its `afterHash` as `digest`.
- `GET /api/v1/operations` and `POST /api/v1/operations/:id/restore-plan` — inspect operations and prepare a restore plan.
- `GET /api/v1/events` — authenticated SSE updates for catalog and operation changes.

Success responses return their DTO directly. API errors use `{ "error": { "code", "message", "requestId?" } }`. Every API route except health and the one-time bootstrap exchange requires a browser session. The bootstrap ticket is held in server memory, expires, and can be redeemed once. Browser origins are limited to the service origin and, in explicit development mode, the Vite origin. The service does not enable general CORS.

Catalog responses include structured metadata and paths for registered configuration sources. They do not include raw configuration documents, environment credentials, or OAuth tokens. Full snapshots and prepared plans may contain secrets. They are stored as plaintext in the application data directory and are never returned through the browser API. Windows relies on the inherited directory ACL; AgentDeck does not currently set an explicit ACL or encrypt stored bytes.

## Available checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

Build before running the browser test because it starts the compiled server and serves `apps/web/dist`. Playwright uses an installed Edge or Chrome from its standard Windows path, or `AGENTDECK_BROWSER_PATH` if set. For example, in PowerShell: `$env:AGENTDECK_BROWSER_PATH='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'`. Browser artifacts and temporary data are written under the ignored `work/` directory.

The compatibility, write, and recovery limits in [`docs/首轮实施决策.md`](docs/首轮实施决策.md) and [`docs/实施方案.md`](docs/实施方案.md) describe the current scope. A local sample passing does not count as validation against an installed client version.
