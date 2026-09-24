import registryModule from './services/cctv-registry.js';
import { fetchTimeout, json, safePublicHttpUrl, withSecurity } from './lib/http.js';

const { resolveCamera } = registryModule;
const mediaCache = new Map();
const CACHE_MS = 20 * 60 * 1000;
const MAX_HTML = 1_500_000;
const MAX_PLAYLIST = 2_000_000;

function decodeHtml(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\\\//g, '/');
}

function mediaKind(contentType = '', url = '') {
  const type = String(contentType).toLowerCase();
  const target = String(url).toLowerCase();
  if (/mpegurl|m3u8/.test(type) || /\.m3u8(?:\?|$)/.test(target)) return 'hls';
  if (/multipart\/x-mixed-replace/.test(type) || /\.(?:mjpg|mjpeg)(?:\?|$)/.test(target)) return 'mjpeg';
  if (/^image\//.test(type) || /\.(?:jpg|jpeg|png|webp|avif)(?:\?|$)/.test(target)) return 'image';
  if (/^video\//.test(type) || /\.(?:mp4|webm|mov)(?:\?|$)/.test(target)) return 'video';
  if (/text\/html|application\/xhtml/.test(type)) return 'html';
  return 'unknown';
}

function sniffKind(bytes) {
  if (!bytes?.length) return 'unknown';
  const head = bytes.subarray(0, Math.min(1024, bytes.length));
  const text = new TextDecoder().decode(head);
  if (/^#EXTM3U/m.test(text)) return 'hls';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (head.length > 12 && new TextDecoder().decode(head.subarray(4, 8)) === 'ftyp') return 'video';
  if (/^\s*</.test(text) && /<(?:!doctype|html|head|body|script|video|img)\b/i.test(text)) return 'html';
  return 'unknown';
}

function getCookieHeader(headers) {
  let values = [];
  try { if (typeof headers.getSetCookie === 'function') values = headers.getSetCookie(); } catch (_) {}
  if (!values.length) {
    const raw = headers.get('set-cookie');
    if (raw) values = [raw];
  }
  return values.map((x) => String(x).split(';')[0].trim()).filter(Boolean).join('; ');
}

function mergeCookie(a = '', b = '') {
  const map = new Map();
  for (const chunk of `${a};${b}`.split(';')) {
    const part = chunk.trim();
    if (!part || !part.includes('=')) continue;
    const idx = part.indexOf('=');
    map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function candidateScore(url) {
  const s = String(url || '');
  let score = 0;
  if (/\.m3u8(?:\?|$)/i.test(s)) score += 180;
  else if (/\.(?:mp4|webm)(?:\?|$)/i.test(s)) score += 150;
  else if (/\.(?:mjpg|mjpeg)(?:\?|$)/i.test(s)) score += 140;
  else if (/\.(?:jpg|jpeg)(?:\?|$)/i.test(s)) score += 100;
  else if (/\.png(?:\?|$)/i.test(s)) score += 35;
  if (/(?:cctv|camera|cam|stream|snapshot|live|traffic|video|image|showframe|hls)/i.test(s)) score += 55;
  if (/(?:logo|icon|favicon|avatar|banner|ads?|sprite|brand|analytics|pixel)/i.test(s)) score -= 180;
  return score;
}

function discoverMediaFromHtml(html, baseUrl) {
  const raw = decodeHtml(String(html || ''));
  const candidates = [];
  const push = (value) => { if (value) candidates.push(String(value).trim()); };
  const attrRe = /(?:src|href|data-src|data-url|data-stream|data-video|data-image|poster)\s*=\s*["']([^"']+)["']/ig;
  let m;
  while ((m = attrRe.exec(raw))) push(m[1]);
  const jsRes = [
    /(?:loadSource|setSource|play)\s*\(\s*["']([^"']+)["']/ig,
    /(?:file|url|src|streamUrl|stream_url|videoUrl|imageUrl|snapshot)\s*[:=]\s*["']([^"']+)["']/ig,
    /(https?:\/\/[^"'\s<>\\]+(?:\.m3u8|\.mp4|\.webm|\.mjpg|\.mjpeg|\.jpg|\.jpeg|\.png)(?:\?[^"'\s<>\\]*)?)/ig,
  ];
  for (const re of jsRes) while ((m = re.exec(raw))) push(m[1]);

  const base = new URL(baseUrl);
  const scored = [];
  const seen = new Set();
  for (const value of candidates) {
    try {
      const cleaned = decodeHtml(value).replace(/^['"]|['"]$/g, '');
      const abs = safePublicHttpUrl(new URL(cleaned, base).toString());
      if (seen.has(abs.toString())) continue;
      seen.add(abs.toString());
      const score = candidateScore(abs.toString());
      if (score > 0) scored.push({ url: abs, score });
    } catch (_) {}
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.url || null;
}

async function readPrefix(response, maxBytes = 65536) {
  const reader = response.body?.getReader?.();
  if (!reader) return new Uint8Array();
  try {
    const { value } = await reader.read();
    return value ? value.subarray(0, Math.min(maxBytes, value.length)) : new Uint8Array();
  } finally {
    try { await reader.cancel(); } catch (_) {}
  }
}

async function resolveMediaTarget(camera) {
  const cacheKey = String(camera.id || camera.streamUrl || '');
  const cached = mediaCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached;
  if (!camera.streamUrl && camera.imageUrl) camera = { ...camera, streamUrl: camera.imageUrl };
  if (!camera.streamUrl) throw new Error('Camera has no public media endpoint');

  let target = safePublicHttpUrl(camera.streamUrl);
  let referer = camera.pageUrl || '';
  let cookie = '';
  let kind = mediaKind('', target.toString());
  let contentType = '';

  // Direct media URLs do not need a discovery round trip.
  if (kind !== 'unknown' && kind !== 'html') {
    const out = { url: target, kind, contentType, referer, cookie, expiresAt: Date.now() + CACHE_MS };
    mediaCache.set(cacheKey, out);
    return out;
  }

  for (let depth = 0; depth < 3; depth++) {
    const headers = {
      Accept: '*/*',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.6',
      'User-Agent': 'Mozilla/5.0 (compatible; SENTINEL-Taiwan-Cloudflare/2.0; public-cctv-inline)',
    };
    if (referer) headers.Referer = referer;
    if (cookie) headers.Cookie = cookie;

    const response = await fetchTimeout(target.toString(), {
      headers,
      cf: { cacheTtl: 10, cacheEverything: false },
    }, depth === 0 ? 7000 : 6000);
    if (!response.ok) throw new Error(`CCTV upstream HTTP ${response.status}`);

    const finalUrl = safePublicHttpUrl(response.url || target.toString());
    const setCookie = getCookieHeader(response.headers);
    cookie = mergeCookie(cookie, setCookie);
    contentType = response.headers.get('content-type') || '';
    kind = mediaKind(contentType, finalUrl.toString());

    if (kind === 'html') {
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_HTML) throw new Error('CCTV wrapper page too large');
      const html = await response.text();
      const discovered = discoverMediaFromHtml(html, finalUrl.toString());
      if (!discovered) throw new Error('No playable media found in CCTV wrapper');
      referer = finalUrl.toString();
      target = discovered;
      continue;
    }

    if (kind === 'unknown') {
      const prefix = await readPrefix(response);
      kind = sniffKind(prefix);
      if (kind === 'html') throw new Error('CCTV wrapper format could not be resolved');
    } else {
      try { await response.body?.cancel?.(); } catch (_) {}
    }

    target = finalUrl;
    const out = { url: target, kind, contentType, referer, cookie, expiresAt: Date.now() + CACHE_MS };
    mediaCache.set(cacheKey, out);
    return out;
  }
  throw new Error('CCTV wrapper recursion limit reached');
}

function sameHostOrSubdomain(base, candidate) {
  const a = base.hostname.toLowerCase();
  const b = candidate.hostname.toLowerCase();
  return a === b || b.endsWith(`.${a}`) || a.endsWith(`.${b}`);
}

function proxyUrl(id, value) {
  return `/api/cctv-feed?id=${encodeURIComponent(id)}&resource=${encodeURIComponent(value)}`;
}

function rewritePlaylist(text, sourceUrl, id) {
  const base = new URL(sourceUrl);
  return String(text).split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = new URL(uri, base).toString();
        return `URI="${proxyUrl(id, abs)}"`;
      });
    }
    const trimmed = line.trim();
    if (!trimmed) return line;
    try { return proxyUrl(id, new URL(trimmed, base).toString()); } catch (_) { return line; }
  }).join('\n');
}

function forwardedHeaders(request, resolved) {
  const headers = {
    Accept: request.headers.get('accept') || '*/*',
    'Accept-Language': request.headers.get('accept-language') || 'zh-TW,zh;q=0.9,en;q=0.6',
    'User-Agent': 'Mozilla/5.0 (compatible; SENTINEL-Taiwan-Cloudflare/2.0; public-cctv-inline)',
  };
  const range = request.headers.get('range');
  if (range) headers.Range = range;
  if (resolved.referer) headers.Referer = resolved.referer;
  if (resolved.cookie) headers.Cookie = resolved.cookie;
  return headers;
}

export async function handleCctvFeed(request) {
  if (request.method === 'OPTIONS') return withSecurity(new Response(null, { status: 204 }), { 'Access-Control-Allow-Origin': '*' });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405 });
  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id || id.length > 180) return new Response('Missing or invalid CCTV id', { status: 400 });

  try {
    const camera = await resolveCamera(id);
    const resolved = await resolveMediaTarget(camera);
    const base = safePublicHttpUrl(resolved.url.toString());

    if (url.searchParams.get('probe') === '1') {
      return json({ id, kind: resolved.kind, contentType: resolved.contentType, proxied: true, cloudflareNative: true }, 200, { 'Cache-Control': 'no-store' });
    }

    let target = base;
    const resource = url.searchParams.get('resource');
    if (resource) {
      const requested = safePublicHttpUrl(resource);
      if (!sameHostOrSubdomain(base, requested)) return new Response('CCTV resource host rejected', { status: 403 });
      target = requested;
    }

    const upstream = await fetchTimeout(target.toString(), {
      method: request.method,
      headers: forwardedHeaders(request, resolved),
      cf: { cacheTtlByStatus: { '200-299': 2, '404': 1, '500-599': 0 } },
    }, 12000);
    if (!upstream.ok || (request.method !== 'HEAD' && !upstream.body)) return new Response(`CCTV upstream HTTP ${upstream.status}`, { status: 502 });

    const finalUrl = safePublicHttpUrl(upstream.url || target.toString());
    if (!sameHostOrSubdomain(target, finalUrl)) return new Response('CCTV redirect host rejected', { status: 403 });
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const isPlaylist = /mpegurl|m3u8/i.test(contentType) || /\.m3u8(?:\?|$)/i.test(finalUrl.toString());

    if (isPlaylist && request.method !== 'HEAD') {
      const declared = Number(upstream.headers.get('content-length') || 0);
      if (declared > MAX_PLAYLIST) return new Response('HLS playlist too large', { status: 502 });
      const text = await upstream.text();
      if (text.length > MAX_PLAYLIST) return new Response('HLS playlist too large', { status: 502 });
      return withSecurity(new Response(rewritePlaylist(text, finalUrl.toString(), id), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
          'Access-Control-Allow-Origin': '*',
        },
      }));
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'no-store, max-age=0');
    headers.set('Access-Control-Allow-Origin', '*');
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return withSecurity(new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers }));
  } catch (error) {
    return new Response(`CCTV inline feed unavailable: ${error?.message || String(error)}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...Object.fromEntries(Object.entries({ 'Access-Control-Allow-Origin': '*' })) },
    });
  }
}
