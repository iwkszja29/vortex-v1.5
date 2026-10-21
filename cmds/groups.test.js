const test = require('node:test');
const assert = require('node:assert/strict');
const groups = require('./groups');

test('categorizes only recognized group threads and ignores duplicate IDs', async () => {
  const api = { getThreadList(limit, timestamp, tags, callback) {
    assert.equal(limit, 100);
    assert.deepEqual(tags, ['PENDING']);
    callback(null, [
      { threadID: 'g1', name: 'Group 1', isGroup: true, folder: 'PENDING' },
      { threadID: 'p1', name: 'Person', isGroup: false },
      { threadID: 'g1', name: 'Duplicate', isGroup: true },
      { threadID: 'g2', name: 'Group 2', isGroup: 1 }
    ]);
  }};
  const result = await groups._test.fetchGroups(api, 'PENDING');
  assert.deepEqual(result.map(x => x.threadID), ['g1', 'g2']);
});
test('supports callback and promise FCA methods without double resolution', async () => {
  const callbackApi = { getThreadList(limit, timestamp, tags, cb) { cb(null, [{ threadID: 'x' }]); } };
  assert.deepEqual(await groups._test.callApi(callbackApi, 'getThreadList', [10, null, []]), [{ threadID: 'x' }]);
  const promiseApi = { getThreadList: async () => [{ threadID: 'y' }] };
  assert.deepEqual(await groups._test.callApi(promiseApi, 'getThreadList', [10, null, []]), [{ threadID: 'y' }]);
});
test('enforces per-thread and sender session state and expires it', () => {
  const event = { threadID: 'command-chat', senderID: 'owner' };
  const key = groups._test.sessionKey(event);
  groups._test.saveSession(key, { stage: 'category', senderID: 'owner', threadID: 'command-chat' });
  assert.equal(groups._test.getSession(key).stage, 'category');
  groups._test.clearSession(key);
  assert.equal(groups._test.getSession(key), null);
});
test('owner confirmation accepts a pending group and sends rocket only after acceptance', async () => {
  const sent = [], actions = [];
  const api = {
    handleMessageRequest(ids, accept, callback) { actions.push(['accept', ids, accept]); callback(null); },
    sendMessage(message, threadID) { sent.push([message, threadID]); return Promise.resolve({ ok: true }); }
  };
  const event = { threadID: 'command-chat', senderID: 'owner', body: '1', isOwner: true };
  const key = groups._test.sessionKey(event);
  groups._test.saveSession(key, { stage: 'confirm', senderID: 'owner', threadID: 'command-chat', category: '1', selected: { threadID: 'target-group', name: 'Target' } });
  assert.equal(await groups.handleReply(api, event), true);
  assert.deepEqual(actions, [['accept', ['target-group'], true]]);
  assert.deepEqual(sent, [['𝑹𝑶𝑪𝑲𝑬𝑻 🚀', 'target-group'], ['✅ تم قبول طلب المحادثة «Target»، وأُرسلت رسالة 𝑹𝑶𝑪𝑲𝑬𝑻 🚀 إليها.', 'command-chat']]);
});
test('declining does not accept or send to the selected group', async () => {
  const sent = [], actions = [];
  const api = {
    handleMessageRequest(ids, accept, callback) { actions.push(['accept', ids, accept]); callback(null); },
    sendMessage(message, threadID) { sent.push([message, threadID]); return Promise.resolve({ ok: true }); }
  };
  const event = { threadID: 'command-chat', senderID: 'owner', body: '2' };
  const key = groups._test.sessionKey(event);
  groups._test.saveSession(key, { stage: 'confirm', senderID: 'owner', threadID: 'command-chat', category: '1', selected: { threadID: 'target-group', name: 'Target' } });
  assert.equal(await groups.handleReply(api, event), true);
  assert.deepEqual(actions, []);
  assert.deepEqual(sent, [['تم الإلغاء. لم يتم قبول المجموعة ولم تُرسل رسالة إليها.', 'command-chat']]);
});
test('rejects unsupported thread list API cleanly', async () => {
  await assert.rejects(groups._test.fetchGroups({}, 'OTHER'), /getThreadList/);
});
