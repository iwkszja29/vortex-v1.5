const DEFAULTS = {
  minIntervalMs: 5000,
  globalIntervalMs: 2500,
  duplicateWindowMs: 30000,
  maxPerMinute: 8,
  failureWindowMs: 120000,
  maxConsecutiveFailures: 2,
  circuitPauseMs: 30 * 60 * 1000
};

function createHumanWriter({ logger = console, onSafetyStop = () => {}, ...options } = {}) {
  const config = { ...DEFAULTS, ...options };
  let queue = Promise.resolve();
  let lastGlobalSend = 0;
  const lastThreadSend = new Map();
  const recentMessages = new Map();
  const sentAt = [];
  const recentFailures = [];
  let consecutiveFailures = 0;
  let pausedUntil = 0;
  let pausedReason = null;

  function prune(now) {
    for (const [key, at] of recentMessages) if (now - at > config.duplicateWindowMs) recentMessages.delete(key);
    while (sentAt.length && now - sentAt[0] >= 60000) sentAt.shift();
    while (recentFailures.length && now - recentFailures[0] > config.failureWindowMs) recentFailures.shift();
    if (recentMessages.size > 2000) {
      const entries = [...recentMessages.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of entries.slice(0, recentMessages.size - 1500)) recentMessages.delete(key);
    }
  }

  function contentKey(value) {
    try { return typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : JSON.stringify(value); }
    catch { return String(value); }
  }

  function refreshPause(now = Date.now()) {
    if (pausedUntil !== Infinity && pausedUntil > 0 && now >= pausedUntil) {
      pausedUntil = 0;
      pausedReason = null;
      consecutiveFailures = 0;
      recentFailures.length = 0;
    }
  }

  function triggerPause(reason, durationMs, type) {
    if (pausedUntil === Infinity || (pausedUntil > Date.now())) return;
    pausedUntil = durationMs === Infinity ? Infinity : Date.now() + durationMs;
    pausedReason = reason;
    logger.warn?.('OUTBOUND_SAFETY_PAUSE', { reason, type, pauseMs: durationMs === Infinity ? null : durationMs });
    try { onSafetyStop({ type, reason, pausedUntil: Number.isFinite(pausedUntil) ? pausedUntil : null }); }
    catch (error) { logger.warn?.('OUTBOUND_SAFETY_CALLBACK_FAILED', { error: String(error?.message || error).slice(0, 120) }); }
  }

  function resetProtection() {
    pausedUntil = 0;
    pausedReason = null;
    consecutiveFailures = 0;
    recentFailures.length = 0;
  }

  function handleSendFailure(error, threadID) {
    const message = String(error?.message || error);
    const normalized = message.toLowerCase();
    const authFailure = /checkpoint|login approval|login required|invalid appstate|invalid cookie|cookie.{0,20}(expired|invalid)|session.{0,20}(expired|invalid)|not logged in|authentication failed|account disabled|two.factor|\\b401\\b|\\b403\\b|please log in/.test(normalized);
    if (authFailure) {
      triggerPause('session-authentication', Infinity, 'session');
    } else if (/rate.?limit|too many|temporar|spam|blocked|try again|restricted|unusual activity|we limit how often|automated behavior|please wait before you try again/.test(normalized)) {
      triggerPause('platform-restriction-or-rate-limit', config.circuitPauseMs, 'platform');
    } else {
      const now = Date.now();
      recentFailures.push(now);
      consecutiveFailures += 1;
      prune(now);
      if (consecutiveFailures >= config.maxConsecutiveFailures && recentFailures.length >= config.maxConsecutiveFailures) {
        triggerPause('repeated-send-failures', config.circuitPauseMs, 'circuit-breaker');
      }
    }
    logger.warn?.('OUTBOUND_SEND_FAILED', { threadID, error: message.slice(0, 180), failureCountInWindow: recentFailures.length });
  }

  function wrap(api) {
    return new Proxy(api, {
      get(target, property) {
        if (property === 'sendMessage' && typeof target.sendMessage === 'function') {
          return (...args) => {
            const threadID = String(args[1] ?? 'unknown');
            const messageToken = typeof args[2] === 'string' || typeof args[2] === 'number' ? String(args[2]) : contentKey(args[0]);
            const key = threadID + ':' + messageToken + ':' + contentKey(args[0]);
            const now = Date.now();
            refreshPause(now);
            prune(now);
            if (pausedUntil === Infinity || now < pausedUntil) {
              logger.warn?.('OUTBOUND_PAUSED', { threadID, reason: pausedReason, until: Number.isFinite(pausedUntil) ? new Date(pausedUntil).toISOString() : null });
              return Promise.resolve({ suppressed: true, reason: pausedReason || 'temporary-pause' });
            }
            if (recentMessages.has(key)) {
              logger.warn?.('OUTBOUND_DUPLICATE_SUPPRESSED', { threadID });
              return Promise.resolve({ suppressed: true, reason: 'duplicate' });
            }
            if (sentAt.length >= config.maxPerMinute) {
              logger.warn?.('OUTBOUND_RATE_LIMITED', { threadID, window: '60s' });
              return Promise.resolve({ suppressed: true, reason: 'local-rate-limit' });
            }
            recentMessages.set(key, now);
            const send = async () => {
              const at = Date.now();
              const wait = Math.max(0, config.globalIntervalMs - (at - lastGlobalSend), config.minIntervalMs - (at - (lastThreadSend.get(threadID) || 0)));
              if (wait) await new Promise(resolve => setTimeout(resolve, wait));
              const started = Date.now();
              refreshPause(started);
              prune(started);
              if (pausedUntil === Infinity || Date.now() < pausedUntil) {
                recentMessages.delete(key);
                logger.warn?.('OUTBOUND_PAUSED', { threadID, reason: pausedReason, until: Number.isFinite(pausedUntil) ? new Date(pausedUntil).toISOString() : null });
                return { suppressed: true, reason: pausedReason || 'temporary-pause' };
              }
              if (sentAt.length >= config.maxPerMinute) {
                recentMessages.delete(key);
                logger.warn?.('OUTBOUND_RATE_LIMITED', { threadID, window: '60s' });
                return { suppressed: true, reason: 'local-rate-limit' };
              }
              try {
                const result = await Reflect.apply(target.sendMessage, target, args);
                lastGlobalSend = Date.now();
                lastThreadSend.set(threadID, lastGlobalSend);
                sentAt.push(lastGlobalSend);
                consecutiveFailures = 0;
                recentFailures.length = 0;
                return result;
              } catch (error) {
                recentMessages.delete(key);
                handleSendFailure(error, threadID);
                throw error;
              }
            };
            const result = queue.then(send, send);
            queue = result.catch(() => {});
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  return {
    wrap,
    resetProtection,
    getState: () => {
      const now = Date.now();
      refreshPause(now);
      prune(now);
      return {
        paused: pausedUntil === Infinity || now < pausedUntil,
        pausedUntil: Number.isFinite(pausedUntil) && pausedUntil > 0 ? pausedUntil : null,
        pauseReason: pausedReason,
        sendsLastMinute: sentAt.length,
        failuresLastWindow: recentFailures.length,
        consecutiveFailures,
        circuitPauseMs: config.circuitPauseMs,
        maxConsecutiveFailures: config.maxConsecutiveFailures
      };
    }
  };
}

module.exports = { createHumanWriter, DEFAULTS };
