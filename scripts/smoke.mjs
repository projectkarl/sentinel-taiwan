import process from 'node:process';

const raw = process.env.BASE_URL || process.argv[2] || '';
if (!raw) {
  console.error('Usage: BASE_URL=https://your-worker.workers.dev npm run smoke');
  process.exit(2);
}
const base = raw.replace(/\/$/, '');
const hard = [];
const soft = [];

async function get(path, name, validate = () => true, required = true, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(base + path, {signal:ctrl.signal, headers:{accept:'application/json'}});
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const pass = res.ok && validate(data, text, res);
    console.log(`${pass ? '✓' : required ? '✗' : '△'} ${name} — HTTP ${res.status} — ${Date.now()-started} ms`);
    if (!pass) (required ? hard : soft).push(`${name}: HTTP ${res.status} ${text.slice(0,180)}`);
    return {pass,res,data,text};
  } catch (e) {
    console.log(`${required ? '✗' : '△'} ${name} — ${e?.name === 'AbortError' ? 'timeout' : e?.message || e}`);
    (required ? hard : soft).push(`${name}: ${e?.message || e}`);
    return {pass:false};
  } finally { clearTimeout(timer); }
}

console.log(`SENTINEL Cloudflare smoke test: ${base}\n`);
await get('/api/health','Cloudflare health', d => d?.ok && String(d?.platform).includes('Cloudflare'));
await get('/api/data?action=geocode&q=Taipei%20101','Geocode', d => Array.isArray(d?.items) ? d.items.length > 0 : !!(d?.lat || d?.results?.length));
await get('/api/data?action=weather&lat=25.0330&lon=121.5654','Weather', d => !!d && !d.error);
await get('/api/data?action=route&from=121.5654,25.0330&to=121.5170,25.0478','Routing', d => !!d && !d.error);
await get('/api/data?action=cctv&lat=25.0330&lon=121.5654&radius=8&fast=1&limit=24','Nearby CCTV registry', d => Array.isArray(d?.items) && d.items.length > 0);
await get('/api/data?action=flow&lat=25.0330&lon=121.5654&radius=25','Traffic flow', d => !!d && !d.error, false);
await get('/api/data?action=traffic&lat=25.0330&lon=121.5654&radius=25','Traffic incidents', d => !!d && !d.error, false);
await get('/api/data?action=air-quality&lat=25.0330&lon=121.5654&radius=60','Air quality', d => !!d && !d.error, false);
await get('/api/data?action=earthquakes&lat=25.0330&lon=121.5654&radius=600','Earthquakes', d => !!d && !d.error, false);
await get('/api/data?action=flights&lat=25.0330&lon=121.5654&radius=120','Flights', d => !!d && !d.error, false);

// Exercise the inline CCTV path with one returned camera. This is required only if the registry supplied an id.
const cams = await get('/api/data?action=cctv&lat=25.0330&lon=121.5654&radius=15&fast=1&limit=12','CCTV playback candidates', d => Array.isArray(d?.items), false);
const ids = (cams.data?.items || []).map(x => x?.id).filter(Boolean).slice(0,4);
if (ids.length) {
  let played = false;
  for (const id of ids) {
    const r = await get(`/api/cctv-feed?id=${encodeURIComponent(id)}&probe=1`,`CCTV probe ${id}`, d => ['hls','mjpeg','image','video'].includes(d?.kind), false, 12000);
    if (r.pass) { played = true; break; }
  }
  if (!played) soft.push('CCTV: no playable candidate among first 4 at test point; registry still responded');
}

console.log('\nSummary');
console.log(`Required failures: ${hard.length}`);
console.log(`Optional/upstream warnings: ${soft.length}`);
if (soft.length) soft.forEach(x => console.log(`  - ${x}`));
if (hard.length) {
  hard.forEach(x => console.error(`  - ${x}`));
  process.exit(1);
}
console.log('SMOKE PASSED: core Cloudflare routes and key public integrations are responding.');
