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

import crypto from 'node:crypto';
import { requireAdmin } from './_auth.js';
import { findProject, updateProject, userError } from './_projects.js';
import { withRevizto } from './_revizto.js';
import { importStatus, listModels, countElements, propertyDefinitions, searchPage, isReviztoId } from './_revizto-objects.js';
import { analyse } from './_od.js';
import { rest, fail, select, insert, update, remove, tableMissing } from './_supabase.js';
import { deriveKey } from './_session.js';

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

      case 'POST search': return res.status(200).json(await runSearch(project, body));

      default: return res.status(400).json({ ok: false, error: 'Unknown request' });
    }
  } catch (e) {
    const msg = e?.message || String(e);
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
  const step = await countElements(token, project.revizto, { sceneId: job.sceneId, modelId: job.modelId, cursor: job.cursor, deadline });
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
const SEARCH_PAGE = 5000;

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

async function runSearch(project, body) {
  const conditions = Array.isArray(body.conditions) ? body.conditions.slice(0, 25) : [];
  const nodes = conditions.map(buildFilter);
  const sceneId = body.sceneId && isReviztoId(body.sceneId) ? String(body.sceneId) : null;
  const modelId = sceneId && body.modelId && isReviztoId(body.modelId) ? String(body.modelId) : null;
  if (!nodes.length && !modelId) throw userError('Add at least one condition, or pick one model to list.');

  const columns = (Array.isArray(body.columns) ? body.columns : []).slice(0, 20)
    .map(c => ({ category: cleanText(c?.category, 200), name: cleanText(c?.name, 300) }))
    .filter(c => c.category && c.name);
  if (!columns.length) throw userError('Add at least one column to show.');

  const nodeFilters = nodes.length ? { node: 'collection', type: body.match === 'any' ? 'or' : 'and', nodes } : null;
  const page = await withRevizto(project.reviztoConnection, token => searchPage(token, project.revizto, {
    nodeFilters, columns, elementsOnly: body.elementsOnly !== false, sceneId, modelId,
    cursor: typeof body.cursor === 'string' && body.cursor.length < 2000 ? body.cursor : null,
    limit: SEARCH_PAGE
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
  if (!def || typeof def !== 'object' || JSON.stringify(def).length > 30000) throw userError('That search is too large to save.');
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
