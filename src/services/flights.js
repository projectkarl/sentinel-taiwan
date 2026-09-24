const { json, fetchJson, distanceKm } = require('./_utils');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(250, Math.max(20, Number(req.query.radius || 120)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });
  try {
    const d = await fetchJson(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${Math.round(radius)}`, {}, 12000);
    const rows = Array.isArray(d?.ac) ? d.ac : [];
    const items = rows.map((x, i) => ({
      id: String(x.hex || x.r || `ac-${i}`),
      callsign: String(x.flight || x.callsign || x.r || 'AIR CONTACT').trim(),
      lat: Number(x.lat), lon: Number(x.lon),
      altitude: Number(x.alt_baro ?? x.alt_geom),
      groundSpeed: Number(x.gs),
      heading: Number(x.track),
      type: String(x.t || ''),
      squawk: String(x.squawk || ''),
      source: 'adsb.lol public ADS-B',
    })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon))
      .map((x) => ({ ...x, distance: distanceKm(lat, lon, x.lat, x.lon) }))
      .filter((x) => x.distance <= radius)
      .sort((a,b) => a.distance-b.distance)
      .slice(0, 180);
    return json(res, 200, { zeroKey: true, source: 'adsb.lol', items }, 's-maxage=15, stale-while-revalidate=45');
  } catch (e) {
    return json(res, 502, { error: `航空公開訊號暫時無法取得：${e.message}` }, 'no-store');
  }
};
