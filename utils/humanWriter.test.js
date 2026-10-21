const test = require('node:test');
const assert = require('node:assert/strict');
const { createHumanWriter } = require('./humanWriter');

function makeApi(sendMessage) {
  return { sendMessage };
}

test('pauses outbound sending and invokes safety callback on platform restriction errors', async () => {
  const events = [];
  const writer = createHumanWriter({
    logger: {},
    minIntervalMs: 0,
    globalIntervalMs: 0,
    onSafetyStop: event => events.push(event)
  });
  const api = makeApi(async () => { throw new Error('Rate limit: too many messages'); });

  await assert.rejects(writer.wrap(api).sendMessage('hello', 'thread-1'));
  const state = writer.getState();
  assert.equal(state.paused, true);
  assert.equal(state.pauseReason, 'platform-restriction-or-rate-limit');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'platform');

  const result = await writer.wrap(makeApi(async () => assert.fail('must not send while paused')))
    .sendMessage('next', 'thread-1');
  assert.equal(result.suppressed, true);
});

test('opens circuit breaker after three consecutive generic send failures', async () => {
  const events = [];
  const writer = createHumanWriter({
    logger: {},
    minIntervalMs: 0,
    globalIntervalMs: 0,
    maxConsecutiveFailures: 3,
    onSafetyStop: event => events.push(event)
  });
  const api = makeApi(async () => { throw new Error('socket write failed'); });

  for (let i = 0; i < 3; i++) {
    await assert.rejects(writer.wrap(api).sendMessage('message ' + i, 'thread-2'));
  }
  assert.equal(writer.getState().paused, true);
  assert.equal(writer.getState().pauseReason, 'repeated-send-failures');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'circuit-breaker');
});

test('authentication/checkpoint errors pause until protection is explicitly reset', async () => {
  const events = [];
  const writer = createHumanWriter({
    logger: {},
    minIntervalMs: 0,
    globalIntervalMs: 0,
    onSafetyStop: event => events.push(event)
  });
  const api = makeApi(async () => { throw new Error('Facebook checkpoint required'); });

  await assert.rejects(writer.wrap(api).sendMessage('hello', 'thread-3'));
  assert.equal(writer.getState().paused, true);
  assert.equal(writer.getState().pauseReason, 'session-authentication');
  assert.equal(writer.getState().pausedUntil, null);
  assert.equal(events[0].type, 'session');

  writer.resetProtection();
  assert.equal(writer.getState().paused, false);
  const result = await writer.wrap(makeApi(async () => 'sent')).sendMessage('fresh session', 'thread-3');
  assert.equal(result, 'sent');
});
