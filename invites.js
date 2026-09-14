const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INVITES_FILE = path.join(__dirname, 'invites.json');

function loadInvites() {
  try {
    const data = JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'));
    return Array.isArray(data.invites) ? data.invites : [];
  } catch (e) {
    return [];
  }
}

function saveInvites(invites) {
  fs.writeFileSync(INVITES_FILE, JSON.stringify({ invites }, null, 2));
}

function createInvite({ isAdmin, canEdit, allowedPages, createdBy }) {
  const invites = loadInvites();
  const token = crypto.randomBytes(16).toString('hex');
  const invite = {
    token,
    isAdmin: !!isAdmin,
    canEdit: canEdit !== false,
    allowedPages: Array.isArray(allowedPages) ? allowedPages : [],
    createdBy,
    createdAt: new Date().toISOString(),
    used: false,
    usedBy: null,
  };
  invites.push(invite);
  saveInvites(invites);
  return invite;
}

function getInvite(token) {
  return loadInvites().find(i => i.token === token) || null;
}

function markUsed(token, username) {
  const invites = loadInvites();
  const invite = invites.find(i => i.token === token);
  if (invite) {
    invite.used = true;
    invite.usedBy = username;
    invite.usedAt = new Date().toISOString();
    saveInvites(invites);
  }
}

function revokeInvite(token) {
  saveInvites(loadInvites().filter(i => i.token !== token));
}

function listInvites() {
  return loadInvites();
}

module.exports = { createInvite, getInvite, markUsed, revokeInvite, listInvites, loadInvites, saveInvites };
