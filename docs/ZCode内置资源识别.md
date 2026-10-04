# ZCode 内置资源识别

更新：2026-10-04。此前仅扫描用户 Skill 根和插件缓存，没有核对桌面安装目录，导致随包资源漏扫，已有缓存也统一显示“插件附带”。现已补齐扫描器、契约和详情中的内置来源证据。

## 识别依据

生产发现只读查询 Windows 卸载登记中名称为 ZCode 的安装位置或图标位置；不读会话、socket 或运行日志，不启动 ZCode。只有当前用户真实 home 的发现才查询安装登记；隔离 home 不读取本机安装目录。也可显式设置 `ZCODE_DESKTOP_ROOT` 指定安装根。

候选根必须有 `ZCode.exe`、`resources/glm/zcode.cjs` 和 `.node-bundle-meta.json` 的 electron-node / zcode.cjs 元数据。扫描限定在 `resources/glm/packages`，最多 40 个直属包，不遍历磁盘寻找安装目录。元数据不等于发行签名认证或运行验证。

随包 `@zcode/` 插件清单及其 Skill/MCP 标为“Agent 内置”；无 package.json 的专用 `bundled-skills/skills` 从已验证随包目录盘点。安装原文保持只读，缺少启用配置时仍为“未确定”。

已有用户缓存仅在完整 `name@zcode-plugins-official` 身份、版本、manifest 摘要都匹配随包插件时标为内置来源；Skill/MCP 还须相对路径和原文摘要匹配。关联用户插件配置记录继承已核实的身份来源，保留原状态与写入边界。已匹配缓存组件不另建随包副本记录。

官方市场名称、Z.ai 作者名或相同资源名均不能单独证明内置。旧版本、改过的内容、无对应随包原文继续保留原来源；当前安装版本不能证明历史缓存来自旧安装包。同名但未证明相同的记录仍分别保留。

详情增加“Agent 内置来源证据”的实际随包文件路径。“Agent 内置”是来源类型，所属 Agent 与作用范围保持独立，也不代表配置已启用或当前会话加载。

## 本机有限只读核对

本机安装目录为 `D:\Program Files\Zcode`。ZCode 本轮扫描得到 116 条绑定，37 条有内置来源证据，其中 19 条 Skill：包括 control-browser、web-gui-tester、computer-use、文档技能、诊断技能，以及新增盘点的 android-dev、dynamic-workflows、ios-dev。这些数字限于当前固定入口，不表示客户端完整覆盖；配置状态继续保留启用、禁用与未确定。

131 个结果来源及内置证据文件的摘要在连续只读扫描前后保持不变，真实 cli/config.json 摘要不变。没有执行客户端、Skill、插件、hook 或 MCP。

隔离测试覆盖内容匹配、改动 Skill、旧缓存版本、缺失安装依据、漏扫的 bundled-skills、原文不变、保持禁用与内置只读；浏览器覆盖来源标签、内置证据路径及既有单项启停回归。
