import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import worker from '../src/worker.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const required = [
  'package.json','wrangler.jsonc','public/index.html','public/app.js','public/styles.css','public/sw.js',
  'src/worker.js','src/cctv-feed.js','src/lib/http.js','src/lib/legacy-adapter.js',
  'src/services/cctv.js','src/services/cctv-registry.js','src/services/geocode.js','src/services/weather.js','src/services/route.js'
];

let failed = 0;
const ok = (name, detail='') => console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail='') => { failed++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); };

for (const rel of required) {
  const p = path.join(root, rel);
  fs.existsSync(p) ? ok(`file ${rel}`) : bad(`file ${rel}`, 'missing');
}

const wrangler = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
for (const needle of ['\"main\": \"src/worker.js\"','\"directory\": \"./public\"','\"run_worker_first\": [\"/api/*\"]','\"cache\"','\"enabled\": true']) {
  wrangler.includes(needle) ? ok(`wrangler ${needle}`) : bad(`wrangler ${needle}`, 'not configured');
}

const assets = {
  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return new Response(fs.readFileSync(path.join(root, 'public/index.html')), {headers:{'content-type':'text/html; charset=utf-8'}});
    }
    return new Response('asset', {status:200});
  }
};

async function expectJson(url, predicate, name) {
  try {
    const response = await worker.fetch(new Request(url), {ASSETS:assets}, {});
    const data = await response.json();
    if (response.ok && predicate(data, response)) ok(name, `HTTP ${response.status}`);
    else bad(name, `HTTP ${response.status} ${JSON.stringify(data).slice(0,180)}`);
  } catch (e) { bad(name, e?.message || String(e)); }
}

await expectJson('https://sentinel.invalid/api/health', d => d.ok && d.platform?.includes('Cloudflare'), 'native /api/health');
await expectJson('https://sentinel.invalid/api/data?action=health', d => d.ok && d.build?.includes('cloudflare'), 'legacy-adapter /api/data?action=health');

try {
  const response = await worker.fetch(new Request('https://sentinel.invalid/'), {ASSETS:assets}, {});
  const html = await response.text();
  if (response.ok && html.includes('2.0.0 CF')) ok('static assets binding', 'index.html reachable');
  else bad('static assets binding', `HTTP ${response.status}`);
} catch (e) { bad('static assets binding', e?.message || String(e)); }

try {
  const response = await worker.fetch(new Request('https://sentinel.invalid/api/data?action=nope'), {ASSETS:assets}, {});
  if (response.status === 404) ok('unknown API action guard', 'HTTP 404');
  else bad('unknown API action guard', `expected 404, got ${response.status}`);
} catch (e) { bad('unknown API action guard', e?.message || String(e)); }

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const actions = [...app.matchAll(/action=([a-z-]+)/g)].map(m => m[1]);
const unique = [...new Set(actions)];
const workerText = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
const missingActions = unique.filter(a => !workerText.includes(`'${a}'`) && !new RegExp(`\\b${a}\\s*[,}]`).test(workerText));
if (!missingActions.length) ok('frontend API action coverage', `${unique.length} actions routed`);
else bad('frontend API action coverage', `missing: ${missingActions.join(', ')}`);

if (failed) {
  console.error(`\nCHECK FAILED: ${failed} problem(s)`);
  process.exit(1);
}
console.log('\nCHECK PASSED: Cloudflare project structure and local routing are consistent.');
