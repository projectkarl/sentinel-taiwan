const zlib = require('node:zlib');
const { fetchText, fetchBuffer, tag, xmlBlocks } = require('./_utils');

const CACHE_MS = 6 * 60 * 60 * 1000;
const registryCache = new Map();

const SOURCES = [
  {
    id: 'freeway', name: '交通部高速公路局', region: '全台國道', access: 'live', kind: 'xml-standard',
    url: 'https://tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml', timeout: 18000,
  },
  {
    id: 'highway', name: '交通部公路局省道', region: '全台省道', access: 'live', kind: 'xml-standard',
    url: 'https://cctv-maintain.thb.gov.tw/opendataCCTVs.xml', timeout: 20000,
  },
  {
    id: 'chiayi-city', name: '嘉義市政府交通處', region: '嘉義市', access: 'live', kind: 'xml-standard',
    url: 'https://data.chiayi.gov.tw/opendata/api/getResource?oid=452283a9-bb9f-40fd-b748-228dd5c3fb1e&rid=c353736b-c126-4652-bc33-951423d73431', timeout: 16000,
  },
  {
    id: 'chiayi-county', name: '嘉義縣政府即時路況 CCTV', region: '嘉義縣', access: 'live', kind: 'ods-generic',
    url: 'https://ws-tm.cyhg.gov.tw/Download.ashx?n=Y2N0dmxpc3QtdjEub2Rz&u=LzAwMS9VcGxvYWQvMTM0Mi9yZWxmaWxlLzEyNTU4LzE5NjM5NS81ZTYwMzg5Zi0yZmE5LTQ3ZGQtYWY2NS0zYzZkMDc2ZWVmNDYub2Rz', timeout: 22000,
    fields: {
      id: ['CCTVID','cctvid','id','ID'], name: ['RoadName','roadname','Location','location','name'],
      lat: ['PositionLat','latitude','Latitude','lat'], lon: ['PositionLon','longitude','Longitude','lon','lng'],
      stream: ['VideoStreamURL','url','URL','streamUrl'], direction: ['RoadDirection','direction','Direction'],
    },
    note: '嘉義縣政府公開即時路況 CCTV；上游以 ODS 發布，本專案於伺服器端直接解析，不需 API 金鑰。',
  },
  {
    id: 'tainan', name: '臺南市政府交通局', region: '臺南市', access: 'live', kind: 'json-generic',
    url: 'https://trafficopendata.tainan.gov.tw/opendata/json/cctv/latest', timeout: 16000,
    fields: {
      id: ['CCTVID','cctvid','id','ID'], name: ['Location','location','RoadName','roadname','name'],
      lat: ['wgsy','WGSY','PositionLat','latitude','Latitude','lat'], lon: ['wgsx','WGSX','PositionLon','longitude','Longitude','lon','lng'],
      stream: ['url','URL','VideoStreamURL','videoStreamURL','streamUrl'], direction: ['RoadDirection','direction','Direction'],
    },
  },
  {
    id: 'taichung', name: '臺中市政府交通局', region: '臺中市', access: 'live', kind: 'json-generic',
    url: 'https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=6c9f5fd5-d74c-4450-9339-1a00e6cda2e6', timeout: 16000,
    fields: {
      id: ['cctvid','CCTVID','id','ID'], name: ['roadsection','RoadSection','location','Location','roadname','RoadName'],
      lat: ['py','PY','PositionLat','latitude','Latitude','lat'], lon: ['px','PX','PositionLon','longitude','Longitude','lon','lng'],
      stream: ['url','URL','VideoStreamURL','streamUrl'], direction: ['direction','Direction','RoadDirection'], status: ['status','Status'],
    },
  },
  {
    id: 'taipei-position', name: '臺北市交通管制工程處 CCTV', region: '臺北市', access: 'authorization-required', kind: 'csv-generic',
    embedAllowed: true,
    url: 'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=d317a3c4-ff08-48af-894e-31dfb5155de3', timeout: 16000,
    fields: {
      id: ['流水號','序號','編號','id','Serial number'], name: ['攝影機編號位置','攝影機編號','攝影機位置','位置','路口','camera','Camera number'],
      lat: ['WGSYWGS84緯度座標','WGSY','WGS84Y','緯度','latitude'], lon: ['WGSXWGS84經度座標','WGSX','WGS84X','經度','longitude'],
    },
    viewerBuilder: ({ rawId, road }) => { const m = String(road || '').match(/(?:^|\D)(\d{1,4})(?:\D|$)/); const id = m?.[1] || String(rawId || '').match(/\d{1,4}/)?.[0] || ''; return id ? `https://hls.bote.gov.taipei/live/index.html?id=${encodeURIComponent(id)}` : ''; },
    requiresAuthorization: true,
    authorizationUrl: 'https://bote.gov.taipei/cp.aspx?n=8B8FFEA8353857B5',
    note: '臺北市官方 CCTV 點位；SENTINEL 先顯示攝影機位置，僅在取得可公開使用的媒體端點時才顯示 LIVE。',
  },
  {
    id: 'new-taipei-position', name: '新北市政府交通局 CCTV', region: '新北市', access: 'official-viewer', kind: 'json-generic',
    publicWrapper: true,
    embedAllowed: false,
    url: 'https://data.ntpc.gov.tw/api/datasets/157501bf-f1cd-4838-92a7-612770351e43/json?page=0&size=2000', timeout: 16000,
    fields: {
      id: ['id','ID','cctv_id','CCTVID','項次','編號'], name: ['equipment','location','Location','address','Address','位置','設備位置','路口'],
      lat: ['lat','latitude','Latitude','緯度','PositionLat'], lon: ['lon','lng','longitude','Longitude','經度','PositionLon'], stream:['areacode','設備編號','equipment_id','deviceid'],
    },
    viewerBuilder: ({ rawStream }) => { const id = String(rawStream || '').trim().match(/[A-Za-z]?\d{3,}/)?.[0] || ''; return id ? `https://atis.ntpc.gov.tw/ATIS/ShowFrame4CCTV/${encodeURIComponent(id)}` : ''; },
    note: '新北市開放資料提供 CCTV 點位與公開官方檢視頁；SENTINEL 會由伺服器端解析檢視頁中實際公開媒體，成功後才標示為 LIVE，不再直接 iframe 整頁。',
  },
  {
    id: 'keelung', name: '基隆市政府公開 CCTV', region: '基隆市', access: 'live', kind: 'csv-generic',
    url: 'https://www.klcg.gov.tw/wSite/public/Attachment/016/f1728008895657.csv', timeout: 16000,
    fields: {
      id: ['CCTVID','cctvid','編號','id'], name: ['RoadName','路名','位置','SurveillanceDescription','location'],
      lat: ['PositionLat','緯度','latitude','lat'], lon: ['PositionLon','經度','longitude','lon'],
      stream: ['VideoStreamURL','URL','url','影像網址'], direction: ['RoadDirection','方向','direction'],
    },
  },
  {
    id: 'taoyuan-position', name: '桃園市政府警察局路口監視器', region: '桃園市', access: 'position-only', kind: 'csv-generic',
    url: 'https://opendata.tycg.gov.tw/api/dataset/07c81524-7e13-4cc7-a1bf-286ea86b0778/resource/376a0cfd-ae39-4a6c-afa2-30b561033f09/download', timeout: 16000,
    fields: {
      id: ['編號','序號','id'], name: ['監控點名稱','攝影機名稱','設置地點','位置','路口'],
      lat: ['緯度','latitude','lat'], lon: ['經度','longitude','lon','lng'], direction: ['管轄分局','分局'],
    },
    note: '官方公開路口監視器位置；資料集未提供可直接播放影像網址。',
  },
];


// verified official quick index around Taipei 101. These records only
// contain official device metadata and original Taipei City player URLs; no
// third-party playback page is used. Coordinates are retained from the previously
// verified nearby-camera index to make cold-start map rendering deterministic.
const OFFICIAL_FAST_SEEDS = [
  { id:'taipei-fast:277', cameraId:'277', lat:25.0338, lon:121.5647, road:'信義路五段7號（台北101大樓）', name:'CCTV 277 · 台北101大樓' },
  { id:'taipei-fast:128', cameraId:'128', lat:25.0329, lon:121.5655, road:'信義松智東南角', name:'CCTV 128 · 信義松智東南角' },
  { id:'taipei-fast:138', cameraId:'138', lat:25.0361, lon:121.5652, road:'市府東南（松壽松智）', name:'CCTV 138 · 市府東南（松壽松智）' },
  { id:'taipei-fast:284', cameraId:'284', lat:25.0330, lon:121.5613, road:'信義路－莊敬路口', name:'CCTV 284 · 信義路－莊敬路口' },
  { id:'taipei-fast:075', cameraId:'075', lat:25.0326, lon:121.5682, road:'信義松仁', name:'CCTV 075 · 信義松仁' },
].map((cam) => ({
  ...cam,
  streamUrl:'',
  officialViewerUrl:`https://hls.bote.gov.taipei/live/index.html?id=${encodeURIComponent(cam.cameraId)}`,
  direction:'', start:'', end:'', mile:'', status:'',
  source:'臺北市交通管制工程處',
  sourceDatasetUrl:'https://bote.gov.taipei/cp.aspx?n=8B8FFEA8353857B5',
  originalSource:true,
  region:'臺北市', regionResolvedBy:'verified-fast-index', regionConfidence:'high',
  access:'authorization-required', playbackPolicy:'authorization-required', requiresAuthorization:true, embedAllowed:false, quickIndex:true,
  authorizationUrl:'https://bote.gov.taipei/cp.aspx?n=8B8FFEA8353857B5',
  note:'臺北市官方 CCTV 快速索引；保留官方點位與檢視頁資訊，但未取得可免授權直連的原始媒體端點時不標示為 LIVE。',
}));

function decodeXmlUrl(v = '') {
  return String(v).replace(/&amp;/g, '&').replace(/&#38;/g, '&').trim();
}

function csvRows(text) {
  const rows = [];
  let row = [], cur = '', quote = false;
  const input = String(text || '').replace(/^\ufeff/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quote && input[i + 1] === '"') { cur += '"'; i++; }
      else quote = !quote;
    } else if (ch === ',' && !quote) { row.push(cur); cur = ''; }
    else if ((ch === '\n' || ch === '\r') && !quote) {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((v) => String(v).trim())) rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); if (row.some((v) => String(v).trim())) rows.push(row); }
  return rows;
}

function keyNorm(v = '') {
  return String(v).replace(/^\ufeff/, '').replace(/[\s_\-()（）【】\[\]\/\\.:：]/g, '').toLowerCase();
}

function fieldValue(obj = {}, candidates = []) {
  const keys = Object.keys(obj);
  const normalized = keys.map((k) => keyNorm(k));
  for (const candidate of candidates || []) {
    const n = keyNorm(candidate);
    const exact = normalized.indexOf(n);
    if (exact >= 0 && obj[keys[exact]] != null) return obj[keys[exact]];
  }
  for (const candidate of candidates || []) {
    const n = keyNorm(candidate);
    const partial = normalized.findIndex((k) => k && n && (k.includes(n) || n.includes(k)));
    if (partial >= 0 && obj[keys[partial]] != null) return obj[keys[partial]];
  }
  return '';
}

function findCol(headers, candidates) {
  const normalized = headers.map(keyNorm);
  for (const c of candidates || []) {
    const k = keyNorm(c);
    const exact = normalized.indexOf(k); if (exact >= 0) return exact;
  }
  for (const c of candidates || []) {
    const k = keyNorm(c);
    const partial = normalized.findIndex((x) => x && k && (x.includes(k) || k.includes(x)));
    if (partial >= 0) return partial;
  }
  return -1;
}

function normalizeCoordinate(value) {
  if (value == null) return NaN;
  const raw = String(value).trim().replace(/,/g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function plausibleTaiwan(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 20.5 && lat <= 26.7 && lon >= 118 && lon <= 123.8;
}

const ADMIN_REGION_RE = /(臺北市|台北市|新北市|桃園市|臺中市|台中市|臺南市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|臺東縣|台東縣|澎湖縣|金門縣|連江縣)/;
function normalizeRegionName(value = '') {
  const raw = String(value || '').trim();
  const hit = raw.match(ADMIN_REGION_RE)?.[1] || '';
  return hit.replace(/^台北市$/, '臺北市').replace(/^台中市$/, '臺中市').replace(/^台南市$/, '臺南市').replace(/^台東縣$/, '臺東縣');
}

// Conservative offline county/city inference for national-road cameras whose source only says
// "全台國道/省道/Taiwan". Municipal sources and explicit place text always win.
// This avoids an external reverse-geocoder request for every camera, keeping nearby CCTV fast.
function approximateRegionByCoordinate(lat, lon) {
  const y = Number(lat), x = Number(lon);
  if (!plausibleTaiwan(y, x)) return '';
  if (x < 118.65 && y > 24.30 && y < 24.65) return '金門縣';
  if (x < 120.05 && y > 23.10 && y < 23.90) return '澎湖縣';
  if (y > 25.80 && x >= 119.80 && x < 120.75) return '連江縣';

  // North coast / Taipei basin. Smaller municipality envelopes are checked first.
  if (y >= 25.075 && y <= 25.205 && x >= 121.625 && x <= 121.825) return '基隆市';
  if (y >= 24.280 && y < 25.060 && x >= 121.650 && x <= 122.050) return '宜蘭縣';
  if (y >= 24.955 && y <= 25.205 && x >= 121.495 && x <= 121.690 && !(y < 25.025 && x < 121.525)) return '臺北市';
  if (y >= 24.640 && y <= 25.320 && x >= 121.280 && x <= 122.020) return '新北市';
  if (y >= 24.720 && y <= 25.150 && x >= 120.970 && x < 121.460) return '桃園市';

  // Hsinchu / central west.
  if (y >= 24.725 && y <= 24.875 && x >= 120.880 && x <= 121.030) return '新竹市';
  if (y >= 24.620 && y <= 24.980 && x >= 120.820 && x <= 121.390) return '新竹縣';
  if (y >= 24.250 && y < 24.740 && x >= 120.550 && x <= 121.300) return '苗栗縣';
  if (y >= 23.930 && y <= 24.500 && x >= 120.450 && x <= 121.420) return '臺中市';
  if (y >= 23.780 && y <= 24.220 && x >= 120.200 && x < 120.700) return '彰化縣';
  if (y >= 23.400 && y <= 24.260 && x >= 120.610 && x <= 121.350) return '南投縣';
  if (y >= 23.420 && y < 23.850 && x >= 120.080 && x < 120.720) return '雲林縣';
  if (y >= 23.425 && y <= 23.535 && x >= 120.365 && x <= 120.515) return '嘉義市';
  if (y >= 23.200 && y <= 23.670 && x >= 120.050 && x <= 121.050) return '嘉義縣';
  if (y >= 22.850 && y <= 23.420 && x >= 120.000 && x <= 120.720) return '臺南市';
  if (y >= 22.450 && y < 23.450 && x >= 120.150 && x <= 121.060) return '高雄市';
  if (y >= 21.850 && y < 22.900 && x >= 120.300 && x <= 120.980) return '屏東縣';

  // East coast; evaluate Yilan before Hualien and use longitude to avoid central-mountain overlap.
  if (y >= 23.000 && y < 24.650 && x >= 121.000 && x <= 121.850) return '花蓮縣';
  if (y >= 21.900 && y < 23.520 && x >= 120.720 && x <= 121.650) return '臺東縣';
  return '';
}

function resolveCameraRegion(camera = {}, source = {}) {
  const textRegion = normalizeRegionName([camera.road, camera.name, camera.direction].filter(Boolean).join(' '));
  if (textRegion) return { region:textRegion, by:'camera-text', confidence:'high' };
  const declared = normalizeRegionName(camera.region || source.region || '');
  if (declared) return { region:declared, by:'source', confidence:'high' };
  const inferred = approximateRegionByCoordinate(Number(camera.lat), Number(camera.lon));
  if (inferred) return { region:inferred, by:'coordinate', confidence:'medium' };
  return { region:'臺灣', by:'fallback', confidence:'low' };
}

function cameraRecord(source, raw, index) {
  const f = source.fields || {};
  const rawId = fieldValue(raw, f.id || ['CCTVID','id','編號','序號']);
  let lat = normalizeCoordinate(fieldValue(raw, f.lat || ['PositionLat','Latitude','latitude','緯度','lat']));
  let lon = normalizeCoordinate(fieldValue(raw, f.lon || ['PositionLon','Longitude','longitude','經度','lon','lng']));
  // Defensive swap for providers that publish X/Y with inverted labels.
  if (!plausibleTaiwan(lat, lon) && plausibleTaiwan(lon, lat)) [lat, lon] = [lon, lat];
  const road = String(fieldValue(raw, f.name || ['RoadName','Location','位置','路口','name']) || '').trim();
  const rawStream = decodeXmlUrl(fieldValue(raw, f.stream || ['VideoStreamURL','URL','url','streamUrl']));
  const rawImage = decodeXmlUrl(fieldValue(raw, f.image || ['VideoImageURL','ImageURL','imageUrl','snapshotUrl']));
  const imageRefreshRate = Math.max(1, Number(fieldValue(raw, f.refresh || ['ImageRefreshRate','refreshRate','RefreshRate'])) || 5);
  const directStreamAllowed = !['position-only','authorization-required','official-viewer'].includes(source.access);
  let streamUrl = directStreamAllowed ? rawStream : '';
  if (directStreamAllowed && typeof source.streamBuilder === 'function') {
    try { streamUrl = source.streamBuilder({ rawId, rawStream, road, raw, index }) || ''; } catch (_) { streamUrl = ''; }
  }
  let officialViewerUrl = '';
  if (typeof source.viewerBuilder === 'function') {
    try { officialViewerUrl = source.viewerBuilder({ rawId, rawStream, road, raw, index }) || ''; } catch (_) { officialViewerUrl = ''; }
  }
  // Some agencies expose a public viewer page whose HTML declares the actual media URL.
  // Treat that page as a server-side wrapper candidate, never as an iframe LIVE source.
  if (!streamUrl && source.publicWrapper && officialViewerUrl && !source.requiresAuthorization) {
    streamUrl = officialViewerUrl;
  }
  const direction = String(fieldValue(raw, f.direction || ['RoadDirection','Direction','direction','方向']) || '').trim();
  const status = String(fieldValue(raw, f.status || ['status','Status','狀態']) || '').trim();
  const item = {
    id: `${source.id}:${String(rawId || index).trim()}`,
    streamUrl,
    imageUrl: directStreamAllowed ? rawImage : '',
    imageRefreshRate,
    lon, lat,
    road: road || `${source.region || source.name} CCTV`,
    direction,
    start: '', end: '', mile: '', status,
    source: source.name,
    sourceDatasetUrl: source.url || '',
    originalSource: true,
    officialViewerUrl,
    authorizationUrl: source.authorizationUrl || '',
    requiresAuthorization: Boolean(source.requiresAuthorization),
    embedAllowed: Boolean(source.embedAllowed),
    playbackPolicy: source.requiresAuthorization ? 'authorization-required' : (source.publicWrapper && streamUrl ? 'public-wrapper' : (officialViewerUrl && !streamUrl ? 'official-viewer-only' : (streamUrl ? 'direct-public-stream' : 'position-only'))),
    region: source.region || '',
    access: streamUrl ? (source.publicWrapper ? 'live-wrapper' : (source.access || 'live')) : (source.requiresAuthorization ? 'authorization-required' : (officialViewerUrl ? 'official-viewer' : 'position-only')),
    note: source.note || (streamUrl ? '政府公開交通 CCTV 影像來源。' : '政府公開 CCTV 位置；未提供可直接免授權播放的串流。'),
  };
  if (!plausibleTaiwan(item.lat, item.lon)) return null;
  const resolvedRegion = resolveCameraRegion(item, source);
  item.region = resolvedRegion.region;
  item.regionResolvedBy = resolvedRegion.by;
  item.regionConfidence = resolvedRegion.confidence;
  return item;
}

function parseStandardXml(xml, source) {
  let blocks = xmlBlocks(xml, 'CCTV');
  if (!blocks.length) blocks = xmlBlocks(xml, 'Camera');
  return blocks.map((block, index) => {
    const raw = {
      CCTVID: tag(block, 'CCTVID') || tag(block, 'ID'),
      VideoStreamURL: tag(block, 'VideoStreamURL') || tag(block, 'videostreamurl') || tag(block, 'URL') || tag(block, 'Url'),
      VideoImageURL: tag(block, 'VideoImageURL') || tag(block, 'videoimageurl') || tag(block, 'ImageURL') || tag(block, 'SnapshotURL'),
      ImageRefreshRate: tag(block, 'ImageRefreshRate') || tag(block, 'imagerefreshrate') || '5',
      PositionLon: tag(block, 'PositionLon') || tag(block, 'positionlon') || tag(block, 'Longitude') || tag(block, 'X'),
      PositionLat: tag(block, 'PositionLat') || tag(block, 'positionlat') || tag(block, 'Latitude') || tag(block, 'Y'),
      RoadName: tag(block, 'RoadName') || tag(block, 'roadname') || tag(block, 'RoadID') || tag(block, 'Location'),
      RoadDirection: tag(block, 'RoadDirection') || tag(block, 'roaddirection') || tag(block, 'Direction'),
      Start: tag(block, 'Start'), End: tag(block, 'End'), LocationMile: tag(block, 'LocationMile'),
    };
    const rec = cameraRecord({ ...source, fields: {
      id:['CCTVID'], stream:['VideoStreamURL'], image:['VideoImageURL'], refresh:['ImageRefreshRate'], lon:['PositionLon'], lat:['PositionLat'], name:['RoadName'], direction:['RoadDirection'],
    } }, raw, index);
    if (rec) {
      rec.start = raw.Start || '';
      rec.end = raw.End || '';
      rec.mile = raw.LocationMile || '';
    }
    return rec;
  }).filter(Boolean);
}

function jsonRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const preferred = ['data','Data','result','Result','records','Records','items','Items','retVal','response','Response','CCTVs','cctvs'];
  for (const key of preferred) {
    if (!(key in value)) continue;
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    const rows = jsonRows(nested);
    if (rows.length) return rows;
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) && nested.length && typeof nested[0] === 'object') return nested;
  }
  return [];
}

function parseJsonGeneric(text, source) {
  const clean = String(text || '').replace(/^\ufeff/, '').trim();
  const body = JSON.parse(clean);
  return jsonRows(body).map((raw, index) => cameraRecord(source, raw, index)).filter(Boolean);
}

function parseCsvGeneric(text, source) {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((x) => String(x).trim());
  const f = source.fields || {};
  const indices = {};
  for (const [key, candidates] of Object.entries(f)) indices[key] = findCol(headers, candidates);
  return rows.slice(1).map((row, index) => {
    const raw = {};
    for (const [key, idx] of Object.entries(indices)) if (idx >= 0) raw[key] = row[idx];
    const mapped = {
      id: raw.id, name: raw.name, lat: raw.lat, lon: raw.lon, stream: raw.stream, direction: raw.direction, status: raw.status,
    };
    return cameraRecord({ ...source, fields: {
      id:['id'], name:['name'], lat:['lat'], lon:['lon'], stream:['stream'], direction:['direction'], status:['status'],
    } }, mapped, index);
  }).filter(Boolean);
}

function decodeXmlText(value = '') {
  return String(value)
    .replace(/<text:line-break\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ').trim();
}

function extractZipEntry(buffer, wantedName) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 22) throw new Error('Invalid ODS/ZIP payload');
  let eocd = -1;
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ODS central directory not found');
  const entries = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries && ptr + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const fileNameLength = buf.readUInt16LE(ptr + 28);
    const extraLength = buf.readUInt16LE(ptr + 30);
    const commentLength = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const fileName = buf.subarray(ptr + 46, ptr + 46 + fileNameLength).toString('utf8');
    if (fileName === wantedName) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ODS local file header invalid');
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buf.length) throw new Error('ODS entry truncated');
      const packed = buf.subarray(dataStart, dataEnd);
      if (method === 0) return packed;
      if (method === 8) return zlib.inflateRawSync(packed, { maxOutputLength: 12 * 1024 * 1024 });
      throw new Error(`Unsupported ODS compression method ${method}`);
    }
    ptr += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`ODS entry ${wantedName} not found`);
}

function odsRowsFromContentXml(xml) {
  const rows = [];
  const rowBlocks = String(xml).match(/<table:table-row(?:\s[^>]*)?>[\s\S]*?<\/table:table-row>/gi) || [];
  for (const rowBlock of rowBlocks) {
    const row = [];
    const cellRe = /<table:table-cell([^>]*)>([\s\S]*?)<\/table:table-cell>|<table:table-cell([^>]*)\/>/gi;
    let m;
    while ((m = cellRe.exec(rowBlock))) {
      const attrs = m[1] || m[3] || '';
      const body = m[2] || '';
      const repeatMatch = attrs.match(/table:number-columns-repeated="(\d+)"/i);
      const repeat = Math.min(64, Math.max(1, Number(repeatMatch?.[1] || 1)));
      const paragraphs = [...body.matchAll(/<text:p(?:\s[^>]*)?>([\s\S]*?)<\/text:p>/gi)].map((x) => decodeXmlText(x[1]));
      const valueAttr = attrs.match(/office:(?:string-value|value)="([^"]*)"/i)?.[1] || '';
      const value = paragraphs.filter(Boolean).join(' ').trim() || decodeXmlText(valueAttr);
      for (let i = 0; i < repeat; i++) row.push(value);
    }
    if (row.some((x) => String(x).trim())) rows.push(row);
  }
  return rows;
}

function parseOdsGeneric(buffer, source) {
  const content = extractZipEntry(buffer, 'content.xml').toString('utf8');
  const rows = odsRowsFromContentXml(content);
  if (rows.length < 2) return [];
  const headers = rows[0].map((x) => String(x).trim());
  const f = source.fields || {};
  const indices = {};
  for (const [key, candidates] of Object.entries(f)) indices[key] = findCol(headers, candidates);
  return rows.slice(1).map((row, index) => {
    const raw = {};
    for (const [key, idx] of Object.entries(indices)) if (idx >= 0) raw[key] = row[idx];
    const mapped = { id:raw.id, name:raw.name, lat:raw.lat, lon:raw.lon, stream:raw.stream, direction:raw.direction, status:raw.status };
    return cameraRecord({ ...source, fields:{ id:['id'], name:['name'], lat:['lat'], lon:['lon'], stream:['stream'], direction:['direction'], status:['status'] } }, mapped, index);
  }).filter(Boolean);
}

function parseSourceText(text, source) {
  if (source.kind === 'xml-standard') return parseStandardXml(text, source);
  if (source.kind === 'json-generic') return parseJsonGeneric(text, source);
  if (source.kind === 'csv-generic') return parseCsvGeneric(text, source);
  return [];
}

async function fetchSource(source, { force = false, timeoutCap = null } = {}) {
  const now = Date.now();
  const cached = registryCache.get(source.id);
  if (!force && cached && cached.expiresAt > now) return cached.items;
  const normalTimeout = source.kind === 'ods-generic' ? (source.timeout || 22000) : (source.timeout || 16000);
  const timeout = Number.isFinite(Number(timeoutCap)) ? Math.max(1800, Math.min(normalTimeout, Number(timeoutCap))) : normalTimeout;
  try {
    const items = source.kind === 'ods-generic'
      ? parseOdsGeneric(await fetchBuffer(source.url, {}, timeout, 16 * 1024 * 1024), source)
      : parseSourceText(await fetchText(source.url, {}, timeout), source);
    registryCache.set(source.id, { items, expiresAt: now + CACHE_MS });
    return items;
  } catch (err) {
    // Keep the last known official registry usable during a temporary upstream timeout.
    if (cached?.items?.length) return cached.items;
    throw err;
  }
}

async function loadRegistry(options = {}) {
  const allowedIds = Array.isArray(options.sourceIds) && options.sourceIds.length ? new Set(options.sourceIds) : null;
  const sourceList = SOURCES.filter((source) => (!options.liveOnly || source.access !== 'position-only') && (!allowedIds || allowedIds.has(source.id)));
  const settled = await Promise.allSettled(sourceList.map((source) => fetchSource(source, options)));
  const dedup = new Map();
  const sourceStatus = [];
  settled.forEach((result, index) => {
    const source = sourceList[index];
    if (result.status === 'fulfilled') {
      sourceStatus.push({ id:source.id, name:source.name, region:source.region, ok:true, count:result.value.length, access:source.access });
      result.value.forEach((camera) => {
        const streamKey = camera.streamUrl ? String(camera.streamUrl).replace(/^http:/i, 'https:') : '';
        const key = streamKey || `${camera.lat.toFixed(5)},${camera.lon.toFixed(5)},${keyNorm(camera.road)}`;
        if (!dedup.has(key)) dedup.set(key, camera);
      });
    } else {
      sourceStatus.push({ id:source.id, name:source.name, region:source.region, ok:false, count:0, access:source.access, error:String(result.reason?.message || result.reason || 'SOURCE OFFLINE').slice(0,140) });
    }
  });
  const items = [...dedup.values()];
  return { items, sourceStatus };
}

function normalizeSearch(value = '') {
  return String(value)
    .toLowerCase().replace(/臺/g, '台')
    .replace(/(?:cctv|監視器|監視攝影機|攝影機|即時影像|路況影像|查看|查詢|附近|目前)/gi, ' ')
    .replace(/[與和及]/g, ' ')
    .replace(/[、，,。．.\-_/／\\()（）【】\[\]]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function searchScore(camera, query) {
  const q = normalizeSearch(query);
  if (!q) return 0;
  const nameRaw = [camera.road, camera.name, camera.direction, camera.region, camera.source, camera.start, camera.end, camera.mile].filter(Boolean).join(' ');
  const name = normalizeSearch(nameRaw);
  if (!name) return -1;
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800;
  if (name.includes(q)) return 650;
  const tokens = q.split(' ').filter(Boolean);
  if (!tokens.length) return -1;
  const hits = tokens.filter((token) => name.includes(token)).length;
  if (!hits) return -1;
  return hits === tokens.length ? 500 + hits * 35 : hits * 60;
}

function searchRegistry(items, query, limit = 120) {
  const max = Math.min(500, Math.max(1, Number(limit) || 120));
  return items.map((camera) => ({ camera, score: searchScore(camera, query) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || Number(Boolean(b.camera.streamUrl)) - Number(Boolean(a.camera.streamUrl)))
    .slice(0, max).map((x) => ({ ...x.camera, matchScore:x.score }));
}

async function resolveCamera(id) {
  const rawId = String(id || '');
  const prefix = rawId.split(':')[0];
  if (prefix === 'twipcam') {
    const slug = rawId.slice('twipcam:'.length).trim();
    if (!/^[A-Za-z0-9._-]{2,120}$/.test(slug)) throw new Error('Invalid CCTV resolver id');
    return {
      id:rawId,
      streamUrl:`https://www.twipcam.com/cam/${encodeURIComponent(slug)}`,
      resolverBridge:true,
      source:'公開 CCTV 原始媒體解析',
      access:'live-wrapper', playbackPolicy:'public-wrapper', originalSource:true,
      road:slug, region:'Taiwan',
    };
  }
  const fastSeed = OFFICIAL_FAST_SEEDS.find((item) => String(item.id) === rawId);
  if (fastSeed) return { ...fastSeed };
  const source = SOURCES.find((item) => item.id === prefix);
  if (!source) throw new Error('Unknown CCTV source');
  const items = await fetchSource(source);
  const camera = items.find((x) => String(x.id) === rawId);
  if (!camera) throw new Error('CCTV not found');
  return camera;
}

module.exports = {
  SOURCES,
  OFFICIAL_FAST_SEEDS,
  csvRows,
  jsonRows,
  parseSourceText,
  parseStandardXml,
  parseJsonGeneric,
  parseCsvGeneric,
  parseOdsGeneric,
  odsRowsFromContentXml,
  extractZipEntry,
  normalizeSearch,
  searchRegistry,
  approximateRegionByCoordinate,
  resolveCameraRegion,
  loadRegistry,
  resolveCamera,
};
