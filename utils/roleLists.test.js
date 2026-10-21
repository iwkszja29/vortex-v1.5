const test = require('node:test');
const assert = require('node:assert/strict');
const { addOwner, removeOwner, addAdmin, removeAdmin } = require('./roleLists');

test('adds and removes owners, respecting the maximum of three', () => {
  let owners = addOwner([], '100');
  owners = addOwner(owners, '200');
  owners = addOwner(owners, '300');
  assert.equal(owners.length, 3);
  assert.throws(() => addOwner(owners, '400'), /Maximum of 3/);
  assert.throws(() => addOwner(owners, '200'), /already saved/);
  assert.deepEqual(removeOwner(owners, '200'), ['100', '300']);
});
test('does not allow removing the last owner', () => {
  assert.throws(() => removeOwner(['100'], '100'), /At least one Owner/);
});
test('adds regular admins separately, respecting max 20 and owner exclusion', () => {
  const owners = ['100', '200'];
  assert.throws(() => addAdmin([], owners, '100'), /Owners cannot/);
  let admins = [];
  for (let i = 1; i <= 20; i++) admins = addAdmin(admins, owners, String(1000 + i));
  assert.equal(admins.length, 20);
  assert.throws(() => addAdmin(admins, owners, '9999'), /Maximum of 20/);
  assert.throws(() => addAdmin(admins, owners, '1001'), /already saved/);
  assert.deepEqual(removeAdmin(admins, owners, '1001'), admins.slice(1));
});
test('rejects non-numeric IDs', () => {
  assert.throws(() => addOwner([], 'abc'), /numeric ID/);
  assert.throws(() => addAdmin([], [], '12x'), /numeric ID/);
});
