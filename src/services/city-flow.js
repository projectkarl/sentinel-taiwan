const { json, fetchText, distanceKm, tag, xmlBlocks } = require('./_utils');

const STATIC_URL = 'https://tcgbusfs.blob.core.windows.net/blobtisv/VD.xml';
const LIVE_URL = 'https://tcgbusfs.blob.core.windows.net/blobtisv/GetVDDATA.xml';

function parseStatic(xml) {
  const map = new Map();
  for (const block of xmlBlocks(xml, 'VD')) {
    const id = tag(block, 'VDID');
    const lat = Number(tag(block, 'PositionLat'));
    const lon = Number(tag(block, 'PositionLon'));
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    map.set(id, {
      id,
      lat,
      lon,
      road: tag(block, 'RoadName') || tag(block, 'RoadID') || '臺北市道路',
      direction: tag(block, 'RoadDirection') || tag(block, 'Bearing'),
      laneNum: Number(tag(block, 'LaneNum')) || null,
      district: tag(block, 'TownName') || tag(block, 'LocationType'),
    });
  }
  return map;
}

function parseLane(block) {
  const vehicles = xmlBlocks(block, 'Vehicle');
  const speeds = vehicles.map((v) => Number(tag(v, 'Speed'))).filter(Number.isFinite);
  const volumes = vehicles.map((v) => Number(tag(v, 'Volume'))).filter(Number.isFinite);
  let speed = Number(tag(block, 'Speed'));
  if (!Number.isFinite(speed) && speeds.length) speed = speeds.reduce((a,b)=>a+b,0)/speeds.length;
  let volume = Number(tag(block, 'Volume'));
  if (!Number.isFinite(volume) && volumes.length) volume = volumes.reduce((a,b)=>a+b,0);
  const occupancy = Number(tag(block, 'Occupancy'));
  return {
    laneId: tag(block, 'LaneID'),
    speed: Number.isFinite(speed) ? speed : null,
    volume: Number.isFinite(volume) ? volume : null,
    occupancy: Number.isFinite(occupancy) ? occupancy : null,
  };
}

function parseLive(xml) {
  const out = new Map();
  for (const block of xmlBlocks(xml, 'VDLive')) {
    const id = tag(block, 'VDID');
    if (!id) continue;
    const lanes = xmlBlocks(block, 'Lane').map(parseLane);
    const fallback = lanes.length ? lanes : [parseLane(block)];
    const usable = fallback.filter((x) => x.speed != null || x.volume != null || x.occupancy != null);
    const speeds = usable.map((x)=>x.speed).filter(Number.isFinite);
    const volumes = usable.map((x)=>x.volume).filter(Number.isFinite);
    const occs = usable.map((x)=>x.occupancy).filter(Number.isFinite);
    out.set(id, {
      id,
      collectTime: tag(block, 'DataCollectTime') || tag(xml, 'UpdateTime'),
      avgSpeed: speeds.length ? speeds.reduce((a,b)=>a+b,0)/speeds.length : null,
      volume: volumes.length ? volumes.reduce((a,b)=>a+b,0) : null,
      occupancy: occs.length ? occs.reduce((a,b)=>a+b,0)/occs.length : null,
      lanes: usable,
    });
  }
  return out;
}

function statusFor(speed) {
  if (!Number.isFinite(speed)) return 'unknown';
  if (speed < 20) return 'congested';
  if (speed < 35) return 'slow';
  if (speed < 50) return 'moderate';
  return 'clear';
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(25, Math.max(1, Number(req.query.radius || 5)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });
  try {
    const settled = await Promise.allSettled([
      fetchText(STATIC_URL, {}, 16000),
      fetchText(LIVE_URL, {}, 16000),
    ]);
    if (settled[0].status !== 'fulfilled' || settled[1].status !== 'fulfilled') throw new Error('Taipei VD upstream unavailable');
    const meta = parseStatic(settled[0].value);
    const live = parseLive(settled[1].value);
    const items = [];
    for (const [id, dynamic] of live) {
      const m = meta.get(id);
      if (!m) continue;
      const distance = distanceKm(lat, lon, m.lat, m.lon);
      if (distance > radius) continue;
      items.push({
        ...m,
        ...dynamic,
        distance,
        status: statusFor(dynamic.avgSpeed),
        source: '臺北市交通管制工程處 VD',
      });
    }
    items.sort((a,b) => a.distance-b.distance);
    return json(res, 200, {
      zeroKey: true,
      source: 'Taipei City VD.xml + GetVDDATA.xml',
      items: items.slice(0, 80),
      note: '臺北市公開車輛偵測器資料；速度為鄰近偵測器量測，不等同每一個路口或每一條車道即時速度。',
    }, 's-maxage=60, stale-while-revalidate=120');
  } catch (e) {
    return json(res, 502, { error: `臺北市道路流速資料暫時無法取得：${e.message}` }, 'no-store');
  }
};
