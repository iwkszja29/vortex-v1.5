'use strict';

const DEFAULT_NICKNAME = '𝑽𝑶𝑹𝑻𝑬𝑿 →';

function callWithCallback(api, method, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!api || typeof api[method] !== 'function') {
      reject(new Error(`FCA method ${method} is unavailable`));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
    timer.unref?.();
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    }
    const callback = (error, value) => finish(error, value);
    try {
      const result = api[method](...args, callback);
      if (result && typeof result.then === 'function') result.then(value => finish(null, value), finish);
    } catch (error) {
      finish(error);
    }
  });
}

class NicknameGuard {
  constructor({ getApi, logger = console, nickname = DEFAULT_NICKNAME, cooldownMs = 30000 } = {}) {
    this.getApi = getApi;
    this.logger = logger;
    this.nickname = nickname;
    this.cooldownMs = cooldownMs;
    this.checkedAt = new Map();
    this.inFlight = new Map();
  }

  async handle(event) {
    if (!event || !event.threadID) return;
    const api = this.getApi?.();
    if (!api) return;

    const logType = event.logMessageType || event.type;
    if (logType === 'log:user-nickname') {
      const data = event.logMessageData || {};
      const botID = this.getBotID(api);
      const participantID = String(data.participant_id || data.participantID || '');
      const changedNickname = data.nickname ?? data.newNickname;
      if (botID && participantID === botID && changedNickname !== this.nickname) {
        this.checkedAt.delete(String(event.threadID));
        await this.ensureThread(event.threadID, api, true);
      }
      return;
    }

    if (logType === 'log:subscribe') {
      await this.ensureThread(event.threadID, api, true);
      return;
    }

    // The first message seen in a conversation is also a useful signal that
    // the bot is present there; thread metadata prevents renaming 1:1 chats.
    if (event.type === 'message' && event.body) {
      await this.ensureThread(event.threadID, api, false);
    }
  }

  getBotID(api) {
    try {
      const id = typeof api.getCurrentUserID === 'function' ? api.getCurrentUserID() : null;
      return id == null ? '' : String(id);
    } catch {
      return '';
    }
  }

  async ensureThread(threadID, api, force) {
    const id = String(threadID);
    const now = Date.now();
    if (!force && now - (this.checkedAt.get(id) || 0) < this.cooldownMs) return;
    if (this.inFlight.has(id)) return this.inFlight.get(id);

    const task = (async () => {
      this.checkedAt.set(id, Date.now());
      const info = await callWithCallback(api, 'getThreadInfo', [id]);
      const participants = Array.isArray(info?.participantIDs)
        ? info.participantIDs.map(String)
        : Array.isArray(info?.participants)
          ? info.participants.map(p => String(p.userID || p.id || '')).filter(Boolean)
          : [];
      const isGroup = info?.isGroup === true || String(info?.threadType || '').toUpperCase() === 'GROUP' || participants.length > 2;
      if (!isGroup) return;

      const botID = this.getBotID(api);
      if (!botID || (participants.length && !participants.includes(botID))) return;
      const nicknames = info?.nicknames || {};
      if (nicknames[botID] === this.nickname) return;

      await callWithCallback(api, 'changeNickname', [this.nickname, id, botID]);
      this.logger.info?.('BOT_NICKNAME_ENFORCED', { threadID: id });
    })().catch(error => {
      // Retry on a later message/event if FCA is temporarily unavailable.
      this.checkedAt.delete(id);
      this.logger.warn?.('BOT_NICKNAME_ENFORCEMENT_FAILED', {
        threadID: id,
        error: String(error?.message || error).slice(0, 200)
      });
    }).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, task);
    return task;
  }
}

module.exports = { NicknameGuard, DEFAULT_NICKNAME };
