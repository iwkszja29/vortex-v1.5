const sessions = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_GROUPS_SHOWN = 30;
const ROCKET_MESSAGE = '𝑹𝑶𝑪𝑲𝑬𝑻 🚀';
const CATEGORIES = {
  '1': { folder: 'PENDING', title: 'طلبات المراسلة', action: 'request' },
  '2': { folder: 'OTHER', title: 'غير مهم / قد يكون احتياليًا', action: 'request' },
  '3': { folder: 'INBOX', title: 'المجموعات المقبولة', action: 'inbox' }
};

function sessionKey(event) {
  return String(event.threadID) + ':' + String(event.senderID || '');
}
function clearSession(key) {
  const current = sessions.get(key);
  if (current?.timer) clearTimeout(current.timer);
  sessions.delete(key);
}
function saveSession(key, value) {
  clearSession(key);
  value.expiresAt = Date.now() + SESSION_TTL_MS;
  value.timer = setTimeout(() => sessions.delete(key), SESSION_TTL_MS);
  value.timer.unref?.();
  sessions.set(key, value);
}
function getSession(key) {
  const value = sessions.get(key);
  if (!value) return null;
  if (value.expiresAt <= Date.now()) {
    clearSession(key);
    return null;
  }
  return value;
}
function callApi(api, method, args = []) {
  return new Promise((resolve, reject) => {
    if (typeof api?.[method] !== 'function') {
      reject(new Error('النسخة المثبتة لا تدعم ' + method));
      return;
    }
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(result);
    };
    try {
      const result = api[method](...args, done);
      if (result && typeof result.then === 'function') result.then(value => done(null, value), done);
      else if (result !== undefined && api[method].length <= args.length) done(null, result);
    } catch (error) { done(error); }
  });
}
function isGroupThread(thread) {
  return !!thread && (thread.isGroup === true || thread.isGroup === 1 || thread.isGroup === 'true');
}
function formatGroup(thread, index) {
  const name = String(thread.name || 'مجموعة بلا اسم').replace(/[\r\n]+/g, ' ').slice(0, 90);
  return `${index + 1}. ${name} — ID: ${thread.threadID}`;
}
async function fetchGroups(api, folder) {
  const threads = await callApi(api, 'getThreadList', [100, null, [folder]]);
  if (!Array.isArray(threads)) throw new Error('لم تُرجع قائمة المحادثات بشكل صحيح.');
  const seen = new Set();
  return threads.filter(thread => {
    if (!isGroupThread(thread) || !thread.threadID) return false;
    const id = String(thread.threadID);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, MAX_GROUPS_SHOWN).map(thread => ({
    threadID: String(thread.threadID),
    name: String(thread.name || 'مجموعة بلا اسم').replace(/[\r\n]+/g, ' ').slice(0, 90),
    folder: thread.folder || folder
  }));
}
async function send(api, event, message) {
  return api.sendMessage(message, event.threadID, event.messageID);
}
module.exports = {
  name: 'groups',
  aliases: ['غروبات', 'المجموعات'],
  description: 'إدارة مجموعات طلبات المراسلة والمهمَل والمقبول (للمالك فقط)',
  adminOnly: true,
  _test: { CATEGORIES, isGroupThread, fetchGroups, sessionKey, saveSession, clearSession, getSession, callApi },
  async execute(api, event) {
    if (!event.isOwner) {
      return send(api, event, '⛔ أمر الغروبات متاح للمالك فقط؛ لأنه قد يقبل طلبات مراسلة ويرسل رسالة إلى مجموعة.');
    }
    const key = sessionKey(event);
    saveSession(key, { stage: 'category', senderID: String(event.senderID), threadID: String(event.threadID) });
    return send(api, event,
      '🗂️ VORTEX | إدارة الغروبات\n\n' +
      'اختر القسم بإرسال رقمه في نفس المحادثة:\n' +
      '1️⃣ طلبات المراسلة\n' +
      '2️⃣ غير مهم / قد يكون احتياليًا\n' +
      '3️⃣ المجموعات المقبولة\n\n' +
      'تنتهي الجلسة بعد 5 دقائق. اكتب إلغاء لإيقاف العملية.'
    );
  },
  async handleReply(api, event) {
    const key = sessionKey(event);
    const state = getSession(key);
    if (!state) return false;
    if (String(event.senderID || '') !== state.senderID || String(event.threadID) !== state.threadID) return false;
    const input = String(event.body || '').trim();
    if (!input) return false;
    if (/^(إلغاء|الغاء|cancel)$/i.test(input)) {
      clearSession(key);
      await send(api, event, 'تم إلغاء العملية.');
      return true;
    }
    if (state.stage === 'category') {
      const category = CATEGORIES[input];
      if (!category) {
        await send(api, event, 'اختر رقمًا صحيحًا: 1 أو 2 أو 3، أو اكتب إلغاء.');
        return true;
      }
      try {
        const groups = await fetchGroups(api, category.folder);
        if (!groups.length) {
          clearSession(key);
          await send(api, event, `لا توجد مجموعات في قسم «${category.title}» ضمن أول 100 محادثة أعادها Messenger.`);
          return true;
        }
        saveSession(key, { ...state, stage: 'choose-group', category: input, groups });
        await send(api, event,
          `📂 ${category.title} — ${groups.length} مجموعة\n\n` +
          groups.map((group, index) => formatGroup(group, index)).join('\n') +
          '\n\nأرسل رقم المجموعة التي تريد مراجعتها، أو اكتب إلغاء.'
        );
      } catch (error) {
        clearSession(key);
        await send(api, event, '❌ تعذّر جلب المجموعات: ' + String(error?.message || error).slice(0, 180));
      }
      return true;
    }
    if (state.stage === 'choose-group') {
      const number = Number(input);
      if (!/^\d+$/.test(input) || number < 1 || number > state.groups.length) {
        await send(api, event, `أرسل رقمًا من 1 إلى ${state.groups.length}، أو اكتب إلغاء.`);
        return true;
      }
      const selected = state.groups[number - 1];
      saveSession(key, { ...state, stage: 'confirm', selected });
      await send(api, event,
        `هل تريد قبول/تفعيل هذه المجموعة؟\n«${selected.name}»\nID: ${selected.threadID}\n\n` +
        '1️⃣ نعم — قبول الطلب إن كان معلّقًا، ثم إرسال 𝑹𝑶𝑪𝑲𝑬𝑻 🚀\n' +
        '2️⃣ لا — إلغاء دون إرسال شيء.'
      );
      return true;
    }
    if (state.stage === 'confirm') {
      if (input === '2') {
        clearSession(key);
        await send(api, event, 'تم الإلغاء. لم يتم قبول المجموعة ولم تُرسل رسالة إليها.');
        return true;
      }
      if (input !== '1') {
        await send(api, event, 'أرسل 1 للتأكيد أو 2 للإلغاء.');
        return true;
      }
      const selected = state.selected;
      const category = CATEGORIES[state.category];
      try {
        if (category.action === 'request') {
          await callApi(api, 'handleMessageRequest', [[selected.threadID], true]);
        }
        const result = await api.sendMessage(ROCKET_MESSAGE, selected.threadID);
        if (result?.suppressed) {
          clearSession(key);
          await send(api, event, '⚠️ تم تنفيذ خطوة القبول إن لزم، لكن نظام الحماية منع الإرسال: ' + String(result.reason || 'suppressed'));
          return true;
        }
        clearSession(key);
        await send(api, event, `✅ ${category.action === 'request' ? 'تم قبول طلب المحادثة' : 'تم تأكيد المجموعة المقبولة'} «${selected.name}»، وأُرسلت رسالة 𝑹𝑶𝑪𝑲𝑬𝑻 🚀 إليها.`);
      } catch (error) {
        clearSession(key);
        await send(api, event, '❌ تعذّر إكمال العملية: ' + String(error?.message || error).slice(0, 180) + '\nتحقق من حالة المجموعة قبل إعادة المحاولة.');
      }
      return true;
    }
    clearSession(key);
    return false;
  }
};
