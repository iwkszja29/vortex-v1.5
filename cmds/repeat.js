function normalizeArabic(value) {
  return String(value)
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[أإآ]/g, 'ا')
    .toLowerCase();
}

module.exports = {
  name: 'repeat',
  aliases: ['تشغيل', 'ايقاف', 'إيقاف', 'وقف'],
  description: 'تكرار رسالتين بفاصل زمني مع الإيقاف عند غياب الرد',
  async execute(api, event) {
    const action = normalizeArabic(event.commandName || '');
    const isStop = ['ايقاف', 'وقف'].includes(action) || ['ايقاف', 'وقف'].includes(normalizeArabic(event.args[0] || ''));
    if (!event.isAdmin) {
      return api.sendMessage('⛔ هذا الأمر متاح للمالك والمسؤولين فقط.', event.threadID, event.messageID);
    }

    if (isStop) {
      const result = event.runtime.stopRepeatingMessage(event.threadID);
      return api.sendMessage(
        result.stopped ? '✅ تم إيقاف الرسالتين المتكررتين في هذه المحادثة.' : 'ℹ️ لا توجد رسائل متكررة تعمل في هذه المحادثة.',
        event.threadID,
        event.messageID
      );
    }

    const args = [...event.args];
    if (normalizeArabic(args[0] || '') === 'تشغيل') args.shift();
    const durationToken = args.pop() || '';
    const match = normalizeArabic(durationToken).match(/^(\d+)(ث|ثانيه|ثواني|د|دقيقه|دقائق|s|sec|m|min)$/);
    if (!match) {
      return api.sendMessage(
        'الاستخدام: ' + event.config.prefix + 'تشغيل <الرسالة الأولى> | <الرسالة الثانية> <الفاصل>\nمثال: ' + event.config.prefix + 'تشغيل صباح الخير | كيفكم؟ 30ث\nالفاصل لا يقل عن 15 ثانية. يتوقف التكرار بعد 16 دقيقة دون رد. للإيقاف: ' + event.config.prefix + 'إيقاف',
        event.threadID,
        event.messageID
      );
    }

    const amount = Number(match[1]);
    const unit = match[2];
    const isMinutes = ['د', 'دقيقه', 'دقائق', 'm', 'min'].includes(unit);
    const intervalMs = amount * (isMinutes ? 60000 : 1000);
    const messageText = args.join(' ').trim();
    const separator = messageText.indexOf('|');
    if (separator < 0) {
      return api.sendMessage('❗ اكتب رسالتين وافصل بينهما بعلامة | مثال: صباح الخير | كيفكم؟', event.threadID, event.messageID);
    }
    const messages = [messageText.slice(0, separator).trim(), messageText.slice(separator + 1).trim()];
    if (messages.some(message => !message)) {
      return api.sendMessage('❗ يجب كتابة الرسالتين كاملتين على جانبي علامة |.', event.threadID, event.messageID);
    }
    if (!Number.isSafeInteger(amount) || amount <= 0 || intervalMs < 15000 || intervalMs > 86400000) {
      return api.sendMessage('⏱️ الفاصل يجب أن يكون بين 15 ثانية و24 ساعة.', event.threadID, event.messageID);
    }

    const result = event.runtime.startRepeatingMessage({
      threadID: event.threadID,
      senderID: event.senderID,
      messages,
      intervalMs,
      inactivityMs: 16 * 60 * 1000
    });
    if (!result.started) {
      const reason = result.reason === 'already-running'
        ? 'توجد رسائل متكررة تعمل بالفعل في هذه المحادثة. أوقفها أولاً ثم ابدأ من جديد.'
        : result.reason === 'offline'
          ? 'البوت غير متصل حالياً.'
          : 'تعذر بدء الإرسال؛ تحقق من الرسالتين والفاصل الزمني.';
      return api.sendMessage('⚠️ ' + reason, event.threadID, event.messageID);
    }

    const shownInterval = isMinutes ? amount + ' دقيقة/دقائق' : amount + ' ثانية/ثوانٍ';
    return api.sendMessage(
      '✅ تم تشغيل الرسالتين بالتتابع كل ' + shownInterval + '. إذا لم يرسل أي عضو آخر رسالة لمدة 16 دقيقة، سيتوقف التكرار تلقائياً. لن يغادر البوت المجموعة تلقائياً. للإيقاف يدوياً: ' + event.config.prefix + 'إيقاف',
      event.threadID,
      event.messageID
    );
  }
};
