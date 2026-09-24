const { json, fetchJson, distanceKm } = require('./_utils');

const CACHE_MS = 30 * 60 * 1000;
const cache = new Map();

function angularDifference(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 180;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function normalizeRows(payload) {
  const candidates = [
    payload?.result?.data,
    payload?.result,
    payload?.data,
  ];
  for (const value of candidates) if (Array.isArray(value)) return value;
  return [];
}

function imageUrl(row = {}) {
  return row.fileurlProc || row.fileurl || row.fileurlLTh || row.fileurlTh || row.imageUrl || row.url || '';
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat), lon = Number(req.query.lon), heading = Number(req.query.heading);
  const radius = Math.min(350, Math.max(40, Number(req.query.radius || 180)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error:'Invalid coordinates' });

  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${Number.isFinite(heading) ? Math.round(heading/20)*20 : 'x'},${radius}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return json(res, 200, cached.value, 's-maxage=900, stale-while-revalidate=3600');

  try {
    const url = `https://api.openstreetcam.org/2.0/photo/?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&radius=${Math.round(radius)}&zoomLevel=18&join=sequence&orderBy=id&orderDirection=desc`;
    const payload = await fetchJson(url, { headers:{ Accept:'application/json', 'User-Agent':'SENTINEL-Taiwan/1.0 public-turn-visual' } }, 5200);
    const rows = normalizeRows(payload).map((row) => {
      const y = Number(row.lat ?? row.matchLat), x = Number(row.lng ?? row.matchLng);
      const h = Number(row.heading ?? row.projectionYaw);
      const src = imageUrl(row);
      if (!src || !Number.isFinite(y) || !Number.isFinite(x)) return null;
      const distance = distanceKm(lat, lon, y, x);
      const headingDiff = Number.isFinite(heading) && Number.isFinite(h) ? angularDifference(heading, h) : 90;
      const score = distance * 1000 + Math.min(180, headingDiff) * 1.8;
      return {
        id:String(row.id || row.photoId || ''), imageUrl:String(src), lat:y, lon:x,
        heading:Number.isFinite(h) ? h : null,
        capturedAt:row.shotDate || row.dateAdded || row.dateProcessed || '',
        sequenceId:String(row.sequenceId || row.sequence?.id || ''),
        distance, headingDiff, score,
      };
    }).filter(Boolean).filter((x) => x.distance <= radius / 1000 * 1.35).sort((a,b)=>a.score-b.score);

    const best = rows[0] || null;
    const value = {
      zeroKey:true,
      source:'KartaView public street-level imagery',
      live:false,
      historical:true,
      item:best,
      message:best ? undefined : '此轉彎位置附近目前沒有 KartaView 公開街景影像。',
    };
    cache.set(key, { value, expiresAt:Date.now()+CACHE_MS });
    return json(res, 200, value, 's-maxage=900, stale-while-revalidate=3600');
  } catch (err) {
    return json(res, 200, {
      zeroKey:true, source:'KartaView temporarily unavailable', live:false, historical:true, item:null,
      message:'轉彎街景影像暫時無法取得；導航方向與道路名稱仍正常運作。',
    }, 'no-store');
  }
};
