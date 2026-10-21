const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif'
};

function isAllowedFacebookUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === 'facebook.com' || host.endsWith('.facebook.com') ||
    host.endsWith('.fbcdn.net') || host.endsWith('.fbsbx.com');
}

function getRepliedImage(event) {
  const attachments = event?.messageReply?.attachments ||
    event?.messageReply?.attachment || [];
  const list = Array.isArray(attachments) ? attachments : [attachments];
  return list.find(item => {
    if (!item || typeof item !== 'object') return false;
    const url = item.url || item.imageUrl || item.largePreviewUrl || item.previewUrl;
    if (typeof url !== 'string' || !url) return false;
    const type = String(item.type || item.mimeType || item.mime_type || '').toLowerCase();
    return !type || type.includes('photo') || type.includes('image') || type.startsWith('image/');
  }) || null;
}

async function downloadFacebookImage(sourceUrl, destination) {
  let currentUrl = sourceUrl;
  let response;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    if (!isAllowedFacebookUrl(currentUrl)) throw new Error('Image URL is not from an allowed Facebook image host.');
    response = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'Mozilla/5.0 VORTEX-BOT image-fetch' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirect === MAX_REDIRECTS) throw new Error('Too many redirects while fetching the image.');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }

  if (!response || !response.ok) throw new Error('Facebook did not provide the replied image.');
  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, mime)) {
    throw new Error('The replied attachment is not a supported image.');
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error('The image is too large (maximum 8 MB).');
  if (!response.body) throw new Error('The image download returned no data.');

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error('The image is too large (maximum 8 MB).');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error('The image is empty.');
  await fs.writeFile(destination, Buffer.concat(chunks, total), { mode: 0o600, flag: 'wx' });
  return MIME_EXTENSIONS[mime];
}

function changeAvatar(api, stream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    let result;
    try {
      if (typeof api.changeAvatar !== 'function') {
        return finish(new Error('This installed FCA client does not support changeAvatar.'));
      }
      result = api.changeAvatar(stream, error => finish(error || null));
    } catch (error) {
      return finish(error);
    }
    if (result && typeof result.then === 'function') result.then(() => finish(null), finish);
  });
}

module.exports = {
  // Exported helpers allow deterministic tests without a live Facebook session.
  _test: { isAllowedFacebookUrl, getRepliedImage, downloadFacebookImage, changeAvatar },
  name: 'avatar',
  aliases: ['تغييرالصورة', 'تغييرالصوره', 'صورةالحساب', 'صورهالحساب'],
  description: 'تغيير صورة حساب فيسبوك إلى الصورة التي تم الرد عليها (للمسؤولين)',
  adminOnly: true,
  async execute(api, event) {
    const attachment = getRepliedImage(event);
    const sourceUrl = attachment && (attachment.url || attachment.imageUrl || attachment.largePreviewUrl || attachment.previewUrl);
    if (!sourceUrl) {
      return api.sendMessage(
        '🖼️ ردّ على رسالة تحتوي صورة، ثم اكتب: ' + event.config.prefix + 'تغييرالصورة',
        event.threadID,
        event.messageID
      );
    }

    const temporaryBase = path.join(os.tmpdir(), 'vortex-avatar-' + randomUUID());
    let filePath = null;
    try {
      // Download first to a private temporary file; only supported image bytes are accepted.
      const extension = await downloadFacebookImage(sourceUrl, temporaryBase);
      filePath = temporaryBase + extension;
      await fs.rename(temporaryBase, filePath);
      await changeAvatar(api, createReadStream(filePath));
      return api.sendMessage('✅ تم إرسال طلب تغيير صورة الحساب للصورة التي رددت عليها.', event.threadID, event.messageID);
    } catch (error) {
      try { await fs.rm(temporaryBase, { force: true }); } catch {}
      return api.sendMessage(
        '❌ تعذّر تغيير صورة الحساب: ' + String(error?.message || error).slice(0, 180),
        event.threadID,
        event.messageID
      );
    } finally {
      if (filePath) {
        try { await fs.rm(filePath, { force: true }); } catch {}
      }
    }
  }
};
