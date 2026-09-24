const { json, fetchJson } = require('./_utils');
const labels = { 0:'晴朗',1:'大致晴朗',2:'局部多雲',3:'陰天',45:'有霧',48:'霧凇',51:'細雨',53:'細雨',55:'較強細雨',61:'小雨',63:'中雨',65:'大雨',66:'凍雨',67:'強凍雨',71:'小雪',73:'中雪',75:'大雪',80:'陣雨',81:'陣雨',82:'強陣雨',85:'陣雪',86:'強陣雪',95:'雷雨',96:'雷雨伴冰雹',99:'強雷雨伴冰雹' };
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });
  try {
    const gridLat = Math.round(lat * 100) / 100;
    const gridLon = Math.round(lon * 100) / 100;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${gridLat}&longitude=${gridLon}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m&timezone=Asia%2FTaipei&forecast_days=2`;
    const d = await fetchJson(url);
    const nowIso = d.current?.time;
    let rain = 0;
    if (nowIso && Array.isArray(d.hourly?.time)) {
      const idx = d.hourly.time.findIndex((t) => t === nowIso.slice(0,13)+':00');
      rain = idx >= 0 ? Number(d.hourly.precipitation_probability?.[idx] || 0) : 0;
    }
    return json(res, 200, {
      source: 'Open-Meteo', lat: gridLat, lon: gridLon, zeroKey: true,
      current: {
        temperature: Number(d.current?.temperature_2m),
        apparentTemperature: Number(d.current?.apparent_temperature),
        precipitation: Number(d.current?.precipitation),
        precipitationProbability: rain,
        windSpeed: Number(d.current?.wind_speed_10m),
        weatherCode: d.current?.weather_code,
        summary: labels[d.current?.weather_code] || '即時天氣',
        time: d.current?.time,
      },
      hourly: (d.hourly?.time || []).slice(0, 36).map((time, i) => ({
        time,
        temperature: Number(d.hourly?.temperature_2m?.[i]),
        precipitation: Number(d.hourly?.precipitation?.[i]),
        precipitationProbability: Number(d.hourly?.precipitation_probability?.[i] || 0),
        windSpeed: Number(d.hourly?.wind_speed_10m?.[i]),
        weatherCode: Number(d.hourly?.weather_code?.[i]),
        summary: labels[d.hourly?.weather_code?.[i]] || '天氣預報',
      }))
    }, 's-maxage=300, stale-while-revalidate=900');
  } catch (e) { return json(res, 502, { error: `天氣來源暫時無法使用：${e.message}` }, 'no-store'); }
};
