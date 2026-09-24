# Third-party notices

SENTINEL // TAIWAN does not relicense third-party data, map tiles, video streams or imagery.

- OpenStreetMap contributors / Nominatim — ODbL and applicable public-service usage policies
- OSRM — open-source routing engine; public demo service is best-effort
- Valhalla / FOSSGIS public demo — open-source routing engine used as a best-effort long-trip highway-biased alternate; subject to public demo fair-use/availability
- Open-Meteo — public API subject to its terms and fair-use limits
- 交通部高速公路局、公路局、警廣、警政署及其他政府開放資料 — subject to each dataset's license and notices
- 環境部空氣品質開放資料 — used for official AQI observation context; subject to the government dataset license and service terms
- 經濟部水利署防災／淹水警戒開放資料 — used as public warning signals; subject to dataset license and notices
- 臺北市停車管理工程處公開停車資訊 — used for supported parking facility / availability context; subject to Taipei open-data terms
- 臺北市工務局道路施工公開資料 — used for supported current-roadwork context; subject to Taipei open-data terms
- Esri World Imagery plus Esri public place/reference labels — default Zero-Key satellite basemap and labels; subject to Esri terms
- ADSB.lol / public ADS-B source, public seismic sources and public news sources — subject to each source's terms
- Leaflet — BSD-2-Clause
- hls.js — Apache-2.0; loaded on demand only when the browser needs HLS decoding support

CCTV media is shown from a public source URL or through same-origin proxying for HTTPS/stream compatibility. Proxying does not change the source's content license and does not create a video archive.

The area-status / threat display is a visualization derived from public signals. It is not an official emergency-warning service and must not replace notices from competent authorities.


## CesiumJS (lazy 3D cockpit)

The optional 3D cockpit path lazy-loads CesiumJS from a public CDN only when requested. CesiumJS is an open-source geospatial visualization library; its own license and notices apply. The Taiwan build uses OSM imagery over a WGS84 ellipsoid and does not claim Google Photorealistic 3D Tiles or Cesium World Terrain.

## CCTV registry
- 嘉義縣政府即時路況 CCTV open dataset: official location / stream metadata published as ODS; used under the source's government open-data terms.
- The app does not redistribute private CCTV, perform face/plate recognition, or infer identities.

## Original-source CCTV / scenic source discovery

- SENTINEL plays CCTV/scenic media from original public publishers whenever available: government CCTV endpoints, official government player pages, or official/public YouTube embeds.
- `monitor1.wfuapp.com` is used only as a best-effort directory to identify the underlying original source for a user-searched place. Its page is not embedded as the CCTV player and is not treated as the media owner.
- When a reference page points to an official wrapper/player page, SENTINEL may fetch that public page once to resolve a more direct YouTube/HLS/JPEG/MJPEG/MP4/WebM media endpoint.
- If no verifiable original public source can be resolved, SENTINEL shows the item as unavailable/position-only rather than falling back to a third-party reference player.
- All upstream content remains subject to the original publisher's terms, licenses, embedding rules, uptime and rate limits. SENTINEL does not archive or relicense the media.

## Optional browser vision analysis
- TensorFlow.js — Apache-2.0 — loaded on demand from jsDelivr only after the user presses VISION LAB.
- TensorFlow Models / COCO-SSD — Apache-2.0 — loaded on demand from jsDelivr for broad object-class detection.
- These libraries are not required for normal map, routing, CCTV playback or official VD/flow sensor fusion.


## Taiwan administrative boundary reference
- Ministry of the Interior / National Land Surveying and Mapping Center county-city boundary dataset is used as the reference for CCTV region QA. Runtime prefers explicit camera/source metadata and conservative coordinate inference to avoid bulk reverse-geocoding against public services.
- Government Open Data License, version 1.0 applies to the referenced dataset.

## Highway Live / navigation visuals
- Traffic color bands use the Freeway Bureau public LiveTraffic / Section / SectionShape feeds already integrated in SENTINEL. The HWY mode is a SENTINEL visualization inspired by the information hierarchy of freeway traffic maps; it is not an official 1968 client.
- KartaView is used only for best-effort public historical street-level imagery near an upcoming maneuver. KartaView images remain subject to KartaView/OpenStreetCam source terms and contributor licensing. SENTINEL does not claim these images are live or current.
- The navigation HUD does not use or reproduce proprietary commercial Junction View assets. If no public historical image exists, text/arrow navigation continues normally.
