import { invokeLegacy } from './lib/legacy-adapter.js';
import { json, withSecurity } from './lib/http.js';
import { handleCctvFeed } from './cctv-feed.js';

import geocode from './services/geocode.js';
import reverseGeocode from './services/reverse-geocode.js';
import weather from './services/weather.js';
import route from './services/route.js';
import cctv from './services/cctv.js';
import scenic from './services/scenic.js';
import traffic from './services/traffic.js';
import flow from './services/flow.js';
import cityFlow from './services/city-flow.js';
import laneFlow from './services/lane-flow.js';
import streetImage from './services/street-image.js';
import news from './services/news.js';
import speedCameras from './services/speed-cameras.js';
import flights from './services/flights.js';
import earthquakes from './services/earthquakes.js';
import health from './services/health.js';
import airQuality from './services/air-quality.js';
import parking from './services/parking.js';
import construction from './services/construction.js';
import flood from './services/flood.js';

const BUILD = '2.0.0-cloudflare-rebuild';
const HANDLERS = {
  geocode,
  'reverse-geocode': reverseGeocode,
  weather,
  route,
  cctv,
  'scenic-cctv': scenic,
  traffic,
  flow,
  'city-flow': cityFlow,
  'lane-flow': laneFlow,
  'street-image': streetImage,
  news,
  'speed-cameras': speedCameras,
  flights,
  earthquakes,
  health,
  'air-quality': airQuality,
  parking,
  construction,
  flood,
};

const ACTION_TTLS = {
  geocode: 86400,
  'reverse-geocode': 86400,
  weather: 60,
  route: 120,
  cctv: 120,
  'scenic-cctv': 120,
  traffic: 15,
  flow: 15,
  'city-flow': 15,
  'lane-flow': 15,
  'street-image': 3600,
  news: 60,
  'speed-cameras': 3600,
  flights: 2,
  earthquakes: 60,
  'air-quality': 180,
  parking: 60,
  construction: 180,
  flood: 60,
  health: 0,
};

async function handleData(request) {
  const url = new URL(request.url);
  const action = String(url.searchParams.get('action') || '').trim().toLowerCase();
  if (!action) return json({ error: 'Missing action', available: Object.keys(HANDLERS) }, 400, { 'Cache-Control': 'no-store' });
  const handler = HANDLERS[action];
  if (!handler) return json({ error: 'Unknown action', action, available: Object.keys(HANDLERS) }, 404, { 'Cache-Control': 'no-store' });

  const response = await invokeLegacy(handler, request);
  const headers = new Headers(response.headers);
  headers.set('X-Sentinel-Build', BUILD);
  const ttl = Number(ACTION_TTLS[action] || 0);
  if (response.ok && ttl > 0) {
    // Browser always revalidates; Cloudflare Workers Caching may serve the same API URL at the edge.
    headers.set('Cache-Control', `public, max-age=0, s-maxage=${ttl}`);
  } else if (ttl === 0) {
    headers.set('Cache-Control', 'no-store');
  }
  return withSecurity(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return withSecurity(new Response(null, { status: 204 }), {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Max-Age': '86400',
      });
    }

    if (url.pathname === '/api/cctv-feed') {
      const response = await handleCctvFeed(request, env);
      const headers = new Headers(response.headers);
      headers.set('X-Sentinel-Build', BUILD);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    if (url.pathname === '/api/data') return handleData(request);

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        build: BUILD,
        platform: 'Cloudflare Workers + Static Assets',
        runtime: 'module-worker',
        zeroKey: true,
        actions: Object.keys(HANDLERS),
        cctv: { inlineOnly: true, hlsRewrite: true, webStreams: true, wrapperResolve: true },
        time: new Date().toISOString(),
      }, 200, { 'Cache-Control': 'no-store', 'X-Sentinel-Build': BUILD });
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'API route not found', path: url.pathname }, 404, { 'Cache-Control': 'no-store' });
    }

    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response('SENTINEL static asset binding unavailable', { status: 503 });
  },
};
