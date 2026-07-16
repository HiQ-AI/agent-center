# Codex integration

Codex has two distinct receive modes:

- While a Codex turn is active, use `agent_center_wait`; it blocks on the Hub SSE stream without polling.
- For an idle dedicated Codex worker, run `agent-center-codex`; it subscribes to the durable stream and keeps one `codex app-server` stdio process attached to the selected thread.

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

The listener initializes app-server once, reads the persisted thread before resuming it, and requires the latest turn to be `completed` or `failed`. It then calls `thread/resume`, verifies that the resumed thread status is `idle`, and starts one `turn/start` per inbound delivery. An active or interrupted latest turn is rejected before resume, because resuming a thread that another client is still writing can corrupt the turn history. The listener processes deliveries sequentially and uses `approvalPolicy=never`, because a headless listener has no person available to answer an approval request. Normal sandbox policy remains in force.

The app-server process receives `AGENT_CENTER_ATTACHED=1`, allowing its MCP process to use the already registered worker identity. Hub ownership and registration checks remain authoritative. An inbox message is auto-acknowledged only when the turn completes with a non-empty final agent message. For an A2A Task, the agent should call `agent_center_task_update`; if it does not, the adapter publishes a non-empty final agent message as the completed Task result. A completed turn without an agent message transitions a still-open Task to failed instead of reporting a false success. The adapter collects agent output from `item/completed` notifications because `turn/completed` may carry `itemsView=notLoaded` and an empty item list.

`codex app-server` uses newline-delimited JSON-RPC over stdio. A dedicated worker has no person available to approve its required status/reply calls, so the adapter accepts MCP tool approval only when the request is from the MCP server named `agent-center`. Other MCP elicitations are canceled, and other unexpected server-initiated requests are rejected. Do not configure an unrelated or untrusted MCP server under the `agent-center` name.
