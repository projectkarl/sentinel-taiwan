const { json } = require('./_utils');
module.exports = async (req, res) => json(res, 200, {
  ok: true,
  build: '2.0.0-cloudflare-rebuild',
  zeroKey: true,
  environmentSecretsRequired: false,
  sources: [
    'OpenStreetMap / Nominatim',
    'Esri World Imagery (optional keyless basemap)',
    'Open-Meteo',
    'OSRM public demo server',
    'Freeway Bureau CCTV.xml',
    'Freeway Bureau LiveTraffic.xml / Section.xml / SectionShape.xml',
    'Freeway Bureau VDLive.xml / VD.xml (lane-level sensor fusion)',
    'Police Broadcasting Service open data',
    'National Police Agency public speed-enforcement data',
    'ADSB.lol public aircraft data',
    'USGS earthquake feed',
    'CNA public RSS',
    'GDELT DOC 2.0',
  ],
  time: new Date().toISOString(),
}, 'no-store');
