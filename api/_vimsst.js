// Reads Revizto search set exports (.vimsst). The file is Protocol Buffers (a compact binary
// format). Revizto doesn't publish its layout, so this follows what real exports contain:
//
//   file        1: "MarkerSearchSets"   2: version   4: search set (repeated)
//   search set  1: id   2: created   3: changed   4: owner id   7: name   8: query
//   query       2: part (repeated)    – the conditions written out in order, with brackets
//   part        1: kind  (0 condition, 1 "(", 2 ")", 3 OR, 4 AND, 5 NOT, 6 IS)
//               2: condition – either 1: another search set (id + folder path)
//                                  or 2: a property test (category, property, values, comparison)
//   comparison  6 = is (any of the values), 12 = contains (any of the values)
//
// Anything else is reported as "not understood yet" instead of being guessed.

const KIND = { 0: 'operand', 1: '(', 2: ')', 3: 'or', 4: 'and', 5: 'not', 6: 'is' };
export const OPERATORS = { 6: 'is', 12: 'contains' };

// ── Protocol Buffers, the minimum needed ────────────────────────
function readVarint(buf, pos) {
  let result = 0n, shift = 0n, b;
  do {
    if (pos >= buf.length) throw new Error('file ends in the middle of a number');
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (shift > 70n) throw new Error('number too long');
  } while (b & 0x80);
  return [result, pos];
}

// → [{ f, wt, v }] where v is a BigInt (varint), Buffer (bytes) or Buffer (fixed)
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const f = Number(key >> 3n), wt = Number(key & 7n);
    if (f === 0) throw new Error('bad field number');
    if (wt === 0) { let v; [v, pos] = readVarint(buf, pos); out.push({ f, wt, v }); }
    else if (wt === 2) {
      let len; [len, pos] = readVarint(buf, pos);
      const n = Number(len);
      if (pos + n > buf.length) throw new Error('a block runs past the end of the file');
      out.push({ f, wt, v: buf.subarray(pos, pos + n) });
      pos += n;
    } else if (wt === 1) { out.push({ f, wt, v: buf.subarray(pos, pos + 8) }); pos += 8; }
    else if (wt === 5) { out.push({ f, wt, v: buf.subarray(pos, pos + 4) }); pos += 4; }
    else throw new Error(`unsupported block type ${wt}`);
  }
  return out;
}
const str = b => Buffer.from(b).toString('utf8');
const first = (fs, n) => fs.find(x => x.f === n);
const all = (fs, n) => fs.filter(x => x.f === n);
const int = (fs, n) => { const x = first(fs, n); return x && x.wt === 0 ? Number(x.v) : null; };
const text = (fs, n) => { const x = first(fs, n); return x && x.wt === 2 ? str(x.v) : null; };

// .NET ticks (100 ns since year 1) → ISO date
function ticksToIso(fs, n) {
  const x = first(fs, n);
  if (!x || x.wt !== 0) return null;
  const ms = Number((x.v - 621355968000000000n) / 10000n);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100 ? null : d.toISOString();
}

// ── One condition ───────────────────────────────────────────────
// A short description of a block we don't understand, e.g. "fields 1, 3 (text: 'Level 2')"
function describe(buf) {
  try {
    const fs = fields(buf);
    const texts = [];
    const walk = (b, d) => {
      if (d > 4 || texts.length > 4) return;
      for (const x of fields(b)) {
        if (x.wt !== 2) continue;
        const t = str(x.v);
        if (/^[\x20-\x7e\u00a0-\uffff]{2,80}$/.test(t) && !/[\ufffd]/.test(t)) texts.push(t);
        else { try { walk(x.v, d + 1); } catch { /* not a block */ } }
      }
    };
    try { walk(buf, 0); } catch { /* ignore */ }
    return `fields ${[...new Set(fs.map(x => x.f))].join(', ')}${texts.length ? ` (${texts.slice(0, 4).map(t => `"${t}"`).join(', ')})` : ''}`;
  } catch {
    return `${buf.length} bytes`;
  }
}

function readOperand(buf, problems) {
  const fs = fields(buf);
  const ref = first(fs, 1);
  if (ref && ref.wt === 2) {
    const inner = first(fields(ref.v), 1);
    if (!inner || inner.wt !== 2) {
      const detail = describe(ref.v);
      problems.push(`a link to something in a form not seen before: ${detail}`);
      return { type: 'unknown', detail };
    }
    const r = fields(inner.v);
    const path = all(r, 2).map(x => str(x.v));
    return { type: 'ref', id: text(r, 1) || '', name: path[path.length - 1] || '(unnamed search set)', path };
  }
  const cond = first(fs, 2);
  if (cond && cond.wt === 2) {
    const c = fields(cond.v);
    const cat = first(c, 2), prop = first(c, 3), val = first(c, 4);
    const catF = cat ? fields(cat.v) : [], propF = prop ? fields(prop.v) : [], valF = val ? fields(val.v) : [];
    const code = int(c, 5);
    const op = OPERATORS[code];
    const valueType = int(valF, 1);
    const values = all(valF, 2).map(x => str(x.v));
    const node = {
      type: 'cond',
      category: text(catF, 2) || '',
      property: text(propF, 2) || '',
      categoryKey: text(catF, 1) || null,
      propertyKey: text(propF, 1) || null,
      valueType,
      op: op || null,
      opCode: code,
      values,
      flags: int(c, 1)
    };
    if (!op) problems.push(`the comparison used for "${node.property}" (code ${code})`);
    if (valueType !== 5) problems.push(`a value of type ${valueType} for "${node.property}" (only text values are understood so far)`);
    if (!node.category || !node.property) problems.push('a condition without a property name');
    if (valF.some(x => x.f !== 1 && x.f !== 2)) problems.push(`a value format not seen before for "${node.property}"`);
    return node;
  }
  const detail = describe(buf);
  problems.push(`a condition type not seen before: ${detail}`);
  return { type: 'unknown', detail };
}

// ── The query: parts in order → a tree ──────────────────────────
// Brackets first, then NOT / IS, then AND, then OR.
function buildTree(parts, problems) {
  let i = 0;
  const peek = () => parts[i];
  function orExpr() {
    const nodes = [andExpr()];
    while (peek() && peek().kind === 'or') { i++; nodes.push(andExpr()); }
    return nodes.length === 1 ? nodes[0] : { type: 'or', nodes };
  }
  function andExpr() {
    const nodes = [unary()];
    while (peek() && peek().kind === 'and') { i++; nodes.push(unary()); }
    return nodes.length === 1 ? nodes[0] : { type: 'and', nodes };
  }
  function unary() {
    const p = peek();
    if (!p) throw new Error('the conditions end too early');
    if (p.kind === 'not') { i++; return { type: 'not', node: unary() }; }
    if (p.kind === 'is') { i++; return unary(); }
    if (p.kind === '(') {
      i++;
      const e = orExpr();
      if (!peek() || peek().kind !== ')') throw new Error('a bracket is not closed');
      i++;
      return e;
    }
    if (p.kind === 'operand') { i++; return p.node; }
    throw new Error(`unexpected "${p.kind}"`);
  }
  if (!parts.length) return null;
  const tree = orExpr();
  if (i < parts.length) throw new Error('extra parts after the end of the conditions');
  return flatten(tree);
}

// (A AND (B AND C)) → (A AND B AND C)
function flatten(n) {
  if (!n || typeof n !== 'object') return n;
  if (n.type === 'not') return { type: 'not', node: flatten(n.node) };
  if (n.type === 'and' || n.type === 'or') {
    const nodes = [];
    for (const c of n.nodes.map(flatten)) {
      if (c.type === n.type) nodes.push(...c.nodes); else nodes.push(c);
    }
    return { type: n.type, nodes };
  }
  return n;
}

// ── Whole file ──────────────────────────────────────────────────
export function parseVimsst(buf, fileName = 'file') {
  let root;
  try { root = fields(buf); } catch (e) { throw new Error(`${fileName} isn't a Revizto search set export (${e.message}).`); }
  if (text(root, 1) !== 'MarkerSearchSets') throw new Error(`${fileName} isn't a Revizto search set export.`);
  const sets = [];
  for (const s of all(root, 4)) {
    const sf = fields(s.v);
    const problems = [];
    const set = {
      id: text(sf, 1) || '',
      name: text(sf, 7) || '(unnamed search set)',
      created: ticksToIso(sf, 2),
      changed: ticksToIso(sf, 3),
      file: fileName,
      tree: null,
      refs: [],
      problems,
      flags: { query1: null, query3: null }
    };
    const q = first(sf, 8);
    if (!q || q.wt !== 2) { problems.push('no conditions'); sets.push(set); continue; }
    const qf = fields(q.v);
    set.flags = { query1: int(qf, 1), query3: int(qf, 3) };
    const parts = all(qf, 2).map(p => {
      const pf = fields(p.v);
      const code = int(pf, 1) ?? 0;
      const kind = KIND[code];
      if (!kind) { problems.push(`a joining word not seen before (code ${code})`); return { kind: 'operand', node: { type: 'unknown' } }; }
      if (kind !== 'operand') return { kind };
      const body = first(pf, 2);
      return { kind, node: body && body.wt === 2 ? readOperand(body.v, problems) : { type: 'unknown' } };
    });
    try { set.tree = buildTree(parts, problems); }
    catch (e) { problems.push(`the logic couldn't be read (${e.message})`); }
    const refs = new Map();
    const walk = n => {
      if (!n) return;
      if (n.type === 'ref' && !refs.has(n.id)) refs.set(n.id, { id: n.id, name: n.name, path: n.path });
      if (n.type === 'unknown') problems.push('an unreadable condition');
      (n.nodes || []).forEach(walk);
      if (n.node) walk(n.node);
    };
    walk(set.tree);
    set.refs = [...refs.values()];
    set.problems = [...new Set(problems)];
    sets.push(set);
  }
  return sets;
}

// ── Saved tree → Revizto API filter ─────────────────────────────
// resolveRef(id) → the saved search imported with that Revizto id ({ tree }), or null.
// A search set that wasn't in the file can be saved as a stand-in, e.g. "model file contains …".
export function treeToNodeFilters(tree, { resolveRef, depth = 0, seen = new Set() } = {}) {
  if (depth > 12) throw userErr('Search sets refer to each other too deeply (or in a loop).');
  const conv = n => {
    switch (n?.type) {
      case 'and': case 'or': return { node: 'collection', type: n.type, nodes: n.nodes.map(conv) };
      case 'not': return { node: 'collection', type: 'not', nodes: [conv(n.node)] };
      case 'cond': return condFilter(n);
      case 'ref': {
        if (seen.has(n.id)) throw userErr(`"${n.name}" refers back to itself.`);
        const target = resolveRef(n.id);
        if (target && target.tree) {
          return treeToNodeFilters(target.tree, { resolveRef, depth: depth + 1, seen: new Set([...seen, n.id]) });
        }
        throw userErr(`This search uses the search set "${n.name}", which hasn't been imported yet. Import it (or set up a stand-in for it) with Import Revizto search sets.`);
      }
      default: throw userErr('This search has a condition that can\'t be read yet.');
    }
  };
  return conv(tree);
}

// A stand-in for a search set that wasn't exported: elements whose model file contains the text
export function standInTree(fileText) {
  return { type: 'cond', category: 'Item', property: 'Source File', valueType: 5, op: 'contains', values: [String(fileText)] };
}

function condFilter(n) {
  const values = (n.values || []).filter(v => v !== '');
  if (!values.length) throw userErr(`"${n.property}" has no value to compare with.`);
  if (n.op === 'is') {
    return values.length === 1
      ? { node: 'filter', category: n.category, property: n.property, operator: 'equal', value: values[0] }
      : { node: 'filter', category: n.category, property: n.property, operator: 'arrayContain', value: values };
  }
  if (n.op === 'contains') {
    const one = v => ({ node: 'filter', category: n.category, property: n.property, operator: 'stringContain', value: v });
    return values.length === 1 ? one(values[0]) : { node: 'collection', type: 'or', nodes: values.map(one) };
  }
  throw userErr(`The comparison used for "${n.property}" isn't understood yet.`);
}

function userErr(message) {
  const e = new Error(message);
  e.status = 400;
  e.userFacing = true;
  return e;
}

// Checks a stored tree has only the shapes this file produces
export function validTree(n, depth = 0) {
  if (!n || typeof n !== 'object' || depth > 40) return false;
  if (n.type === 'and' || n.type === 'or') return Array.isArray(n.nodes) && n.nodes.length > 0 && n.nodes.every(c => validTree(c, depth + 1));
  if (n.type === 'not') return validTree(n.node, depth + 1);
  if (n.type === 'ref') return typeof n.id === 'string' && n.id.length < 80;
  if (n.type === 'cond') return typeof n.category === 'string' && typeof n.property === 'string' && Array.isArray(n.values) && n.values.every(v => typeof v === 'string');
  return false;
}
