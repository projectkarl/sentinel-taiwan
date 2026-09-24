const { json, fetchJson, distanceKm } = require('./_utils');

const DESC = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json';
const AVAIL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json';

function recordsOf(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  for (const k of ['data','Data','records','Records','park','parking','ParkingAvailabilities','ParkingLots']) {
    if (Array.isArray(v[k])) return v[k];
  }
  for (const val of Object.values(v)) {
    const r = recordsOf(val); if (r.length) return r;
  }
  return [];
}

function twd97ToWgs84(x, y) {
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const a = 6378137.0, b = 6356752.314245;
  const lng0 = 121 * Math.PI / 180, k0 = 0.9999, dx = 250000;
  const dy = 0; x -= dx; y -= dy;
  const e = Math.pow(1 - Math.pow(b, 2) / Math.pow(a, 2), 0.5);
  const e2 = Math.pow(e, 2) / (1 - Math.pow(e, 2));
  const M = y / k0;
  const mu = M / (a * (1 - Math.pow(e,2)/4 - 3*Math.pow(e,4)/64 - 5*Math.pow(e,6)/256));
  const e1 = (1 - Math.pow(1 - Math.pow(e,2), 0.5)) / (1 + Math.pow(1 - Math.pow(e,2), 0.5));
  const j1 = 3*e1/2 - 27*Math.pow(e1,3)/32;
  const j2 = 21*Math.pow(e1,2)/16 - 55*Math.pow(e1,4)/32;
  const j3 = 151*Math.pow(e1,3)/96;
  const j4 = 1097*Math.pow(e1,4)/512;
  const fp = mu + j1*Math.sin(2*mu) + j2*Math.sin(4*mu) + j3*Math.sin(6*mu) + j4*Math.sin(8*mu);
  const c1 = e2*Math.pow(Math.cos(fp),2), t1 = Math.pow(Math.tan(fp),2);
  const r1 = a*(1-Math.pow(e,2))/Math.pow(1-Math.pow(e,2)*Math.pow(Math.sin(fp),2),1.5);
  const n1 = a/Math.pow(1-Math.pow(e,2)*Math.pow(Math.sin(fp),2),0.5);
  const d = x/(n1*k0);
  const lat = fp - (n1*Math.tan(fp)/r1)*(Math.pow(d,2)/2-(5+3*t1+10*c1-4*Math.pow(c1,2)-9*e2)*Math.pow(d,4)/24+(61+90*t1+298*c1+45*Math.pow(t1,2)-252*e2-3*Math.pow(c1,2))*Math.pow(d,6)/720);
  const lon = lng0 + (d-(1+2*t1+c1)*Math.pow(d,3)/6+(5-2*c1+28*t1-3*Math.pow(c1,2)+8*e2+24*Math.pow(t1,2))*Math.pow(d,5)/120)/Math.cos(fp);
  return { lat: lat*180/Math.PI, lon: lon*180/Math.PI };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function coords(x) {
  for (const [a,b] of [['Ycod','Xcod'],['lat','lon'],['Latitude','Longitude'],['latitude','longitude']]) {
    const lat = num(x[a]), lon = num(x[b]);
    if (lat != null && lon != null && lat >= 20 && lat <= 27 && lon >= 118 && lon <= 123.5) return { lat, lon };
  }
  const raw = x.EntranceCoord || x.entranceCoord || '';
  const nums = String(raw).match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (nums.length >= 2) {
    const [a,b] = nums;
    if (a >= 118 && a <= 123.5 && b >= 20 && b <= 27) return { lat:b, lon:a };
    if (b >= 118 && b <= 123.5 && a >= 20 && a <= 27) return { lat:a, lon:b };
  }
  const twx = num(x.tw97x || x.Tw97x || x.X), twy = num(x.tw97y || x.Tw97y || x.Y);
  if (twx != null && twy != null && twx > 100000 && twy > 2000000) return twd97ToWgs84(twx, twy);
  return null;
}
function idOf(x) { return String(x.id ?? x.ID ?? x.parkId ?? x.ParkingLotID ?? x.parkingId ?? '').trim(); }
function availableOf(x) {
  for (const k of ['availablecar','availableCar','AvailableCar','available','AvailableSpaces','Availability','car']) {
    const v = num(x[k]); if (v != null) return v;
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  const radius = Math.min(20, Math.max(1, Number(req.query.radius || 5)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });
  const likelyTaipei = lat > 24.93 && lat < 25.22 && lon > 121.42 && lon < 121.68;
  if (!likelyTaipei) return json(res, 200, { zeroKey:true, source:'臺北市停車場公開資料', coverage:'Taipei City', items:[], message:'目前即時剩餘車位 Zero-Key 來源先提供臺北市；其他縣市仍顯示既有交通情報。' }, 's-maxage=1800');
  try {
    const [desc, avail] = await Promise.all([fetchJson(DESC, {}, 12000), fetchJson(AVAIL, {}, 12000)]);
    const availability = new Map(recordsOf(avail).map((x) => [idOf(x), availableOf(x)]));
    const items = recordsOf(desc).map((x) => {
      const p = coords(x); if (!p) return null;
      const id = idOf(x);
      const total = num(x.totalcar ?? x.TotalCar ?? x.totalCar ?? x.TotalSpaces);
      const available = availability.has(id) ? availability.get(id) : null;
      return {
        id, name: x.name || x.Name || x.parkingName || '停車場', address: x.address || x.Address || '',
        total, available, lat:p.lat, lon:p.lon, distance:distanceKm(lat, lon, p.lat, p.lon),
        fare: x.payex || x.FareInfo || '',
      };
    }).filter(Boolean).filter((x) => x.distance <= radius).sort((a,b) => a.distance-b.distance).slice(0,12);
    return json(res, 200, { zeroKey:true, source:'臺北市停車場資訊V2 + 剩餘停車位數V2', coverage:'Taipei City', generatedAt:new Date().toISOString(), cadenceMinutes:5, items }, 's-maxage=120, stale-while-revalidate=600');
  } catch (e) { return json(res, 502, { error:`停車情報暫時無法取得：${e.message}` }, 'no-store'); }
};
