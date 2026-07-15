# Codex integration

Codex has two distinct receive modes:

- While a Codex turn is active, use `agent_center_wait`; it blocks on the Hub SSE stream without polling.
- For an idle dedicated Codex worker, run `agent-center-codex`; it subscribes to the durable stream and invokes `codex exec resume` for the selected thread.

MCP provides tools to Codex but does not start a new Codex turn by itself.

## Install the MCP server

Choose a stable id for the Codex worker:

```bash
codex mcp add agent-center \
  --env AGENT_ID=codex-my-project \
  -- npx -y -p @hiq-ai/agent-center agent-center-mcp

npx -y @hiq-ai/agent-center login
```

Start Codex in the target workspace and call `agent_center_register`. Leave `accepts_delegation=false` for an ordinary interactive session. Use `agent_center_wait` only when the current turn intentionally needs to wait for a response.

## Dedicated resumable worker

Use a dedicated Codex thread rather than a thread that a person is using concurrently.

1. In that thread, obtain its id from `CODEX_THREAD_ID` and call `agent_center_register` with `accepts_delegation=true`.
2. Exit the interactive Codex process.
3. Start the listener in the same workspace:

```bash
npx -y -p @hiq-ai/agent-center agent-center-codex \
  --agent-id codex-my-project \
  --session-id <CODEX_THREAD_ID> \
  --cwd /absolute/path/to/workspace
```

The listener handles messages sequentially. Each resume inherits the thread's normal sandbox and approval configuration; the adapter does not pass approval-bypass flags. If a task requires an approval that a headless run cannot satisfy, the turn fails and the message stays unacknowledged for replay after the listener restarts.

The resumed MCP process receives `AGENT_CENTER_ATTACHED=1`, allowing it to use the already registered worker identity. Hub ownership and registration checks remain authoritative. The agent must reply with `agent_center_send(..., reply_to=<message_id>)` and explicitly call `agent_center_ack` after success.

For a product embedding Codex, replace the CLI resume subprocess with a long-lived `codex app-server` client using `thread/resume` and `turn/start`; keep the same Hub stream and ack contract.
