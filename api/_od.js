// Object Data rules: the baseline check and the element-count change check.
//
// Baseline: each required entry is a fixed piece of text; a model "is there" when its file
// name contains that text (not case-sensitive). Models that match no entry are flagged as
// "not in baseline" until the admin approves (adds an entry) or ignores them.
//
// Element counts: compared with the previous count of the same model. A model that is in the
// baseline is tracked through its baseline entry, so its history carries on even if Revizto
// gives a re-uploaded file a new model Id.

const norm = s => String(s || '').toLowerCase();

// A suggested baseline text for a file name: no extension, no revision tag at the end
// e.g. "nNSHS_ST_A_SHP-TE_IFC[14].ifc" → "nNSHS_ST_A_SHP-TE_IFC"
export function suggestMatchText(fileName) {
  let s = String(fileName || '').trim();
  s = s.replace(/\.(ifc|rvt|nwc|nwd|dwg|dgn|skp|fbx|3dm|pln|e57|rcp|ifczip|obj)$/i, '');
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/\s*[\[(][^\])]{1,12}[\])]\s*$/, '')            // [14]  (C1)
      .replace(/[_\s-]+\d{1,2}[.\-]\d{1,2}[.\-]\d{2,4}$/, '')    // _13.08.26
      .replace(/[_\s-]+(rev|r)?\d{1,3}$/i, '')                  // _20  _R3  -rev2
      .trim();
    if (s === before) break;
  }
  return s || String(fileName || '').trim();
}

export function analyse({ models, scenes, baseline, counts, threshold }) {
  const required = baseline.filter(b => b.status === 'required');
  const ignored = baseline.filter(b => b.status === 'ignored');
  const th = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : 10;

  // ── Baseline check ──
  const entryMatches = new Map();
  const baselineRows = required.map(b => {
    const t = norm(b.match_text);
    const ms = models.filter(m => norm(m.fileName).includes(t));
    entryMatches.set(b.id, ms);
    const sc = ms.length ? [] : scenes.filter(s => norm(s.name).includes(t));
    const status = ms.length > 1 ? 'duplicate' : (ms.length || sc.length) ? 'found' : 'missing';
    return {
      id: b.id,
      text: b.match_text,
      label: b.label || null,
      status,
      models: ms.map(m => m.modelId),
      scenes: sc.map(s => ({ sceneId: s.sceneId, name: s.name, lastSynced: s.lastSynced, lastSyncedBy: s.lastSyncedBy }))
    };
  });

  const entryFor = new Map();   // modelId → required entry it belongs to
  for (const b of required) for (const m of entryMatches.get(b.id) || []) if (!entryFor.has(m.modelId)) entryFor.set(m.modelId, b);

  // ── Element counts ──
  const byModel = new Map();
  for (const c of counts) {
    if (!byModel.has(c.model_id)) byModel.set(c.model_id, []);
    byModel.get(c.model_id).push(c);
  }

  const modelRows = models.map(m => {
    const entry = entryFor.get(m.modelId) || null;
    const ignoredBy = entry ? null : ignored.find(b => norm(m.fileName).includes(norm(b.match_text))) || null;
    const inBaseline = entry ? 'required' : ignoredBy ? 'ignored' : 'new';

    // Count history: through the baseline entry if it points at this model only, else this model's own
    let series = byModel.get(m.modelId) || [];
    if (entry && (entryMatches.get(entry.id) || []).length === 1) {
      const t = norm(entry.match_text);
      series = counts.filter(c => c.model_id === m.modelId || norm(c.file_name).includes(t));
    }
    const points = collapse(series);
    const own = (byModel.get(m.modelId) || []).slice().sort((a, b) => Date.parse(b.counted_at) - Date.parse(a.counted_at));
    const latestOwn = own[0] || null;
    const latest = points[points.length - 1] || null;
    const prev = points.length > 1 ? points[points.length - 2] : null;
    let changePct = null;
    let change = null;
    if (latest && prev && prev.c > 0) {
      change = latest.c - prev.c;
      changePct = Math.round((change / prev.c) * 1000) / 10;
    } else if (latest && prev && prev.c === 0) {
      change = latest.c;
    }
    const flag = changePct !== null && changePct <= -th ? 'drop' : changePct !== null && changePct >= th ? 'rise' : null;
    const needsCount = !latestOwn || !sameTime(latestOwn.model_synced_at, m.lastSynced);

    return {
      ...m,
      inBaseline,
      baselineId: entry ? entry.id : ignoredBy ? ignoredBy.id : null,
      baselineText: entry ? entry.match_text : ignoredBy ? ignoredBy.match_text : null,
      suggest: inBaseline === 'new' ? suggestMatchText(m.fileName) : null,
      count: latest ? latest.c : null,
      countedAt: latestOwn ? latestOwn.counted_at : null,
      countedSync: latestOwn ? latestOwn.model_synced_at : null,
      previous: prev ? prev.c : null,
      previousSync: prev ? prev.t : null,
      change,
      changePct,
      flag,
      needsCount,
      history: points.slice(-60)
    };
  });

  const kpis = {
    models: models.length,
    scenes: scenes.length,
    required: baselineRows.length,
    found: baselineRows.filter(r => r.status !== 'missing').length,
    missing: baselineRows.filter(r => r.status === 'missing').length,
    duplicates: baselineRows.filter(r => r.status === 'duplicate').length,
    notInBaseline: modelRows.filter(r => r.inBaseline === 'new').length,
    ignored: modelRows.filter(r => r.inBaseline === 'ignored').length,
    drops: modelRows.filter(r => r.flag === 'drop').length,
    rises: modelRows.filter(r => r.flag === 'rise').length,
    needCount: modelRows.filter(r => r.needsCount).length,
    elements: modelRows.reduce((s, r) => s + (r.count || 0), 0),
    threshold: th
  };

  return { kpis, baseline: baselineRows, models: modelRows, ignoredEntries: ignored.map(b => ({ id: b.id, text: b.match_text })) };
}

// One point per model sync (a recount of the same sync replaces the earlier one), oldest first
function collapse(rows) {
  const bySync = new Map();
  for (const r of rows) {
    const t = r.model_synced_at || r.counted_at;
    const k = String(Date.parse(t) || t);
    const cur = bySync.get(k);
    if (!cur || Date.parse(r.counted_at) >= Date.parse(cur.at)) {
      bySync.set(k, { t, c: Number(r.element_count), at: r.counted_at, f: r.file_name || null });
    }
  }
  return [...bySync.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t) || Date.parse(a.at) - Date.parse(b.at));
}

function sameTime(a, b) {
  if (!a || !b) return false;
  return Date.parse(a) === Date.parse(b);
}
