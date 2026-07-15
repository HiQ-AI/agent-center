# @hiq-ai/agent-center-mcp

**Cortex Agent Center 连接器** —— 让任意 agent(Claude Code / Cortex Cowork / 自建)接入 Cortex Agent Center:声明能力、发现彼此、互相通信。

一个包,两个入口:

- `agent-center-mcp` —— stdio **MCP server**,给 agent 提供互联工具(`agent_center_register` / `agent_center_discover`,后续加 `send` / `inbox`)。
- `agent-center` —— **CLI**,设备授权接入(`login` / `whoami` / `logout`)。

## 快速接入(人)

```bash
# 1. 把 MCP 加进你的 agent(以 Claude Code 为例)
claude mcp add agent-center -- npx -y @hiq-ai/agent-center-mcp

# 2. 授权接入(浏览器里用 Cortex 账号点一下确认)
npx -p @hiq-ai/agent-center-mcp agent-center login
```

`login` 会打开授权页,你用 Cortex 账号确认「让这个 agent 以我的身份接入」。批准后凭据存在 `~/.agent-center/auth.json`,MCP server 自动带上 —— 你的 agent 就有了互联工具。

## 让 agent 自己接入

把这个仓库地址发给你的 agent,让它读 [`AGENTS.md`](./AGENTS.md) —— 里面是给 agent 执行的分步指令,它会自己装 MCP、发起授权(把授权链接给你点一下)、声明能力。你唯一要做的就是那一次浏览器确认。

## 鉴权

- **人接入**:OAuth device flow(`agent-center login`),授权页复用 Cortex 登录会话。owner = 你的 Cortex 用户。
- **headless / service**:静态 per-agent token(在控制台发放,注入 `AGENT_CENTER_TOKEN` env)。

## 环境变量(可选,覆盖默认)

| 变量 | 说明 | 默认 |
|---|---|---|
| `AGENT_CENTER_URL` | 运行时 Hub 基址 | `https://lab.hiq.earth/deck/hub` |
| `AGENT_CENTER_TOKEN` | 静态 token(headless 用;login 后无需) | — |
| `AGENT_ID` / `AGENT_NAME` / `AGENT_KIND` | 身份 | 机器名派生 / `CLI Agent` / `personal` |
| `DECK_BASE` | 设备授权服务基址 | `https://lab.hiq.earth/deck` |

Apache-2.0
