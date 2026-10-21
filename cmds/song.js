const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const API_URL = 'https://api.jamendo.com/v3.0/tracks/';
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const ALIASES = ['song', 'اغنية', 'أغنية', 'موسيقى'];

function parseQuery(body, prefix = '*') {
  const text = String(body || '').trim();
  const escaped = String(prefix || '*').replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  const names = ALIASES.map(x => x.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')).join('|');
  const match = text.match(new RegExp('^' + escaped + '(?:' + names + ')(?:\\s+|$)', 'i'));
  return match ? text.slice(match[0].length).trim() : '';
}

function isCreativeCommonsTrack(track) {
  return !!track && typeof track.audiodownload === 'string' &&
    track.audiodownload.startsWith('https://') &&
    typeof track.license_ccurl === 'string' &&
    /creativecommons\.org\/licenses\//i.test(track.license_ccurl);
}

async function callSendMessage(api, message, event) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    try {
      const result = api.sendMessage(message, event.threadID, event.messageID, done);
      if (result && typeof result.then === 'function') result.then(() => done(), done);
      else if (result !== undefined && api.sendMessage.length < 4) done();
    } catch (error) { done(error); }
  });
}

async function searchJamendo(query, clientId) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    client_id: clientId, format: 'json', limit: '10',
    namesearch: query, audioformat: 'mp31', include: 'licenses'
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Jamendo search failed (HTTP ' + response.status + ').');
  const data = await response.json();
  if (data?.headers?.status !== 'success' || !Array.isArray(data.results)) {
    throw new Error('Jamendo returned an invalid search response.');
  }
  return data.results.filter(isCreativeCommonsTrack);
}

async function downloadAudio(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Audio source URL is not safe.');
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Audio download failed (HTTP ' + response.status + ').');
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (!(type.startsWith('audio/') || type.includes('application/octet-stream'))) {
    throw new Error('The selected source did not return an audio file.');
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error('Audio file exceeds the 15 MB limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('The downloaded audio file is empty.');
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error('Audio file exceeds the 15 MB limit.');
  const filePath = path.join(os.tmpdir(), 'vortex-song-' + randomUUID() + '.mp3');
  await fs.writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' });
  return filePath;
}

module.exports = {
  name: 'song',
  aliases: ['اغنية', 'أغنية', 'موسيقى'],
  description: 'البحث عن مقاطع مرخّصة Creative Commons وإرسالها كملف صوتي',
  _test: { parseQuery, isCreativeCommonsTrack, searchJamendo, downloadAudio },
  async execute(api, event) {
    const query = parseQuery(event?.body, event?.config?.prefix || '*');
    if (!query) {
      return api.sendMessage('🎵 اكتب اسم الأغنية بعد الأمر.\nمثال: *song free music', event.threadID, event.messageID);
    }
    const clientId = String(process.env.JAMENDO_CLIENT_ID || '').trim();
    if (!clientId) {
      return api.sendMessage(
        '⚙️ أمر الأغاني يحتاج متغير JAMENDO_CLIENT_ID في Railway. أضف Client ID من Jamendo API ثم أعد النشر.',
        event.threadID, event.messageID
      );
    }
    let filePath;
    try {
      const tracks = await searchJamendo(query, clientId);
      if (!tracks.length) {
        return api.sendMessage(
          '🔎 لم أجد مقطعًا قابلًا للتنزيل بترخيص Creative Commons لهذا الاسم. جرّب اسمًا آخر.',
          event.threadID, event.messageID
        );
      }
      const track = tracks[0];
      filePath = await downloadAudio(track.audiodownload);
      const title = String(track.name || query).replace(/[\r\n]+/g, ' ').slice(0, 100);
      const artist = String(track.artist_name || 'Unknown artist').replace(/[\r\n]+/g, ' ').slice(0, 100);
      await callSendMessage(api, {
        body: '🎵 ' + title + ' — ' + artist + '\n📜 ترخيص: ' + track.license_ccurl,
        attachment: createReadStream(filePath)
      }, event);
    } catch (error) {
      console.error('SONG_COMMAND_FAILED', String(error?.message || error).slice(0, 200));
      return api.sendMessage(
        '❌ تعذّر جلب الملف الصوتي: ' + String(error?.message || error).slice(0, 160),
        event.threadID, event.messageID
      );
    } finally {
      if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
    }
  }
};
