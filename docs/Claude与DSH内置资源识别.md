# Claude 与 DSH 内置资源识别

审查修正（2026-10-04）：修复仅凭 Skill 正文相同改标及隐藏绑定、结构行误计插件、元数据链接边界不足；补齐静态随包 MCP 反例测试。此前 216 条插件行的统计已被本节修正结果替代。

更新：2026-10-04。继[ZCode 内置资源识别](./ZCode内置资源识别.md)后，为 Claude Code 与 DeepSeek Harness 补齐"Agent 内置资源"识别。两家均不采用 ZCode 的安装布局，按各自真实发布形态分别核对；有可靠证据才标内置，识别不出或证据不足的部分如实报告缺口，不强行实现。

## 通用规则

- 内置来源是来源类型，复用网页"Agent 内置"筛选与详情中的 `builtinSourcePath` 证据路径；与所属 Agent、作用范围、配置状态分开，不证明已启用或当前会话加载。
- 安装目录与随包原文只读；不启动客户端、模型、Skill、插件、hook 或 MCP。
- 只核对明确入口（配置根的直接子目录与登记的安装位置），不全盘寻找安装目录。
- 同名、多版本、用户/项目与独立安装路径的绑定分别保留。仅 SKILL.md 或清单层文本相同不足以证明整份资源相同，不改标用户来源、不合并独立路径。符号链接安装副本仍按既有安全边界跳过。
- 内置来源不改变配置状态规则：随包记录一律"未确定"，不开放新的启停能力。

## DeepSeek Harness：有可靠证据，已补齐

本机 DSH 安装不在独立桌面目录，而是位于配置根 `~/.dsh` 下：`app/node_modules/@deepseek-ai/`（app 安装根）与 `profiles/node_modules/@deepseek-ai/`（profile 级安装根，本机多数包是指向 app 根的符号链接）。安装身份以 `dsh/package.json` 的完整包名 `@deepseek-ai/dsh` 与版本（本机 0.1.7-rc.2）验证，包名或版本缺失的目录不扫描。扫描器只读这两个显式根，不做磁盘搜索。

随包 Skill（6 条，均为文件系统原文，状态未确定）：

- `dsh-skill-office/assets/{office-docx,office-pptx,office-xlsx}/SKILL.md`：随包提供方代码以包内 `assets/` 目录注册 `source: "bundled"` 的 Skill（rank 600），`package.json` `files` 含 `assets`。机制经随包 `lib/index.js` 静态核实。
- `dsh-agent-preset/skills/{cordis-composition-reference,cordis-plugin-development,editing-cordis-compositions}/SKILL.md`：随包 README 载明经 skill-filesystem 在 creator mode 挂载；挂载条件是动态行为，静态盘点未验证（记录中已注明）。

随包插件声明（审查修正后 186 条行声明）：随包 bundle 层 `dsh-base/cordis.patch.yml`、`dsh-sdk-app/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml` 及 `dsh-web-app/presets/*.patch.yml` 的静态插件名行；结构分组与动态名称不计为插件，缺少静态 id 时保留有限行位置身份。每条记录标注所在层文件与包存在性；`disabled` 为动态表达式或非布尔值时状态未确定，静态 `disabled: true` 也只是随包默认层，可被后续层覆盖。行声明不是独立启用开关。

关联核对：用户及项目 Skill 即使同名且 SKILL.md 摘要一致，也只增加相同正文的诊断说明；辅助文件未比较，来源和独立路径绑定保持原样，随包记录照常保留。独立安装路径中的相同清单层也分别保存，文本相同不证明解析依赖和版本相同。随包插件行不反标用户 profile 行，运行时解析版本尚未证实。旧 node_modules-old-rc6 目录仍不扫描。

随包 MCP：bundle 层无 `@deepseek-ai/dsh-mcp-client` 行、无静态 `serverName` 声明，本机没有可核实的随包 MCP 服务器；扫描器可盘点其他版本随包层中的静态 dsh-mcp-client/serverName；动态名称不推断，也不执行。用户 MCP 的既有 profile 扫描保持不变。

## Claude Code：本机无可靠机制，明确报告缺口

本机为原生单文件安装：`~/.local/share/claude/versions/`（2.1.126.exe、2.1.266）加 `~/.local/bin/claude.exe` 启动器，无随包资源树或可读清单。二进制内可能嵌有内置内容，但无法静态枚举清单、路径或版本，不强行解析。

`~/.claude/plugins/cache/claude-plugins-official/gopls-lsp/1.0.0` 是市场安装缓存（`installed_plugins.json` 记录 user scope、版本与 gitCommitSha），`plugins/marketplaces/*` 是 GitHub 市场克隆；二者均为下载物，不能仅凭官方市场名或安装目录位置判为内置，保持原来源。因此本轮未为 Claude Code 标记任何内置记录，也未新增扫描入口。

## 验证

- 隔离测试 `tests/dsh-builtin.test.ts`：随包资源盘点、独立安装路径保留、用户/项目副本与辅助文件差异、结构分组及动态名称排除、元数据身份与链接边界、静态随包 MCP、旧目录不扫及无效安装根拒绝；全程文件树摘要不变。
- 既有 YAML 行解析助手抽到 `packages/adapters/src/dsh-patch.ts`，用户 profile 扫描行为不变，既有测试全部通过。
- 本机有限只读核对（`work/dsh-builtin-audit.ts`，Git 忽略）：审查修正后 DSH 扫描 201 条绑定，其中内置 192 条（Skill 6、插件声明行 186、MCP 0）；这些行来自不同配置层，不是 186 个独立已安装插件，82 个来源文件摘要扫描前后不变；`unchanged: true`。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、浏览器套件 6 通过/1 跳过、全量单元测试 146 通过/4 跳过。

剩余缺口：DSH 随包 Skill 的 creator mode 挂载条件、插件行到 profile 层叠后的生效状态、行引用包的实际解析版本均未静态证实，状态保持未确定；Claude Code 内置资源需要官方提供可静态核实的随包清单机制后才能补齐；组织同步与额外安装布局继续未知。
