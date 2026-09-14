const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, 'onedrive-token.json');
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPE = 'offline_access Files.ReadWrite.AppFolder';

function config() {
  return {
    clientId: process.env.ONEDRIVE_CLIENT_ID,
    clientSecret: process.env.ONEDRIVE_CLIENT_SECRET,
    redirectUri: process.env.ONEDRIVE_REDIRECT_URI,
  };
}

function isConfigured() {
  const c = config();
  return !!(c.clientId && c.clientSecret && c.redirectUri);
}

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function isConnected() {
  return !!readTokens();
}

function disconnect() {
  try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* déjà absent */ }
}

function getAuthUrl() {
  const c = config();
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: c.redirectUri,
    response_mode: 'query',
    scope: SCOPE,
  });
  return `${AUTHORITY}/authorize?${params.toString()}`;
}

async function exchangeCode(code) {
  const c = config();
  const params = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: c.redirectUri,
    scope: SCOPE,
  });
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error('Échec de l\'échange du code : ' + (await res.text()));
  const data = await res.json();
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 - 60000,
  });
  return true;
}

async function refreshTokens() {
  const c = config();
  const tokens = readTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('Non connecté à OneDrive.');
  const params = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    scope: SCOPE,
  });
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    disconnect();
    throw new Error('Le renouvellement de la connexion OneDrive a échoué, reconnexion nécessaire.');
  }
  const data = await res.json();
  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 - 60000,
  };
  saveTokens(updated);
  return updated.access_token;
}

async function getValidAccessToken() {
  const tokens = readTokens();
  if (!tokens) throw new Error('Non connecté à OneDrive.');
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  return refreshTokens();
}

async function uploadBackup(dataObj) {
  const accessToken = await getValidAccessToken();
  const content = JSON.stringify(dataObj, null, 2);
  const res = await fetch(
    'https://graph.microsoft.com/v1.0/me/drive/special/approot:/flotte-backup.json:/content',
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: content,
    }
  );
  if (!res.ok) throw new Error('Échec de l\'envoi vers OneDrive : ' + (await res.text()));
  return true;
}

module.exports = {
  isConfigured,
  isConnected,
  disconnect,
  getAuthUrl,
  exchangeCode,
  uploadBackup,
};
