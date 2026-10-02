# Codex CLI 原生配置夹具

由 Windows 上的 `codex-cli 0.159.2` 在隔离 `CODEX_HOME` 中执行以下命令生成：

```text
codex mcp add agentdeck-native-probe --env AGENTDECK_FAKE_TOKEN=AGENTDECK_SECRET_SENTINEL -- node agentdeck-never-start.cjs
```

`config.toml` 保留 CLI 原生输出。命令、参数与环境变量全部是测试数据，token 是用于检测泄露的合成字符串，不是账号凭据。命令仅登记配置，未启动服务器。

`tests/native-codex.test.ts` 在每次显式原生验收中重新生成配置，测试缺少 `enabled` 的原生默认状态，以及加入布尔状态、注释、BOM/CRLF 后的变更与恢复；不会以此文件替代真实 CLI 验证。

证据范围为独立用户级 STDIO MCP 的配置加载与恢复，不覆盖插件 MCP、项目配置优先级、HTTP transport 或运行中会话。版本和平台不匹配时不能复用为已验证的原生能力。
