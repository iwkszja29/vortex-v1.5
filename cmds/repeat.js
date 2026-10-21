function normalizeArabic(value) {
  return String(value)
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[أإآ]/g, 'ا')
    .toLowerCase();
}

module.exports = {
  name: 'repeat',
  aliases: ['تشغيل', 'ايقاف', 'إيقاف', 'وقف'],
  description: 'إرسال رسالة بشكل متكرر بفاصل زمني محدد (للمسؤولين)',
  async execute(api, event) {
    const action = normalizeArabic(event.commandName || '');
    const isStop = ['ايقاف', 'وقف'].includes(action) || ['ايقاف', 'وقف'].includes(normalizeArabic(event.args[0] || ''));
    if (!event.isAdmin) {
      return api.sendMessage('⛔ هذا الأمر متاح للمالك والمسؤولين فقط.', event.threadID, event.messageID);
    }

    if (isStop) {
      const result = event.runtime.stopRepeatingMessage(event.threadID);
      return api.sendMessage(
        result.stopped ? '✅ تم إيقاف الرسالة المتكررة في هذه المحادثة.' : 'ℹ️ لا توجد رسالة متكررة تعمل في هذه المحادثة.',
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
        'الاستخدام: ' + event.config.prefix + 'تشغيل <النص> <المدة>\nمثال: ' + event.config.prefix + 'تشغيل هسم كششكك 25ث\nاستخدم د للدقائق، مثل 2د. للإيقاف: ' + event.config.prefix + 'إيقاف',
        event.threadID,
        event.messageID
      );
    }

    const amount = Number(match[1]);
    const unit = match[2];
    const isMinutes = ['د', 'دقيقه', 'دقائق', 'm', 'min'].includes(unit);
    const intervalMs = amount * (isMinutes ? 60000 : 1000);
    const message = args.join(' ').trim();
    if (!message) {
      return api.sendMessage('❗ اكتب الرسالة التي تريد تكرارها قبل المدة.', event.threadID, event.messageID);
    }
    if (!Number.isSafeInteger(amount) || amount <= 0 || intervalMs < 10000 || intervalMs > 86400000) {
      return api.sendMessage('⏱️ المدة يجب أن تكون بين 10 ثوانٍ و24 ساعة.', event.threadID, event.messageID);
    }

    const result = event.runtime.startRepeatingMessage({
      threadID: event.threadID,
      senderID: event.senderID,
      message,
      intervalMs
    });
    if (!result.started) {
      const reason = result.reason === 'already-running'
        ? 'توجد رسالة متكررة تعمل بالفعل في هذه المحادثة. أوقفها أولاً ثم ابدأ من جديد.'
        : result.reason === 'offline'
          ? 'البوت غير متصل حالياً.'
          : 'تعذر بدء الإرسال؛ تحقق من الرسالة والمدة.';
      return api.sendMessage('⚠️ ' + reason, event.threadID, event.messageID);
    }

    const shownInterval = isMinutes ? amount + ' دقيقة/دقائق' : amount + ' ثانية/ثوانٍ';
    return api.sendMessage(
      '✅ تم تشغيل الإرسال المتكرر. سأرسل الرسالة كل ' + shownInterval + '.\nلإيقافه اكتب: ' + event.config.prefix + 'إيقاف',
      event.threadID,
      event.messageID
    );
  }
};
