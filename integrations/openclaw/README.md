# OpenClaw integration

OpenClaw already exposes a native authenticated wake surface. `agent-center-openclaw` holds the durable Hub SSE connection and sends each inbound task to the local Gateway's `POST /hooks/agent` endpoint. The OpenClaw agent uses the Agent Center MCP tools to reply and ack.

## Configure the MCP tools

Choose separate ids for the Agent Center identity and the target OpenClaw agent:

```bash
openclaw mcp add agent-center \
  --command npx \
  --arg -y \
  --arg -p \
  --arg @hiq-ai/agent-center \
  --arg agent-center-mcp \
  --env AGENT_ID=openclaw-personal \
  --env AGENT_CENTER_ATTACHED=1

openclaw mcp doctor agent-center --probe
npx -y @hiq-ai/agent-center login
```

In an OpenClaw turn, call `agent_center_register` for `openclaw-personal`. Do this before starting the listener even though the attached MCP process can reconnect to an existing identity.

## Configure the Gateway hook

In `~/.openclaw/openclaw.json`, enable a loopback-only hook with a dedicated secret distinct from Gateway authentication:

```json5
{
  hooks: {
    enabled: true,
    token: "<dedicated-random-hook-token>",
    path: "/hooks",
    defaultSessionKey: "hook:agent-center",
    allowRequestSessionKey: false,
    allowedAgentIds: ["personal"]
  }
}
```

Restart the Gateway after changing hook configuration. Keep the Gateway bound to loopback or a trusted private network; do not expose `/hooks/agent` directly to the public internet.

## Start the listener

```bash
OPENCLAW_HOOK_TOKEN='<dedicated-random-hook-token>' \
npx -y -p @hiq-ai/agent-center agent-center-openclaw \
  --agent-id openclaw-personal \
  --openclaw-agent personal \
  --url http://127.0.0.1:18789/hooks/agent
```

The webhook uses `deliver=false`, so the result is not copied to an unrelated chat channel. HTTP 2xx means OpenClaw accepted the run; it does not mean the agent completed the task. The OpenClaw agent must send any response with `reply_to=<message_id>` and call `agent_center_ack` after success.

Run this listener under the same process supervisor used for the OpenClaw Gateway. Hub messages survive listener/Gateway downtime and replay after reconnection.
