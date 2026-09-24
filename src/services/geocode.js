const { json, fetchJson } = require('./_utils');

const memoryCache = new Map();
let lastNominatimAt = 0;

// Small verified landmark layer for common Taiwan shorthand that public geocoders
// frequently misunderstand. This is intentionally tiny: it fixes high-confidence
// aliases while the general search still comes from open providers.
const VERIFIED_PLACES = [
  {
    keys: ['華南總行','華南銀行總行','華南商銀總行','華南商業銀行總行','華南銀行總部','華南商業銀行總部'],
    name: '華南商業銀行總行',
    address: '臺北市信義區松仁路123號',
    lat: 25.0343,
    lon: 121.5692,
    type: 'bank',
    category: 'office',
  },
  {
    keys: ['台北101','101','信義101','台北一零一'],
    name: '台北 101',
    address: '臺北市信義區信義路五段7號',
    lat: 25.033968,
    lon: 121.564468,
    type: 'landmark',
    category: 'tourism',
  },
  {
    keys: ['台北車站','北車'],
    name: '台北車站',
    address: '臺北市中正區北平西路3號',
    lat: 25.0478,
    lon: 121.5170,
    type: 'station',
    category: 'railway',
  },
];

function cleanCache() {
  const now = Date.now();
  for (const [key, value] of memoryCache) if (now - value.time > 24 * 60 * 60 * 1000) memoryCache.delete(key);
}

function unique(list = []) {
  return [...new Set(list.map((x) => String(x || '').trim().replace(/\s+/g, ' ')).filter(Boolean))];
}

function normText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/臺/g, '台')
    .replace(/[\s\-_.·・／/()（）【】\[\],，、]/g, '')
    .replace(/股份有限公司|有限公司/g, '')
    .trim();
}

function verifiedMatches(raw = '') {
  const key = normText(raw);
  if (!key) return [];
  const out = [];
  for (const place of VERIFIED_PLACES) {
    const keys = place.keys.map(normText);
    let score = 0;
    for (const k of keys) {
      if (key === k) score = Math.max(score, 1000);
      else if (k.startsWith(key) || key.startsWith(k)) score = Math.max(score, 930);
      else if (k.includes(key) || key.includes(k)) score = Math.max(score, 860);
    }
    if (score) out.push({ ...place, provider: 'SENTINEL verified landmark', verified: true, textScore: score });
  }
  return out.sort((a,b) => b.textScore - a.textScore);
}

function queryCandidates(raw = '') {
  const q = String(raw || '').trim().replace(/\s+/g, ' ');
  const noNoise = q.replace(/(?:附近|這附近|目前|位置|地點)$/g, '').trim();
  const intersection = noNoise
    .replace(/(?:交叉口|路口)/g, ' ')
    .replace(/\s*(?:與|和|及|&|＆|\+|＋)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const metroCore = noNoise
    .replace(/^捷運\s*/,'')
    .replace(/捷運站$/,'')
    .replace(/站$/,'')
    .trim();
  const station = /捷運/.test(noNoise) || /站$/.test(noNoise) ? `${metroCore}站` : '';
  const metroStation = station ? `捷運${station}` : '';
  const roadPair = /(?:路口|交叉口|(?:路|街|大道|巷|道).*(?:與|和|及|&|＆|\+|＋).*(?:路|街|大道|巷|道))/.test(noNoise);
  const metroLike = Boolean(station);

  const corporate = [];
  if (/(?:總行|總部|總公司)$/.test(noNoise)) {
    const core = noNoise.replace(/(?:總行|總部|總公司)$/,'').trim();
    if (core) {
      corporate.push(`${core} 總行`, `${core} 總部`, `${core} 總公司`);
      if (/銀行|商銀|金控|金融/.test(core)) corporate.push(`${core} 台北 總行`);
      else corporate.push(`${core} 銀行 總行`, `${core} 公司 總部`);
    }
  }
  // Common shorthand: 華南總行 -> 華南銀行總行, 國泰總部 -> 國泰公司總部, etc.
  if (/總行$/.test(noNoise) && !/銀行|商銀/.test(noNoise)) {
    corporate.push(noNoise.replace(/總行$/, '銀行總行'));
  }

  const addressish = [];
  if (/(?:市|縣|區|鄉|鎮|路|街|大道|巷|號)/.test(noNoise)) {
    addressish.push(`${noNoise} 台灣`);
  }

  const early = [q, noNoise, ...corporate];
  if (metroLike) early.push(station, metroStation);
  if (roadPair) early.push(intersection);
  early.push(q.replace(/臺/g, '台'), q.replace(/台/g, '臺'));
  if (!roadPair) early.push(intersection);
  early.push(...addressish);
  return unique(early).slice(0, 10);
}

function inTaiwan(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 21.7 && lat <= 25.7 && lon >= 119.0 && lon <= 122.3;
}

function textScore(query, row) {
  const q = normText(query);
  const name = normText(row.name || '');
  if (!q || !name) return 0;
  if (name === q) return 500;
  if (name.startsWith(q)) return 420;
  if (name.includes(q)) return 360;
  if (q.includes(name) && name.length >= 3) return 300;
  const pieces = String(query).replace(/臺/g,'台').split(/[\s,，、/]+/).map(normText).filter((x) => x.length >= 2);
  return pieces.reduce((sum, piece) => sum + (name.includes(piece) ? 75 : 0), 0);
}

function haversineApproxKm(aLat, aLon, bLat, bLon) {
  return Math.hypot((aLat-bLat)*111, (aLon-bLon)*101);
}

function rankResults(results, query, biasLat, biasLon, hasBias) {
  const clean = results.filter((x) => inTaiwan(Number(x.lat), Number(x.lon)));
  return clean.map((x) => {
    const d = hasBias ? haversineApproxKm(Number(x.lat), Number(x.lon), biasLat, biasLon) : null;
    const score = Number(x.textScore || 0)
      + textScore(query, x)
      + (x.verified ? 900 : 0)
      + Math.min(80, Number(x.importance || 0) * 80)
      + (hasBias ? Math.max(0, 80 - Math.min(80, d * 2.2)) : 0);
    return { ...x, ...(hasBias ? { biasDistance: d } : {}), rankScore: Math.round(score) };
  }).sort((a,b) => Number(b.rankScore) - Number(a.rankScore) || Number(a.biasDistance || 9999) - Number(b.biasDistance || 9999));
}

function dedupeResults(rows = []) {
  const out = [];
  for (const row of rows) {
    const same = out.find((x) => {
      const sameName = normText(x.name) === normText(row.name);
      const near = haversineApproxKm(Number(x.lat), Number(x.lon), Number(row.lat), Number(row.lon)) < 0.08;
      return near && (sameName || normText(x.name).includes(normText(row.name)) || normText(row.name).includes(normText(x.name)));
    });
    if (!same) out.push(row);
    else if (Number(row.rankScore || 0) > Number(same.rankScore || 0)) Object.assign(same, row);
  }
  return out;
}

async function searchNominatim(q, hasBias, biasLat, biasLon) {
  const wait = Math.max(0, 1050 - (Date.now() - lastNominatimAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimAt = Date.now();
  const viewbox = hasBias ? `&viewbox=${(biasLon-0.9).toFixed(4)},${(biasLat+0.7).toFixed(4)},${(biasLon+0.9).toFixed(4)},${(biasLat-0.7).toFixed(4)}` : '';
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&namedetails=1&extratags=1&countrycodes=tw&limit=10&accept-language=zh-TW${viewbox}&q=${encodeURIComponent(q)}`;
  const rows = await fetchJson(url, {}, 7500);
  return (Array.isArray(rows) ? rows : []).map((x) => ({
    name: x.namedetails?.['name:zh'] || x.namedetails?.name || x.display_name,
    displayName: x.display_name,
    address: [x.address?.city || x.address?.county, x.address?.suburb || x.address?.district, x.address?.road, x.address?.house_number].filter(Boolean).join(''),
    lat: Number(x.lat),
    lon: Number(x.lon),
    type: x.type,
    category: x.category,
    importance: Number(x.importance || 0),
    provider: 'Nominatim',
  }));
}

async function searchPhoton(q) {
  const url = `https://photon.komoot.io/api/?limit=10&lang=zh&q=${encodeURIComponent(`${q} Taiwan`)}`;
  const data = await fetchJson(url, {}, 6000);
  return (Array.isArray(data?.features) ? data.features : []).map((f) => {
    const p = f?.properties || {};
    const coords = f?.geometry?.coordinates || [];
    const label = [p.name, p.street, p.district, p.city, p.county, p.state].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(', ');
    return {
      name: p.name || label || q,
      displayName: label || p.name || q,
      address: [p.city || p.county, p.district, p.street, p.housenumber].filter(Boolean).join(''),
      lat: Number(coords[1]),
      lon: Number(coords[0]),
      type: p.type || p.osm_value || '',
      category: p.osm_key || 'place',
      importance: Number(p.extent ? 0.45 : 0.25),
      provider: 'Photon',
    };
  });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const q = String(req.query.q || '').trim().replace(/\s+/g, ' ');
  if (!q) return json(res, 400, { error: 'Missing q' });
  if (q.length > 120) return json(res, 400, { error: 'Query too long' });

  const biasLat = Number(req.query.lat);
  const biasLon = Number(req.query.lon);
  const hasBias = Number.isFinite(biasLat) && Number.isFinite(biasLon);
  const key = `${q.toLowerCase()}|${hasBias ? `${biasLat.toFixed(2)},${biasLon.toFixed(2)}` : 'nobias'}`;
  cleanCache();
  const cached = memoryCache.get(key);
  if (cached) return json(res, 200, cached.body, 's-maxage=86400, stale-while-revalidate=604800');

  const candidates = queryCandidates(q);
  const known = verifiedMatches(q);
  let results = [...known];
  const tried = [];
  const warnings = [];

  // Query open providers even when a verified shorthand exists, so the response
  // remains useful for suggestions and nearby similarly named POIs.
  try {
    tried.push(`Nominatim:${candidates[0]}`);
    const primary = await searchNominatim(candidates[0], hasBias, biasLat, biasLon);
    results.push(...primary);
  } catch (e) { warnings.push(`Nominatim primary: ${e.message}`); }

  // Photon is intentionally used for at most two normalized candidates to avoid
  // turning each keystroke into a burst against a public service.
  const photonCandidates = unique([candidates[0], candidates.find((x) => x !== candidates[0] && /(?:銀行|總行|總部|捷運|站|台灣)/.test(x))]).filter(Boolean).slice(0,2);
  for (const candidate of photonCandidates) {
    try {
      tried.push(`Photon:${candidate}`);
      results.push(...await searchPhoton(candidate));
    } catch (e) { warnings.push(`Photon ${candidate}: ${e.message}`); }
  }

  // One normalized Nominatim retry when the first query did not produce a strong
  // name match. Respect the public endpoint by keeping it serial and rate-limited.
  const rankedPre = rankResults(results, q, biasLat, biasLon, hasBias);
  const strong = rankedPre.some((x) => Number(x.rankScore) >= 500);
  if (!strong) {
    const retry = candidates.find((candidate, i) => i > 0 && candidate !== candidates[0]);
    if (retry) {
      try {
        tried.push(`Nominatim:${retry}`);
        results.push(...await searchNominatim(retry, hasBias, biasLat, biasLon));
      } catch (e) { warnings.push(`Nominatim retry: ${e.message}`); }
    }
  }

  results = dedupeResults(rankResults(results, q, biasLat, biasLon, hasBias)).slice(0, 10);

  if (!results.length) {
    return json(res, 200, {
      zeroKey: true,
      source: 'OpenStreetMap Nominatim + Photon',
      query: q,
      normalizedQueries: candidates,
      results: [],
      tried,
      warnings,
      hint: '可嘗試加入縣市、區域、完整地址或較正式的店家／機構名稱。',
    }, 's-maxage=600, stale-while-revalidate=3600');
  }

  const providers = [...new Set(results.map((x) => x.provider).filter(Boolean))];
  const body = {
    zeroKey: true,
    source: providers.join(' + '),
    query: q,
    normalizedQueries: candidates,
    results,
    tried,
    ...(warnings.length ? { warnings } : {}),
  };
  memoryCache.set(key, { time: Date.now(), body });
  return json(res, 200, body, 's-maxage=86400, stale-while-revalidate=604800');
};
