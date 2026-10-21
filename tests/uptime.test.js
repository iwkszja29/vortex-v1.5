'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatUptime } = require('../cmds/uptime');

test('formats uptime into days, hours, minutes and seconds', () => {
  assert.equal(formatUptime(90061000), '1 يوم و 1 ساعة و 1 دقيقة و 1 ثانية');
});

test('formats zero uptime', () => {
  assert.equal(formatUptime(0), '0 ثانية');
});
