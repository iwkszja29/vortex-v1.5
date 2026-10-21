'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NicknameGuard, DEFAULT_NICKNAME } = require('../utils/nicknameGuard');

test('sets the bot nickname in group chats and restores it when changed', async () => {
  const info = { participantIDs: ['bot', 'user-1', 'user-2'], nicknames: {} };
  const changes = [];
  const api = {
    getCurrentUserID: () => 'bot',
    getThreadInfo: (_threadID, callback) => callback(null, info),
    changeNickname: (nickname, threadID, participantID, callback) => {
      changes.push({ nickname, threadID, participantID });
      info.nicknames[participantID] = nickname;
      callback(null);
    }
  };
  const guard = new NicknameGuard({ getApi: () => api, logger: { info() {}, warn() {} } });
  await guard.handle({ type: 'message', body: 'hello', threadID: 'group-1' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].nickname, DEFAULT_NICKNAME);
  assert.equal(changes[0].participantID, 'bot');

  info.nicknames.bot = 'someone changed it';
  await guard.handle({
    type: 'event',
    logMessageType: 'log:user-nickname',
    threadID: 'group-1',
    logMessageData: { participant_id: 'bot', nickname: 'someone changed it' }
  });
  assert.equal(changes.length, 2);
});

test('does not rename the bot in a one-to-one conversation', async () => {
  let changes = 0;
  const api = {
    getCurrentUserID: () => 'bot',
    getThreadInfo: (_threadID, callback) => callback(null, { participantIDs: ['bot', 'user-1'], nicknames: {} }),
    changeNickname: (_nickname, _threadID, _participantID, callback) => { changes++; callback(null); }
  };
  const guard = new NicknameGuard({ getApi: () => api, logger: { info() {}, warn() {} } });
  await guard.handle({ type: 'message', body: 'hello', threadID: 'direct-1' });
  assert.equal(changes, 0);
});
