import assert from 'node:assert/strict';
import test from 'node:test';
import { appendOutputWindow, getOutputUpdate, pollSelectedSessionOutput } from './session-output.mjs';

test('poll reads the currently selected session on each invocation', async () => {
  let selected = 'session-a';
  const calls = [];
  const offsets = {};
  const outputs = {};
  const client = {
    async readOutput(sessionId, offset) {
      calls.push([sessionId, offset]);
      return { chunks: [`${sessionId};`], next: offset + 20, exited: false, truncated: false };
    },
  };

  const first = await pollSelectedSessionOutput({ client, getSelectedSessionId: () => selected, offsets, outputs });
  selected = 'session-b';
  const second = await pollSelectedSessionOutput({ client, getSelectedSessionId: () => selected, offsets, outputs });
  selected = 'session-a';
  const third = await pollSelectedSessionOutput({ client, getSelectedSessionId: () => selected, offsets, outputs });

  assert.deepEqual(calls, [['session-a', 0], ['session-b', 0], ['session-a', 20]]);
  assert.equal(first.output, 'session-a;');
  assert.equal(second.output, 'session-b;');
  assert.equal(third.output, 'session-a;session-a;');
});

test('oversized output keeps its newest tail and advances the full server byte cursor', async () => {
  const offsets = {};
  const outputs = {};
  const requests = [];
  const client = {
    async readOutput(sessionId, offset) {
      requests.push([sessionId, offset]);
      return {
        chunks: ['😀'.repeat(16_000) + 'TAIL'],
        next: 64_004,
        exited: false,
        truncated: false,
      };
    },
  };

  const result = await pollSelectedSessionOutput({
    client,
    getSelectedSessionId: () => 'session-large',
    offsets,
    outputs,
  });

  assert.equal(result.output.length, 24_000);
  assert.equal(result.output.slice(-4), 'TAIL');
  assert.equal(offsets['session-large'], 64_004);
  assert.deepEqual(requests, [['session-large', 0]]);
  await pollSelectedSessionOutput({
    client,
    getSelectedSessionId: () => 'session-large',
    offsets,
    outputs,
  });
  assert.deepEqual(requests[1], ['session-large', 64_004]);
});

test('bounded output does not split a surrogate pair at its left edge', () => {
  const result = appendOutputWindow('a'.repeat(5), '😀bc', 4);
  assert.equal(result, '😀bc');
  assert.equal(/^[\uDC00-\uDFFF]/.test(result), false);
});

test('sliding output windows append only newly consumed text without resetting the terminal', () => {
  const previous = 'a'.repeat(24_000);
  const next = `${'a'.repeat(23_999)}b`;
  assert.deepEqual(getOutputUpdate(previous, next), { append: true, delta: 'b' });
});

test('truncated reconnect resumes from the retained-history cursor without rereading old bytes', async () => {
  const offsets = {};
  const outputs = {};
  const requests = [];
  const client = {
    async readOutput(sessionId, offset) {
      requests.push([sessionId, offset]);
      if (requests.length === 1) {
        return { chunks: ['tail'], next: 104, exited: false, truncated: true };
      }
      return { chunks: ['next'], next: 108, exited: false, truncated: false };
    },
  };

  const first = await pollSelectedSessionOutput({
    client,
    getSelectedSessionId: () => 'session-reconnected',
    offsets,
    outputs,
  });
  const second = await pollSelectedSessionOutput({
    client,
    getSelectedSessionId: () => 'session-reconnected',
    offsets,
    outputs,
  });

  assert.ok(first.output.startsWith('\n['));
  assert.ok(first.output.endsWith('tail'));
  assert.equal(second.output, `${first.output}next`);
  assert.deepEqual(requests, [['session-reconnected', 0], ['session-reconnected', 104]]);
  assert.equal(offsets['session-reconnected'], 108);
});
