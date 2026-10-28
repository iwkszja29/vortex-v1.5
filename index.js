const express = require('express');
const { startDashboard } = require('./dashboard/server');
const { createBotRuntime } = require('./utils/botRuntime');
const { createLogger } = require('./utils/logger');
const { loadConfig } = require('./utils/config');

async function main() {
  const logger = createLogger();
  const config = loadConfig();
  const path = require('node:path');
  const secondaryDataDir = path.join(config.dataDir, 'account-2');
  // Each runtime checks the other runtime's persisted AppState before saving/connecting.
  config.peerAppStateFiles = [path.join(secondaryDataDir, 'appstate.json')];
  const runtime = createBotRuntime({ config, logger });
  const secondConfig = { ...config, dataDir: secondaryDataDir, peerAppStateFiles: [path.join(config.dataDir, 'appstate.json')], appStateJson: '', appStateFile: '', ownerIDs: [...config.ownerIDs], adminIDs: [...config.adminIDs] };
  const secondRuntime = createBotRuntime({ config: secondConfig, logger });
  const server = await startDashboard({ config, logger, runtime, accounts: { primary: runtime, secondary: secondRuntime, secondaryConfig: secondConfig } });
  await Promise.all([
    runtime.start().catch(err => logger.error('BOT_START_FAILED', { account: 1, error: err.message })),
    secondRuntime.start().catch(err => logger.error('BOT_START_FAILED', { account: 2, error: err.message }))
  ]);
  const shutdown = async () => {
    logger.info('SHUTDOWN_REQUESTED');
    await Promise.all([
      runtime.stop().catch(err => logger.warn('BOT_STOP_FAILED', { account: 1, error: err.message })),
      secondRuntime.stop().catch(err => logger.warn('BOT_STOP_FAILED', { account: 2, error: err.message }))
    ]);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
main().catch(err => { console.error('Fatal startup error:', err.message); process.exitCode = 1; });
