const crypto = require('crypto');

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function findRecord(data, kind, id) {
  if (kind === 'vehicle') return (data.vehicles || []).find(v => v.id === id);
  if (kind === 'document') return (data.documents || []).find(d => d.id === id);
  return null;
}

function labelFor(kind, record) {
  if (!record) return kind === 'vehicle' ? 'Véhicule' : 'Document';
  if (kind === 'vehicle') return `Véhicule ${record.plaque || ''}`.trim();
  return `Document ${record.type || ''}`.trim();
}

function isLocked(record) {
  return !!(record && record.verrou && record.verrou.locked);
}

function checkPassword(record, password) {
  return isLocked(record) && record.verrou.passwordHash === hashPassword(password);
}

function preserveLocks(oldData, newData) {
  const oldVehiclesById = new Map((oldData.vehicles || []).map(v => [v.id, v]));
  const oldDocumentsById = new Map((oldData.documents || []).map(d => [d.id, d]));
  (newData.vehicles || []).forEach(v => {
    const old = oldVehiclesById.get(v.id);
    v.verrou = old ? old.verrou : undefined;
  });
  (newData.documents || []).forEach(d => {
    const old = oldDocumentsById.get(d.id);
    d.verrou = old ? old.verrou : undefined;
  });
}

function findLockViolation(oldData, newData, unlocks) {
  const proofs = Array.isArray(unlocks) ? unlocks : [];
  const groups = [
    ['vehicle', oldData.vehicles || [], newData.vehicles || []],
    ['document', oldData.documents || [], newData.documents || []],
  ];
  for (const [kind, oldArr, newArr] of groups) {
    const newMap = new Map(newArr.map(x => [x.id, x]));
    for (const oldItem of oldArr) {
      if (!isLocked(oldItem)) continue;
      const newItem = newMap.get(oldItem.id);
      const strip = (x) => JSON.stringify({ ...x, verrou: null });
      const changedOrRemoved = !newItem || strip(oldItem) !== strip(newItem);
      if (!changedOrRemoved) continue;
      const proof = proofs.find(p => p.kind === kind && p.id === oldItem.id);
      if (!proof || !checkPassword(oldItem, proof.password)) {
        return { label: labelFor(kind, oldItem) };
      }
    }
  }
  return null;
}

module.exports = { hashPassword, findRecord, labelFor, isLocked, checkPassword, preserveLocks, findLockViolation };
