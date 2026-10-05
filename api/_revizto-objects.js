// Revizto "Model and object properties" API: processing status, scenes and models,
// element counts, property definitions and property searches.
//
// Revizto Ids are signed 64-bit numbers, too big for JavaScript numbers. They are always
// requested as strings (reviztoIdFormat = string) and written into request bodies as raw
// digits, so no digit is ever lost.

import { reviztoGet, reviztoPost } from './_revizto.js';

const ID_RX = /^-?\d{1,20}$/;
export const isReviztoId = v => ID_RX.test(String(v ?? ''));

const OPTIONS = { linearUnit: 'm', angularUnit: 'deg', reviztoIdFormat: 'string' };
const base = uuid => `/v5/project/${uuid}/object-properties`;

// JSON body with some fields written as raw 64-bit integers
function bodyWithIds(obj, ids) {
  const marked = { ...obj };
  for (const k of Object.keys(ids)) marked[k] = `@@${k}@@`;
  let s = JSON.stringify(marked);
  for (const [k, v] of Object.entries(ids)) {
    if (v == null || v === '') { s = s.replace(`"@@${k}@@"`, 'null'); continue; }
    if (!ID_RX.test(String(v))) throw new Error(`Invalid Revizto Id for ${k}`);
    s = s.replace(`"@@${k}@@"`, String(v));
  }
  return s;
}

// ── Processing status ───────────────────────────────────────────
// After a sync, Revizto takes a while to update the object data. Counts are only
// trustworthy when objectTreeStatus is SUCCESS.
export async function importStatus(token, uuid) {
  const d = await reviztoGet(token, `${base(uuid)}/import-status`);
  const tree = String(d?.objectTreeStatus || '').toUpperCase();
  return {
    modelsStatus: String(d?.scenesAndModelsStatus || '').toUpperCase() || null,
    modelsProgress: Number(d?.scenesAndModelsProgress) || 0,
    objectsStatus: tree || null,
    objectsProgress: Number(d?.objectTreeProgress) || 0,
    startedAt: d?.startedAt || null,
    completedAt: d?.completedAt || null,
    // Revizto's UI numbers versions from 1, the API from 0
    version: Number.isFinite(Number(d?.revision)) ? Number(d.revision) + 1 : null,
    revision: Number.isFinite(Number(d?.revision)) ? Number(d.revision) : null,
    // No object status at all usually means "Extended API access" is off for this project
    objectAccess: Boolean(tree),
    objectsReady: tree === 'SUCCESS' && Boolean(d?.completedAt)
  };
}

// ── Scenes and models ───────────────────────────────────────────
const MODEL_PROPS = [
  { category: 'Item', name: 'Name' },
  { category: 'Item', name: 'Source File Name' },
  { category: 'Item', name: 'Authoring Tool' },
  { category: 'Item', name: 'Type' },
  { category: 'Item', name: 'Last published' },
  { category: 'Item', name: 'Last published by' },
  { category: 'Revizto', name: 'Revizto Name' },
  { category: 'Revizto', name: 'Original Name' }
];

function prop(props, category, name) {
  const p = (props || []).find(x => x.categoryDisplayName === category && x.displayName === name);
  return p ? p.value : null;
}
function baseName(path) {
  const s = String(path || '');
  return s.split(/[\\/]/).pop() || '';
}

// Every model of the project, flattened, with its scene and sync details
export async function listModels(token, uuid) {
  const body = JSON.stringify({ propertyFilters: MODEL_PROPS, options: OPTIONS });
  const data = await reviztoPost(token, `${base(uuid)}/get-scenes-and-models`, body);
  const scenes = Array.isArray(data) ? data : [];
  const outScenes = [];
  const models = [];
  for (const s of scenes) {
    const sp = s.properties || [];
    const scene = {
      sceneId: String(s.sceneReviztoId),
      name: String(prop(sp, 'Item', 'Name') || prop(sp, 'Revizto', 'Original Name') || baseName(prop(sp, 'Item', 'Source File Name')) || 'Untitled scene'),
      label: prop(sp, 'Revizto', 'Revizto Name') || null,
      authoringTool: prop(sp, 'Item', 'Authoring Tool') || null,
      lastSynced: s.lastSynced || null,
      lastSyncedBy: s.lastSyncedBy || null,
      modelCount: 0
    };
    const walk = list => {
      for (const m of list || []) {
        const mp = m.properties || [];
        const fileName = String(prop(mp, 'Item', 'Name') || prop(mp, 'Revizto', 'Original Name') ||
          baseName(prop(mp, 'Item', 'Source File Name')) || prop(mp, 'Revizto', 'Revizto Name') || 'Untitled model');
        models.push({
          sceneId: scene.sceneId,
          sceneName: scene.name,
          sceneLabel: scene.label,
          authoringTool: scene.authoringTool,
          modelId: String(m.modelReviztoId),
          fileName,
          label: prop(mp, 'Revizto', 'Revizto Name') || null,
          sourceFile: prop(mp, 'Item', 'Source File Name') || null,
          lastSynced: m.lastSynced || null,
          lastSyncedBy: m.lastSyncedBy || null,
          lastPublished: prop(mp, 'Item', 'Last published') || null,
          lastPublishedBy: prop(mp, 'Item', 'Last published by') || null
        });
        scene.modelCount++;
        walk(m.models);   // always empty today, kept in case Revizto nests them again
      }
    };
    walk(s.models);
    outScenes.push(scene);
  }
  return { scenes: outScenes, models };
}

// ── Element counts ──────────────────────────────────────────────
// Asks Revizto for the model's elements with no properties at all (a property name that
// doesn't exist), so each page is small. Keeps going until done or the time budget runs out;
// the caller passes `cursor` back in to continue.
const COUNT_PAGE = 25000;
const NO_PROPERTIES = [{ category: 'Revizto', name: '__count_only__' }];

export async function countElements(token, uuid, { sceneId, modelId, cursor = null, deadline, pageSize = COUNT_PAGE }) {
  let count = 0;
  let next = cursor || null;
  let pages = 0;
  let slowest = 0;
  do {
    const t0 = Date.now();
    const body = bodyWithIds(
      { limit: pageSize, cursor: next, elementsOnly: true, propertyFilters: NO_PROPERTIES, options: OPTIONS },
      { sceneReviztoId: sceneId, modelReviztoId: modelId }
    );
    let data;
    try {
      data = await reviztoPost(token, `${base(uuid)}/get-tree`, body, { timeoutMs: Math.max(3000, deadline - Date.now()) });
    } catch (e) {
      // Out of time: keep what was counted so far; the caller continues from `next`
      if (e.timeout && pages > 0) break;
      throw e;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    count += items.length;
    next = data?.cursor || null;
    pages++;
    slowest = Math.max(slowest, Date.now() - t0);
    // Only start another page if it should finish before the time budget runs out
  } while (next && Date.now() + slowest * 1.3 < deadline);
  return { count, cursor: next, done: !next, pages };
}

// ── Property definitions (for the search builder) ───────────────
const DEFS_TTL = 15 * 60 * 1000;
const defsCache = new Map();   // uuid → { at, list }; reused while this server instance stays warm

// Types that can't be searched or summed (binary / structured data)
const SKIP_TYPES = new Set([14, 15, 100]);

export async function propertyDefinitions(token, uuid, { fresh = false } = {}) {
  const hit = defsCache.get(uuid);
  if (!fresh && hit && Date.now() - hit.at < DEFS_TTL) return hit.list;
  const data = await reviztoGet(token, `${base(uuid)}/get-all-properties`);
  const raw = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  const seen = new Set();
  const list = [];
  for (const d of raw) {
    const t = Number(d.valueType);
    if (SKIP_TYPES.has(t) || !d.displayName || !d.categoryDisplayName) continue;
    const k = `${d.categoryDisplayName}\u0001${d.displayName}\u0001${t}`;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ c: d.categoryDisplayName, n: d.displayName, t, custom: Boolean(d.isCustom) });
  }
  list.sort((a, b) => a.n.localeCompare(b.n) || a.c.localeCompare(b.c));
  defsCache.set(uuid, { at: Date.now(), list });
  return list;
}

// ── Property search: one page of matching objects ───────────────
// columns: [{ category, name }] – the properties to bring back for each object
export async function searchPage(token, uuid, { nodeFilters, columns, elementsOnly, sceneId, modelId, cursor, limit, timeoutMs = 0 }) {
  const body = bodyWithIds(
    {
      limit,
      cursor: cursor || null,
      elementsOnly: Boolean(elementsOnly),
      propertyFilters: columns.map(c => ({ category: c.category, name: c.name })),
      nodeFilters: nodeFilters || null,
      options: OPTIONS
    },
    { sceneReviztoId: sceneId || null, modelReviztoId: sceneId && modelId ? modelId : null }
  );
  const data = await reviztoPost(token, `${base(uuid)}/get-tree`, body, { timeoutMs });
  const items = Array.isArray(data?.items) ? data.items : [];
  const units = columns.map(() => '');
  const rows = items.map(o => {
    const byKey = new Map();
    for (const p of o.properties || []) {
      const k = `${p.categoryDisplayName}\u0001${p.displayName}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(p);
    }
    const v = columns.map((c, i) => {
      const ps = byKey.get(`${c.category}\u0001${c.name}`);
      if (!ps || !ps.length) return null;
      if (!units[i] && ps[0].unit) units[i] = ps[0].unit;
      const vals = ps.map(p => (p.value !== null && typeof p.value === 'object') ? JSON.stringify(p.value) : p.value);
      if (vals.length === 1) return vals[0];
      return [...new Set(vals.map(String))].join('; ');
    });
    return { m: String(o.modelReviztoId), v };
  });
  return { rows, cursor: data?.cursor || null, units };
}
