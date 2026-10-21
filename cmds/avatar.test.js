const test = require('node:test');
const assert = require('node:assert/strict');
const avatar = require('./avatar');
const { isAllowedFacebookUrl, getRepliedImage, changeAvatar } = avatar._test;

test('only HTTPS Facebook image hosts are accepted', () => {
  assert.equal(isAllowedFacebookUrl('https://scontent.xx.fbcdn.net/photo.jpg'), true);
  assert.equal(isAllowedFacebookUrl('https://evil.example/photo.jpg'), false);
  assert.equal(isAllowedFacebookUrl('http://scontent.xx.fbcdn.net/photo.jpg'), false);
  assert.equal(isAllowedFacebookUrl('https://facebook.com.evil.example/photo.jpg'), false);
});

test('finds a replied image attachment using supported FCA fields', () => {
  assert.equal(getRepliedImage({ messageReply: { attachments: [{ type: 'photo', largePreviewUrl: 'https://scontent.xx.fbcdn.net/a.jpg' }] } }).type, 'photo');
  assert.equal(getRepliedImage({ messageReply: { attachments: [{ type: 'file', url: 'https://scontent.xx.fbcdn.net/a.jpg' }] } }), null);
  assert.equal(getRepliedImage({}), null);
});

test('changeAvatar rejects when the FCA method is missing', async () => {
  await assert.rejects(changeAvatar({}, {}), /does not support changeAvatar/);
});

test('avatar command explains when no image was replied to', async () => {
  const sent = [];
  const api = { sendMessage: async (...args) => sent.push(args) };
  await avatar.execute(api, { body: '*avatar', config: { prefix: '*' }, threadID: 'thread-1', messageID: 'msg-1' });
  assert.equal(sent.length, 1);
  assert.match(sent[0][0], /ردّ على رسالة تحتوي صورة/);
});

test('avatar command downloads a mocked image and calls changeAvatar', async () => {
  const originalFetch = global.fetch;
  const bytes = Buffer.from('fake-image-bytes');
  const sent = [];
  let avatarBytes = Buffer.alloc(0);
  global.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/scontent\.xx\.fbcdn\.net\//);
    assert.equal(options.redirect, 'manual');
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } });
  };
  const api = {
    changeAvatar(stream, callback) {
      (async () => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        avatarBytes = Buffer.concat(chunks);
        callback(null);
      })().catch(callback);
    },
    sendMessage: async (...args) => sent.push(args)
  };
  try {
    await avatar.execute(api, {
      messageReply: { attachments: [{ type: 'photo', largePreviewUrl: 'https://scontent.xx.fbcdn.net/photo.png' }] },
      config: { prefix: '*' }, threadID: 'thread-1', messageID: 'msg-2'
    });
    assert.deepEqual(avatarBytes, bytes);
    assert.match(sent.at(-1)[0], /تم إرسال طلب تغيير صورة الحساب/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('avatar command reports unsupported image MIME type without calling changeAvatar', async () => {
  const originalFetch = global.fetch;
  const sent = [];
  let called = false;
  global.fetch = async () => new Response('not-an-image', { status: 200, headers: { 'content-type': 'text/html' } });
  const api = {
    changeAvatar() { called = true; },
    sendMessage: async (...args) => sent.push(args)
  };
  try {
    await avatar.execute(api, {
      messageReply: { attachments: [{ type: 'photo', url: 'https://scontent.xx.fbcdn.net/photo.png' }] },
      config: { prefix: '*' }, threadID: 'thread-1', messageID: 'msg-3'
    });
    assert.equal(called, false);
    assert.match(sent.at(-1)[0], /not a supported image/);
  } finally {
    global.fetch = originalFetch;
  }
});
