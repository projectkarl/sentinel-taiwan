const { json, fetchJson } = require('./_utils');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });
  const fallback = {
    name: '地圖選取位置',
    displayName: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    lat, lon,
    provider: 'coordinate fallback',
  };
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1&accept-language=zh-TW`;
    const d = await fetchJson(url, { headers: { 'User-Agent': 'SENTINEL-TAIWAN/1.0 (zero-key public map client)' } }, 6500);
    const a = d.address || {};
    const city = a.city || a.town || a.county || a.state || '';
    const district = a.city_district || a.district || a.suburb || a.village || a.neighbourhood || '';
    const road = a.road || a.pedestrian || a.footway || a.path || '';
    const house = a.house_number || '';
    const name = d.name || [road, house].filter(Boolean).join(' ') || district || city || fallback.name;
    return json(res, 200, {
      zeroKey: true,
      source: 'OpenStreetMap Nominatim reverse geocoding',
      place: {
        name,
        displayName: d.display_name || [city, district, road, house].filter(Boolean).join(' ') || fallback.displayName,
        address: [city, district, road, house].filter(Boolean).join(' ') || d.display_name || fallback.address,
        lat: Number(d.lat) || lat,
        lon: Number(d.lon) || lon,
        city,
        district,
        provider: 'Nominatim reverse',
      },
    }, 's-maxage=300, stale-while-revalidate=3600');
  } catch (e) {
    return json(res, 200, {
      zeroKey: true,
      source: 'coordinate fallback',
      degraded: true,
      message: '地址反查暫時不可用，仍可使用座標載入附近資料與 CCTV。',
      place: fallback,
    }, 'no-store');
  }
};
