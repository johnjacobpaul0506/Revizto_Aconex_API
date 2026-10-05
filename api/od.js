// Revizto Object Data API (admin sign-in only, for now). One server function for all of it,
// because the Vercel Hobby plan allows 12 functions per site.
//
//   GET  /api/od?op=overview&project=<key>                 models, baseline check, element counts
//   POST /api/od?op=baseline-add     { project, status, entries: [{ text, label? }] }
//   POST /api/od?op=baseline-edit    { project, id, text?, label? }
//   POST /api/od?op=baseline-remove  { project, id }
//   POST /api/od?op=count            { project, sceneId, modelId } → then { project, job } until done
//   POST /api/od?op=settings         { project, dropThreshold }
//   GET  /api/od?op=properties&project=<key>&q=<text>       property names for the search builder
//   POST /api/od?op=search           { project, match, conditions, columns, elementsOnly, sceneId?, modelId?, cursor? }
//   GET  /api/od?op=searches                               saved searches
//   POST /api/od?op=search-save      { id?, name, definition }
//   POST /api/od?op=search-delete    { id }
//   POST /api/od?op=import-preview   { files: [{ name, data (base64) }] }      read Revizto .vimsst exports
//   POST /api/od?op=import-save      { files, ids: [...], standIns: { refId: "model file text" } }

import crypto from 'node:crypto';
import { requireAdmin } from './_auth.js';
import { findProject, updateProject, userError } from './_projects.js';
import { withRevizto } from './_revizto.js';
import { importStatus, listModels, countElements, propertyDefinitions, searchPage, isReviztoId } from './_revizto-objects.js';
import { analyse } from './_od.js';
import { rest, fail, select, insert, update, remove, tableMissing } from './_supabase.js';
import { deriveKey } from './_session.js';
import { parseVimsst, treeToNodeFilters, standInTree, validTree } from './_vimsst.js';

export const config = { maxDuration: 60 };

const NEED_SQL = 'The Object Data tables are not in Supabase yet. Run sql/01-setup.sql in Supabase (SQL Editor), then reload.';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireAdmin(req, res)) return;
  const op = String(req.query?.op || '');
  const body = readBody(req);
  const started = Date.now();

  try {
    if (req.method === 'GET' && op === 'searches') return res.status(200).json({ ok: true, searches: await listSearches() });
    if (req.method === 'POST' && op === 'search-save') return res.status(200).json({ ok: true, search: await saveSearch(body) });
    if (req.method === 'POST' && op === 'search-delete') {
      const id = toId(body.id);
      await remove('od_searches', `id=eq.${id}`);
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'POST' && op === 'import-preview') return res.status(200).json(await importPreview(body));
    if (req.method === 'POST' && op === 'import-save') return res.status(200).json(await importSave(body));

    const project = await findProject(req.method === 'GET' ? req.query?.project : body.project);
    if (!project) throw userError('Unknown or archived project', 404);
    const key = encodeURIComponent(project.key);

    switch (`${req.method} ${op}`) {
      case 'GET overview': return res.status(200).json(await overview(project, key));

      case 'POST baseline-add': {
        const status = body.status === 'ignored' ? 'ignored' : 'required';
        const entries = (Array.isArray(body.entries) ? body.entries : []).slice(0, 500)
          .map(e => ({ text: cleanText(e?.text, 200), label: cleanText(e?.label, 120) }))
          .filter(e => e.text);
        if (!entries.length) throw userError('Enter at least one piece of text.');
        const existing = await baselineRows(key);
        const have = new Set(existing.filter(b => b.status === status).map(b => b.match_text.toLowerCase()));
        const fresh = [];
        for (const e of entries) {
          const k = e.text.toLowerCase();
          if (have.has(k)) continue;
          have.add(k);
          fresh.push({ project_key: project.key, match_text: e.text, label: e.label || null, status });
        }
        if (fresh.length) await insert('od_baseline', fresh);
        // Approving a model that was ignored: remove the matching "ignored" entry
        if (status === 'required') {
          for (const e of entries) {
            const ig = existing.find(b => b.status === 'ignored' && b.match_text.toLowerCase() === e.text.toLowerCase());
            if (ig) await remove('od_baseline', `id=eq.${ig.id}`);
          }
        }
        return res.status(200).json({ ok: true, added: fresh.length, skipped: entries.length - fresh.length });
      }

      case 'POST baseline-edit': {
        const id = toId(body.id);
        const patch = {};
        if (body.text !== undefined) {
          patch.match_text = cleanText(body.text, 200);
          if (!patch.match_text) throw userError('The text can\'t be empty.');
        }
        if (body.label !== undefined) patch.label = cleanText(body.label, 120) || null;
        if (!Object.keys(patch).length) throw userError('Nothing to change.');
        const r = await rest(`od_baseline?id=eq.${id}&project_key=eq.${key}`, {
          method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch)
        });
        if (!r.ok) {
          if (r.status === 409) throw userError('That text is already in the baseline.', 409);
          throw fail('update baseline', r);
        }
        return res.status(200).json({ ok: true });
      }

      case 'POST baseline-remove': {
        await remove('od_baseline', `id=eq.${toId(body.id)}&project_key=eq.${key}`);
        return res.status(200).json({ ok: true });
      }

      case 'POST count': return res.status(200).json(await countStep(project, body, started));

      case 'POST settings': {
        const t = Number(body.dropThreshold);
        if (!Number.isFinite(t) || t < 1 || t > 90) throw userError('Enter a percentage between 1 and 90.');
        const p = await updateProject(project.key, { settings: { dropThreshold: Math.round(t * 10) / 10 } });
        return res.status(200).json({ ok: true, settings: p.settings });
      }

      case 'GET properties': {
        const list = await withRevizto(project.reviztoConnection,
          token => propertyDefinitions(token, project.revizto, { fresh: req.query?.fresh === '1' }));
        return res.status(200).json({ ok: true, total: list.length, matches: rankProperties(list, req.query?.q) });
      }

      case 'POST search': return res.status(200).json(await runSearch(project, body, started));

      default: return res.status(400).json({ ok: false, error: 'Unknown request' });
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (e?.timeout) return res.status(503).json({ ok: false, timeout: true, error: msg });
    const needsSignIn = /not connected|expired or was revoked/i.test(msg);
    return res.status(e.status || (needsSignIn ? 409 : 502)).json({ ok: false, error: msg, reviztoNeedsSignIn: needsSignIn });
  }
}

// ── Overview ────────────────────────────────────────────────────
async function overview(project, key) {
  const [[status, list], baseline, counts] = await Promise.all([
    withRevizto(project.reviztoConnection, token => Promise.all([importStatus(token, project.revizto), listModels(token, project.revizto)])),
    baselineRows(key),
    select('od_model_counts', `project_key=eq.${key}&select=id,model_id,file_name,element_count,model_synced_at,counted_at&order=counted_at.asc&limit=50000`)
      .catch(e => { throw /does not exist|Could not find the table|PGRST205/i.test(e.message) ? userError(NEED_SQL, 409) : e; })
  ]);
  const result = analyse({ ...list, baseline, counts, threshold: project.settings.dropThreshold });
  return {
    ok: true,
    project: { key: project.key, name: project.name, settings: project.settings },
    status,
    scenes: list.scenes,
    ...result,
    loadedAt: new Date().toISOString()
  };
}

async function baselineRows(key) {
  const r = await rest(`od_baseline?project_key=eq.${key}&select=id,match_text,label,status,created_at&order=id.asc`);
  if (!r.ok) {
    if (tableMissing(r)) throw userError(NEED_SQL, 409);
    throw fail('read baseline', r);
  }
  return r.body || [];
}

// ── Element count, one step at a time ───────────────────────────
// The first call checks Revizto has finished processing and finds the model. Each call counts
// for up to ~40 seconds and returns a signed "job" (where it got to); the page sends it back
// until the count is done, then the result is saved.
function countStep(project, body, started) {
  return withRevizto(project.reviztoConnection, token => countWith(token, project, body, started));
}
async function countWith(token, project, body, started) {
  let job;
  if (body.job) {
    job = openJob(body.job);
    if (job.project !== project.key) throw userError('This count belongs to another project. Start again.');
  } else {
    if (!isReviztoId(body.sceneId) || !isReviztoId(body.modelId)) throw userError('Pick a model to count.');
    const [status, list] = await Promise.all([importStatus(token, project.revizto), listModels(token, project.revizto)]);
    if (!status.objectAccess) {
      throw userError('Revizto isn\'t sharing object data for this project. In Revizto, open Project info → Extended API access and tick "Enable API access to object properties".', 409);
    }
    if (!status.objectsReady) {
      throw userError(`Revizto is still processing the latest sync (${status.objectsStatus || 'not started'}${status.objectsProgress ? `, ${status.objectsProgress}%` : ''}). Counting now could give a wrong number, so try again in a few minutes.`, 409);
    }
    const m = list.models.find(x => x.sceneId === String(body.sceneId) && x.modelId === String(body.modelId));
    if (!m) throw userError('That model is no longer in Revizto. Reload the page.', 404);
    job = {
      project: project.key, sceneId: m.sceneId, modelId: m.modelId, fileName: m.fileName,
      lastSynced: m.lastSynced, revision: status.revision, soFar: 0, cursor: null, pages: 0, at: Date.now()
    };
  }

  const deadline = started + 40000;
  job.pageSize = job.pageSize || 25000;
  let step;
  try {
    step = await countElements(token, project.revizto, { sceneId: job.sceneId, modelId: job.modelId, cursor: job.cursor, deadline, pageSize: job.pageSize });
  } catch (e) {
    if (!e.timeout) throw e;
    // Revizto is slow on this model: carry on in smaller pages
    if (job.pageSize <= 2000) throw userError('Revizto is too slow to count this model right now. Try again later.', 503);
    job.pageSize = Math.max(2000, Math.floor(job.pageSize / 2));
    return { ok: true, done: false, soFar: job.soFar, job: sealJob(job) };
  }
  job.soFar += step.count;
  job.cursor = step.cursor;
  job.pages += step.pages;

  if (!step.done) return { ok: true, done: false, soFar: job.soFar, job: sealJob(job) };

  const saved = await saveCount(project.key, job);
  return { ok: true, done: true, count: job.soFar, modelId: job.modelId, fileName: job.fileName, saved };
}

async function saveCount(key, job) {
  // Same sync counted again with the same result: just note the new time
  const last = await select('od_model_counts',
    `project_key=eq.${encodeURIComponent(key)}&model_id=eq.${encodeURIComponent(job.modelId)}&select=id,element_count,model_synced_at&order=counted_at.desc&limit=1`);
  const prev = last[0];
  const now = new Date().toISOString();
  if (prev && prev.element_count === job.soFar && job.lastSynced && Date.parse(prev.model_synced_at) === Date.parse(job.lastSynced)) {
    await update('od_model_counts', `id=eq.${prev.id}`, { counted_at: now, import_revision: job.revision });
    return 'updated';
  }
  await insert('od_model_counts', [{
    project_key: key,
    scene_id: job.sceneId,
    model_id: job.modelId,
    file_name: job.fileName,
    element_count: job.soFar,
    model_synced_at: job.lastSynced,
    import_revision: job.revision,
    counted_at: now
  }]);
  return 'added';
}

function jobKey() {
  const k = deriveKey('od-count-job');
  if (!k) throw new Error('Server signing key is missing (SESSION_SECRET or SUPABASE_SECRET_KEY).');
  return k;
}
function sealJob(job) {
  const payload = Buffer.from(JSON.stringify(job)).toString('base64url');
  const sig = crypto.createHmac('sha256', jobKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function openJob(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) throw userError('This count can\'t continue. Start it again.');
  const want = crypto.createHmac('sha256', jobKey()).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw userError('This count can\'t continue. Start it again.');
  const job = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (Date.now() - job.at > 30 * 60 * 1000) throw userError('This count took too long and was stopped. Start it again.');
  return job;
}

// ── Property names for the search builder ───────────────────────
function rankProperties(list, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return list.slice(0, 60);
  const scored = [];
  for (const p of list) {
    const n = p.n.toLowerCase();
    const full = `${p.c} › ${p.n}`.toLowerCase();
    let score = -1;
    if (n === s) score = 0;
    else if (n.startsWith(s)) score = 1;
    else if (n.includes(s)) score = 2;
    else if (full.includes(s)) score = 3;
    if (score >= 0) scored.push([score, p]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].n.length - b[1].n.length || a[1].n.localeCompare(b[1].n));
  return scored.slice(0, 80).map(x => x[1]);
}

// ── Property search ─────────────────────────────────────────────
const NUMERIC_TYPES = new Set([1, 2, 7, 8, 9, 10]);
const TEXT_TYPES = new Set([4, 5]);
const OPS = {
  equal: 'equal', notEqual: 'notEqual',
  greaterThan: 'greaterThan', greaterThanOrEqual: 'greaterThanOrEqual',
  lowerThan: 'lowerThan', lowerThanOrEqual: 'lowerThanOrEqual',
  between: 'numericInRange', contains: 'stringContain', notContains: 'stringNotContain',
  anyOf: 'arrayContain', noneOf: 'arrayNotContain'
};
const OPS_FOR = {
  text: ['equal', 'notEqual', 'contains', 'notContains', 'anyOf', 'noneOf'],
  number: ['equal', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lowerThan', 'lowerThanOrEqual', 'between', 'anyOf', 'noneOf'],
  bool: ['equal', 'notEqual']
};
const SEARCH_PAGE = 2000;

function kindOf(t) {
  if (TEXT_TYPES.has(t)) return 'text';
  if (NUMERIC_TYPES.has(t)) return 'number';
  if (t === 3) return 'bool';
  return null;
}

function buildFilter(c, i) {
  const n = i + 1;
  const category = cleanText(c?.category, 200);
  const property = cleanText(c?.property, 300);
  if (!category || !property) throw userError(`Condition ${n}: pick a property.`);
  const kind = kindOf(Number(c.valueType));
  if (!kind) throw userError(`Condition ${n}: "${property}" can't be searched (it holds dates or data, not text or numbers).`);
  const op = String(c.op || '');
  if (!OPS_FOR[kind].includes(op)) throw userError(`Condition ${n}: that comparison doesn't work for this property.`);

  const num = (v, what) => {
    const x = Number(String(v ?? '').replace(/,/g, '').trim());
    if (String(v ?? '').trim() === '' || !Number.isFinite(x)) throw userError(`Condition ${n}: enter a number${what ? ` for ${what}` : ''}.`);
    return x;
  };
  let value;
  if (op === 'between') {
    const a = num(c.value, 'from'), b = num(c.value2, 'to');
    value = [Math.min(a, b), Math.max(a, b)];
  } else if (op === 'anyOf' || op === 'noneOf') {
    const parts = String(c.value ?? '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).slice(0, 200);
    if (!parts.length) throw userError(`Condition ${n}: enter one or more values, separated by commas.`);
    value = kind === 'number' ? parts.map(p => num(p)) : parts;
  } else if (kind === 'bool') {
    value = c.value === true || String(c.value).toLowerCase() === 'true' || String(c.value).toLowerCase() === 'yes';
  } else if (kind === 'number') {
    value = num(c.value);
  } else {
    value = String(c.value ?? '');
    if ((op === 'contains' || op === 'notContains') && !value.trim()) throw userError(`Condition ${n}: enter the text to look for.`);
  }
  return { node: 'filter', category, property, operator: OPS[op], value };
}

async function runSearch(project, body, started = Date.now()) {
  const sceneId = body.sceneId && isReviztoId(body.sceneId) ? String(body.sceneId) : null;
  const modelId = sceneId && body.modelId && isReviztoId(body.modelId) ? String(body.modelId) : null;
  let nodeFilters = null;
  if (body.savedId) {
    // A search imported from Revizto: its conditions come from the saved copy, not the page
    const all = await listSearches();
    const saved = all.find(x => x.id === Number(body.savedId));
    if (!saved) throw userError('That saved search no longer exists. Reload the list.', 404);
    if (!saved.definition?.tree) throw userError('That saved search has no conditions from Revizto.');
    nodeFilters = treeToNodeFilters(saved.definition.tree, { resolveRef: byReviztoId(all) });
  }
  const conditions = !body.savedId && Array.isArray(body.conditions) ? body.conditions.slice(0, 25) : [];
  const nodes = conditions.map(buildFilter);
  if (!nodeFilters && !nodes.length && !modelId) throw userError('Add at least one condition, or pick one model to list.');

  const columns = (Array.isArray(body.columns) ? body.columns : []).slice(0, 20)
    .map(c => ({ category: cleanText(c?.category, 200), name: cleanText(c?.name, 300) }))
    .filter(c => c.category && c.name);
  if (!columns.length) throw userError('Add at least one column to show.');

  if (!nodeFilters && nodes.length) nodeFilters = { node: 'collection', type: body.match === 'any' ? 'or' : 'and', nodes };
  const page = await withRevizto(project.reviztoConnection, token => searchPage(token, project.revizto, {
    nodeFilters, columns, elementsOnly: body.elementsOnly !== false, sceneId, modelId,
    cursor: typeof body.cursor === 'string' && body.cursor.length < 2000 ? body.cursor : null,
    limit: Math.min(5000, Math.max(100, Math.round(Number(body.limit) || SEARCH_PAGE))),
    // Stop well before Vercel's 60 seconds; the page then asks again with a smaller page
    timeoutMs: Math.max(5000, started + 48000 - Date.now())
  }));
  return { ok: true, ...page };
}

// ── Saved searches ──────────────────────────────────────────────
async function listSearches() {
  const r = await rest('od_searches?select=id,name,definition,updated_at&order=name.asc');
  if (!r.ok) {
    if (tableMissing(r)) throw userError(NEED_SQL, 409);
    throw fail('read saved searches', r);
  }
  return r.body || [];
}

async function saveSearch(body) {
  const name = cleanText(body.name, 80);
  if (!name) throw userError('Give the search a name.');
  const def = body.definition;
  if (!def || typeof def !== 'object' || JSON.stringify(def).length > 60000) throw userError('That search is too large to save.');
  if (def.tree !== undefined && def.tree !== null && !validTree(def.tree)) throw userError('That search\'s conditions can\'t be saved.');
  const now = new Date().toISOString();
  if (body.id) {
    const r = await rest(`od_searches?id=eq.${toId(body.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name, definition: def, updated_at: now })
    });
    if (!r.ok) {
      if (r.status === 409) throw userError(`A saved search called "${name}" already exists.`, 409);
      throw fail('save search', r);
    }
    if (!r.body?.[0]) throw userError('That saved search no longer exists.', 404);
    return r.body[0];
  }
  const r = await rest('od_searches', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name, definition: def, updated_at: now })
  });
  if (!r.ok) {
    if (r.status === 409) throw userError(`A saved search called "${name}" already exists. Pick another name, or load it and save over it.`, 409);
    if (tableMissing(r)) throw userError(NEED_SQL, 409);
    throw fail('save search', r);
  }
  return r.body[0];
}

// ── Import Revizto search sets (.vimsst) ────────────────────────
const MAX_IMPORT_BYTES = 3 * 1024 * 1024;

function byReviztoId(saved) {
  const map = new Map();
  for (const s of saved) {
    const id = s.definition?.source?.kind === 'revizto' ? s.definition.source.id : null;
    if (id && !map.has(id)) map.set(id, s.definition);
  }
  return id => map.get(id) || null;
}

// Reads every file; a search set in more than one file keeps its most recently changed copy
function readImportFiles(body) {
  const files = Array.isArray(body.files) ? body.files.slice(0, 20) : [];
  if (!files.length) throw userError('Pick at least one .vimsst file exported from Revizto.');
  let total = 0;
  const sets = new Map();
  const fileErrors = [];
  for (const f of files) {
    const name = cleanText(f?.name, 160) || 'file';
    const buf = Buffer.from(String(f?.data || ''), 'base64');
    total += buf.length;
    if (total > MAX_IMPORT_BYTES) throw userError('Those files are too large to import at once. Try fewer files.');
    try {
      for (const set of parseVimsst(buf, name)) {
        const prev = sets.get(set.id);
        if (!prev || String(set.changed || '') > String(prev.changed || '')) sets.set(set.id, set);
      }
    } catch (e) {
      fileErrors.push(e.message);
    }
  }
  return { sets: [...sets.values()], fileErrors };
}

async function importPreview(body) {
  const { sets, fileErrors } = readImportFiles(body);
  const saved = await listSearches();
  const savedById = new Map();
  for (const s of saved) if (s.definition?.source?.kind === 'revizto' && s.definition.source.id) savedById.set(s.definition.source.id, s);
  const inFile = new Set(sets.map(s => s.id));
  const missing = new Map();
  const out = sets.map(s => {
    for (const r of s.refs) {
      if (inFile.has(r.id)) continue;
      const have = savedById.get(r.id);
      if (have && !have.definition.source.standIn) continue;
      if (!missing.has(r.id)) missing.set(r.id, { id: r.id, name: r.name, path: r.path, usedBy: [], standIn: have ? have.definition.standInText || null : null });
      missing.get(r.id).usedBy.push(s.name);
    }
    const existing = savedById.get(s.id);
    return {
      id: s.id, name: s.name, created: s.created, changed: s.changed, file: s.file,
      tree: s.tree, refs: s.refs, problems: s.problems,
      existing: existing ? { id: existing.id, name: existing.name, standIn: Boolean(existing.definition.source.standIn) } : null
    };
  });
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, sets: out, missing: [...missing.values()], fileErrors };
}

async function importSave(body) {
  const { sets } = readImportFiles(body);
  const want = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
  const chosen = sets.filter(s => want.has(s.id));
  const standIns = body.standIns && typeof body.standIns === 'object' ? body.standIns : {};
  if (!chosen.length && !Object.keys(standIns).length) throw userError('Tick at least one search set to import.');
  const bad = chosen.find(s => s.problems.length || !s.tree);
  if (bad) throw userError(`"${bad.name}" has parts that can't be read yet, so it can't be imported.`);

  let saved = await listSearches();
  const result = { added: 0, updated: 0, standIns: 0 };
  const now = new Date().toISOString();

  const takenName = (name, exceptId) => saved.some(x => x.id !== exceptId && x.name.toLowerCase() === name.toLowerCase());
  const freeName = (name, exceptId) => {
    if (!takenName(name, exceptId)) return name;
    for (let i = 1; i < 50; i++) {
      const n = `${name} (Revizto${i > 1 ? ` ${i}` : ''})`;
      if (!takenName(n, exceptId)) return n;
    }
    return `${name} (${Date.now()})`;
  };
  const upsert = async (reviztoId, name, makeDef) => {
    const existing = saved.find(x => x.definition?.source?.kind === 'revizto' && x.definition.source.id === reviztoId);
    if (existing) {
      const definition = makeDef(existing.definition);
      const finalName = freeName(name, existing.id);
      const r = await rest(`od_searches?id=eq.${existing.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ name: finalName, definition, updated_at: now })
      });
      if (!r.ok) throw fail('save imported search', r);
      Object.assign(existing, r.body[0]);
      return 'updated';
    }
    const finalName = freeName(name, null);
    const r = await rest('od_searches', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ name: finalName, definition: makeDef(null), updated_at: now })
    });
    if (!r.ok) {
      if (tableMissing(r)) throw userError(NEED_SQL, 409);
      throw fail('save imported search', r);
    }
    saved = [...saved, r.body[0]];
    return 'added';
  };

  for (const s of chosen) {
    const columns = defaultColumns(s.tree);
    const outcome = await upsert(s.id, cleanText(s.name, 80) || 'Imported search set', prev => ({
      format: 2,
      source: { kind: 'revizto', id: s.id, created: s.created, changed: s.changed, file: s.file, importedAt: now, flags: s.flags },
      tree: s.tree,
      refs: s.refs,
      // Keep what was set up here (columns, formulas, totals) when a search set is imported again
      columns: prev && !prev.source?.standIn && Array.isArray(prev.columns) && prev.columns.length ? prev.columns : columns,
      calcs: prev && Array.isArray(prev.calcs) ? prev.calcs : [],
      elementsOnly: prev ? prev.elementsOnly !== false : true,
      groupBy: prev?.groupBy || '',
      aggs: prev?.aggs || {}
    }));
    result[outcome]++;
  }

  // Stand-ins for search sets that weren't exported: "model file contains …"
  for (const [refId, raw] of Object.entries(standIns).slice(0, 50)) {
    const text = cleanText(raw, 200);
    if (!text || !/^[0-9a-f-]{8,64}$/i.test(refId)) continue;
    const real = saved.find(x => x.definition?.source?.kind === 'revizto' && x.definition.source.id === refId && !x.definition.source.standIn);
    if (real) continue;
    const ref = sets.flatMap(x => x.refs).find(r => r.id === refId);
    const name = cleanText(ref?.name, 80) || 'Stand-in search set';
    await upsert(refId, name, () => ({
      format: 2,
      source: { kind: 'revizto', id: refId, standIn: true, path: ref?.path || [], importedAt: now },
      standInText: text,
      tree: standInTree(text),
      refs: [],
      columns: [{ category: 'Item', name: 'Name', valueType: 5 }, { category: 'Item', name: 'Source File', valueType: 5 }],
      calcs: [], elementsOnly: true, groupBy: '', aggs: {}
    }));
    result.standIns++;
  }
  return { ok: true, ...result };
}

// Item › Name, Item › Type, then the properties the search tests (up to 6 in all)
function defaultColumns(tree) {
  const cols = [{ category: 'Item', name: 'Name', valueType: 5 }, { category: 'Item', name: 'Type', valueType: 5 }];
  const walk = n => {
    if (!n) return;
    if (n.type === 'cond' && cols.length < 6 && !cols.some(c => c.category === n.category && c.name === n.property)) {
      cols.push({ category: n.category, name: n.property, valueType: n.valueType || 5 });
    }
    (n.nodes || []).forEach(walk);
    if (n.node) walk(n.node);
  };
  walk(tree);
  return cols;
}

// ── Small helpers ───────────────────────────────────────────────
function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function toId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw userError('Unknown item.');
  return n;
}
function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { /* fall through */ } }
  return {};
}
