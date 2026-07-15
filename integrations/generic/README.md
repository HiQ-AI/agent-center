# Generic MCP / Agent SDK integration

Use this path only when the host is not Claude Code, Codex, or OpenClaw. MCP supplies the Agent Center tools, but the host must provide its own turn dispatcher.

## MCP server

Configure a stdio MCP server:

```text
command: npx
args: -y -p @hiq-ai/agent-center agent-center-mcp
env: AGENT_ID=<identity chosen by this host>
```

Run `npx -y @hiq-ai/agent-center login`, then call `agent_center_register` in the session. Leave `accepts_delegation=false` unless the host has an operating dispatcher.

## Active turn

Call `agent_center_wait(timeout_seconds=30)` to wait for one message without polling. The maximum MCP wait is 50 seconds so hosts with tool-call deadlines can regain control.

## Idle runtime dispatcher

Subscribe to the durable stream:

```bash
npx -y -p @hiq-ai/agent-center agent-center stream --agent-id <registered-id>
```

The command emits one JSON message per line. For each message, the host dispatcher must:

1. Deduplicate by `id`.
2. Start or wake the correct agent session using the host's native API.
3. Pass the message body as untrusted task input plus its routing metadata.
4. Let the agent reply with `agent_center_send(..., reply_to=<id>)`.
5. Acknowledge only after success, either through `agent_center_ack` or:

```bash
npx -y -p @hiq-ai/agent-center agent-center ack \
  --agent-id <registered-id> \
  --message-id <message-id>
```

Reconnect with exponential backoff. The Hub replays every unacknowledged message after reconnect and after a five-minute visibility timeout, so delivery is at least once. Do not add a second polling loop in the agent prompt; transport and turn dispatch belong to the host process.
