const express = require('express');
const fs = require('fs');
const path = require('path');
const onedrive = require('./onedrive');
const users = require('./users');
const history = require('./history');
const { computeDiff } = require('./history-diff');
const lock = require('./lock');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'publique')));

const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT_DOC_TYPES = ["Carte grise", "Carte bleue", "Assurance", "Licence de transport", "Conformité fiscale"];
const ONLINE_WINDOW_MS = 90 * 1000;

const presence = new Map();

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

app.get('/api/data', checkAuth, (req, res) => {
  res.json(readData());
});

function requireCanEdit(req, res, next) {
  if (!req.user.isAdmin && req.user.canEdit === false) {
    return res.status(403).json({ error: 'forbidden', message: 'Votre compte est en consultation seule.' });
  }
  next();
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

  let onedriveBackup = 'skipped';
  if (onedrive.isConfigured() && onedrive.isConnected()) {
    try {
      await onedrive.uploadBackup(saved);
      onedriveBackup = 'ok';
    } catch (e) {
      onedriveBackup = 'error';
      console.error('Erreur de sauvegarde OneDrive :', e.message);
    }
  }
  res.json({ ok: true, saved, onedriveBackup });
});

app.get('/api/users', checkAuth, requireAdmin, (req, res) => {
  res.json({ users: users.publicUsers() });
});

app.post('/api/users', checkAuth, requireAdmin, (req, res) => {
  try {
    const { name, username, password, isAdmin, canEdit, allowedPages } = req.body || {};
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'Nom, identifiant et mot de passe sont requis.' });
    }
    const user = users.addUser({ name, username, password, isAdmin, canEdit, allowedPages });
    res.json({ ok: true, user: { name: user.name, username: user.username, isAdmin: !!user.isAdmin, canEdit: user.canEdit, allowedPages: user.allowedPages } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/users/:username', checkAuth, requireAdmin, (req, res) => {
  try {
    users.removeUser(req.params.username);
    presence.delete(req.params.username);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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

app.get('/api/history', checkAuth, requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json({ history: history.loadHistory().slice(0, limit) });
});

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
  try {
    await onedrive.uploadBackup(readData());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/onedrive/disconnect', checkAuth, requireAdmin, (req, res) => {
  onedrive.disconnect();
  res.json({ ok: true });
});

app.post('/api/unlock-check', checkAuth, (req, res) => {
  const { kind, id, password } = req.body || {};
  const data = readData();
  const record = lock.findRecord(data, kind, id);
  if (!lock.isLocked(record)) return res.json({ ok: true });
  res.json({ ok: lock.checkPassword(record, password) });
});

app.post('/api/lock', checkAuth, requireAdmin, (req, res) => {
  const { kind, id, password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Mot de passe requis.' });
  const data = readData();
  const record = lock.findRecord(data, kind, id);
  if (!record) return res.status(404).json({ error: 'Introuvable.' });
  record.verrou = { locked: true, passwordHash: lock.hashPassword(password) };
  writeData(data);
  history.appendHistory([{ action: `${kind}_lock`, summary: `${lock.labelFor(kind, record)} — protégé par mot de passe`, username: req.user.name }]);
  res.json({ ok: true });
});

app.post('/api/unlock-remove', checkAuth, requireAdmin, (req, res) => {
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
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur de gestion de flotte démarré sur le port ${PORT}`);
});
