const express = require('express');
const fs = require('fs');
const path = require('path');
const onedrive = require('./onedrive');
const users = require('./users');
const history = require('./history');
const { computeDiff } = require('./history-diff');
const lock = require('./lock');
const invites = require('./invites');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/invite/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT_DOC_TYPES = ["Carte grise", "Carte bleue", "Assurance", "Licence de transport", "Conformité fiscale"];
const ONLINE_WINDOW_MS = 90 * 1000; // considéré "en ligne" si vu il y a moins de 90s

// présence en mémoire uniquement (redémarre à zéro si le serveur redémarre)
const presence = new Map(); // username -> { name, lastSeen }

function touchPresence(user) {
  presence.set(user.username, { name: user.name, lastSeen: Date.now() });
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { vehicles: [], documents: [], docTypes: DEFAULT_DOC_TYPES, chauffeurs: [], sinistres: [] };
  }
}

function writeData(data) {
  const safe = {
    vehicles: Array.isArray(data.vehicles) ? data.vehicles : [],
    documents: Array.isArray(data.documents) ? data.documents : [],
    docTypes: Array.isArray(data.docTypes) && data.docTypes.length ? data.docTypes : DEFAULT_DOC_TYPES,
    chauffeurs: Array.isArray(data.chauffeurs) ? data.chauffeurs : [],
    sinistres: Array.isArray(data.sinistres) ? data.sinistres : []
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(safe, null, 2));
  return safe;
}

function checkAuth(req, res, next) {
  const username = req.header('x-username');
  const password = req.header('x-password');
  const user = users.findUser(username, password);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  touchPresence(user);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  next();
}

// ---- Connexion ----

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = users.findUser(username, password);
  if (!user) return res.status(401).json({ ok: false });
  touchPresence(user);
  res.json({ ok: true, user: { name: user.name, username: user.username, isAdmin: !!user.isAdmin, canEdit: user.canEdit, allowedPages: user.allowedPages } });
});

app.post('/api/ping', checkAuth, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/me', checkAuth, (req, res) => {
  res.json({ user: { name: req.user.name, username: req.user.username, isAdmin: !!req.user.isAdmin, canEdit: req.user.canEdit, allowedPages: req.user.allowedPages } });
});

// ---- Données ----

app.get('/api/data', checkAuth, (req, res) => {
  res.json(readData());
});

function requireCanEdit(req, res, next) {
  if (!req.user.isAdmin && req.user.canEdit === false) {
    return res.status(403).json({ error: 'forbidden', message: 'Votre compte est en consultation seule.' });
  }
  next();
}

async function syncToOneDrive() {
  if (!onedrive.isConfigured() || !onedrive.isConnected()) return 'skipped';
  try {
    await onedrive.uploadBackup({
      data: readData(),
      users: users.loadUsers(),
      history: history.loadHistory(),
      invites: invites.listInvites(),
    });
    return 'ok';
  } catch (e) {
    console.error('Erreur de sauvegarde OneDrive :', e.message);
    return 'error';
  }
}

app.put('/api/data', checkAuth, requireCanEdit, async (req, res) => {
  const oldData = readData();
  const incoming = req.body || {};
  lock.preserveLocks(oldData, incoming);

  const violation = lock.findLockViolation(oldData, incoming, incoming.unlocks);
  if (violation) {
    return res.status(423).json({
      error: 'locked',
      message: `« ${violation.label} » est protégé par un mot de passe. Déverrouillez-le avant de le modifier.`,
    });
  }

  const saved = writeData(incoming);

  const diffEntries = computeDiff(oldData, saved).map(e => ({ ...e, username: req.user.name }));
  history.appendHistory(diffEntries);

  const onedriveBackup = await syncToOneDrive();
  res.json({ ok: true, saved, onedriveBackup });
});

// ---- Utilisateurs (admin uniquement) ----

app.get('/api/users', checkAuth, requireAdmin, (req, res) => {
  res.json({ users: users.publicUsers() });
});

app.post('/api/users', checkAuth, requireAdmin, async (req, res) => {
  try {
    const { name, username, password, isAdmin, canEdit, allowedPages } = req.body || {};
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'Nom, identifiant et mot de passe sont requis.' });
    }
    const user = users.addUser({ name, username, password, isAdmin, canEdit, allowedPages });
    await syncToOneDrive();
    res.json({ ok: true, user: { name: user.name, username: user.username, isAdmin: !!user.isAdmin, canEdit: user.canEdit, allowedPages: user.allowedPages } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/users/:username', checkAuth, requireAdmin, async (req, res) => {
  try {
    users.removeUser(req.params.username);
    presence.delete(req.params.username);
    await syncToOneDrive();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/users/:username/reset-password', checkAuth, requireAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || password.length < 1) {
      return res.status(400).json({ error: 'Nouveau mot de passe requis.' });
    }
    users.setPassword(req.params.username, password);
    history.appendHistory([{ action: 'user_password_reset', summary: `Mot de passe réinitialisé pour @${req.params.username}`, username: req.user.name }]);
    await syncToOneDrive();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Présence (admin uniquement) ----

app.get('/api/presence', checkAuth, requireAdmin, (req, res) => {
  const now = Date.now();
  const list = users.publicUsers().map(u => {
    const p = presence.get(u.username);
    return {
      ...u,
      lastSeen: p ? new Date(p.lastSeen).toISOString() : null,
      online: !!(p && now - p.lastSeen < ONLINE_WINDOW_MS),
    };
  });
  res.json({ users: list });
});

// ---- Historique des modifications (admin uniquement) ----

app.get('/api/history', checkAuth, requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json({ history: history.loadHistory().slice(0, limit) });
});

// ---- OneDrive : connexion et sauvegarde ----

app.get('/auth/onedrive/login', (req, res) => {
  if (!onedrive.isConfigured()) {
    return res
      .status(500)
      .send('OneDrive n\'est pas configuré sur ce serveur (variables ONEDRIVE_CLIENT_ID / ONEDRIVE_CLIENT_SECRET / ONEDRIVE_REDIRECT_URI manquantes). Voir le README.');
  }
  res.redirect(onedrive.getAuthUrl());
});

app.get('/auth/onedrive/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    return res.send(`<p>Erreur d'autorisation OneDrive : ${error_description || error}</p>`);
  }
  try {
    await onedrive.exchangeCode(code);
    res.send('<p>OneDrive connecté avec succès. Vous pouvez fermer cet onglet et retourner au système.</p>');
  } catch (e) {
    res.status(500).send('<p>Erreur : ' + e.message + '</p>');
  }
});

app.get('/api/onedrive/status', checkAuth, (req, res) => {
  res.json({ configured: onedrive.isConfigured(), connected: onedrive.isConnected() });
});

app.post('/api/onedrive/backup-now', checkAuth, requireAdmin, async (req, res) => {
  const result = await syncToOneDrive();
  if (result === 'ok') return res.json({ ok: true });
  res.status(500).json({ ok: false, error: result === 'skipped' ? 'OneDrive non connecté.' : 'Échec de la sauvegarde.' });
});

app.post('/api/onedrive/disconnect', checkAuth, requireAdmin, (req, res) => {
  onedrive.disconnect();
  res.json({ ok: true });
});

// ---- Invitations (créer un lien pour qu'une personne crée elle-même son compte) ----

app.post('/api/invites', checkAuth, requireAdmin, async (req, res) => {
  const { isAdmin, canEdit, allowedPages } = req.body || {};
  const invite = invites.createInvite({ isAdmin, canEdit, allowedPages, createdBy: req.user.name });
  await syncToOneDrive();
  res.json({ ok: true, token: invite.token, path: `/invite/${invite.token}` });
});

app.get('/api/invites', checkAuth, requireAdmin, (req, res) => {
  res.json({ invites: invites.listInvites() });
});

app.delete('/api/invites/:token', checkAuth, requireAdmin, async (req, res) => {
  invites.revokeInvite(req.params.token);
  await syncToOneDrive();
  res.json({ ok: true });
});

app.get('/api/invite-info/:token', (req, res) => {
  const invite = invites.getInvite(req.params.token);
  if (!invite || invite.used) {
    return res.status(404).json({ error: 'Cette invitation est introuvable ou a déjà été utilisée.' });
  }
  res.json({ ok: true, isAdmin: invite.isAdmin, canEdit: invite.canEdit, allowedPages: invite.allowedPages });
});

app.post('/api/invite-accept', async (req, res) => {
  const { token, name, username, password } = req.body || {};
  const invite = invites.getInvite(token);
  if (!invite || invite.used) {
    return res.status(400).json({ error: 'Cette invitation est introuvable ou a déjà été utilisée.' });
  }
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Nom, identifiant et mot de passe sont requis.' });
  }
  try {
    const user = users.addUser({ name, username, password, isAdmin: invite.isAdmin, canEdit: invite.canEdit, allowedPages: invite.allowedPages });
    invites.markUsed(token, username);
    await syncToOneDrive();
    res.json({ ok: true, user: { name: user.name, username: user.username, isAdmin: !!user.isAdmin, canEdit: user.canEdit, allowedPages: user.allowedPages } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Protection par mot de passe de fiches individuelles ----

app.post('/api/unlock-check', checkAuth, (req, res) => {
  const { kind, id, password } = req.body || {};
  const data = readData();
  const record = lock.findRecord(data, kind, id);
  if (!lock.isLocked(record)) return res.json({ ok: true });
  res.json({ ok: lock.checkPassword(record, password) });
});

app.post('/api/lock', checkAuth, requireAdmin, async (req, res) => {
  const { kind, id, password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Mot de passe requis.' });
  const data = readData();
  const record = lock.findRecord(data, kind, id);
  if (!record) return res.status(404).json({ error: 'Introuvable.' });
  record.verrou = { locked: true, passwordHash: lock.hashPassword(password) };
  writeData(data);
  history.appendHistory([{ action: `${kind}_lock`, summary: `${lock.labelFor(kind, record)} — protégé par mot de passe`, username: req.user.name }]);
  await syncToOneDrive();
  res.json({ ok: true });
});

app.post('/api/unlock-remove', checkAuth, requireAdmin, async (req, res) => {
  const { kind, id, password } = req.body || {};
  const data = readData();
  const record = lock.findRecord(data, kind, id);
  if (!lock.isLocked(record)) return res.json({ ok: true });
  if (!lock.checkPassword(record, password)) {
    return res.status(403).json({ ok: false, error: 'Mot de passe incorrect.' });
  }
  record.verrou = { locked: false, passwordHash: null };
  writeData(data);
  history.appendHistory([{ action: `${kind}_unlock`, summary: `${lock.labelFor(kind, record)} — protection retirée`, username: req.user.name }]);
  await syncToOneDrive();
  res.json({ ok: true });
});

async function restoreFromOneDriveOnBoot() {
  if (!onedrive.isConfigured() || !onedrive.isConnected()) return;
  try {
    const backup = await onedrive.downloadBackup();
    if (backup) {
      if (backup.data) writeData(backup.data);
      if (backup.users) users.saveUsers(backup.users);
      if (backup.history) history.overwriteHistory(backup.history);
      if (backup.invites) invites.saveInvites(backup.invites);
      console.log('Données restaurées depuis OneDrive au démarrage.');
    }
  } catch (e) {
    console.error('Erreur de restauration OneDrive au démarrage :', e.message);
  }
}

const PORT = process.env.PORT || 3000;
restoreFromOneDriveOnBoot().finally(() => {
  app.listen(PORT, () => {
    console.log(`Serveur de gestion de flotte démarré sur le port ${PORT}`);
  });
});
