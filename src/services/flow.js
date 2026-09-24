const { json, fetchText, distanceKm, tag, xmlBlocks, parseWktLineString, midpoint, simplifyCoords } = require('./_utils');

const BASE = 'https://tisvcloud.freeway.gov.tw/history/motc20';
let snapshot = { live: new Map(), sections: new Map(), shapes: new Map(), liveAt: 0, metaAt: 0 };

function parseLive(xml) {
  const map = new Map();
  for (const block of xmlBlocks(xml, 'LiveTraffic')) {
    const sectionId = tag(block, 'SectionID');
    if (!sectionId) continue;
    map.set(sectionId, {
      sectionId,
      travelTime: Number(tag(block, 'TravelTime')),
      travelSpeed: Number(tag(block, 'TravelSpeed')),
      congestionLevelId: tag(block, 'CongestionLevelID'),
      congestionLevel: tag(block, 'CongestionLevel'),
      dataCollectTime: tag(block, 'DataCollectTime'),
    });
  }
  return map;
}

function endpointFromBlock(block = '') {
  const latRaw = String(tag(block, 'PositionLat') || tag(block, 'Latitude') || '').trim();
  const lonRaw = String(tag(block, 'PositionLon') || tag(block, 'Longitude') || '').trim();
  if (!latRaw || !lonRaw) return null;
  const lat = Number(latRaw), lon = Number(lonRaw);
  // Never let an empty XML field become Number('') === 0 and masquerade as geometry.
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 20 && lat <= 27 && lon >= 118 && lon <= 123.9 ? [lat, lon] : null;
}

function parseSections(xml) {
  const map = new Map();
  for (const block of xmlBlocks(xml, 'Section')) {
    const sectionId = tag(block, 'SectionID');
    if (!sectionId) continue;
    const startBlock = tag(block, 'SectionStart') || tag(block, 'Start');
    const endBlock = tag(block, 'SectionEnd') || tag(block, 'End');
    const startPoint = endpointFromBlock(startBlock);
    const endPoint = endpointFromBlock(endBlock);
    const geometryFallback = startPoint && endPoint ? [startPoint, endPoint] : [];
    map.set(sectionId, {
      sectionId,
      name: tag(block, 'SectionName'),
      road: tag(block, 'RoadName') || tag(block, 'RoadID'),
      direction: tag(block, 'RoadDirection'),
      start: tag(startBlock, 'LocationName') || tag(startBlock, 'Name') || '',
      end: tag(endBlock, 'LocationName') || tag(endBlock, 'Name') || '',
      speedLimit: Number(tag(block, 'SpeedLimit')),
      geometryFallback,
    });
  }
  return map;
}

function parseShapes(xml) {
  const map = new Map();
  for (const block of xmlBlocks(xml, 'SectionShape')) {
    const sectionId = tag(block, 'SectionID');
    const geometry = parseWktLineString(tag(block, 'Geometry'));
    if (sectionId && geometry.length) map.set(sectionId, geometry);
  }
  return map;
}

function inferStatus(item) {
  const text = String(item.congestionLevel || '').toLowerCase();
  const id = Number(item.congestionLevelId);
  const speed = Number(item.travelSpeed);
  if (/嚴重|壅塞|congest|jam/.test(text) || id >= 4 || (Number.isFinite(speed) && speed < 30)) return 'congested';
  if (/車多|緩慢|heavy|slow/.test(text) || id >= 2 || (Number.isFinite(speed) && speed < 60)) return 'slow';
  return 'normal';
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(260, Math.max(10, Number(req.query.radius || 70)));
  const national = String(req.query.national || '') === '1' || radius >= 180;
  const detail = String(req.query.detail || '') === '1';
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });

  // FAST FLOW: LiveTraffic + Section endpoints are sufficient to draw the
  // nationwide performance network immediately. The much heavier SectionShape feed
  // is optional and must never block the first paint.
  const jobs = [
    fetchText(`${BASE}/LiveTraffic.xml`, {}, 5200),
    fetchText(`${BASE}/Section.xml`, {}, 5600),
  ];
  if (detail) jobs.push(fetchText(`${BASE}/SectionShape.xml`, {}, 7200));
  const settled = await Promise.allSettled(jobs);
  let degraded = false;
  if (settled[0]?.status === 'fulfilled') {
    const live = parseLive(settled[0].value);
    if (live.size) snapshot.live = live;
    if (live.size) snapshot.liveAt = Date.now();
  } else degraded = true;
  if (settled[1]?.status === 'fulfilled') {
    const sections = parseSections(settled[1].value);
    if (sections.size) snapshot.sections = sections;
    if (sections.size) snapshot.metaAt = Date.now();
  } else degraded = true;
  if (detail && settled[2]?.status === 'fulfilled') {
    const shapes = parseShapes(settled[2].value);
    if (shapes.size) snapshot.shapes = shapes;
    if (shapes.size) snapshot.metaAt = Date.now();
  } else if (detail) degraded = true;

  // Some legacy Section.xml variants omit endpoint coordinates. Only in that case
  // fall back to the heavy shape feed; normal first paint never pays this cost.
  const endpointGeometryAvailable = [...snapshot.sections.values()].some((x) => x.geometryFallback?.length >= 2);
  if (!detail && snapshot.sections.size && !endpointGeometryAvailable && !snapshot.shapes.size) {
    try {
      const shapeXml = await fetchText(`${BASE}/SectionShape.xml`, {}, 5200);
      const shapes = parseShapes(shapeXml);
      if (shapes.size) snapshot.shapes = shapes;
    } catch (_) { degraded = true; }
  }

  const live = snapshot.live;
  const sections = snapshot.sections;
  const shapes = snapshot.shapes;
  if (!live.size) {
    return json(res, 200, {
      zeroKey: true,
      source: 'Freeway Bureau LiveTraffic temporarily unavailable',
      degraded: true,
      unavailable: true,
      shapeAvailable: shapes.size > 0,
      metadataAvailable: sections.size > 0,
      avgSpeed: null,
      status: 'unknown',
      items: [],
      message: '國道路速來源暫時無法更新；仍可使用導航、警廣事件與 CCTV。',
    }, 'no-store');
  }

  const items = [];
  for (const [sectionId, dynamic] of live) {
    const meta = sections.get(sectionId) || {};
    const geometry = shapes.get(sectionId) || meta.geometryFallback || [];
    if (!geometry?.length) continue;
    const center = midpoint(geometry);
    if (!center) continue;
    const distance = distanceKm(lat, lon, center.lat, center.lon);
    if (distance > radius) continue;
    const item = {
      ...meta,
      ...dynamic,
      lat: center.lat,
      lon: center.lon,
      distance,
      geometry: simplifyCoords(geometry, 32),
    };
    item.status = inferStatus(item);
    items.push(item);
  }

  items.sort((a, b) => a.distance - b.distance);
  // National mode must not truncate the north/south ends of the freeway network.
  const visible = items.slice(0, national ? 1200 : 280);
  const speeds = visible.map((x) => x.travelSpeed).filter(Number.isFinite).filter((x) => x >= 0);
  const avgSpeed = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null;
  const worst = visible.some((x) => x.status === 'congested') ? 'congested' : visible.some((x) => x.status === 'slow') ? 'slow' : visible.length ? 'normal' : 'unknown';

  const roadMap = new Map();
  for (const item of visible) {
    const road = String(item.road || item.name || '國道').replace(/\s+/g,' ').trim();
    if (!roadMap.has(road)) roadMap.set(road, { road, count:0, critical:0, slow:0, speeds:[] });
    const stat = roadMap.get(road); stat.count += 1;
    if (item.status === 'congested' || Number(item.travelSpeed) < 30) stat.critical += 1;
    else if (item.status === 'slow' || Number(item.travelSpeed) < 60) stat.slow += 1;
    if (Number.isFinite(Number(item.travelSpeed))) stat.speeds.push(Number(item.travelSpeed));
  }
  const roadStats = [...roadMap.values()].map((x) => ({
    road:x.road, count:x.count, critical:x.critical, slow:x.slow,
    avgSpeed:x.speeds.length ? Math.round(x.speeds.reduce((a,b)=>a+b,0)/x.speeds.length) : null,
  })).sort((a,b) => b.critical-a.critical || b.slow-a.slow || b.count-a.count).slice(0,12);

  return json(res, 200, {
    zeroKey: true,
    source: degraded ? 'Freeway Bureau cached/live blended snapshot' : 'Freeway Bureau LiveTraffic.xml + Section.xml fast geometry',
    degraded,
    stale: degraded,
    national,
    updatedAt: snapshot.liveAt || null,
    shapeAvailable: detail && shapes.size > 0,
    shapeFallbackAvailable: [...sections.values()].some((x) => x.geometryFallback?.length >= 2),
    geometryMode: detail && shapes.size ? 'shape' : 'section-endpoints',
    metadataAvailable: sections.size > 0,
    avgSpeed,
    status: worst,
    totalMatched: items.length,
    roadStats,
    items: visible,
    message: visible.length ? (degraded ? '部分國道資料使用最近快取。' : undefined) : '此範圍目前沒有可定位的國道路段流速資料。',
  }, degraded ? 'no-store' : 's-maxage=45, stale-while-revalidate=300');
};
