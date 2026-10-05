# AgentDeck

当前版本聚焦本机 MCP、插件和 Skill 的分类、范围、Agent 归属、来源与配置状态。列表支持受支持资源的单项启停，并保留预览、备份和恢复；不支持的资源保持只读。客户端适用性和实时运行状态功能已取消。跨 Agent 转移、插件安装更新、批量操作和桌面壳不在当前范围。

Codex、ZCode、Claude Code 和 DeepSeek Harness 的部分用户级配置支持单项启停；Codex Skill 与插件写入限定已验证的 CLI 0.159.2 / Windows。其他资源和未验证范围只读。

## 快速开始

需要 Node.js 24.7.0 和 pnpm 11.22.0。在仓库根目录运行：

```sh
pnpm install
pnpm dev
```

开发服务只绑定本机：API 为 `127.0.0.1:4780`，网页为 `127.0.0.1:5173`。终端会打印一次性连接链接；打开它后，浏览器兑换本机会话，并用 CSRF token 保护写请求。

开发数据和默认扫描 home 位于 `work/dev-data` 与 `work/dev-data/home`，隔离演示文件位于 `work/demo`。可用 `AGENTDECK_DEV_HOME` 指定开发扫描 home。生产时用 `AGENTDECK_HOME` 指定管理器数据目录，或用 `USER_HOME` / `AGENTDECK_USER_HOME` 指定扫描 home。客户端自己的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`DSH_HOME` 等环境变量仍可选择客户端配置根目录。

首次打开资源页，点击“发现并扫描本机资源”读取当前用户的实际客户端配置；这会跳过开发模式默认的隔离扫描目录。扫描结果保存到本地索引，真实配置不会被改写。“重新扫描已登记实例”刷新已经接入的实例；未选项目时同时刷新全部明确登记的项目，不寻找未登记项目。也可以载入隔离演示数据体验交互。

自动发现与手动登记默认允许已支持资源的单项启停，无需额外开放按钮；可显式登记只读。演示目标使用独立文件。Codex CLI 0.159.2 / Windows 的独立用户级 STDIO MCP 已在隔离配置根完成配置复读与恢复验收。真实配置未用于写入，运行时生效未验证。未匹配版本或范围的能力保持只读。原始计划字节和恢复快照可能含秘密；数据目录使用 Windows ACL 继承，没有额外加密或 ACL 设置。请将 `AGENTDECK_HOME` 放在仅当前用户可访问的位置。

AgentDeck is a local web manager for viewing and classifying Agent configuration instances, projects, Skills, plugins, and MCP entries. It provides four scanners and guarded single-resource configuration switches where the client format is verified, with preview, backup, conflict checks, and restore.

Read-only configuration and plugin cache layouts have been checked on this Windows machine. Codex CLI 0.159.2 has passed native configuration reread and toggle/restore validation for independent user STDIO MCP entries in isolated configuration roots. Runtime activation remains unverified. Supported single-resource switches are allowed by default for discovered and registered instances; an explicit read-only choice is respected. A write plan still requires a verified toggle target. The demo has a separate, isolated Codex target. The app does not start Skills, plugins, or MCP processes. An explicit version check runs only the supported CLI's bounded `--version` command in an isolated environment.

插件缓存按市场、插件身份与版本建立父子索引。资源页可区分缓存、配置记录和本地文件；详情展示资源配置状态、关联配置证据、缓存状态、实际存放位置和分类依据。登记项目后点击项目卡片的“扫描项目”，读取该项目范围的候选配置和 Skills；项目配置及插件资源保持只读。

资源归类分为用户全局来源、项目公共来源、Agent 全局资源、Agent 项目资源、待确定；存放归属与配置/使用范围分开。用户全局不代表所有 Agent 共用，所属 Agent 不表示内容专用；共享来源需要同一实际来源的多 Agent 索引证据。

实例页提供客户端兼容报告，区分已识别 CLI、未验证的可执行候选、仅有配置、未发现和隔离演示。显式检查版本后，证据按可执行路径及文件身份保存；替换、删除或检查失败使旧证据失效。静态扫描、夹具与原生配置证据分别展示，不评估资源内容适用性。检查版本不会开放写入许可。

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
- `POST /api/v1/plans` — prepare a supported Codex or ZCode resource configuration toggle; the returned plan contains a redacted diff and digest.
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

Configuration controls are limited to the supported single-resource targets. Sample tests do not count as native validation against an installed client version.
