export async function invokeLegacy(handler, request) {
  const url = new URL(request.url);
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else query[key] = value;
  }

  const reqHeaders = {};
  for (const [key, value] of request.headers.entries()) reqHeaders[key.toLowerCase()] = value;
  const req = {
    method: request.method,
    query,
    headers: reqHeaders,
    url: url.pathname + url.search,
  };

  let statusCode = 200;
  let body;
  let finished = false;
  const headers = new Headers();

  const res = {
    setHeader(name, value) {
      if (Array.isArray(value)) {
        headers.delete(name);
        for (const item of value) headers.append(name, String(item));
      } else headers.set(name, String(value));
      return res;
    },
    getHeader(name) { return headers.get(name); },
    removeHeader(name) { headers.delete(name); return res; },
    status(code) { statusCode = Number(code) || 200; return res; },
    json(value) {
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8');
      body = JSON.stringify(value);
      finished = true;
      return res;
    },
    send(value = '') {
      if (value == null) body = '';
      else if (typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer) body = value;
      else {
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8');
        body = JSON.stringify(value);
      }
      finished = true;
      return res;
    },
    end(value = '') {
      body = value == null ? '' : value;
      finished = true;
      return res;
    },
    get headersSent() { return finished; },
    get statusCode() { return statusCode; },
    set statusCode(value) { statusCode = Number(value) || 200; },
  };

  try {
    await handler(req, res);
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error?.message || String(error) }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if (statusCode === 204) body = null;
  else if (body === undefined) body = '';
  return new Response(body, { status: statusCode, headers });
}
