function vehicleLabel(v) {
  if (!v) return 'véhicule supprimé';
  return [v.plaque, [v.marque, v.modele].filter(Boolean).join(' ')].filter(Boolean).join(' — ');
}

function buildVehicleMap(oldVehicles, newVehicles) {
  const map = new Map();
  [...(oldVehicles || []), ...(newVehicles || [])].forEach(v => map.set(v.id, v));
  return map;
}

function diffById(oldArr, newArr, kind, labelFn) {
  const oldMap = new Map((oldArr || []).map(x => [x.id, x]));
  const newMap = new Map((newArr || []).map(x => [x.id, x]));
  const entries = [];
  for (const [id, item] of newMap) {
    if (!oldMap.has(id)) {
      entries.push({ action: `${kind}_create`, summary: `${labelFn(item)} — ajouté` });
    } else if (JSON.stringify(oldMap.get(id)) !== JSON.stringify(item)) {
      entries.push({ action: `${kind}_update`, summary: `${labelFn(item)} — modifié` });
    }
  }
  for (const [id, item] of oldMap) {
    if (!newMap.has(id)) {
      entries.push({ action: `${kind}_delete`, summary: `${labelFn(item)} — supprimé` });
    }
  }
  return entries;
}

function diffDocTypes(oldTypes, newTypes) {
  const entries = [];
  const oldSet = new Set(oldTypes || []);
  const newSet = new Set(newTypes || []);
  for (const t of newSet) if (!oldSet.has(t)) entries.push({ action: 'doctype_create', summary: `Type de document « ${t} » — ajouté` });
  for (const t of oldSet) if (!newSet.has(t)) entries.push({ action: 'doctype_delete', summary: `Type de document « ${t} » — supprimé` });
  return entries;
}

function computeDiff(oldData, newData) {
  const vehicleMap = buildVehicleMap(oldData.vehicles, newData.vehicles);
  const chauffeurMap = new Map();
  [...(oldData.chauffeurs || []), ...(newData.chauffeurs || [])].forEach(c => chauffeurMap.set(c.id, c));

  const vehicleEntries = diffById(oldData.vehicles, newData.vehicles, 'vehicle', v => `Véhicule ${vehicleLabel(v)}`);

  const docLabel = (d) => `Document ${d.type} (${vehicleLabel(vehicleMap.get(d.vehicleId))})`;
  const documentEntries = diffById(oldData.documents, newData.documents, 'document', docLabel);

  const docTypeEntries = diffDocTypes(oldData.docTypes, newData.docTypes);

  const chauffeurEntries = diffById(oldData.chauffeurs, newData.chauffeurs, 'chauffeur', c => `Chauffeur ${c ? c.name : 'inconnu'}`);

  const sinistreLabel = (s) => `Sinistre ${s.type || ''} — ${vehicleLabel(vehicleMap.get(s.vehicleId))}${s.date ? ' du ' + s.date : ''}`;
  const sinistreEntries = diffById(oldData.sinistres, newData.sinistres, 'sinistre', sinistreLabel);

  return [...vehicleEntries, ...documentEntries, ...docTypeEntries, ...chauffeurEntries, ...sinistreEntries];
}

module.exports = { computeDiff };
