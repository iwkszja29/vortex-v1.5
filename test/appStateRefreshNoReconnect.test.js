const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AppStateRefreshManager } = require('../utils/appStateRefresh');

function logger() {
  return { info() {}, warn() {}, error() {} };
}

test('refresh while offline fails without connecting or restarting the runtime', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-refresh-offline-'));
  let ensureConnectedCalls = 0;
  const manager = new AppStateRefreshManager({
    dataDir,
    getApi: () => null,
    // Deliberately passed to prove the manager never invokes a legacy reconnect callback.
    ensureConnected: async () => { ensureConnectedCalls += 1; },
    setAppState() {},
    logger: logger(),
    intervalMs: 60_000
  });
  await assert.rejects(manager.refresh(), /not connected/i);
  assert.equal(ensureConnectedCalls, 0);
  assert.equal(manager.getState().failureCount, 1);
  manager.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('refresh exports and persists AppState from the existing client without replacing it', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-refresh-connected-'));
  const expected = [{ key: 'c_user', value: 'example-session-value' }];
  const client = { getAppState: async () => expected };
  let setValue;
  let ensureConnectedCalls = 0;
  const manager = new AppStateRefreshManager({
    dataDir,
    getApi: () => client,
    ensureConnected: async () => { ensureConnectedCalls += 1; },
    setAppState: value => { setValue = value; },
    logger: logger(),
    intervalMs: 60_000
  });
  const result = await manager.refresh();
  assert.equal(result.success, true);
  assert.strictEqual(client, client);
  assert.deepEqual(setValue, expected);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'appstate.json'), 'utf8')), expected);
  assert.equal(ensureConnectedCalls, 0);
  assert.equal(manager.getState().successCount, 1);
  manager.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});
