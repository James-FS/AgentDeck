# AgentDeck

AgentDeck 是一个运行在本机的 Web 工具，用于发现和管理 Codex、ZCode、Claude Code 与 DeepSeek Harness 的部分本地 Skill、插件和 MCP 配置。它会扫描配置并展示资源来源、作用范围、Agent 归属及可识别的启用状态；它不会启动 MCP 服务、Skill 或插件进程。

## 当前功能

- 自动发现客户端配置，或手动登记实例和项目；扫描用户配置及已登记项目。
- 对 Skill、插件和 MCP 配置进行分类，查看配置记录、插件缓存、来源路径和关联证据。
- 查看客户端与版本识别报告。显式版本检查只对 Codex 和 Claude Code 的可执行候选，在隔离临时目录中运行受限 `--version` 命令；检查结果不会自动开放写入。
- 对明确支持的单项配置创建预览计划，再应用变更；操作记录支持基于备份生成恢复计划。
- 加载隔离的演示数据体验界面。

### 写入范围

扫描到资源不代表该资源可写。项目级配置和未验证的资源保持只读。当前支持的范围如下：

- **ZCode**：支持部分用户级 Skill、已配置或已安装插件，以及独立 MCP 的启停。
- **Codex**：独立的用户级 MCP 启停不要求版本验证，当前按实验性支持开放；用户配置根中的 Skill 覆盖和本地市场插件，仅支持已检查为 **Codex CLI 0.159.2 / Windows** 的实例。
- **Claude Code**：支持部分用户级插件启用状态开关；Skill、MCP 和项目级配置保持只读。
- **DeepSeek Harness**：支持部分用户级 `cordis.patch.yaml` 插件行的 `disabled` 开关；项目级条目、管理器必需组件及插件附带 MCP 保持只读。

具体资源是否可写还取决于其配置格式、来源和扫描结果。所有变更都需先创建并确认计划；隔离演示配置与真实客户端配置分开。Codex 原生验收仅覆盖隔离配置根中的独立用户级 STDIO MCP 配置读写与恢复，不代表运行中的客户端已加载变更。

## 环境要求

- Node.js `>=22.12.0`；仓库 `.nvmrc` 指定 `24.7.0`。
- pnpm `11.22.0`（由根目录 `package.json` 固定）。

## 开发运行

在仓库根目录执行：

```sh
pnpm install
pnpm dev
```

开发模式启动本地 API 和 Vite 页面：API 默认监听 `127.0.0.1:4780`，页面监听 `127.0.0.1:5173`。终端会打印一次性连接链接；使用该链接打开页面并建立本机会话。写请求受 CSRF token 保护。

开发数据默认保存在 `work/dev-data`，隔离扫描 home 位于 `work/dev-data/home`，演示配置位于 `work/demo`。可设置 `AGENTDECK_DEV_HOME` 更换开发扫描 home。开发时使用隔离目录，不要把演示或测试操作指向真实用户目录。

## 构建与启动

```sh
pnpm build
pnpm start
```

生产模式下，服务只监听回环地址 `127.0.0.1`，并由同一服务提供构建后的 Web 页面和 `/api/v1` API。默认端口为 `4780`，可通过 `PORT` 修改。启动前需要先构建。

也可用命令行入口启动 Web 服务（同样需要先构建完整项目）：

```sh
pnpm build
node apps/cli/dist/index.js serve
```

CLI 当前仅提供 `serve [--port=4780]`，不提供独立资源管理命令。

## 数据与配置目录

- `AGENTDECK_HOME`：指定 AgentDeck 的应用数据目录，包含本地 SQLite 数据库、变更计划及备份/恢复所需数据。
- 未设置 `AGENTDECK_HOME` 时，生产数据默认位于 Windows `%LOCALAPPDATA%\AgentDeck`、macOS `~/Library/Application Support/AgentDeck`，或 Linux `$XDG_DATA_HOME/agentdeck`（未设置时为 `~/.local/share/agentdeck`）。开发数据默认位于仓库的 `work/dev-data`。
- `USER_HOME` 或 `AGENTDECK_USER_HOME`：指定主动发现扫描所使用的用户 home。生产环境默认使用当前操作系统用户的 home；开发环境默认使用隔离扫描目录。`AGENTDECK_DEV_HOME` 只用于开发环境。
- `CODEX_HOME`、`ZCODE_HOME`、`CLAUDE_CONFIG_DIR`、`DSH_HOME`：可分别指定对应客户端的配置根目录。

AgentDeck 的操作计划和备份可能包含原始配置字节及敏感信息，并以明文保存在应用数据目录。请将该目录放在仅可信用户可访问的位置；程序不负责加密数据或配置专用文件 ACL。

## API 概览

API 前缀为 `/api/v1`。常用路由：

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 本机服务状态和版本 |
| `GET` | `/api/v1/adapters`、`/api/v1/catalog` | 适配器能力与资源目录 |
| `GET` | `/api/v1/compatibility` | 客户端识别和能力证据 |
| `POST` | `/api/v1/instances`、`/api/v1/projects` | 登记配置实例或项目 |
| `POST` | `/api/v1/scans` | 发现或扫描已登记资源 |
| `POST` | `/api/v1/instances/:id/version-check` | 主动检查客户端版本 |
| `POST` | `/api/v1/demo` | 创建或刷新隔离演示目录 |
| `POST` | `/api/v1/plans`、`/api/v1/plans/:id/apply` | 创建和应用单项变更计划 |
| `GET` | `/api/v1/operations`、`POST /api/v1/operations/:id/restore-plan` | 查看操作记录并准备恢复计划 |
| `GET` | `/api/v1/events` | 接收目录和操作更新事件（SSE） |

除 `/health` 和一次性会话引导接口外，API 需要本机会话。服务拒绝非本机连接，不开放通用 CORS。目录 API 返回结构化元数据，不返回原始配置文档或凭据。

## 开发检查

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

浏览器测试由 Playwright 驱动，需要本机已安装 Edge 或 Chrome；也可通过 `AGENTDECK_BROWSER_PATH` 指定浏览器可执行文件。浏览器测试报告、截图和临时数据写入被 Git 忽略的 `work/` 目录。

## 项目结构

- `apps/web`：Vue Web 界面。
- `apps/server`：Fastify 本机服务与 API。
- `apps/cli`：启动本机 Web 服务的命令行入口。
- `packages/adapters`：四种客户端的发现与扫描适配器。
- `packages/core`：目录、发现、扫描和版本识别服务。
- `packages/change-engine`：配置变更计划、应用和恢复。
- `packages/contracts`、`packages/storage`：共享类型与本地 SQLite 存储。
- `fixtures`、`tests`：扫描夹具、单元测试和浏览器测试。
