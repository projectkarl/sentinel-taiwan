const { json, fetchText, distanceKm, tag, xmlBlocks } = require('./_utils');

const BASE = 'https://tisvcloud.freeway.gov.tw/history/motc20';

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
      road: tag(block, 'RoadName') || tag(block, 'RoadID'),
      direction: tag(block, 'RoadDirection') || tag(block, 'Bearing'),
      laneNum: Number(tag(block, 'LaneNum')) || null,
      locationType: tag(block, 'LocationType'),
      detectionType: tag(block, 'DetectionType'),
    });
  }
  return map;
}

function parseLane(block) {
  const laneIdRaw = tag(block, 'LaneID');
  const laneId = Number.isFinite(Number(laneIdRaw)) ? Number(laneIdRaw) : laneIdRaw;
  const speedValues = xmlBlocks(block, 'Vehicle').map((v) => Number(tag(v, 'Speed'))).filter(Number.isFinite);
  let speed = Number(tag(block, 'Speed'));
  if (!Number.isFinite(speed) && speedValues.length) speed = speedValues.reduce((a,b)=>a+b,0)/speedValues.length;
  const volumes = xmlBlocks(block, 'Vehicle').map((v) => Number(tag(v, 'Volume'))).filter(Number.isFinite);
  let volume = Number(tag(block, 'Volume'));
  if (!Number.isFinite(volume) && volumes.length) volume = volumes.reduce((a,b)=>a+b,0);
  const occupancy = Number(tag(block, 'Occupancy'));
  return {
    laneId,
    laneType: tag(block, 'LaneType'),
    speed: Number.isFinite(speed) ? speed : null,
    occupancy: Number.isFinite(occupancy) ? occupancy : null,
    volume: Number.isFinite(volume) ? volume : null,
  };
}

function parseLive(xml) {
  const out = new Map();
  for (const block of xmlBlocks(xml, 'VDLive')) {
    const id = tag(block, 'VDID');
    if (!id) continue;
    let lanes = xmlBlocks(block, 'Lane').map(parseLane).filter((x) => x.laneId !== '' && x.laneId != null);
    if (!lanes.length) {
      const fallback = parseLane(block);
      if (fallback.speed != null || fallback.occupancy != null || fallback.volume != null) lanes = [fallback];
    }
    out.set(id, { id, lanes, collectTime: tag(block, 'DataCollectTime') });
  }
  return out;
}

function laneScore(lane) {
  const speed = Number.isFinite(lane.speed) ? lane.speed : 0;
  const occupancy = Number.isFinite(lane.occupancy) ? lane.occupancy : 35;
  const volume = Number.isFinite(lane.volume) ? lane.volume : 0;
  // Higher speed and lower occupancy are positive. Volume has only a small stabilizing contribution.
  return Math.max(0.01, speed * 1.15 + Math.max(0, 45 - occupancy) * 1.25 + Math.min(20, volume * 0.12));
}

function probabilities(lanes) {
  if (!Array.isArray(lanes) || lanes.length < 2) return lanes.map((x) => ({ ...x, probability: null }));
  const usable = lanes.filter((x) => Number.isFinite(x.speed) || Number.isFinite(x.occupancy));
  if (usable.length < 2) return lanes.map((x) => ({ ...x, probability: null }));
  const scores = lanes.map(laneScore);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / 42));
  const sum = exps.reduce((a,b)=>a+b,0) || 1;
  const uniform = 1 / lanes.length;
  return lanes.map((x, i) => {
    const raw = exps[i] / sum;
    const calibrated = raw * 0.72 + uniform * 0.28;
    return { ...x, probability: Math.round(calibrated * 100) };
  });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(40, Math.max(1, Number(req.query.radius || 8)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });

  try {
    const settled = await Promise.allSettled([
      fetchText(`${BASE}/VDLive.xml`, {}, 18000),
      fetchText(`${BASE}/VD.xml`, {}, 18000),
    ]);
    if (settled[0].status !== 'fulfilled') throw settled[0].reason;
    const live = parseLive(settled[0].value);
    const meta = settled[1].status === 'fulfilled' ? parseStatic(settled[1].value) : new Map();
    const items = [];
    for (const [id, dynamic] of live) {
      const m = meta.get(id);
      if (!m) continue;
      const distance = distanceKm(lat, lon, m.lat, m.lon);
      if (distance > radius) continue;
      const lanes = probabilities(dynamic.lanes).sort((a,b) => Number(a.laneId) - Number(b.laneId));
      const speeds = lanes.map((x) => x.speed).filter(Number.isFinite);
      const occupancies = lanes.map((x) => x.occupancy).filter(Number.isFinite);
      items.push({
        ...m,
        distance,
        collectTime: dynamic.collectTime,
        lanes,
        avgSpeed: speeds.length ? Math.round(speeds.reduce((a,b)=>a+b,0)/speeds.length) : null,
        avgOccupancy: occupancies.length ? Math.round(occupancies.reduce((a,b)=>a+b,0)/occupancies.length) : null,
      });
    }
    items.sort((a,b) => a.distance-b.distance);
    return json(res, 200, {
      zeroKey: true,
      source: 'Freeway Bureau VDLive.xml + VD.xml',
      items: items.slice(0, 40),
      note: 'Lane probability is a short-horizon flow indicator derived from current speed/occupancy/volume; it is not a guarantee and must not be used to justify unsafe or prohibited lane changes.',
    }, 's-maxage=60, stale-while-revalidate=120');
  } catch (e) {
    return json(res, 502, { error: `車道級 VD 資料暫時無法取得：${e.message}` }, 'no-store');
  }
};
