const { json, fetchText, distanceKm } = require('./_utils');

const SOURCE_URL = 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/6CDA283E-DD10-49AD-8F44-271FCB2001B4/download';

function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

function normalizeHeader(v) {
  return String(v || '').trim().toLowerCase().replace(/[\s_\-()（）]/g, '');
}

function valueByAliases(record, aliases) {
  for (const alias of aliases) {
    const key = Object.keys(record).find((k) => normalizeHeader(k) === normalizeHeader(alias));
    if (key != null && String(record[key] ?? '').trim()) return String(record[key]).trim();
  }
  return '';
}

function rowsToItems(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((x) => String(x || '').trim());
  return rows.slice(1).map((values, index) => {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = values[i] ?? ''; });
    const lat = Number(valueByAliases(rec, ['Latitude', '緯度', 'lat']));
    const lon = Number(valueByAliases(rec, ['Longitude', '經度', 'lon', 'lng']));
    const limitRaw = valueByAliases(rec, ['limit', '速限', '速度限制']);
    const limitMatch = limitRaw.match(/\d+/);
    return {
      id: `npa-speed:${index}:${lat.toFixed?.(5) || lat}:${lon.toFixed?.(5) || lon}`,
      city: valueByAliases(rec, ['CityName', '設置縣市', '縣市']),
      region: valueByAliases(rec, ['RegionName', '設置市區鄉鎮', '行政區']),
      address: valueByAliases(rec, ['Address', '設置地址', '地址']),
      department: valueByAliases(rec, ['DeptNm', '管轄警局']),
      branch: valueByAliases(rec, ['BranchNm', '管轄分局']),
      direction: valueByAliases(rec, ['direct', '拍攝方向', '方向']),
      limit: limitMatch ? Number(limitMatch[0]) : null,
      lat,
      lon,
      source: '警政署公開測速執法設置點',
    };
  }).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, 'no-store');
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(250, Math.max(3, Number(req.query.radius || 50)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'Invalid coordinates' });

  try {
    const csv = await fetchText(SOURCE_URL, {}, 18000);
    const all = rowsToItems(parseCsv(csv));
    const items = all
      .map((x) => ({ ...x, distance: distanceKm(lat, lon, x.lat, x.lon) }))
      .filter((x) => x.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 500);
    return json(res, 200, {
      zeroKey: true,
      source: '內政部警政署 / 政府資料開放平臺',
      sourceUpdatedByProvider: '不定期',
      items,
      message: items.length ? undefined : '此範圍內目前沒有取得公開測速執法設置點。',
    }, 's-maxage=43200, stale-while-revalidate=86400');
  } catch (e) {
    return json(res, 502, { error: `測速執法公開資料暫時無法取得：${e.message}` }, 'no-store');
  }
};

module.exports._test = { parseCsv, rowsToItems };
