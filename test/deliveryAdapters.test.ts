import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClaudeChannelNotification } from '../src/claudeChannel.js';
import { codexAppServerArgs } from '../src/codexAdapter.js';
import { formatInboundTask } from '../src/deliveryAdapter.js';
import { openClawRequestBody } from '../src/openclawAdapter.js';
import type { DeliveryEvent, InboxMessage } from '../src/hubClient.js';

const message: InboxMessage = {
  id: 'msg_1',
  fromAgent: 'sender',
  toAgent: 'receiver',
  capability: 'review',
  body: 'Review this change',
  replyTo: null,
  createdAt: '2026-07-15T00:00:00.000Z',
};
const messageEvent: DeliveryEvent = { type: 'message', message };
const taskEvent: DeliveryEvent = {
  type: 'task',
  task: {
    id: 'task-1',
    contextId: 'context-1',
    status: { state: 'TASK_STATE_SUBMITTED', timestamp: '2026-07-15T00:00:00.000Z' },
    history: [
      {
        messageId: 'a2a-message-1',
        role: 'ROLE_USER',
        parts: [{ text: 'Review this task' }],
      },
    ],
    metadata: { agentCenter: { sourceAgentId: 'sender' } },
  },
};

test('inbound task keeps routing and acknowledgment metadata', () => {
  const prompt = formatInboundTask(messageEvent);
  assert.match(prompt, /Message id: msg_1/);
  assert.match(prompt, /From agent: sender/);
  assert.match(prompt, /reply_to="msg_1"/);
  assert.match(prompt, /agent_center_ack/);
});

test('A2A Task prompt uses task status updates instead of inbox ack', () => {
  const prompt = formatInboundTask(taskEvent);
  assert.match(prompt, /Task id: task-1/);
  assert.match(prompt, /Requester: sender/);
  assert.match(prompt, /agent_center_task_update/);
  assert.doesNotMatch(prompt, /agent_center_ack/);
});

test('Claude Channel emits the host-specific notification method', () => {
  assert.deepEqual(formatClaudeChannelNotification(messageEvent), {
    method: 'notifications/claude/channel',
    params: {
      content: formatInboundTask(messageEvent),
      meta: {
        delivery_type: 'message',
        message_id: 'msg_1',
        from_agent: 'sender',
        capability: 'review',
      },
    },
  });
});

test('Codex adapter uses the stable app-server stdio transport', () => {
  assert.deepEqual(codexAppServerArgs(), ['app-server', '--listen', 'stdio://']);
});

test('OpenClaw adapter targets one configured OpenClaw agent', () => {
  assert.deepEqual(openClawRequestBody(messageEvent, 'personal'), {
    name: 'Agent Center',
    agentId: 'personal',
    message: formatInboundTask(messageEvent),
    wakeMode: 'now',
    deliver: false,
  });
});
