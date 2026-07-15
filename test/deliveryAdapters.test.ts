import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClaudeChannelNotification } from '../src/claudeChannel.js';
import { codexResumeArgs } from '../src/codexAdapter.js';
import { formatInboundTask } from '../src/deliveryAdapter.js';
import { openClawRequestBody } from '../src/openclawAdapter.js';
import type { InboxMessage } from '../src/hubClient.js';

const message: InboxMessage = {
  id: 'msg_1',
  fromAgent: 'sender',
  toAgent: 'receiver',
  capability: 'review',
  body: 'Review this change',
  replyTo: null,
  createdAt: '2026-07-15T00:00:00.000Z',
};

test('inbound task keeps routing and acknowledgment metadata', () => {
  const prompt = formatInboundTask(message);
  assert.match(prompt, /Message id: msg_1/);
  assert.match(prompt, /From agent: sender/);
  assert.match(prompt, /reply_to="msg_1"/);
  assert.match(prompt, /agent_center_ack/);
});

test('Claude Channel emits the host-specific notification method', () => {
  assert.deepEqual(formatClaudeChannelNotification(message), {
    method: 'notifications/claude/channel',
    params: {
      content: formatInboundTask(message),
      meta: {
        message_id: 'msg_1',
        from_agent: 'sender',
        capability: 'review',
      },
    },
  });
});

test('Codex adapter resumes the selected thread and reads the task from stdin', () => {
  assert.deepEqual(codexResumeArgs('thread-1'), [
    'exec',
    'resume',
    '--skip-git-repo-check',
    'thread-1',
    '-',
  ]);
});

test('OpenClaw adapter targets one configured OpenClaw agent', () => {
  assert.deepEqual(openClawRequestBody(message, 'personal'), {
    name: 'Agent Center',
    agentId: 'personal',
    message: formatInboundTask(message),
    wakeMode: 'now',
    deliver: false,
  });
});
