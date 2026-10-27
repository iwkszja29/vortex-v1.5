const fs = require('node:fs/promises');
const path = require('node:path');
const { loadCommands } = require('./commandLoader');
const { validateAppState } = require('./appState');
const { atomicWrite } = require('./atomicFile');
const { ReconnectManager } = require('./reconnect');
const { AppStateRefreshManager } = require('./appStateRefresh');
const { NicknameGuard } = require('./nicknameGuard');
const { createHumanWriter } = require('./humanWriter');
const { isAuthorizedSender } = require('./accessControl');

function createBotRuntime({ config, logger }) {
  const cmdsDir = path.join(__dirname, '..', 'cmds');
  let loaded = loadCommands(cmdsDir, logger);
  let api = null;
  let status = 'offline';
  let lastError = null;
  let lastConnect = null;
  let lastDisconnect = null;
  let reconnects = 0;
  let startedAt = Date.now();
  let connecting = false;
  let appStatePresent = false;
  let appState = null;
  let sessionCleared = false;
  let reconnectManager;
  let appStateRefreshManager;
  let mqttStatus = 'offline';
  let manualDisconnect = false;
  let requiresSessionUpdate = false;
  let sessionHealth = 'unknown';
  let sessionMessage = 'Session status has not been verified yet.';
  function isSessionAuthError(value) {
    const message = String(value?.message || value || '').toLowerCase();
    return /checkpoint|login approval|login required|invalid appstate|invalid cookie|cookie.{0,20}(expired|invalid)|session.{0,20}(expired|invalid)|not logged in|authentication failed|account disabled|two.factor|\b401\b|\b403\b|please log in/.test(message);
  }
  async function initializeAppStateRefreshManager() {
    if (appStateRefreshManager) return;
    appStateRefreshManager = new AppStateRefreshManager({
      dataDir: config.dataDir,
      getApi: () => api,
      ensureConnected: async () => { if (!api) await runtime.connect(); },
      setAppState: value => { appState = value; appStatePresent = true; },
      logger
    });
    await appStateRefreshManager.init();
  }
  function setSessionAttention(reason) {
    requiresSessionUpdate = true;
    sessionHealth = 'needs-attention';
    sessionMessage = 'Facebook may have expired this session or requires account verification. Update AppState in the dashboard, then connect again.';
    lastError = sessionMessage;
    reconnectManager?.stop();
    logger.warn('SESSION_REAUTH_REQUIRED', { reason: 'authentication-or-checkpoint-error' });
  }
  const nicknameGuard = new NicknameGuard({ getApi: () => api, logger, nickname: '𝑽𝑶𝑹𝑻𝑬𝑿 →' });
  const humanWriter = createHumanWriter({
    logger, minIntervalMs: 5000, globalIntervalMs: 2500, duplicateWindowMs: 30000, maxPerMinute: 8, circuitPauseMs: 30 * 60 * 1000, maxConsecutiveFailures: 2,
    onSafetyStop: ({ type, reason }) => {
      clearRepeatingMessages();
      logger.warn('OUTBOUND_AUTOMATION_STOPPED', { type, reason });
      if (type === 'session' && runtime) {
        runtime.disconnected('checkpoint/login required after outbound send error').catch(() => {});
      }
    }
  });
  const seenCommandMessages = new Map();
  const repeatingMessages = new Map();
  function clearRepeatingMessages() {
    for (const task of repeatingMessages.values()) {
      clearInterval(task.timer);
      clearTimeout(task.inactivityTimer);
    }
    repeatingMessages.clear();
  }

  const runtime = {
    startRepeatingMessage({ threadID, senderID, messages, intervalMs, inactivityMs = 16 * 60 * 1000 }) {
      const thread = String(threadID);
      if (repeatingMessages.has(thread)) return { started: false, reason: 'already-running' };
      if (!api || typeof api.sendMessage !== 'function') return { started: false, reason: 'offline' };
      if (!Array.isArray(messages) || messages.length !== 2 || messages.some(message => !String(message || '').trim()) ||
          !Number.isFinite(intervalMs) || intervalMs < 15000 || intervalMs > 86400000) {
        return { started: false, reason: 'invalid-input' };
      }
      const task = { senderID: String(senderID), messages: messages.map(String), intervalMs, inactivityMs, busy: false, timer: null, inactivityTimer: null, replied: false };
      const finishForInactivity = async () => {
        if (repeatingMessages.get(thread) !== task) return;
        clearInterval(task.timer);
        clearTimeout(task.inactivityTimer);
        repeatingMessages.delete(thread);
        logger.info('REPEATING_MESSAGE_INACTIVITY_STOPPED', { threadID: thread, inactivityMs });
        try {
          if (api && status === 'connected') {
            await humanWriter.wrap(api).sendMessage('ℹ️ انتهت 16 دقيقة دون رد من أعضاء المحادثة؛ أوقفت التكرار تلقائياً.', thread);
          }
        } catch (error) {
          logger.warn('REPEATING_MESSAGE_NOTICE_FAILED', { threadID: thread, error: String(error?.message || error).slice(0, 160) });
        }
      };
      task.inactivityTimer = setTimeout(finishForInactivity, inactivityMs);
      task.timer = setInterval(async () => {
        if (task.busy || !api || status !== 'connected' || repeatingMessages.get(thread) !== task) return;
        task.busy = true;
        try {
          await humanWriter.wrap(api).sendMessage(task.messages[0], thread);
          await humanWriter.wrap(api).sendMessage(task.messages[1], thread);
        } catch (error) {
          logger.warn('REPEATING_MESSAGE_FAILED', { threadID: thread, error: String(error?.message || error).slice(0, 160) });
        } finally {
          task.busy = false;
        }
      }, intervalMs);
      task.timer.unref?.();
      task.inactivityTimer.unref?.();
      repeatingMessages.set(thread, task);
      logger.info('REPEATING_MESSAGE_STARTED', { threadID: thread, intervalMs, inactivityMs, messageCount: 2 });
      return { started: true, intervalMs, inactivityMs };
    },
    noteRepeatingMessageReply(event) {
      if (!event?.threadID || !event?.senderID || !String(event.body || '').trim()) return;
      const task = repeatingMessages.get(String(event.threadID));
      if (!task || String(event.senderID) === task.senderID) return;
      clearTimeout(task.inactivityTimer);
      task.inactivityTimer = setTimeout(async () => {
        if (repeatingMessages.get(String(event.threadID)) !== task) return;
        clearInterval(task.timer);
        repeatingMessages.delete(String(event.threadID));
        logger.info('REPEATING_MESSAGE_INACTIVITY_STOPPED', { threadID: String(event.threadID), inactivityMs: task.inactivityMs });
        try {
          if (api && status === 'connected') await humanWriter.wrap(api).sendMessage('ℹ️ مرّت 16 دقيقة دون رد جديد؛ أوقفت التكرار تلقائياً.', String(event.threadID));
        } catch (error) {
          logger.warn('REPEATING_MESSAGE_NOTICE_FAILED', { threadID: String(event.threadID), error: String(error?.message || error).slice(0, 160) });
        }
      }, task.inactivityMs);
      task.inactivityTimer.unref?.();
    },
    stopRepeatingMessage(threadID) {
      const thread = String(threadID);
      const task = repeatingMessages.get(thread);
      if (!task) return { stopped: false, reason: 'not-running' };
      clearInterval(task.timer);
      clearTimeout(task.inactivityTimer);
      repeatingMessages.delete(thread);
      logger.info('REPEATING_MESSAGE_STOPPED', { threadID: thread });
      return { stopped: true };
    },
    getState() {
      return {
        bot: config.botName, prefix: config.prefix, status, fcaStatus: status, mqttStatus,
        connected: status === 'connected', uptimeMs: Date.now() - startedAt,
        sessionHealth, sessionMessage, requiresSessionUpdate,
        commands: loaded.unique.length, reconnectAttempts: reconnects,
        lastConnection: lastConnect, lastDisconnect, lastError,
        appStateConfigured: appStatePresent,
        appStateRefresh: appStateRefreshManager ? appStateRefreshManager.getState() : {
          successCount: 0, failureCount: 0, lastAttemptAt: null, lastSuccessAt: null,
          lastFailureAt: null, lastError: null, nextRefreshAt: null, refreshing: false,
          intervalMs: 3 * 60 * 60 * 1000
        },
        outboundProtection: humanWriter.getState(), botID: null, version: require('../package.json').version
      };
    },
    getCommands() {
      return loaded.unique.map(c => ({
        name: c.name, aliases: c.aliases, description: c.description || '',
        adminOnly: !!c.adminOnly, file: c.file, status: 'loaded'
      }));
    },
    getCommandSource(name) {
      const c = loaded.unique.find(x => x.name === name || x.aliases.includes(name));
      if (!c) throw new Error('Command not found');
      return require('node:fs').readFileSync(path.join(cmdsDir, c.file), 'utf8');
    },
    refreshCommands() {
      loaded = loadCommands(cmdsDir, logger);
      return { count: loaded.unique.length, errors: loaded.errors };
    },
    async setAdminIDs(ids) {
      if (!Array.isArray(ids) || ids.some(id => !/^\d{1,30}$/.test(String(id)))) throw new Error('Invalid admin IDs');
      const next = [...new Set(ids.map(String).filter(id => !(config.ownerIDs || [config.ownerID]).includes(id)))];
      if (next.length > 20) throw new Error('Maximum of 20 regular Admins reached');
      config.adminIDs = next;
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(config.dataDir, 'settings.json'), JSON.stringify({
        botName: config.botName, prefix: config.prefix, language: config.language,
        ownerIDs: config.ownerIDs || (config.ownerID ? [config.ownerID] : []), adminIDs: config.adminIDs
      }, null, 2), 0o600);
      return { admins: [...config.adminIDs] };
    },
    async setOwnerIDs(ids) {
      if (!Array.isArray(ids) || ids.some(id => !/^\d{1,30}$/.test(String(id)))) throw new Error('Invalid Owner IDs');
      const next = [...new Set(ids.map(String))];
      if (next.length < 1 || next.length > 3) throw new Error('Owner list must contain 1 to 3 IDs');
      const oldOwners = config.ownerIDs || (config.ownerID ? [config.ownerID] : []);
      const oldOwnerID = config.ownerID;
      const oldAdmins = config.adminIDs;
      config.ownerIDs = next;
      config.ownerID = next[0];
      config.adminIDs = config.adminIDs.filter(id => !next.includes(id));
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      try {
        await atomicWrite(path.join(config.dataDir, 'settings.json'), JSON.stringify({
          botName: config.botName, prefix: config.prefix, language: config.language,
          ownerIDs: config.ownerIDs, adminIDs: config.adminIDs
        }, null, 2), 0o600);
      } catch (error) {
        config.ownerIDs = oldOwners; config.ownerID = oldOwnerID; config.adminIDs = oldAdmins;
        throw error;
      }
      return { owners: [...config.ownerIDs], ownerID: config.ownerID, admins: [...config.adminIDs] };
    },
    async saveAppState(raw, connect = false) {
      const parsed = validateAppState(raw);
      const file = path.join(config.dataDir, 'appstate.json');
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(file, JSON.stringify(parsed), 0o600);
      await fs.rm(path.join(config.dataDir, '.appstate-cleared'), { force: true });
      appState = parsed;
      appStatePresent = true;
      sessionCleared = false;
      humanWriter.resetProtection();
      await initializeAppStateRefreshManager();
      requiresSessionUpdate = false;
      sessionHealth = 'checking';
      sessionMessage = 'New AppState saved. Checking the session connection.';
      lastError = null;
      reconnectManager?.start();
      if (connect) await runtime.connect();
      return { valid: true, connected: status === 'connected' };
    },
    async connect() {
      if (connecting || status === 'connected') return { status, mqttStatus };
      if (requiresSessionUpdate) return { status: 'needs-attention', mqttStatus, sessionHealth, sessionMessage };
      if (reconnectManager && manualDisconnect) {
        reconnectManager.start();
        manualDisconnect = false;
      }
      connecting = true;
      status = 'connecting';
      mqttStatus = 'connecting';
      lastError = null;
      try {
        if (!appState) {
          try { await fs.access(path.join(config.dataDir, '.appstate-cleared')); sessionCleared = true; } catch {}
          if (sessionCleared) throw new Error('No AppState saved. Add a new session in the dashboard.');
          let raw = '';
          try { raw = await fs.readFile(path.join(config.dataDir, 'appstate.json'), 'utf8'); } catch {}
          if (!raw && config.appStateJson) raw = config.appStateJson;
          if (!raw && config.appStateFile) {
            try { raw = await fs.readFile(config.appStateFile, 'utf8'); } catch {}
          }
          if (!raw) throw new Error('No AppState configured');
          appState = validateAppState(raw);
          appStatePresent = true;
        }
        const mod = require('@dongdev/fca-unofficial');
        const login = typeof mod === 'function' ? mod : (mod.login || mod.default?.login || mod.default);
        if (typeof login !== 'function') throw new Error('Installed FCA package does not expose a supported login() API');
        await new Promise((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => finish(new Error('FCA login timed out')), 30000);
          function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            err ? reject(err) : resolve(value);
          }
          try {
            login({ appState }, { listenEvents: true, autoReconnect: false, logLevel: 'error' }, (err, client) => {
              if (err) return finish(new Error('FCA login failed: ' + String(err.message || err).slice(0, 300)));
              if (!client || typeof client.listenMqtt !== 'function') return finish(new Error('FCA returned an unsupported client'));
              api = client;
              try {
                client.setOptions?.({ listenEvents: true, autoReconnect: false, logLevel: 'error' });
                const listener = client.listenMqtt((e, event) => {
                  if (e) {
                    logger.warn('FCA_EVENT_ERROR', { error: isSessionAuthError(e) ? 'authentication-or-checkpoint-error' : String(e.message || e).slice(0, 200) });
                    if (api === client) runtime.disconnected(e.message || 'mqtt-event-error');
                    return;
                  }
                  if (event) {
                    mqttStatus = 'connected';
                    runtime.handleEvent(event).catch(x => logger.error('EVENT_HANDLER_FAILED', { error: String(x.message || x).slice(0, 200) }));
                  }
                });
                if (listener?.on) {
                  listener.on('error', e => {
                    mqttStatus = 'error';
                    logger.warn('MQTT_ERROR', { error: isSessionAuthError(e) ? 'authentication-or-checkpoint-error' : String(e.message || e).slice(0, 200) });
                    if (api === client) runtime.disconnected(e.message || 'mqtt-listener-error');
                  });
                  listener.on('close', () => {
                    mqttStatus = 'offline';
                    if (api === client) runtime.disconnected('mqtt-close');
                  });
                  listener.on('end', () => {
                    mqttStatus = 'offline';
                    if (api === client) runtime.disconnected('mqtt-end');
                  });
                }
                mqttStatus = 'connected';
              } catch (e) { return finish(e); }
              status = 'connected';
              sessionHealth = 'healthy';
              sessionMessage = 'The FCA session is connected. Facebook presence may still be controlled by Facebook.';
              requiresSessionUpdate = false;
              lastConnect = new Date().toISOString();
              lastError = null;
              finish(null, client);
            });
          } catch (e) { finish(e); }
        });
        reconnectManager?.reset();
        return { status };
      } catch (e) {
        mqttStatus = 'offline';
        if (isSessionAuthError(e)) {
          setSessionAttention(e);
          status = 'needs-attention';
        } else {
          status = 'offline';
          sessionHealth = 'disconnected';
          sessionMessage = 'The connection failed. The bot will retry with a delay; check logs if it continues.';
          lastError = String(e.message || e).slice(0, 300);
        }
        lastDisconnect = new Date().toISOString();
        logger.error('FCA_CONNECT_FAILED', { error: requiresSessionUpdate ? 'authentication-or-checkpoint-error' : lastError });
        throw e;
      } finally {
        connecting = false;
      }
    },
    async disconnected(reason) {
      clearRepeatingMessages();
      if (!api && (status === 'offline' || requiresSessionUpdate)) return;
      lastDisconnect = new Date().toISOString();
      mqttStatus = 'offline';
      api = null;
      if (isSessionAuthError(reason)) {
        setSessionAttention(reason);
        status = 'needs-attention';
      } else {
        status = 'offline';
        sessionHealth = 'disconnected';
        sessionMessage = 'The connection was lost. Automatic reconnection will retry with increasing delays.';
        lastError = String(reason || 'connection lost').slice(0, 200);
      }
      logger.warn('FCA_DISCONNECTED', { reason: requiresSessionUpdate ? 'authentication-or-checkpoint-error' : lastError });
      reconnects++;
      if (!manualDisconnect && !requiresSessionUpdate) reconnectManager?.schedule();
    },
    async handleEvent(event) {
      nicknameGuard.handle(event).catch(e => logger.warn('NICKNAME_GUARD_FAILED', { error: String(e.message || e).slice(0, 200) }));
      if (!event || !['message', 'message_reply', 'messageCreate'].includes(event.type) || !event.body || !event.threadID) return;
      const body = String(event.body).trim();
      runtime.noteRepeatingMessageReply(event);
      // Strict allow-list: only IDs configured as Owners/Admins may invoke commands or answer command prompts.
      // This intentionally keeps ordinary group messages from triggering command handlers or replies.
      if (!isAuthorizedSender(event.senderID, config.ownerIDs || [config.ownerID], config.adminIDs || [])) return;
      // Stateful commands may consume plain numeric/confirmation replies without the command prefix.
      const replySender = String(event.senderID || '');
      const replyIsOwner = (config.ownerIDs || [config.ownerID]).filter(Boolean).includes(replySender);
      const replyIsAdmin = replyIsOwner || config.adminIDs.includes(replySender);
      const replyContext = { ...event, args: [], commandName: '', startedAt: Date.now(), config, runtime, isOwner: replyIsOwner, isAdmin: replyIsAdmin };
      for (const command of loaded.unique) {
        if (typeof command.handleReply !== 'function') continue;
        try {
          const handled = await command.handleReply(humanWriter.wrap(api), replyContext);
          if (handled) return;
        } catch (error) {
          logger.warn('COMMAND_REPLY_HANDLER_FAILED', { name: command.name, error: String(error?.message || error).slice(0, 180) });
          return;
        }
      }
      // All commands, including repeating-message controls, must use the dashboard-configured prefix.
      if (!body.startsWith(config.prefix)) return;
      const commandText = body.slice(config.prefix.length).trim();
      const [rawName, ...args] = commandText.split(/\s+/);
      if (!rawName) return;
      const cmd = loaded.commands.get(rawName.toLowerCase());
      if (!cmd) return;
      const sender = String(event.senderID || '');
      const isOwner = (config.ownerIDs || [config.ownerID]).filter(Boolean).includes(sender);
      const isAdmin = isOwner || config.adminIDs.includes(sender);
      if (event.messageID) {
        const now = Date.now();
        for (const [key, at] of seenCommandMessages) if (now - at > 300000) seenCommandMessages.delete(key);
        const dedupeKey = String(event.threadID) + ':' + String(event.messageID);
        if (seenCommandMessages.has(dedupeKey)) {
          logger.warn('DUPLICATE_COMMAND_SUPPRESSED', { command: cmd.name, threadID: String(event.threadID) });
          return;
        }
        seenCommandMessages.set(dedupeKey, now);
        if (seenCommandMessages.size > 2000) {
          const oldest = [...seenCommandMessages.entries()].sort((a, b) => a[1] - b[1]).slice(0, 500);
          for (const [key] of oldest) seenCommandMessages.delete(key);
        }
      }
      // Give every recognized command a natural typing pause before it responds.
      // FCA exposes sendTypingIndicator(threadID, callback) on supported versions.
      try {
        if (typeof api?.sendTypingIndicator === 'function') {
          api.sendTypingIndicator(event.threadID, () => {});
        }
      } catch (error) {
        logger.warn('TYPING_INDICATOR_FAILED', { error: String(error?.message || error).slice(0, 120) });
      }
      const typingDelayMs = 4000 + Math.floor(Math.random() * 2001);
      await new Promise(resolve => setTimeout(resolve, typingDelayMs));

      if (cmd.adminOnly && !isAdmin) {
        humanWriter.wrap(api).sendMessage('⛔ هذا الأمر للمسؤولين فقط.', event.threadID, event.messageID).catch(() => {});
        return;
      }
      const ctx = { ...event, args, commandName: rawName, startedAt: Date.now(), config, runtime, isOwner, isAdmin };
      try {
        await cmd.execute(humanWriter.wrap(api), ctx);
        logger.command('COMMAND_OK', { name: cmd.name, senderID: sender, role: isOwner ? 'owner' : isAdmin ? 'admin' : 'user' });
      } catch (e) {
        logger.error('COMMAND_FAILED', { name: cmd.name, error: String(e.message || e).slice(0, 200) });
      }
    },
    async disconnect() {
      clearRepeatingMessages();
      manualDisconnect = true;
      reconnectManager?.stop();
      if (api && typeof api.logout === 'function') {
        try { await api.logout(); } catch (e) { logger.warn('FCA_LOGOUT_FAILED', { error: e.message }); }
      }
      api = null;
      status = 'offline';
      mqttStatus = 'offline';
      lastDisconnect = new Date().toISOString();
      return { status, mqttStatus };
    },
    async clearAppStateSession() {
      if (appStateRefreshManager) {
        await appStateRefreshManager.stopAndWait();
        appStateRefreshManager = null;
      }
      await runtime.disconnect();
      const appStateFile = path.join(config.dataDir, 'appstate.json');
      const refreshStatsFile = path.join(config.dataDir, 'appstate-refresh-stats.json');
      await fs.rm(appStateFile, { force: true });
      await fs.rm(refreshStatsFile, { force: true });
      await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(config.dataDir, '.appstate-cleared'), new Date().toISOString(), 0o600);
      appState = null;
      appStatePresent = false;
      config.appStateJson = '';
      config.appStateFile = '';
      sessionCleared = true;
      requiresSessionUpdate = false;
      sessionHealth = 'no-session';
      sessionMessage = 'Session removed. Paste a new AppState to connect again.';
      lastError = null;
      lastConnect = null;
      lastDisconnect = null;
      mqttStatus = 'offline';
      reconnects = 0;
      startedAt = Date.now();
      seenCommandMessages.clear();
      clearRepeatingMessages();
      logger.warn('APPSTATE_SESSION_REMOVED', { localSessionDataRemoved: true });
      return { status: 'offline', appStateConfigured: false, sessionCleared: true };
    },
    async refreshAppStateNow() {
      if (!appStateRefreshManager) throw new Error('AppState refresh manager is not ready');
      return appStateRefreshManager.refresh({ manual: true });
    },
    async stop() {
      appStateRefreshManager?.stop();
      await runtime.disconnect();
    },
    async start() {
      try {
        await fs.access(path.join(config.dataDir, '.appstate-cleared'));
        sessionCleared = true;
        appStatePresent = false;
        sessionHealth = 'no-session';
        sessionMessage = 'Session removed. Paste a new AppState to connect again.';
      } catch {
        await initializeAppStateRefreshManager();
      }
      reconnectManager = new ReconnectManager({
        connect: () => runtime.connect(), logger,
        baseMs: config.connection?.baseBackoffMs || 2000,
        maxMs: config.connection?.maxBackoffMs || 60000
      });
      reconnectManager.start();
      manualDisconnect = false;
      try { await runtime.connect(); } catch { if (!sessionCleared) reconnectManager.schedule(); }
    },
    async listMessengerThreads(folder = 'inbox') {
      if (!api || status !== 'connected') throw new Error('Connect the account with a valid AppState first.');
      if (typeof api.getThreadList !== 'function') throw new Error('This FCA version does not support listing Messenger threads.');
      const tags = { inbox: ['INBOX'], requests: ['PENDING'], spam: ['OTHER'] };
      if (!Object.prototype.hasOwnProperty.call(tags, folder)) throw new Error('Invalid Messenger folder.');
      return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => finish(new Error('Messenger request timed out.')), 15000);
        function finish(error, value) {
          if (done) return; done = true; clearTimeout(timer);
          error ? reject(new Error(String(error.message || error).slice(0, 220))) : resolve(Array.isArray(value) ? value : []);
        }
        try {
          const result = api.getThreadList(40, null, tags[folder], finish);
          if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
        } catch (error) { finish(error); }
      });
    },
    async getMessengerHistory(threadID, limit = 40) {
      if (!api || status !== 'connected') throw new Error('Connect the account with a valid AppState first.');
      if (!/^\d{1,40}$/.test(String(threadID))) throw new Error('Invalid thread ID.');
      if (typeof api.getThreadHistory !== 'function') throw new Error('This FCA version does not support conversation history.');
      return new Promise((resolve, reject) => {
        let done = false; const timer = setTimeout(() => finish(new Error('Messenger history request timed out.')), 15000);
        function finish(error, value) {
          if (done) return; done = true; clearTimeout(timer);
          error ? reject(new Error(String(error.message || error).slice(0, 220))) : resolve(Array.isArray(value) ? value : []);
        }
        try {
          const result = api.getThreadHistory(String(threadID), Math.max(1, Math.min(60, Number(limit) || 40)), null, finish);
          if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
        } catch (error) { finish(error); }
      });
    },
    async sendMessengerReply(threadID, message) {
      if (!api || status !== 'connected') throw new Error('Connect the account with a valid AppState first.');
      if (!/^\d{1,40}$/.test(String(threadID))) throw new Error('Invalid thread ID.');
      if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw new Error('Message must contain 1–2000 characters.');
      if (typeof api.sendMessage !== 'function') throw new Error('This FCA version does not support sending Messenger replies.');
      return new Promise((resolve, reject) => {
        let done = false; const timer = setTimeout(() => finish(new Error('Message send timed out.')), 15000);
        function finish(error, value) {
          if (done) return; done = true; clearTimeout(timer);
          error ? reject(new Error(String(error.message || error).slice(0, 220))) : resolve({ sent: true, result: value || null });
        }
        try {
          const result = api.sendMessage(message.trim(), String(threadID), finish);
          if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
        } catch (error) { finish(error); }
      });
    },
    async handleMessengerRequest(threadID, accept = true) {
      if (!api || status !== 'connected') throw new Error('Connect the account with a valid AppState first.');
      if (!/^\d{1,40}$/.test(String(threadID))) throw new Error('Invalid thread ID.');
      if (typeof api.handleMessageRequest !== 'function') throw new Error('This FCA version does not expose message-request accept/decline.');
      return new Promise((resolve, reject) => {
        let done = false; const timer = setTimeout(() => finish(new Error('Message-request action timed out.')), 15000);
        function finish(error, value) {
          if (done) return; done = true; clearTimeout(timer);
          error ? reject(new Error(String(error.message || error).slice(0, 220))) : resolve({ ok: true, result: value || null });
        }
        try {
          const result = api.handleMessageRequest(String(threadID), !!accept, finish);
          if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
        } catch (error) { finish(error); }
      });
    },
    get api() { return api; },
    async editCommand(name, source) {
      // Normalize dashboard input before validating; mobile keyboards may add whitespace.
      name = typeof name === 'string' ? name.trim() : '';
      if (!/^[a-z0-9_-]{1,32}\.js$/i.test(name)) throw new Error('Invalid command filename. Use a name like nm.js (letters, numbers, _ or - only).');
      const vm = require('node:vm');
      new vm.Script(source, { filename: name });
      const target = path.resolve(cmdsDir, name);
      if (path.dirname(target) !== path.resolve(cmdsDir)) throw new Error('Invalid path');
      await fs.mkdir(path.join(config.dataDir, 'backups'), { recursive: true, mode: 0o700 });
      try {
        const old = await fs.readFile(target, 'utf8');
        await atomicWrite(path.join(config.dataDir, 'backups', `${name}.${Date.now()}.bak`), old);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await atomicWrite(target, source, 0o600);
      const result = runtime.refreshCommands();
      if (result.errors.some(e => e.file === name)) throw new Error('Command failed validation after save');
      return result;
    },
    async deleteCommand(name) {
      name = typeof name === 'string' ? name.trim() : '';
      if (!/^[a-z0-9_-]{1,32}\.js$/i.test(name)) throw new Error('Invalid command filename. Use a name like nm.js (letters, numbers, _ or - only).');
      const target = path.resolve(cmdsDir, name);
      if (path.dirname(target) !== path.resolve(cmdsDir)) throw new Error('Invalid path');
      await fs.unlink(target);
      return runtime.refreshCommands();
    }
  };
  return runtime;
}
module.exports = { createBotRuntime };
