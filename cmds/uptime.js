'use strict';

function formatUptime(milliseconds) {
  let seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  const parts = [];
  if (days) parts.push(`${days} يوم`);
  if (hours) parts.push(`${hours} ساعة`);
  if (minutes) parts.push(`${minutes} دقيقة`);
  parts.push(`${seconds} ثانية`);
  return parts.join(' و ');
}

module.exports = {
  name: 'uptime',
  aliases: ['up', 'مدة', 'مدة_التشغيل'],
  description: 'عرض مدة تشغيل البوت',
  formatUptime,
  async execute(api, event) {
    const state = event.runtime.getState();
    return api.sendMessage(
      `🌀 𝑽𝑶𝑹𝑻𝑬𝑿 →\n🟢 الحالة: ${state.status}\n⏱️ مدة التشغيل: ${formatUptime(state.uptimeMs)}`,
      event.threadID,
      event.messageID
    );
  }
};
