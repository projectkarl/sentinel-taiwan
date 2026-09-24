const { json, distanceKm, fetchText } = require('./_utils');
const { loadRegistry, searchRegistry, resolveCameraRegion, OFFICIAL_FAST_SEEDS } = require('./cctv-registry');
const { loadScenicForQuery, shouldSearchScenic } = require('./scenic-cctv');


const bridgeCache = new Map();

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

function parsePublicIndexLinks(html = '') {
  const out = [], seen = new Set();
  const re = /<a\b[^>]*href=["'](?:https?:\/\/(?:www\.)?twipcam\.com)?\/?cam\/([^"'?#/]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    let slug = '';
    try { slug = decodeURIComponent(m[1]).trim(); } catch (_) { slug = String(m[1] || '').trim(); }
    if (!slug || seen.has(slug.toLowerCase())) continue;
    seen.add(slug.toLowerCase());
    out.push({ slug, label:htmlToText(m[2]).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

function parsePublicIndexDetail(html = '', slug = '') {
  const raw = String(html || '');
  const text = htmlToText(raw);
  const h1 = raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const name = h1 ? htmlToText(h1[1]).replace(/\s*即時影像\s*$/,'').trim() : '';
  const lonMatch = text.match(/經度\s*[:：]?\s*(1(?:1[89]|2[0-3])(?:\.\d+)?)/);
  const latMatch = text.match(/緯度\s*[:：]?\s*(2[0-6](?:\.\d+)?)/);
  const lon = Number(lonMatch?.[1]), lat = Number(latMatch?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 20.5 || lat > 26.7 || lon < 118 || lon > 123.8) return null;
  const region = text.match(/(臺北市|台北市|新北市|桃園市|臺中市|台中市|臺南市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)/)?.[1] || '';
  return {
    id:`twipcam:${slug}`,
    streamUrl:`https://www.twipcam.com/cam/${encodeURIComponent(slug)}`,
    resolverBridge:true,
    pageUrl:'',
    lat, lon, road:name || slug, name:name || slug,
    direction:'', start:'', end:'', mile:'', status:'',
    source:'公開 CCTV 索引解析橋接', region, access:'live-wrapper', indexed:true,
    originalSource:true, playbackPolicy:'public-wrapper',
    note:'僅以公開索引定位原始公開媒體；SENTINEL 不顯示或跳轉索引頁。',
  };
}

async function loadPublicIndexNearby(lat, lon, maxItems = 14) {
  const key = `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  const cached = bridgeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  const lat6 = Number(lat).toFixed(6), lon6 = Number(lon).toFixed(6);
  const discoveryUrls = [
    `https://www.twipcam.com/widget/v1/query-cam-list-by-coordinate?lat=${lat6}&lon=${lon6}`,
    `https://www.twipcam.com/nearby?lat=${lat6}&lon=${lon6}`,
  ];
  const headers = {
    Accept:'text/html,application/xhtml+xml',
    'Accept-Language':'zh-TW,zh;q=0.9,en;q=0.6',
    'User-Agent':'Mozilla/5.0 (compatible; SENTINEL-Taiwan/1.0.9; public-cctv-discovery)',
    Referer:'https://www.twipcam.com/',
  };
  let links = [];
  for (const url of discoveryUrls) {
    try {
      const html = await fetchText(url, { headers }, 5200);
      links = parsePublicIndexLinks(html);
      if (links.length) break;
    } catch (_) {}
  }
  links = links.slice(0, Math.max(4, Math.min(16, maxItems)));
  const settled = await Promise.allSettled(links.map(async (link) => {
    const url = `https://www.twipcam.com/cam/${encodeURIComponent(link.slug)}`;
    const html = await fetchText(url, { headers }, 5200);
    return parsePublicIndexDetail(html, link.slug);
  }));
  const items = settled.filter((x) => x.status === 'fulfilled' && x.value).map((x) => x.value)
    .map((cam) => ({ ...cam, distance:distanceKm(lat, lon, cam.lat, cam.lon) }))
    .sort((a,b) => a.distance-b.distance);
  bridgeCache.set(key, { items, expiresAt:Date.now() + 12 * 60 * 1000 });
  return items;
}

const TAIPEI_101_PLAYBACK_SEEDS = [
  ['tpe-000277',25.0338,121.5647,'台北市道路 277-信義路五段7號(台北101大樓)'],
  ['tpe-000128',25.0329,121.5655,'台北市道路 128-信義松智東南角'],
  ['tpe-000138',25.0361,121.5652,'台北市道路 138-市府東南(松壽松智)'],
  ['tpe-000284',25.0330,121.5613,'台北市道路 284-信義路-莊敬路口'],
  ['tpe-000075',25.0326,121.5682,'台北市道路 075-信義松仁'],
].map(([slug,lat,lon,name]) => ({
  id:`twipcam:${slug}`, streamUrl:`https://www.twipcam.com/cam/${slug}`, resolverBridge:true,
  lat, lon, name, road:name, direction:'', start:'', end:'', mile:'', status:'',
  source:'公開 CCTV 索引解析橋接', region:'臺北市', access:'live-wrapper', indexed:true, originalSource:true,
  playbackPolicy:'public-wrapper', verifiedFallback:true,
  note:'快速播放種子只作原始媒體解析，不顯示第三方頁面。',
}));

function playbackSeedsNear(lat, lon) {
  if (distanceKm(Number(lat), Number(lon), 25.033968, 121.564468) > 2.6) return [];
  return TAIPEI_101_PLAYBACK_SEEDS.map((cam) => ({ ...cam, distance:distanceKm(Number(lat), Number(lon), cam.lat, cam.lon) }));
}

function mergeCameras(primary = [], extra = []) {
  const map = new Map();
  const keyFor = (cam) => {
    if (cam?.streamUrl) return `stream:${String(cam.streamUrl).replace(/^http:/i,'https:')}`;
    return `${Number(cam.lat).toFixed(4)},${Number(cam.lon).toFixed(4)},${String(cam.road || cam.name || '').replace(/\s+/g,'').slice(0,24)}`;
  };
  for (const cam of [...primary, ...extra]) {
    if (!cam || !Number.isFinite(Number(cam.lat)) || !Number.isFinite(Number(cam.lon))) continue;
    const key = keyFor(cam);
    const prev = map.get(key);
    if (!prev || (cam.scenic && !prev.scenic) || (cam.originalSource && !prev.originalSource)) map.set(key, cam);
  }
  return [...map.values()];
}

function localSourceIds(lat, lon) {
  const y = Number(lat), x = Number(lon);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
  if (y >= 24.96 && y <= 25.20 && x >= 121.43 && x <= 121.69) return ['taipei-position','new-taipei-position','freeway','highway'];
  if (y >= 25.05 && y <= 25.20 && x > 121.64 && x <= 121.86) return ['keelung','new-taipei-position','freeway','highway'];
  if (y >= 24.78 && y <= 25.18 && x >= 120.95 && x <= 121.38) return ['taoyuan-position','new-taipei-position','freeway','highway'];
  if (y >= 23.95 && y <= 24.48 && x >= 120.45 && x <= 121.05) return ['taichung','freeway','highway'];
  if (y >= 22.82 && y <= 23.48 && x >= 119.95 && x <= 120.58) return ['tainan','freeway','highway'];
  if (y >= 23.30 && y <= 23.64 && x >= 120.25 && x <= 120.58) return ['chiayi-city','chiayi-county','freeway','highway'];
  if (y >= 24.60 && y <= 25.45 && x >= 121.30 && x <= 122.15) return ['new-taipei-position','freeway','highway'];
  return ['freeway','highway'];
}



function officialFastSeedsNear(lat, lon, radius = 35) {
  const y=Number(lat), x=Number(lon), r=Math.min(8, Math.max(0.5, Number(radius)||35));
  if (!Number.isFinite(y) || !Number.isFinite(x)) return [];
  return OFFICIAL_FAST_SEEDS
    .map((cam)=>({ ...cam, distance:distanceKm(y,x,cam.lat,cam.lon) }))
    .filter((cam)=>cam.distance <= r)
    .sort((a,b)=>a.distance-b.distance);
}

function deadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const q = String(req.query.q || '').trim();
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
  const radius = Math.min(520, Math.max(0.2, Number(req.query.radius || (q ? 280 : 40))));
  const national = String(req.query.national || '') === '1';
  const fast = String(req.query.fast || '') === '1';
  const limit = Math.min(8000, Math.max(1, Number(req.query.limit || (q ? 240 : national ? 8000 : 620))));
  if (!hasCoords && !q) return json(res, 400, { error: 'Coordinates or q is required' });

  try {
    // : national mode only needs national road cameras; local mode returns partial
    // source results quickly instead of waiting for every municipal endpoint.
    const localIds = hasCoords ? localSourceIds(lat, lon) : null;
    const fastLocalIds = Array.isArray(localIds) ? localIds.filter((id) => !['freeway','highway'].includes(id)) : null;
    const sourceIds = national ? ['freeway','highway'] : (fast && fastLocalIds?.length ? fastLocalIds : localIds);
    const registryLoad = loadRegistry({
      liveOnly:national,
      sourceIds,
      timeoutCap:national ? 4200 : (fast ? 3600 : 9000),
    });
    // A fast nearby lookup must never spend several seconds waiting for a municipal
    // CSV/XML during a cold edge invocation. Return the verified official quick index first;
    // the frontend immediately starts a second, fuller official-registry enrichment.
    const registryPromise = fast && !national
      ? deadline(registryLoad, 1200, { items:[], sourceStatus:[{ id:'fast-timeout', name:'官方 CCTV 即時清單', region:'附近', ok:false, count:0, access:'live', error:'FAST WINDOW EXCEEDED · background enrichment continues' }] })
      : registryLoad;
    // Scenic discovery is intentionally decoupled from the fast nearby-road request.
    const scenicPromise = !fast && hasCoords && q && !national && shouldSearchScenic(q)
      ? deadline(loadScenicForQuery(q, lat, lon, 5), 4600, [])
      : Promise.resolve([]);
    const playbackSeeds = hasCoords && !national ? playbackSeedsNear(lat, lon) : [];
    const bridgePromise = hasCoords && !national && String(req.query.bridge || '1') !== '0'
      ? (playbackSeeds.length ? Promise.resolve(playbackSeeds) : deadline(loadPublicIndexNearby(lat, lon, Math.min(12, limit)), fast ? 2200 : 4200, []))
      : Promise.resolve([]);

    const [registryResult, scenicResult, bridgeResult] = await Promise.all([registryPromise, scenicPromise, bridgePromise]);
    const sourceStatus = Array.isArray(registryResult?.sourceStatus) ? [...registryResult.sourceStatus] : [];
    const quickSeeds = hasCoords && !national ? officialFastSeedsNear(lat, lon, radius) : [];
    const bridgeItems = Array.isArray(bridgeResult) ? bridgeResult : [];
    const registry = mergeCameras(quickSeeds, Array.isArray(registryResult?.items) ? registryResult.items : []);
    if (bridgeItems.length) sourceStatus.unshift({
      id:'public-playback-bridge', name:'公開 CCTV 原始媒體解析', region:'座標附近', ok:true,
      count:bridgeItems.length, access:'resolver-bridge', note:'索引只在後端協助定位公開媒體；前端不顯示或跳轉索引站。'
    });
    if (quickSeeds.length) sourceStatus.unshift({
      id:'taipei-official-fast-index', name:'臺北市交通管制工程處（快速索引）', region:'臺北市', ok:true,
      count:quickSeeds.length, access:'point-index', note:'官方設備快速索引；先顯示點位，只有取得公開媒體端點時才升級為 LIVE。'
    });
    const scenic = Array.isArray(scenicResult) ? scenicResult : [];
    if (q && hasCoords && !national && shouldSearchScenic(q)) {
      sourceStatus.push({
        id:'scenic-original', name:'景點原始公開即時影像', region:'搜尋景點', ok:true,
        count:scenic.length, access:'original-source',
        note:'參考目錄只用於辨識來源；播放器不嵌入參考站。',
      });
    }

    const combined = mergeCameras(mergeCameras(registry, bridgeItems), scenic);
    let items = q ? combined.map((camera) => ({
      ...camera,
      matchScore: camera.scenic ? 1800 : (searchRegistry([camera], q, 1)[0]?.matchScore || 0),
    })) : combined;

    items = items.map((camera) => {
      const corrected = resolveCameraRegion(camera);
      return {
        ...camera,
        region: camera.region && !/^(?:Taiwan|臺灣|全台)/i.test(camera.region) ? camera.region : corrected.region,
        regionResolvedBy: camera.regionResolvedBy || corrected.by,
        regionConfidence: camera.regionConfidence || corrected.confidence,
        name: camera.name || [camera.road, camera.mile].filter(Boolean).join(' · ') || '公開 CCTV',
        ...(hasCoords ? { distance: distanceKm(lat, lon, camera.lat, camera.lon) } : {}),
      };
    });
    if (hasCoords) items = items.filter((camera) => camera.distance <= radius || camera.scenic);
    items.sort((a, b) => {
      if (Boolean(a.scenic) !== Boolean(b.scenic)) return Number(Boolean(b.scenic)) - Number(Boolean(a.scenic));
      if (q && Number(a.matchScore) !== Number(b.matchScore)) return Number(b.matchScore || 0) - Number(a.matchScore || 0);
      if (hasCoords) return Number(a.distance || 0) - Number(b.distance || 0);
      return Number(Boolean(b.streamUrl)) - Number(Boolean(a.streamUrl));
    });
    items = items.slice(0, limit);

    const liveCount = items.filter((x) => x.streamUrl || x.imageUrl || x.scenic).length;
    const scenicCount = items.filter((x) => x.scenic).length;
    const authorizationRequiredCount = items.filter((x) => (x.requiresAuthorization || x.playbackPolicy === 'authorization-required')).length;
    const officialViewerCount = items.filter((x) => x.officialViewerUrl && !x.streamUrl && !x.requiresAuthorization).length;
    const officialEmbedCount = 0;
    const positionOnlyCount = items.filter((x) => !x.streamUrl).length;
    const cacheControl = items.length
      ? (fast ? 's-maxage=120, stale-while-revalidate=900' : 's-maxage=900, stale-while-revalidate=7200')
      : 'no-store';
    return json(res, 200, {
      zeroKey:true,
      query:q || undefined,
      activeSources:sourceStatus.filter((x)=>x.ok).map((x)=>x.name),
      failedSources:sourceStatus.filter((x)=>!x.ok).map((x)=>x.name),
      sourceStatus,
      coverage:{
        sourceCount:sourceStatus.length,
        activeSourceCount:sourceStatus.filter((x)=>x.ok).length,
        registryCount:registry.length,
        liveCount,
        viewableCount:liveCount,
        scenicCount,
        authorizationRequiredCount,
        officialViewerCount,
        positionOnlyCount, officialEmbedCount,
        referencePlaybackCount:items.filter((x)=>x.resolverBridge || x.indexed).length,
        resolverBridgeCount:items.filter((x)=>x.resolverBridge).length,
      },
      items,
      discovery: hasCoords ? {
        provider:'official-original+resolver-bridge+in-app-fallback', referencePlayback:true, resolverBridge:true, fast,
        externalNavigation:false, playback:'sentinel-inline-only'
      } : undefined,
      message: items.length ? undefined : (q
        ? '目前未找到此景點／路口可直接使用的原始公開 CCTV；只保留官方可驗證來源，不嵌入第三方參考站。'
        : '此範圍目前沒有取得 CCTV 點位或可直接播放影像。'),
      note: national
        ? '全台模式使用高速公路局、公路局與已整合地方政府原始公開來源。'
        : '區域模式融合道路 CCTV 與景點官方直播；公開索引僅在後端解析原始媒體，前端不顯示、不跳轉索引頁。',
    }, cacheControl);
  } catch (e) {
    return json(res, 502, { error:`CCTV 資料暫時無法取得：${e.message}` }, 'no-store');
  }
};
