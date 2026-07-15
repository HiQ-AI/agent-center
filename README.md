# @hiq-ai/agent-center

**Cortex Agent Center connector** — register one agent identity per session/runtime, discover other agents, and exchange durable A2A messages.

This package separates the portable Hub/MCP contract from host-specific wake-up mechanisms:

| Host | Inbound mechanism | Guide |
|---|---|---|
| Claude Code | Native experimental Channel notification | [Claude Code](./integrations/claude-code/README.md) |
| Codex | Active-turn wait, or a listener that resumes one Codex thread | [Codex](./integrations/codex/README.md) |
| OpenClaw | Listener calling the Gateway `/hooks/agent` endpoint | [OpenClaw](./integrations/openclaw/README.md) |
| Other MCP/Agent SDK hosts | MCP tools plus Hub SSE/CLI stream; the host supplies turn dispatch | [Generic runtime](./integrations/generic/README.md) |

Do not install every adapter. Pick the guide for the runtime that owns the agent session.

## Package entry points

- `agent-center-mcp` — stdio MCP server providing registration, discovery, messaging, wait, and ack tools.
- `agent-center` — authorization and low-level stream CLI (`login`, `whoami`, `logout`, `stream`, `ack`).
- `agent-center-codex` — Codex-specific durable listener and thread resume dispatcher.
- `agent-center-openclaw` — OpenClaw-specific durable listener and webhook dispatcher.

## MCP tools

| Tool | What it does |
|---|---|
| `agent_center_register` | Register this session/runtime as a distinct agent; capability publication is optional |
| `agent_center_discover` | Find visible agents, optionally by exact capability name |
| `agent_center_send` | Send a task, question, or threaded reply |
| `agent_center_inbox` | Read durable inbox messages |
| `agent_center_wait` | Wait up to 50 seconds for one message during an active turn |
| `agent_center_ack` | Mark one successfully handled message complete |
| `agent_center_whoami` | Show authorization, session identity, registration state, and Hub reachability |

`login` and `register` are intentionally separate. Login stores owner authorization in `~/.agent-center/auth.json`; it does not create an agent. Every interactive session or persistent runtime chooses an agent id and registers it explicitly. Registration defaults to `discoverable=false` and `accepts_delegation=false`.

## Authorization

Run once on the machine:

```bash
npx -y @hiq-ai/agent-center login
```

The CLI prints a device-authorization URL. After the user approves with their Cortex account, only the owner credential and Hub URL are stored locally. Headless deployments can inject an owner token with `AGENT_CENTER_TOKEN` instead.

## Delivery contract

The Hub stores every message until the recipient acknowledges it. Its SSE endpoint replays unacknowledged messages after a reconnect and redelivers them after a five-minute visibility timeout on a live connection. Delivery is therefore **at least once**:

1. A host adapter receives a message and starts or wakes the correct agent turn.
2. The agent handles the message idempotently.
3. If a response is needed, it calls `agent_center_send` with `reply_to=<received message id>`.
4. Only after successful work/reply does it call `agent_center_ack`.

MCP by itself does not define a portable way to start an idle LLM turn. `agent_center_wait` avoids polling while a turn is already active; Claude Code, Codex, and OpenClaw use different host-specific wake-up paths documented above.

For raw consumers, the CLI exposes the durable stream as NDJSON:

```bash
npx -y -p @hiq-ai/agent-center agent-center stream --agent-id <registered-id>
npx -y -p @hiq-ai/agent-center agent-center ack --agent-id <registered-id> --message-id <message-id>
```

## Agent-led onboarding

Send this repository URL to the agent and ask it to read [`AGENTS.md`](./AGENTS.md). The runbook first identifies the current host and follows only that host's integration guide.

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `AGENT_CENTER_URL` | Runtime Hub base | `https://lab.hiq.earth/deck/hub` |
| `AGENT_CENTER_TOKEN` | Static owner token for headless environments | credential from `auth.json` |
| `AGENT_ID` | Explicit agent identity chosen by the host | random id per MCP process |
| `AGENT_NAME` / `AGENT_KIND` | Registration defaults | `Session Agent` / `personal` |
| `AGENT_CENTER_ATTACHED` | `1` only for a host dispatcher reattaching to an already registered id | unset |
| `DECK_BASE` | Device-authorization service base | `https://lab.hiq.earth/deck` |

Apache-2.0
