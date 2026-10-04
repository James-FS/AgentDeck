# Skill 目录与开关核对

更新：2026-10-04。依据本机只读目录核对、现有扫描器和原生文档。仅扫描明确客户端根与登记项目；不执行客户端、Skill、hook、MCP，不以调用统计或日志推断开关。

## 扫描位置

| Agent | 用户级来源 | 已登记项目来源 | 配置状态来源 |
| --- | --- | --- | --- |
| Codex | 配置根 `skills`、`skills/.system`、用户 `.agents/skills`、插件目录/多版本缓存子组件 | `.codex/skills`、`.agents/skills`、关联插件组件 | 用户/项目 `config.toml` 的 `[[skills.config]]` 完整 manifest 路径覆盖；插件父开关仍独立记录 |
| Claude Code | 配置根 `skills`、插件 manifest 声明的 Skill/缓存 | `.claude/skills`、关联插件组件；`.agents/skills` 只作公共磁盘发现 | 用户 `settings.json`、项目 `settings.json`/`settings.local.json` 的显式 `skillOverrides`；插件状态来自 settings 的插件配置及精确关联 |
| DeepSeek Harness | `.dsh/skills`（或明确 DSH_HOME 下的 skills） | `.dsh/skills` | 独立 Skill 开关尚无证据，继续未知；静态 profile/root patch 的 disabled 只用于对应插件/MCP 声明 |
| ZCode | `.zcode/skills`、公共 `.agents/skills`、插件子组件 | `.zcode/skills`、公共 `.agents/skills`、既有有限发现入口 | 用户 `cli/config.json` 的路径 enable 覆盖，详见配置状态说明；最终发现和运行时配置仍有边界 |

本机 Codex 的用户 skills 当前只有 `.system`，系统目录内五项仍被单独扫描；公共 `.agents/skills` 另有图片风格库。Claude 用户 skills 目录当前不存在，插件缓存发现与安装登记仍会扫描，不能据此断言 Claude 产品只支持插件 Skill。DSH 的 latex-resume/resume-optimizer 是真实文件来源，未找到可靠独立开关，保持开关未确定。

自定义 CODEX_HOME、CLAUDE_CONFIG_DIR、DSH_HOME 沿用发现/明确登记配置根；用户公共来源应以发现上下文的实际用户目录定位。直接手动登记异地配置根而缺少用户目录上下文时，仍有既有父目录回退限制，不宣称覆盖其他用户家目录。

## 本轮修正

1. Codex 原来把 Skill 开关读取与有限可写目标绑定，导致公共、内置和项目 Skill 的显式覆盖漏读。现在只读读取与写入授权分开，按完整 SKILL.md 路径关联现有扫描结果；同名不同路径分别保留。重复、非布尔值、超限记录保持未知；配置中列出的任意外部路径不会被自动扫描。新位置缺少明确覆盖时继续未知，不用默认值宣称客户端已发现。
2. Claude 的项目/local skillOverrides 原来浅合并整张表，local 少量条目可能抹掉 project 的其他条目。现在逐文件、逐名字读取，保留实际来源路径；local 显式同名记录覆盖该项目记录，其他名字保留。公共目录磁盘发现不会被强行套成 Claude 原生 Skill。
3. Claude 原生 skillOverrides 有四态：on 允许；off 禁用；name-only 显示“仅名称可见”；user-invocable-only 显示“仅手动调用”。契约增加可见性字段，详情保留原始状态值；不把部分可见性压成普通已启用。名字匹配使用 Skill 声明名，缺失时回退目录名。未知/历史非标准值不强行判断启用。

Claude 依据：[官方 Skill 可见性规则](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings)、[用户与项目设置位置](https://code.claude.com/docs/en/settings)。这些是读取到的设置记录，不是完整 managed/权限/frontmatter/会话配置的合成结果；未做原生执行验收。

## 不作为开关的文件

- `.codex-global-state.json` 的 skill_approval 或历史列表：不当作每个 Skill 的开关。
- `.agents/.skill-lock.json`：安装来源记录，不当作启用配置。
- Claude `.claude.json`：继续读取独立 MCP 与明确项目私有 MCP；skillUsage 是统计，enabledPlugins 也不代替 settings 的插件开关。
- DSH `skill-manager-ytxue.checked.json` 与 `.log`：规范审计/hash 和日志，不是逐 Skill 开关，扫描器不读取它们来判断启用。

“AgentDeck 扫到同一公共来源”不等于原生客户端已加载。公共来源无 Agent 所属；同名资源、多版本、多个 Agent/项目记录分别保留。没有证据证明用户 `.agents/skills` 是三家原生客户端共同识别的位置；Claude 项目公共目录发现明确标为磁盘证据。

## 验证

新增五项隔离扫描测试：Codex 公共/内置/项目路径覆盖、重复覆盖与外部路径不发现；Claude 四态、逐名字 project/local 来源、公共发现与设置记录分开；DSH 审计/统计/日志不会成为开关。浏览器增加 Claude 两种部分可见性的展示验证。已有 Codex 写入、备份与恢复链路继续回归，未扩大写入范围。

更新后构建并重启后端、刷新网页、重新扫描以替换旧索引。真实项目未登记；不全盘找项目，不提交、不上传、不关机。

本轮结果：typecheck、lint、build、diff 检查通过；单元测试 117 通过、4 跳过，浏览器 5 通过、1 跳过，无最终失败。首次完整测试遇到随机端口被 fetch 禁止（bad port），隔离复测及完整重跑通过，未修改产品接口规避。真实来源只读核对仍为 177 条绑定，332 文件摘要一致；真实项目/原生执行测试未开启。
