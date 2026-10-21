const test = require('node:test');
const assert = require('node:assert/strict');
const { createHumanWriter } = require('../utils/humanWriter');

test('human writer suppresses identical duplicate sends in the same thread', async () => {
  const sent = [];
  const api = { sendMessage: async (body, threadID) => { sent.push([body, threadID]); return true; } };
  const writer = createHumanWriter({ minIntervalMs: 0, globalIntervalMs: 0, duplicateWindowMs: 10000 });
  const wrapped = writer.wrap(api);
  await wrapped.sendMessage('hello', 'thread-1');
  const duplicate = await wrapped.sendMessage('hello', 'thread-1');
  assert.equal(sent.length, 1);
  assert.equal(duplicate.suppressed, true);
});

test('human writer permits the same text in a different thread', async () => {
  const sent = [];
  const api = { sendMessage: async (body, threadID) => { sent.push([body, threadID]); return true; } };
  const writer = createHumanWriter({ minIntervalMs: 0, globalIntervalMs: 0 });
  const wrapped = writer.wrap(api);
  await wrapped.sendMessage('hello', 'thread-1');
  await wrapped.sendMessage('hello', 'thread-2');
  assert.equal(sent.length, 2);
});

test('human writer applies a local per-minute cap without retrying rejected sends', async () => {
  let calls = 0;
  const api = { sendMessage: async () => { calls++; return true; } };
  const writer = createHumanWriter({ minIntervalMs: 0, globalIntervalMs: 0, maxPerMinute: 1 });
  const wrapped = writer.wrap(api);
  await wrapped.sendMessage('first', 'thread-1');
  const second = await wrapped.sendMessage('second', 'thread-1');
  assert.equal(calls, 1);
  assert.equal(second.suppressed, true);
});

test('human writer does not suppress the same reply for a different command message', async () => {
  const sent = [];
  const api = { sendMessage: async (body, threadID, messageID) => { sent.push([body, threadID, messageID]); return true; } };
  const writer = createHumanWriter({ minIntervalMs: 0, globalIntervalMs: 0, duplicateWindowMs: 10000 });
  const wrapped = writer.wrap(api);
  await wrapped.sendMessage('pong', 'thread-1', 'message-1');
  await wrapped.sendMessage('pong', 'thread-1', 'message-2');
  assert.equal(sent.length, 2);
});
