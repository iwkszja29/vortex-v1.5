const fs = require('node:fs/promises');
const path = require('node:path');
const { validateAppState } = require('./appState');
const { atomicWrite } = require('./atomicFile');

const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000;

class AppStateRefreshManager {
  constructor({ dataDir, getApi, setAppState, logger, intervalMs = DEFAULT_INTERVAL_MS }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'appstate-refresh-stats.json');
    this.appStateFile = path.join(dataDir, 'appstate.json');
    this.getApi = getApi;
    this.setAppState = setAppState;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.inFlight = null;
    this.stopped = false;
    this.stats = {
      successCount: 0,
      failureCount: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      nextRefreshAt: null,
      refreshing: false
    };
  }

  async init() {
    this.stopped = false;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.stats = { ...this.stats, ...saved, refreshing: false };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        this.logger.warn('APPSTATE_REFRESH_STATS_LOAD_FAILED', { error: String(error.message || error).slice(0, 160) });
      }
    }
    if (!Number.isFinite(Date.parse(this.stats.nextRefreshAt))) {
      this.stats.nextRefreshAt = new Date(Date.now() + this.intervalMs).toISOString();
    }
    this.schedule();
  }

  getState() {
    return { ...this.stats, intervalMs: this.intervalMs };
  }

  schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Date.parse(this.stats.nextRefreshAt) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh({ manual: false }).catch(() => {});
    }, delay);
    this.timer.unref?.();
  }

  async persistStats() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const safe = { ...this.stats, refreshing: false };
    await atomicWrite(this.file, JSON.stringify(safe, null, 2), 0o600);
  }

  async refresh({ manual = true } = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performRefresh(manual);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async performRefresh(manual) {
    this.stats.refreshing = true;
    this.stats.lastAttemptAt = new Date().toISOString();
    try {
      // Export the current live session only. Never log in, reconnect, disconnect,
      // or restart the runtime as part of a scheduled/manual AppState refresh.
      const api = this.getApi();
      if (!api) throw new Error('Bot is not connected; refresh skipped to avoid reconnecting or restarting it.');
      if (typeof api.getAppState !== 'function') {
        throw new Error('The connected FCA client does not expose getAppState(); session state cannot be exported safely.');
      }
      const refreshed = validateAppState(await api.getAppState());
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(this.appStateFile, JSON.stringify(refreshed), 0o600);
      this.setAppState(refreshed);
      this.stats.successCount += 1;
      this.stats.lastSuccessAt = new Date().toISOString();
      this.stats.lastError = null;
      this.logger.info('APPSTATE_REFRESH_SUCCEEDED', { manual, count: this.stats.successCount });
      return { success: true, state: this.getState() };
    } catch (error) {
      this.stats.failureCount += 1;
      this.stats.lastFailureAt = new Date().toISOString();
      this.stats.lastError = String(error.message || '').includes('getAppState') ? 'FCA client does not expose getAppState().' : String(error.message || '').includes('not connected') ? 'Bot is offline; refresh skipped without reconnecting.' : 'Refresh failed. Check the connection and FCA runtime status.';
      this.logger.warn('APPSTATE_REFRESH_FAILED', { manual, count: this.stats.failureCount, error: this.stats.lastError });
      throw error;
    } finally {
      this.stats.refreshing = false;
      this.stats.nextRefreshAt = new Date(Date.now() + this.intervalMs).toISOString();
      await this.persistStats().catch(error => {
        this.logger.warn('APPSTATE_REFRESH_STATS_SAVE_FAILED', { error: String(error.message || error).slice(0, 160) });
      });
      if (!this.stopped) this.schedule();
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async stopAndWait() {
    this.stop();
    if (this.inFlight) {
      try { await this.inFlight; } catch {}
    }
  }
}

module.exports = { AppStateRefreshManager, DEFAULT_INTERVAL_MS };
