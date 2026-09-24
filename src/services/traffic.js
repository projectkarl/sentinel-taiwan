const { json, fetchJson, distanceKm } = require('./_utils');

let snapshot = { at: 0, items: [] };

function normalizePbs(x) {
  return {
    id: String(x.UID || `pbs-${x.y1}-${x.x1}-${x.happendate}-${x.happentime}`),
    lat: Number(x.y1),
    lon: Number(x.x1),
    title: x.roadtype || '警廣即時路況',
    road: x.road || x.areaNm || '',
    direction: x.direction || '',
    description: x.comment || x.srcdetail || '',
    time: [x.happendate, x.happentime].filter(Boolean).join(' '),
    source: '警察廣播電臺公開資料',
  };
}

function filterNearby(items, lat, lon, radius) {
  return (items || [])
    .map((x) => ({ ...x, distance: distanceKm(lat, lon, x.lat, x.lon) }))
    .filter((x) => x.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 180);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(250, Math.max(10, Number(req.query.radius || 60)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });

  try {
    const d = await fetchJson('https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata', {}, 7500);
    const rows = Array.isArray(d) ? d : (d.data || d.Data || d.result || []);
    const dedup = new Map();
    (Array.isArray(rows) ? rows : [])
      .map(normalizePbs)
      .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon))
      .forEach((x) => dedup.set(x.id, x));

    const all = [...dedup.values()];
    if (all.length) snapshot = { at: Date.now(), items: all };
    const items = filterNearby(all, lat, lon, radius);
    return json(res, 200, {
      zeroKey: true,
      source: 'Police Broadcasting Service open data',
      degraded: false,
      updatedAt: snapshot.at || Date.now(),
      items,
      message: items.length ? undefined : '附近目前沒有警廣事件；國道路速與 CCTV 仍可正常顯示。',
    }, 's-maxage=45, stale-while-revalidate=300');
  } catch (e) {
    const items = filterNearby(snapshot.items, lat, lon, radius);
    return json(res, 200, {
      zeroKey: true,
      source: snapshot.items.length ? 'Police Broadcasting Service cached snapshot' : 'Police Broadcasting Service temporarily unavailable',
      degraded: true,
      stale: snapshot.items.length > 0,
      unavailable: snapshot.items.length === 0,
      updatedAt: snapshot.at || null,
      items,
      message: snapshot.items.length
        ? '警廣事件來源暫時無法更新，顯示最近一次快取；國道路速與 CCTV 可繼續使用。'
        : '警廣事件來源暫時無法更新；國道路速與 CCTV 仍可繼續使用。',
    }, 'no-store');
  }
};
