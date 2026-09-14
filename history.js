const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_ENTRIES = 500;

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function appendHistory(entries) {
  if (!entries || !entries.length) return;
  const history = loadHistory();
  const stamped = entries.map(e => ({
    id: 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString(),
    ...e,
  }));
  const updated = [...stamped, ...history].slice(0, MAX_ENTRIES);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(updated, null, 2));
}

module.exports = { loadHistory, appendHistory };
