module.exports = {
  name: 'admin',
  aliases: ['المسؤولين'],
  description: 'عرض المسؤولين أو إدارتهم (المالك فقط للتعديل)',
  adminOnly: false,
  async execute(api, event) {
    const isAdmin = !!event.isAdmin || (event.config.ownerIDs || [event.config.ownerID]).includes(String(event.senderID)) || event.config.adminIDs.includes(String(event.senderID));
    if (!isAdmin) return api.sendMessage('⛔ هذا الأمر للمسؤولين فقط.', event.threadID, event.messageID);
    const [action, rawId] = event.args;
    const id = String(rawId || '');
    if (action === 'add' || action === 'remove') {
      if (!event.isOwner) return api.sendMessage('⛔ إضافة المسؤولين أو إزالتهم متاحة للمالك فقط.', event.threadID, event.messageID);
      if (!/^\d{1,30}$/.test(id)) return api.sendMessage('استخدام: *admin add <ID> أو *admin remove <ID>', event.threadID, event.messageID);
      if (id === String(event.config.ownerID || '')) return api.sendMessage('لا يمكن إضافة المالك إلى قائمة المسؤولين أو إزالته منها.', event.threadID, event.messageID);
      let next = [...event.config.adminIDs];
      if (action === 'add' && !next.includes(id)) next.push(id);
      if (action === 'remove') next = next.filter(value => value !== id);
      await event.runtime.setAdminIDs(next);
      return api.sendMessage(action === 'add' ? '✅ تمت إضافة المسؤول وحفظ القائمة.' : '✅ تمت إزالة المسؤول وحفظ القائمة.', event.threadID, event.messageID);
    }
    return api.sendMessage(`👑 المالكـون:\n${(event.config.ownerIDs || [event.config.ownerID]).filter(Boolean).join('\n') || 'لا يوجد مالك مضبوط.'}\n🛡️ المسؤولون العاديون:\n${event.config.adminIDs.join('\n') || 'لا يوجد مسؤولون.'}\nإدارة المسؤولين: *admin add <ID> | *admin remove <ID>`, event.threadID, event.messageID);
  }
};
