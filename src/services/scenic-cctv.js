const crypto = require('node:crypto');
const { fetchText } = require('./_utils');

const QUERY_CACHE_MS = 30 * 60 * 1000;
const CAMERA_CACHE_MS = 6 * 60 * 60 * 1000;
const queryCache = new Map();
const cameraCache = new Map();

const REFERENCE_ORIGIN = 'https://monitor1.wfuapp.com';

const VERIFIED_SCENIC = [
  {
    keys:['大溪老街'], name:'大溪老街', region:'桃園市',
    streamUrl:'https://www.youtube.com/embed/XUWjAsajKXg?autoplay=1&mute=1&playsinline=1',
    source:'桃園市政府觀光旅遊局官方即時影像',
    note:'原始公開來源：桃園觀光導覽網所使用的官方 YouTube 即時影像。',
  },
  {
    keys:['石門水庫'], name:'石門水庫', region:'桃園市',
    streamUrl:'https://www.youtube.com/embed/GUCaVR88ZFU?autoplay=1&mute=1&playsinline=1',
    source:'桃園市政府觀光旅遊局官方即時影像',
    note:'原始公開來源：桃園觀光導覽網所使用的官方 YouTube 即時影像。',
  },
  {
    keys:['小烏來天空步道','小烏來'], name:'小烏來天空步道', region:'桃園市',
    streamUrl:'https://www.youtube.com/embed/neaiCec1kec?autoplay=1&mute=1&playsinline=1',
    source:'桃園市政府觀光旅遊局官方即時影像',
    note:'原始公開來源：桃園觀光導覽網所使用的官方 YouTube 即時影像。',
  },
];

function decodeHtml(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html = '') {
  return decodeHtml(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
}

function normalizeQuery(value = '') {
  return String(value || '').toLowerCase().replace(/臺/g,'台')
    .replace(/(?:即時影像|監視器|攝影機|cctv|附近|景點)/gi,' ')
    .replace(/[\s\-_.·・／\/()（）【】\[\]]+/g,'').trim();
}

function canonicalYoutube(url = '') {
  const raw = decodeHtml(url).trim();
  let id = '';
  const patterns = [
    /youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i,
    /youtube\.com\/watch\?[^"'\s>]*v=([A-Za-z0-9_-]{6,})/i,
    /youtu\.be\/([A-Za-z0-9_-]{6,})/i,
  ];
  for (const re of patterns) { const m = raw.match(re); if (m) { id = m[1]; break; } }
  return id ? `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1` : '';
}

function isReferenceHost(url = '') {
  try { return /(^|\.)monitor1\.wfuapp\.com$/i.test(new URL(url).hostname); } catch (_) { return false; }
}

function isOriginalCandidate(url = '') {
  try {
    const u = new URL(decodeHtml(url));
    if (!['http:','https:'].includes(u.protocol) || isReferenceHost(u.toString())) return false;
    if (/blogger\.googleusercontent\.com$/i.test(u.hostname)) return false;
    return true;
  } catch (_) { return false; }
}

function extractArticleLinks(html = '') {
  const out = [], seen = new Set();
  const raw = String(html || '');
  const patterns = [
    /href=["'](https?:\/\/monitor1\.wfuapp\.com\/(?:20\d{2}\/\d{2}\/[^"'#?]+\.html|20\d{2}\/\d{2}\/\d+\.html))["']/gi,
    /href=["'](\/(?:20\d{2}\/\d{2}\/[^"'#?]+\.html|20\d{2}\/\d{2}\/\d+\.html))["']/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(raw))) {
      let url = '';
      try { url = new URL(decodeHtml(m[1]), REFERENCE_ORIGIN).toString(); } catch (_) { continue; }
      if (!isReferenceHost(url) || seen.has(url)) continue;
      seen.add(url); out.push(url);
    }
  }
  return out;
}

function extractOriginalStream(html = '', baseUrl = '') {
  const raw = String(html || '');
  const candidates = [];
  const attr = /(?:src|href|data-src|data-url|data-stream)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(raw))) candidates.push(decodeHtml(m[1]));
  const rawUrls = /(https?:\/\/[^"'\s<>\\]+)/gi;
  while ((m = rawUrls.exec(raw))) candidates.push(decodeHtml(m[1]));

  let best = null;
  for (const value of candidates) {
    let abs = '';
    try { abs = new URL(value, baseUrl || REFERENCE_ORIGIN).toString(); } catch (_) { continue; }
    if (!isOriginalCandidate(abs)) continue;
    const yt = canonicalYoutube(abs);
    let score = 0, streamUrl = abs, kind = 'wrapper';
    if (yt) { score = 160; streamUrl = yt; kind = 'youtube'; }
    else if (/hls\.bote\.gov\.taipei/i.test(abs)) score = 155;
    else if (/\.m3u8(?:\?|$)/i.test(abs)) { score = 150; kind = 'hls'; }
    else if (/\.(?:mjpg|mjpeg)(?:\?|$)/i.test(abs)) { score = 140; kind = 'mjpeg'; }
    else if (/\.(?:mp4|webm)(?:\?|$)/i.test(abs)) { score = 130; kind = 'video'; }
    else if (/\.(?:jpg|jpeg)(?:\?|$)/i.test(abs)) { score = 115; kind = 'image'; }
    else if (/(?:atis\.ntpc\.gov\.tw\/ATIS\/ShowFrame4CCTV|live-camera|即時|live|camera|cctv)/i.test(abs)) score = 100;
    if (/(?:facebook|line\.me|wikipedia|taiwan\.net\.tw|wfublog|blogger|doubleclick|googleusercontent)/i.test(abs)) score -= 120;
    if (!best || score > best.score) best = { streamUrl, kind, score };
  }
  return best && best.score > 40 ? best : null;
}

function isDirectMediaUrl(url = '') {
  const raw = String(url || '');
  return Boolean(canonicalYoutube(raw)) || /\.m3u8(?:\?|$)|\.(?:mjpg|mjpeg|mp4|webm|jpg|jpeg|png|webp)(?:\?|$)/i.test(raw);
}

async function deepenOriginalSource(media, headers) {
  if (!media?.streamUrl || isDirectMediaUrl(media.streamUrl) || isReferenceHost(media.streamUrl)) return media;
  let url;
  try { url = new URL(media.streamUrl); } catch (_) { return media; }
  if (!['http:','https:'].includes(url.protocol)) return media;
  try {
    const html = await fetchText(url.toString(), { headers }, 3200);
    const nested = extractOriginalStream(html, url.toString());
    if (nested?.streamUrl && !isReferenceHost(nested.streamUrl) && nested.streamUrl !== media.streamUrl) {
      return { ...nested, upstreamPage: url.toString() };
    }
  } catch (_) {}
  return media;
}

function articleTitle(html = '') {
  const h = String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return h ? htmlToText(h[1]).replace(/\s*[|｜].*$/,'').replace(/即時影像.*$/,'').trim() : '';
}

function articleSourceName(html = '', streamUrl = '') {
  const text = htmlToText(html);
  const m = text.match(/即時影像來源\s*[:：]\s*([^\n]{2,80})/);
  if (m) return m[1].replace(/官方網站連結.*$/,'').trim();
  try { return new URL(streamUrl).hostname; } catch (_) { return '原始公開即時影像'; }
}

function scenicId(streamUrl, name) {
  return 'scenic:' + crypto.createHash('sha1').update(`${streamUrl}|${name}`).digest('hex').slice(0,16);
}

function cameraRecord({ name, streamUrl, source, note, referenceUrl, lat, lon, region = '' }) {
  const id = scenicId(streamUrl, name);
  const cam = {
    id, streamUrl, lat:Number(lat), lon:Number(lon), road:name, name,
    direction:'', start:'', end:'', mile:'', status:'',
    source, region, access:'live', scenic:true, originalSource:true,
    referenceUrl: referenceUrl || '',
    note: note || '景點即時影像；參考頁僅用於辨識原始公開來源，播放器直接連原始來源。',
  };
  cameraCache.set(id, { camera:cam, expiresAt:Date.now() + CAMERA_CACHE_MS });
  return cam;
}

function verifiedScenic(query, lat, lon) {
  const q = normalizeQuery(query);
  if (!q) return [];
  return VERIFIED_SCENIC.filter((item) => item.keys.some((key) => {
    const k = normalizeQuery(key); return q === k || q.includes(k) || k.includes(q);
  })).map((item) => cameraRecord({ ...item, lat, lon }));
}


function shouldSearchScenic(query = '') {
  const raw = String(query || '').trim();
  if (raw.length < 2) return false;
  if (/(?:國道|高速公路|交流道|匝道|捷運|銀行|總行|分行|公司|醫院|學校|地址)/i.test(raw)) return false;
  if (/\d+\s*號/.test(raw)) return false;
  if (/(?:路|街|大道|橋).*(?:與|和|口|交叉)/.test(raw)) return false;
  return true;
}

function scenicTitleMatches(query = '', title = '') {
  const q = normalizeQuery(query), t = normalizeQuery(title);
  if (!q || !t) return false;
  if (/(?:留言板|留言|討論|站務|聯絡我們|關於本站|使用說明|隱私|標籤|分類|搜尋結果)/i.test(title)) return false;
  if (q === t) return true;
  if (t.includes(q) || q.includes(t)) {
    const ratio = Math.min(q.length, t.length) / Math.max(q.length, t.length);
    return ratio >= .42 || Math.min(q.length, t.length) >= 4;
  }
  return false;
}

async function fetchReferenceScenic(query, lat, lon, maxItems = 4) {
  const url = `${REFERENCE_ORIGIN}/search?q=${encodeURIComponent(query)}`;
  const headers = { Accept:'text/html,application/xhtml+xml', 'Accept-Language':'zh-TW,zh;q=0.9', 'User-Agent':'Mozilla/5.0 (compatible; SENTINEL-Taiwan/1.0; source-resolution-only)' };
  let searchHtml = '';
  try { searchHtml = await fetchText(url, { headers }, 3600); } catch (_) { return []; }
  const links = extractArticleLinks(searchHtml).slice(0, Math.max(2, Math.min(8, maxItems * 2)));
  if (!links.length) return [];
  const settled = await Promise.allSettled(links.map(async (referenceUrl) => {
    const html = await fetchText(referenceUrl, { headers }, 3600);
    const name = articleTitle(html) || '';
    if (!scenicTitleMatches(query, name)) return null;
    let media = extractOriginalStream(html, referenceUrl);
    if (!media?.streamUrl || isReferenceHost(media.streamUrl)) return null;
    media = await deepenOriginalSource(media, headers);
    if (!media?.streamUrl || isReferenceHost(media.streamUrl) || !isDirectMediaUrl(media.streamUrl)) return null;
    const source = articleSourceName(html, media.upstreamPage || media.streamUrl);
    const note = media.upstreamPage
      ? `參考目錄僅用於辨識來源；已再解析官方頁 ${new URL(media.upstreamPage).hostname} 並直接使用其原始媒體。`
      : '參考目錄僅用於辨識來源；播放器直接使用其背後原始公開來源。';
    return cameraRecord({ name, streamUrl:media.streamUrl, source, note, referenceUrl, lat, lon });
  }));
  return settled.filter((x) => x.status === 'fulfilled' && x.value).map((x) => x.value).slice(0,maxItems);
}

async function loadScenicForQuery(query, lat, lon, maxItems = 4) {
  const q = String(query || '').trim();
  if (!q || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return [];
  const key = `${normalizeQuery(q)}@${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  const cached = queryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.items.map((x)=>({ ...x }));
  const verified = verifiedScenic(q, Number(lat), Number(lon));
  const dynamic = verified.length >= maxItems || !shouldSearchScenic(q) ? [] : await fetchReferenceScenic(q, Number(lat), Number(lon), Math.max(1,maxItems-verified.length));
  const seen = new Set(), items = [...verified, ...dynamic].filter((cam) => {
    const k = cam.streamUrl; if (!k || seen.has(k)) return false; seen.add(k); return true;
  }).slice(0,maxItems);
  queryCache.set(key, { items, expiresAt:Date.now() + QUERY_CACHE_MS });
  return items.map((x)=>({ ...x }));
}

function resolveScenicCamera(id) {
  const cached = cameraCache.get(String(id || ''));
  if (!cached || cached.expiresAt <= Date.now()) throw new Error('Scenic CCTV not found in active cache');
  return cached.camera;
}

module.exports = {
  VERIFIED_SCENIC,
  normalizeQuery,
  canonicalYoutube,
  extractArticleLinks,
  extractOriginalStream,
  shouldSearchScenic,
  scenicTitleMatches,
  loadScenicForQuery,
  resolveScenicCamera,
};
