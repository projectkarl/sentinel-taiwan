const { json, fetchJson, fetchText, xmlBlocks, tag } = require('./_utils');

const memoryCache = new Map();
let lastReverseAt = 0;

const CNA_FEEDS = [
  { label: '中央社地方', url: 'https://feeds.feedburner.com/rsscna/local' },
  { label: '中央社社會', url: 'https://feeds.feedburner.com/rsscna/social' },
  { label: '中央社生活', url: 'https://feeds.feedburner.com/rsscna/lifehealth' },
];

const EN_CITY = {
  '台北市': 'Taipei', '新北市': 'New Taipei', '桃園市': 'Taoyuan', '台中市': 'Taichung', '台南市': 'Tainan', '高雄市': 'Kaohsiung',
  '基隆市': 'Keelung', '新竹市': 'Hsinchu', '嘉義市': 'Chiayi', '新竹縣': 'Hsinchu County', '苗栗縣': 'Miaoli', '彰化縣': 'Changhua',
  '南投縣': 'Nantou', '雲林縣': 'Yunlin', '嘉義縣': 'Chiayi County', '屏東縣': 'Pingtung', '宜蘭縣': 'Yilan', '花蓮縣': 'Hualien',
  '台東縣': 'Taitung', '澎湖縣': 'Penghu', '金門縣': 'Kinmen', '連江縣': 'Lienchiang',
};

function norm(v = '') { return String(v).replace(/臺/g, '台').replace(/\s+/g, '').trim(); }
function textNorm(v = '') { return norm(v).toLowerCase(); }
function stripHtml(v = '') { return String(v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(); }
function safeUrl(v = '') { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } }
function parseDate(v) { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; }
function shortKeyword(v = '') {
  const s = norm(v).replace(/(縣|市|區|鄉|鎮|村|里)$/,'');
  return s.length >= 2 ? s : '';
}
function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }

function cacheGet(key) {
  const row = memoryCache.get(key);
  if (!row) return null;
  if (Date.now() - row.time > 12 * 60 * 1000) { memoryCache.delete(key); return null; }
  return row.body;
}
function cacheSet(key, body) {
  if (memoryCache.size > 100) {
    const first = memoryCache.keys().next().value;
    memoryCache.delete(first);
  }
  memoryCache.set(key, { time: Date.now(), body });
}

async function reversePlace(lat, lon) {
  const gridLat = Math.round(lat * 200) / 200;
  const gridLon = Math.round(lon * 200) / 200;
  const key = `rev:${gridLat}:${gridLon}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const wait = Math.max(0, 1050 - (Date.now() - lastReverseAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastReverseAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${gridLat}&lon=${gridLon}&zoom=16&addressdetails=1&accept-language=zh-TW`;
  const d = await fetchJson(url, {}, 10000);
  const a = d.address || {};
  const city = norm(a.city || a.county || a.state || a.municipality || '');
  const district = norm(a.city_district || a.town || a.suburb || a.village || a.quarter || '');
  const label = [district, city].filter(Boolean).join(' · ') || norm(d.display_name || '目前區域');
  const out = { city, district, label, displayName: d.display_name || label };
  cacheSet(key, out);
  return out;
}

function scoreArticle(title, desc, place) {
  const text = textNorm(`${title} ${desc}`);
  const district = textNorm(place.district);
  const city = textNorm(place.city);
  const districtShort = textNorm(shortKeyword(place.district));
  const cityShort = textNorm(shortKeyword(place.city));
  let score = 0;
  let scope = '';
  if (district && text.includes(district)) { score += 7; scope = 'DISTRICT'; }
  else if (districtShort && text.includes(districtShort)) { score += 5; scope = 'DISTRICT'; }
  if (city && text.includes(city)) { score += 4; if (!scope) scope = 'CITY'; }
  else if (cityShort && text.includes(cityShort)) { score += 3; if (!scope) scope = 'CITY'; }
  return { score, scope: scope || 'REGION' };
}

function parseRss(xml, feed, place) {
  return xmlBlocks(xml, 'item').map((block) => {
    const title = stripHtml(tag(block, 'title'));
    const description = stripHtml(tag(block, 'description'));
    const url = safeUrl(tag(block, 'link'));
    const publishedAt = tag(block, 'pubDate') || tag(block, 'date');
    const s = scoreArticle(title, description, place);
    return {
      title, description, url, publishedAt, publishedMs: parseDate(publishedAt), source: feed.label,
      domain: 'cna.com.tw', score: s.score, scope: s.scope, provider: 'CNA RSS',
    };
  }).filter((x) => x.title && x.url && x.score > 0);
}

async function fetchCna(place) {
  const settled = await Promise.allSettled(CNA_FEEDS.map(async (feed) => {
    const xml = await fetchText(feed.url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.2' } }, 9000);
    return parseRss(xml, feed, place);
  }));
  return settled.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
}

async function fetchGdelt(place) {
  const cityEn = EN_CITY[norm(place.city)];
  if (!cityEn) return [];
  const query = `"${cityEn}" sourcecountry:taiwan`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=20&timespan=3d&sort=datedesc&format=json`;
  const d = await fetchJson(url, {}, 10000);
  return (Array.isArray(d.articles) ? d.articles : []).map((a) => ({
    title: stripHtml(a.title),
    description: '',
    url: safeUrl(a.url),
    publishedAt: a.seendate || '',
    publishedMs: parseDate(a.seendate),
    source: a.domain || 'GDELT indexed source',
    domain: a.domain || '',
    score: 2,
    scope: 'CITY',
    provider: 'GDELT',
  })).filter((x) => x.title && x.url);
}

function dedupeAndRank(items) {
  const seen = new Set();
  const now = Date.now();
  return items.filter((x) => {
    const key = textNorm(x.title).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 90) || x.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return !x.publishedMs || now - x.publishedMs < 7 * 24 * 60 * 60 * 1000;
  }).sort((a, b) => (b.score - a.score) || (b.publishedMs - a.publishedMs)).slice(0, 12);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 20 || lat > 27 || lon < 118 || lon > 123.5) {
    return json(res, 400, { error: 'Invalid Taiwan coordinates' });
  }
  const key = `news:${Math.round(lat * 100) / 100}:${Math.round(lon * 100) / 100}`;
  const cached = cacheGet(key);
  if (cached) return json(res, 200, cached, 's-maxage=600, stale-while-revalidate=1800');

  try {
    const place = await reversePlace(lat, lon);
    const [cnaResult, gdeltResult] = await Promise.allSettled([fetchCna(place), fetchGdelt(place)]);
    const cna = cnaResult.status === 'fulfilled' ? cnaResult.value : [];
    const gdelt = gdeltResult.status === 'fulfilled' ? gdeltResult.value : [];
    const items = dedupeAndRank([...cna, ...gdelt]);
    const body = {
      zeroKey: true,
      source: ['中央社 RSS', 'GDELT DOC 2.0'],
      location: place,
      generatedAt: new Date().toISOString(),
      items,
      note: '以行政區與地名關聯篩選；新聞來源通常沒有精確事件座標，因此不代表事件發生於目前位置附近的特定距離內。',
    };
    cacheSet(key, body);
    return json(res, 200, body, 's-maxage=600, stale-while-revalidate=1800');
  } catch (e) {
    return json(res, 502, { error: `附近新聞暫時無法取得：${e.message}` }, 'no-store');
  }
};
