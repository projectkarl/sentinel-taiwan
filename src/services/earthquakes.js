const { json, fetchJson, distanceKm } = require('./_utils');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(600, Math.max(50, Number(req.query.radius || 280)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });
  try {
    const d = await fetchJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', {}, 10000);
    const rows = Array.isArray(d?.features) ? d.features : [];
    const items = rows.map((f) => {
      const c = f?.geometry?.coordinates || [];
      return {
        id: String(f.id || ''), lat: Number(c[1]), lon: Number(c[0]), depth: Number(c[2]),
        mag: Number(f?.properties?.mag), place: String(f?.properties?.place || 'Earthquake'),
        time: Number(f?.properties?.time || 0), alert: f?.properties?.alert || '', source: 'USGS',
      };
    }).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon))
      .map((x) => ({ ...x, distance: distanceKm(lat, lon, x.lat, x.lon) }))
      .filter((x) => x.distance <= radius)
      .sort((a,b) => b.time-a.time)
      .slice(0, 120);
    return json(res, 200, { zeroKey: true, source: 'USGS GeoJSON real-time feed', items }, 's-maxage=60, stale-while-revalidate=180');
  } catch (e) {
    return json(res, 502, { error: `地震公開訊號暫時無法取得：${e.message}` }, 'no-store');
  }
};
