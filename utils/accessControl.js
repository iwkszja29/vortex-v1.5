'use strict';

function isAuthorizedSender(senderID, ownerIDs = [], adminIDs = []) {
  if (senderID === undefined || senderID === null || String(senderID).trim() === '') return false;
  const sender = String(senderID).trim();
  const allowed = [...(Array.isArray(ownerIDs) ? ownerIDs : []), ...(Array.isArray(adminIDs) ? adminIDs : [])]
    .filter(id => id !== undefined && id !== null && String(id).trim() !== '')
    .map(id => String(id).trim());
  return allowed.includes(sender);
}

module.exports = { isAuthorizedSender };
