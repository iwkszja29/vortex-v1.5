'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHECK_INTERVAL_MS = 10_000;
let monitorTimer = null;
let currentApi = null;
let dataFile = null;
let protectedNames = {};

function loadNames(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[nm] Could not load saved names:', error.message);
    return {};
  }
}

function saveNames() {
  if (!dataFile) throw new Error('Data directory is not configured');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temp = dataFile + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(protectedNames, null, 2), { mode: 0o600 });
  fs.renameSync(temp, dataFile);
}

function callApi(method, ...args) {
  return new Promise((resolve, reject) => {
    if (!currentApi || typeof currentApi[method] !== 'function') {
      return reject(new Error('API method unavailable: ' + method));
    }
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(value);
    };
    try {
      const result = currentApi[method](...args, done);
      if (result && typeof result.then === 'function') result.then(value => done(null, value), done);
    } catch (error) {
      done(error);
    }
  });
}

async function checkProtectedNames() {
  if (!currentApi) return;
  for (const [threadID, expectedName] of Object.entries(protectedNames)) {
    try {
      const info = await callApi('getThreadInfo', threadID);
      if (info && info.threadName !== expectedName) {
        await callApi('setTitle', expectedName, threadID);
        console.log('[nm] Restored protected group name:', threadID);
      }
    } catch (error) {
      console.error('[nm] Could not check group ' + threadID + ':', error.message);
    }
  }
}

function startMonitor(api, config) {
  currentApi = api;
  const dir = config && config.dataDir ? config.dataDir : path.join(process.cwd(), 'data');
  const nextDataFile = path.join(dir, 'nm-protected-names.json');
  if (dataFile !== nextDataFile) {
    dataFile = nextDataFile;
    protectedNames = loadNames(dataFile);
  }
  if (!monitorTimer) {
    monitorTimer = setInterval(() => {
      checkProtectedNames().catch(error => console.error('[nm] Monitor failed:', error.message));
    }, CHECK_INTERVAL_MS);
    if (typeof monitorTimer.unref === 'function') monitorTimer.unref();
  }
}

module.exports = {
  name: 'سحب',
  aliases: [],
  description: 'تغيير اسم المجموعة وحمايته كل 10 ثوانٍ',
  adminOnly: true,

  async execute(api, event) {
    const threadID = String(event.threadID || '');
    const config = event.config || {};
    const senderID = String(event.senderID || '');
    const isAuthorized = Boolean(event.isOwner || event.isAdmin) ||
      (Array.isArray(config.ownerIDs) && config.ownerIDs.map(String).includes(senderID)) ||
      String(config.ownerID || '') === senderID ||
      (Array.isArray(config.adminIDs) && config.adminIDs.map(String).includes(senderID));

    if (!threadID) {
      return api.sendMessage('❌ لا يمكن تحديد المجموعة.', event.threadID, event.messageID);
    }
    if (!isAuthorized) {
      return api.sendMessage('⛔ هذا الأمر للمالك والمسؤولين المحددين في الداشبورد فقط.', threadID, event.messageID);
    }

    const args = Array.isArray(event.args) ? event.args : [];
    const newName = args.join(' ').trim();
    const prefix = String(config.prefix || '*');

    if (!newName) {
      return api.sendMessage('استخدم الأمر هكذا: ' + prefix + 'سحب الاسم الجديد', threadID, event.messageID);
    }
    if (newName.length > 100) {
      return api.sendMessage('❌ الاسم طويل جدًا. اختصره وحاول مجددًا.', threadID, event.messageID);
    }

    try {
      currentApi = api;
      startMonitor(api, config);
      await callApi('setTitle', newName, threadID);
      protectedNames[threadID] = newName;
      saveNames();
      return api.sendMessage('✅ تم تغيير اسم المجموعة إلى: ' + newName + '\n🛡️ مراقبة الاسم مفعّلة، ويتم فحصه كل 10 ثوانٍ.', threadID, event.messageID);
    } catch (error) {
      console.error('[nm] Command failed:', error.message);
      return api.sendMessage('❌ تعذر تغيير الاسم. تأكد أن البوت يملك صلاحية تعديل اسم المجموعة. التفاصيل: ' + String(error.message || error).slice(0, 160), threadID, event.messageID);
    }
  }
};
