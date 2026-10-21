'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorizedSender } = require('./accessControl');

test('allows a configured owner', () => assert.equal(isAuthorizedSender('100', ['100'], ['200']), true));
test('allows a dashboard-configured admin', () => assert.equal(isAuthorizedSender(200, ['100'], ['200']), true));
test('blocks an ordinary sender', () => assert.equal(isAuthorizedSender('300', ['100'], ['200']), false));
test('blocks missing sender IDs', () => {
  assert.equal(isAuthorizedSender(undefined, ['100'], ['200']), false);
  assert.equal(isAuthorizedSender('', ['100'], ['200']), false);
});
test('does not authorize everyone when allow-lists are empty', () => assert.equal(isAuthorizedSender('100', [], []), false));
