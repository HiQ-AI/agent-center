import { test } from 'node:test';
import assert from 'node:assert/strict';
import { organizationEnrollmentReceipt } from '../src/organizationEnrollment.js';

test('unbound registration is pending and gives a credential-free owner confirmation link', () => {
  const receipt = organizationEnrollmentReceipt({ id: 'session:a/b?#', orgId: null, owner: 'alice', token: 'never-show-this' }, 'https://cortex.example.invalid');
  assert.match(receipt, /pending confirmation/);
  assert.match(receipt, /https:\/\/cortex.example.invalid\/chat\/agents\/session%3Aa%2Fb%3F%23\/organization/);
  assert.match(receipt, /will not appear in the Warden organization directory/);
  assert.doesNotMatch(receipt, /never-show-this/);
});

test('confirmed receipt uses the server organization rather than visibility or client claims', () => {
  const receipt = organizationEnrollmentReceipt({ id: 'session-a', orgId: 'org-a', visibility: 'owner' }, 'https://cortex.example.invalid');
  assert.match(receipt, /enrollment: confirmed/);
  assert.match(receipt, /organization: org-a/);
  assert.doesNotMatch(receipt, /pending|\/chat\/agents/);
});

test('missing or invalid organization facts cannot be reported as confirmed', () => {
  for (const orgId of [undefined, '', 123]) {
    assert.throws(() => organizationEnrollmentReceipt({ id: 'session-a', orgId, visibility: 'org' }, 'https://cortex.example.invalid'));
  }
});
