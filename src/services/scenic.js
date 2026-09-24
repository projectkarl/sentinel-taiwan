const { json } = require('./_utils');
const { loadScenicForQuery, shouldSearchScenic } = require('./scenic-cctv');

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
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!q || !Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error:'q/lat/lon required' });
  if (!shouldSearchScenic(q)) return json(res, 200, { items:[], skipped:true }, 's-maxage=1800');
  try {
    const items = await deadline(loadScenicForQuery(q, lat, lon, 5), 4800, []);
    return json(res, 200, { items, source:'official-original-scenic' }, 's-maxage=900, stale-while-revalidate=3600');
  } catch (e) {
    return json(res, 200, { items:[], degraded:true, message:String(e.message || e) }, 'no-store');
  }
};
