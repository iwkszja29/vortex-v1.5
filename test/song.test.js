const test = require('node:test');
const assert = require('node:assert/strict');
const song = require('../cmds/song');

test('parses English and Arabic command names with arguments', () => {
  assert.equal(song._test.parseQuery('*song saquarema'), 'saquarema');
  assert.equal(song._test.parseQuery('*اغنية mc mego نيران صديقة'), 'mc mego نيران صديقة');
  assert.equal(song._test.parseQuery('!موسيقى free jazz', '!'), 'free jazz');
});

test('does not treat a bare command as a query', () => {
  assert.equal(song._test.parseQuery('*song'), '');
  assert.equal(song._test.parseQuery('hello *song test'), '');
});

test('accepts only HTTPS tracks with a Creative Commons license URL', () => {
  assert.equal(song._test.isCreativeCommonsTrack({
    audiodownload: 'https://audio.example/track.mp3',
    license_ccurl: 'https://creativecommons.org/licenses/by/4.0/'
  }), true);
  assert.equal(song._test.isCreativeCommonsTrack({
    audiodownload: 'https://audio.example/track.mp3',
    license_ccurl: 'all-rights-reserved'
  }), false);
  assert.equal(song._test.isCreativeCommonsTrack({
    audiodownload: 'http://audio.example/track.mp3',
    license_ccurl: 'https://creativecommons.org/licenses/by/4.0/'
  }), false);
});

test('asks for the required API client ID without network access', async () => {
  const old = process.env.JAMENDO_CLIENT_ID;
  delete process.env.JAMENDO_CLIENT_ID;
  let sent;
  const api = { sendMessage: async (...args) => { sent = args; } };
  try {
    await song.execute(api, { body: '*song test', threadID: 't1', messageID: 'm1', config: { prefix: '*' } });
    assert.match(sent[0], /JAMENDO_CLIENT_ID/);
  } finally {
    if (old !== undefined) process.env.JAMENDO_CLIENT_ID = old;
  }
});
