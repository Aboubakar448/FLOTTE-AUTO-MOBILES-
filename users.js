const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');

const ALL_PAGE_KEYS = ["dashboard","vehicules","documents","rapport-peremption","sinistres","statistiques-sinistres","chauffeurs"];

function seedDefaultAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠️  Aucun ADMIN_PASSWORD défini. Compte "admin" créé avec le mot de passe par défaut "admin123" — changez-le dès la première connexion (onglet Utilisateurs).');
  }
  const users = [{
    id: 'u_' + Date.now().toString(36),
    name: 'Administrateur',
    username,
    password,
    isAdmin: true,
    canEdit: true,
    allowedPages: ALL_PAGE_KEYS.slice(),
  }];
  saveUsers(users);
  return users;
}

function normalizeUser(u) {
  return {
    ...u,
    canEdit: u.isAdmin ? true : (u.canEdit !== false),
    allowedPages: u.isAdmin ? ALL_PAGE_KEYS.slice() : (Array.isArray(u.allowedPages) ? u.allowedPages : ALL_PAGE_KEYS.slice()),
  };
}

function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (Array.isArray(data.users) && data.users.length) return data.users.map(normalizeUser);
  } catch (e) { /* pas encore de fichier */ }
  return seedDefaultAdmin();
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
}

function findUser(username, password) {
  if (!username || !password) return null;
  return loadUsers().find(u => u.username === username && u.password === password) || null;
}

function publicUsers() {
  return loadUsers().map(u => ({
    id: u.id,
    name: u.name,
    username: u.username,
    isAdmin: !!u.isAdmin,
    canEdit: u.canEdit,
    allowedPages: u.allowedPages,
  }));
}

function addUser({ name, username, password, isAdmin, canEdit, allowedPages }) {
  const users = loadUsers();
  if (users.some(u => u.username === username)) {
    throw new Error('Ce nom d\'utilisateur existe déjà.');
  }
  const user = normalizeUser({
    id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    username,
    password,
    isAdmin: !!isAdmin,
    canEdit: canEdit !== false,
    allowedPages: Array.isArray(allowedPages) && allowedPages.length ? allowedPages.filter(p => ALL_PAGE_KEYS.includes(p)) : ALL_PAGE_KEYS.slice(),
  });
  users.push(user);
  saveUsers(users);
  return user;
}

function removeUser(username) {
  const users = loadUsers();
  const target = users.find(u => u.username === username);
  if (!target) throw new Error('Utilisateur introuvable.');
  const remainingAdmins = users.filter(u => u.isAdmin && u.username !== username);
  if (target.isAdmin && remainingAdmins.length === 0) {
    throw new Error('Impossible de supprimer le dernier administrateur.');
  }
  saveUsers(users.filter(u => u.username !== username));
}

module.exports = { loadUsers, findUser, publicUsers, addUser, removeUser, ALL_PAGE_KEYS };
