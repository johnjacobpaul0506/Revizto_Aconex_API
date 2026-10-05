// Seals the pages in src/pages/ into api/_pages.js, so they are only ever sent by the server
// to people who are signed in (never published as files).
// Run: node src/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src/pages');
const pages = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort()) {
  pages[f.replace(/\.html$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8');
}
const out = `// GENERATED from src/pages/*.html by src/build.mjs. Do not edit by hand.
// The signed-in pages, served by api/app.js.
export default ${JSON.stringify(pages)};
`;
fs.writeFileSync(path.join(root, 'api/_pages.js'), out);
console.log(`api/_pages.js written: ${Object.keys(pages).join(', ')} (${Math.round(out.length / 1024)} KB)`);
