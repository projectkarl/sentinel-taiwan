# SENTINEL Cloudflare v2.0.0 — Validation Report

Date: 2026-09-24 (Asia/Taipei)

## Result

**PASS for deploy-ready source validation.**

This report distinguishes code-level verification from a real Cloudflare-edge deployment. A real `workers.dev` smoke test still requires deployment into the owner's Cloudflare account.

## Automated checks completed

### Project / routing
- Required Cloudflare files present.
- `wrangler.jsonc` points to `src/worker.js`.
- Static Assets binding uses `./public`.
- Only `/api/*` runs Worker-first; normal assets remain asset-first.
- SPA fallback enabled.
- Workers Caching enabled.
- Native `/api/health` returns HTTP 200 in local Worker invocation.
- `/api/data?action=health` passes through the compatibility adapter and returns HTTP 200.
- Unknown API actions correctly return HTTP 404.
- Frontend references **19 API actions** and all are routed by the Worker.
- All JS/MJS files pass `node --check`.

### CCTV pipeline
Mocked end-to-end pipeline passed:
1. Public CCTV wrapper page is fetched.
2. Wrapper JavaScript media URL is discovered.
3. Wrapper `Set-Cookie` is retained.
4. Wrapper URL is sent as media `Referer`.
5. HLS master playlist is returned through `/api/cctv-feed`.
6. Child playlist URL is rewritten to same-origin proxy.
7. Segment URL is rewritten to same-origin proxy.
8. Media segment is streamed via Web Streams.
9. Cross-host resource injection is rejected with HTTP 403.

### Free-tier request protection
- Static assets bypass Worker execution.
- Data APIs have per-action edge TTLs.
- Upstream fetches have short/long edge cache policies based on data type.
- CCTV media is `no-store` so live frames are not incorrectly cached.
- Frontend nearby-CCTV fallback was reduced from large sequential probe loops to at most six candidates per search batch.
- CCTV probes are deduplicated in the browser for 30 seconds, preventing the inline panel and popup from probing the same camera twice at the same time.

## Current public-source verification
- Cloudflare Workers Static Assets and `run_worker_first` are current supported deployment mechanisms.
- Cloudflare Workers Caching supports `cache.enabled` and requires Wrangler 4.69.0+.
- Cloudflare Free currently documents 100,000 Worker requests/day, 10 ms CPU/request, 128 MB memory, and 50 subrequests/request.
- Taiwan Freeway Bureau still publishes a traffic database and CCTV/VD open-data formats.
- Highway Bureau public documentation still defines `VideoStreamURL` for CCTV records.
- Taipei City CCTV position data remains public, but real-time image value-added use has a separate application/authorization notice; the project therefore treats Taipei position records as points unless a legitimately public media endpoint can be resolved.

## Required post-deploy verification

Run after Cloudflare gives the final URL:

```bash
BASE_URL=https://your-worker.workers.dev npm run smoke
```

Core failures make the command exit with code 1. Optional public-source outages are shown as warnings so one third-party maintenance event does not mark the entire deployment dead.

## Known external limitation

A public upstream may temporarily block Cloudflare data-center IPs, change its endpoint, require authorization, or return a broken individual camera. The app does not bypass access controls. It will keep official point metadata and attempt other legitimately public nearby cameras instead of opening third-party pages.
