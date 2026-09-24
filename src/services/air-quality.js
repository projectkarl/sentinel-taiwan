const { json, fetchJson, distanceKm } = require('./_utils');

const AQI_URL = 'https://data.moenv.gov.tw/api/v2/aqx_p_432?api_key=af57253c-e838-46da-a1f5-12b43afd75f3&format=JSON&limit=1000&sort=ImportDate+desc';

function statusRank(aqi) {
  const v = Number(aqi);
  if (!Number.isFinite(v)) return 'unknown';
  if (v <= 50) return 'good';
  if (v <= 100) return 'moderate';
  if (v <= 150) return 'sensitive';
  if (v <= 200) return 'unhealthy';
  if (v <= 300) return 'very-unhealthy';
  return 'hazardous';
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  const radius = Math.min(160, Math.max(10, Number(req.query.radius || 60)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });
  try {
    const d = await fetchJson(AQI_URL, {}, 12000);
    const rows = Array.isArray(d) ? d : (d.records || d.data || []);
    const items = (Array.isArray(rows) ? rows : []).map((x) => {
      const pLat = Number(x.latitude), pLon = Number(x.longitude);
      return {
        id: String(x.siteid || x.sitename || ''),
        site: x.sitename || '', county: x.county || '',
        aqi: Number(x.aqi), status: x.status || '', pollutant: x.pollutant || '',
        pm25: Number(x['pm2.5']), pm10: Number(x.pm10), o3: Number(x.o3),
        windSpeed: Number(x.wind_speed), windDirection: Number(x.wind_direc),
        publishedAt: x.publishtime || '', lat: pLat, lon: pLon,
        distance: Number.isFinite(pLat) && Number.isFinite(pLon) ? distanceKm(lat, lon, pLat, pLon) : Infinity,
      };
    }).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon) && x.distance <= radius)
      .sort((a,b) => a.distance - b.distance).slice(0, 12);
    const nearest = items[0] || null;
    return json(res, 200, {
      zeroKey: true,
      source: '環境部空氣品質指標(AQI)公開資料',
      generatedAt: new Date().toISOString(),
      cadenceMinutes: 60,
      nearest: nearest ? { ...nearest, level: statusRank(nearest.aqi) } : null,
      items: items.map((x) => ({ ...x, level: statusRank(x.aqi) })),
    }, 's-maxage=900, stale-while-revalidate=3600');
  } catch (e) {
    return json(res, 502, { error: `官方 AQI 暫時無法取得：${e.message}` }, 'no-store');
  }
};
