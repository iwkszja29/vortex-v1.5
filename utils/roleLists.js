function validateID(value) {
  const id = String(value ?? '').trim();
  if (!/^\d{1,30}$/.test(id)) throw new Error('Enter a valid numeric ID');
  return id;
}
function addOwner(ownerIDs, value) {
  const id = validateID(value);
  if (ownerIDs.includes(id)) throw new Error('This Owner ID is already saved');
  if (ownerIDs.length >= 3) throw new Error('Maximum of 3 Owners reached');
  return [...ownerIDs, id];
}
function removeOwner(ownerIDs, value) {
  const id = validateID(value);
  if (!ownerIDs.includes(id)) throw new Error('Owner ID not found');
  if (ownerIDs.length <= 1) throw new Error('At least one Owner must remain');
  return ownerIDs.filter(x => x !== id);
}
function addAdmin(adminIDs, ownerIDs, value) {
  const id = validateID(value);
  if (ownerIDs.includes(id)) throw new Error('Owners cannot be added to the regular admin list');
  if (adminIDs.includes(id)) throw new Error('This Admin ID is already saved');
  if (adminIDs.length >= 20) throw new Error('Maximum of 20 regular Admins reached');
  return [...adminIDs, id];
}
function removeAdmin(adminIDs, ownerIDs, value) {
  const id = validateID(value);
  if (ownerIDs.includes(id)) throw new Error('Owner IDs are managed separately');
  return adminIDs.filter(x => x !== id);
}
module.exports = { validateID, addOwner, removeOwner, addAdmin, removeAdmin };
