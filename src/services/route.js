const { json, fetchJson, distanceKm } = require('./_utils');

function parsePair(v) {
  const p = String(v || '').split(',').map(Number);
  return p.length === 2 && p.every(Number.isFinite) ? p : null;
}

function compactStep(step = {}) {
  const m = step.maneuver || {};
  return {
    distance: Number(step.distance || 0),
    duration: Number(step.duration || 0),
    name: String(step.name || ''),
    ref: String(step.ref || ''),
    destinations: String(step.destinations || ''),
    drivingSide: String(step.driving_side || ''),
    maneuver: {
      location: Array.isArray(m.location) ? m.location.slice(0, 2).map(Number) : null,
      type: String(m.type || ''),
      modifier: String(m.modifier || ''),
      bearingBefore: Number.isFinite(Number(m.bearing_before)) ? Number(m.bearing_before) : null,
      bearingAfter: Number.isFinite(Number(m.bearing_after)) ? Number(m.bearing_after) : null,
      exit: Number.isFinite(Number(m.exit)) ? Number(m.exit) : null,
    },
  };
}

function decodePolyline6(str = '') {
  let index = 0, lat = 0, lon = 0;
  const coords = [];
  while (index < str.length) {
    let shift = 0, result = 0, byte;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= str.length);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1); lat += dlat;
    shift = 0; result = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= str.length);
    const dlon = (result & 1) ? ~(result >> 1) : (result >> 1); lon += dlon;
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

function osrmRoutes(d) {
  return (d.routes || []).slice(0, 3).map((r) => ({
    distance: Number(r.distance || 0),
    duration: Number(r.duration || 0),
    geometry: r.geometry,
    steps: (r.legs || []).flatMap((leg) => (leg.steps || []).map(compactStep)),
    provider: 'OSRM',
    highwayPreferred: false,
  }));
}


function valhallaManeuverKind(m = {}) {
  const text = `${m.instruction || ''} ${m.verbal_transition_alert_instruction || ''} ${m.verbal_pre_transition_instruction || ''}`.toLowerCase();
  let type = 'continue', modifier = '';
  if (/destination|arrive|抵達|到達/.test(text)) type = 'arrive';
  else if (/roundabout|rotary|圓環/.test(text)) type = 'roundabout';
  else if (/exit|off ramp|出口|下匝道/.test(text)) type = 'off ramp';
  else if (/ramp|匝道/.test(text)) type = 'on ramp';
  else if (/merge|匯入|併入/.test(text)) type = 'merge';
  else if (/fork|岔路/.test(text)) type = 'fork';
  else if (/turn|左轉|右轉|轉向/.test(text)) type = 'turn';
  if (/sharp left|大幅左|急左/.test(text)) modifier = 'sharp left';
  else if (/sharp right|大幅右|急右/.test(text)) modifier = 'sharp right';
  else if (/slight left|稍向左|靠左/.test(text)) modifier = 'slight left';
  else if (/slight right|稍向右|靠右/.test(text)) modifier = 'slight right';
  else if (/u[- ]?turn|迴轉|回轉/.test(text)) modifier = 'uturn';
  else if (/left|左/.test(text)) modifier = 'left';
  else if (/right|右/.test(text)) modifier = 'right';
  else if (/straight|直行|繼續/.test(text)) modifier = 'straight';
  return { type, modifier };
}

function valhallaRoute(d) {
  const trip = d?.trip;
  if (!trip?.legs?.length) return null;
  const geometryCoords = [];
  const steps = [];
  for (const leg of trip.legs) {
    const decoded = decodePolyline6(leg.shape || '');
    if (decoded.length) {
      if (geometryCoords.length && decoded.length && geometryCoords.at(-1)?.[0] === decoded[0]?.[0] && geometryCoords.at(-1)?.[1] === decoded[0]?.[1]) decoded.shift();
      geometryCoords.push(...decoded);
    }
    for (const m of (leg.maneuvers || [])) {
      const streetNames = Array.isArray(m.street_names) ? m.street_names.filter(Boolean) : [];
      const signToward = (m.sign?.exit_toward_elements || []).map((x) => x?.text).filter(Boolean).join(' / ');
      const shapeIndex = Math.max(0, Math.min(decoded.length - 1, Number(m.begin_shape_index || 0)));
      const location = decoded[shapeIndex] ? [Number(decoded[shapeIndex][0]), Number(decoded[shapeIndex][1])] : null;
      const kind = valhallaManeuverKind(m);
      steps.push({
        distance: Number(m.length || 0) * 1000,
        duration: Number(m.time || 0),
        name: streetNames[0] || String(m.instruction || ''),
        ref: streetNames.join(' / '),
        destinations: signToward,
        drivingSide: 'right',
        maneuver: {
          location,
          type: kind.type,
          modifier: kind.modifier,
          bearingBefore: Number.isFinite(Number(m.begin_heading)) ? Number(m.begin_heading) : null,
          bearingAfter: Number.isFinite(Number(m.end_heading)) ? Number(m.end_heading) : null,
          exit: Number.isFinite(Number(m.roundabout_exit_count)) ? Number(m.roundabout_exit_count) : null,
        },
      });
    }
  }
  if (geometryCoords.length < 2) return null;
  return {
    distance: Number(trip.summary?.length || 0) * 1000,
    duration: Number(trip.summary?.time || 0),
    geometry: { type: 'LineString', coordinates: geometryCoords },
    steps,
    provider: 'Valhalla',
    highwayPreferred: true,
  };
}

function nearDuplicate(a, b) {
  if (!a || !b || !a.distance || !b.distance || !a.duration || !b.duration) return false;
  const dd = Math.abs(a.distance - b.distance) / Math.max(a.distance, b.distance);
  const dt = Math.abs(a.duration - b.duration) / Math.max(a.duration, b.duration);
  return dd < 0.012 && dt < 0.02;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const from = parsePair(req.query.from), to = parsePair(req.query.to);
  if (!from || !to) return json(res, 400, { error: 'Invalid from/to' });

  const directKm = distanceKm(from[1], from[0], to[1], to[0]);
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson&alternatives=3&steps=true&continue_straight=false`;
  const calls = [fetchJson(osrmUrl, {}, 12000)];
  if (directKm >= 25) {
    const body = {
      locations: [
        { lat: from[1], lon: from[0], type: 'break' },
        { lat: to[1], lon: to[0], type: 'break' },
      ],
      costing: 'auto',
      costing_options: { auto: { use_highways: 1, use_tolls: 0.65, use_ferry: 0, use_living_streets: 0.12, use_tracks: 0 } },
      units: 'kilometers',
      alternates: 2,
      directions_options: { language: 'zh-TW', units: 'kilometers' },
    };
    calls.push(fetchJson('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'sentinel-taiwan-zero-key' },
      body: JSON.stringify(body),
    }, 12000));
  }

  const settled = await Promise.allSettled(calls);
  const routes = [];
  const sources = [];
  if (settled[0]?.status === 'fulfilled') {
    routes.push(...osrmRoutes(settled[0].value));
    sources.push('OSRM public demo server');
  }
  if (settled[1]?.status === 'fulfilled') {
    const vr = valhallaRoute(settled[1].value);
    if (vr) routes.unshift(vr);
    sources.push('Valhalla FOSSGIS public demo');
  }

  const merged = [];
  for (const route of routes) if (route?.geometry && Number.isFinite(route.distance) && Number.isFinite(route.duration) && !merged.some((x) => nearDuplicate(x, route))) merged.push(route);
  merged.sort((a, b) => a.duration - b.duration);
  if (!merged.length) {
    const reasons = settled.map((x) => x.status === 'rejected' ? x.reason?.message : '').filter(Boolean).join(' / ');
    return json(res, 502, { error: `路線服務暫時無法使用${reasons ? `：${reasons}` : ''}` }, 'no-store');
  }

  return json(res, 200, {
    zeroKey: true,
    source: sources.join(' + ') || 'public routing service',
    longTrip: directKm >= 25,
    routes: merged.slice(0, 4),
  }, 's-maxage=90, stale-while-revalidate=360');
};
