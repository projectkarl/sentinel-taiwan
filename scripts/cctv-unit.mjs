import { handleCctvFeed } from '../src/cctv-feed.js';

const originalFetch = globalThis.fetch;
const calls = [];
const wrapper = `<!doctype html><html><script>player.loadSource('https://media.example.com/live/cam/master.m3u8')</script></html>`;
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=512000\nlevel.m3u8\n';
const level = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg001.ts\n';

globalThis.fetch = async (input, init={}) => {
  const url = String(input);
  calls.push({url, headers:init.headers || {}});
  if (url === 'https://www.twipcam.com/cam/test-public-cam') {
    return new Response(wrapper, {status:200, headers:{'content-type':'text/html; charset=utf-8','set-cookie':'sid=abc; Path=/; Secure'}});
  }
  if (url === 'https://media.example.com/live/cam/master.m3u8') {
    return new Response(master, {status:200, headers:{'content-type':'application/vnd.apple.mpegurl'}});
  }
  if (url === 'https://media.example.com/live/cam/level.m3u8') {
    return new Response(level, {status:200, headers:{'content-type':'application/vnd.apple.mpegurl'}});
  }
  if (url === 'https://media.example.com/live/cam/seg001.ts') {
    return new Response(new Uint8Array([0x47,0x40,0x00,0x10]), {status:200, headers:{'content-type':'video/mp2t'}});
  }
  throw new Error(`unexpected fetch ${url}`);
};

let fail = 0;
function assert(cond, msg) { if (!cond) { fail++; console.error('✗', msg); } else console.log('✓', msg); }
try {
  const id = 'twipcam:test-public-cam';
  const probe = await handleCctvFeed(new Request(`https://sentinel.invalid/api/cctv-feed?id=${encodeURIComponent(id)}&probe=1`));
  const pd = await probe.json();
  assert(probe.ok && pd.kind === 'hls' && pd.cloudflareNative === true, 'wrapper discovery resolves to HLS');

  const p1 = await handleCctvFeed(new Request(`https://sentinel.invalid/api/cctv-feed?id=${encodeURIComponent(id)}`));
  const t1 = await p1.text();
  const nestedMatch = t1.match(/resource=([^\n]+)/);
  assert(p1.ok && t1.includes('/api/cctv-feed?') && t1.includes('level.m3u8'), 'master playlist is rewritten through same-origin proxy');

  const nestedUrl = new URL('https://sentinel.invalid' + t1.split('\n').find(x => x.startsWith('/api/cctv-feed?')));
  const p2 = await handleCctvFeed(new Request(nestedUrl));
  const t2 = await p2.text();
  assert(p2.ok && t2.includes('seg001.ts') && t2.includes('/api/cctv-feed?'), 'child playlist segments are rewritten');

  const segPath = t2.split('\n').find(x => x.startsWith('/api/cctv-feed?'));
  const seg = await handleCctvFeed(new Request('https://sentinel.invalid' + segPath, {headers:{range:'bytes=0-3'}}));
  const bytes = new Uint8Array(await seg.arrayBuffer());
  assert(seg.ok && bytes[0] === 0x47, 'media segment streams through Worker');

  const wrapperCall = calls.find(x => x.url.includes('twipcam.com/cam/'));
  const mediaCall = calls.find(x => x.url.endsWith('master.m3u8'));
  assert(!!wrapperCall && !!mediaCall, 'wrapper and media were both requested');
  assert(String(mediaCall?.headers?.Cookie || '').includes('sid=abc'), 'wrapper cookie is forwarded to media request');
  assert(String(mediaCall?.headers?.Referer || '').includes('twipcam.com/cam/'), 'wrapper referer is forwarded to media request');

  const rejected = await handleCctvFeed(new Request(`https://sentinel.invalid/api/cctv-feed?id=${encodeURIComponent(id)}&resource=${encodeURIComponent('https://evil.example.net/x.ts')}`));
  assert(rejected.status === 403, 'cross-host HLS resource is rejected');
} finally {
  globalThis.fetch = originalFetch;
}
if (fail) process.exit(1);
console.log(`\nCCTV UNIT PASSED: ${calls.length} mocked upstream request(s).`);
