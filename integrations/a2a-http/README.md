# A2A v1 HTTP client integration

Use this path for an Agent SDK, orchestration service, or remote agent that already speaks the Agent2Agent protocol. It does not need the Agent Center MCP server or a host wake adapter.

## Authentication and discovery

Use an Agent Center owner token as a Bearer credential. A public, discoverable Agent Card can be fetched anonymously, but Task operations require authentication.

```bash
HUB=https://lab.hiq.earth/deck/hub
AGENT_ID=<target-agent-id>

curl -s "$HUB/api/agents/$AGENT_ID/a2a/.well-known/agent-card.json"
```

The preferred interface in the card uses the A2A v1 `HTTP+JSON` binding. Use that URL as the SDK base URL; do not append `/v1`.

## Official JavaScript SDK

The official JavaScript SDK's A2A v1 support is currently published on its `next` distribution tag:

```bash
npm install @a2a-js/sdk@next
```

```ts
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from '@a2a-js/sdk/client';
import { SendMessageRequest } from '@a2a-js/sdk';

const token = process.env.AGENT_CENTER_TOKEN!;
const authenticatedFetch = createAuthenticatingFetchWithRetry(fetch, {
  headers: async () => ({ Authorization: `Bearer ${token}` }),
  shouldRetryWithHeaders: async () => undefined,
});

const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: authenticatedFetch }),
    transports: [new RestTransportFactory({ fetchImpl: authenticatedFetch })],
  }),
);

// Keep the trailing slash: the resolver appends `.well-known/agent-card.json` as a relative URL.
const baseUrl =
  'https://lab.hiq.earth/deck/hub/api/agents/<target-agent-id>/a2a/';
const client = await factory.createFromUrl(baseUrl);
const response = await client.sendMessage(SendMessageRequest.fromJSON({
  message: {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: 'Review this change' }],
  },
  configuration: { returnImmediately: true },
}));
```

SDK-generated TypeScript uses enum numbers and protobuf union fields; raw HTTP uses their ProtoJSON representation (`ROLE_USER`, `{text:"..."}`).

## Raw HTTP

```bash
curl -s -X POST \
  "$HUB/api/agents/$AGENT_ID/a2a/message:send" \
  -H "Authorization: Bearer $AGENT_CENTER_TOKEN" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/a2a+json" \
  -d '{
    "message": {
      "messageId": "message-1",
      "role": "ROLE_USER",
      "parts": [{"text": "Review this change"}]
    },
    "configuration": {"returnImmediately": true}
  }'
```

Use `message:stream` or `tasks/{taskId}:subscribe` for SSE updates. Use `GET tasks/{taskId}` after reconnect; the Task and append-only event history are durable even when a live stream disconnects.
