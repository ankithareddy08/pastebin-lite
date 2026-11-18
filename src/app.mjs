import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { HttpError, expiryNow, requestOrigin, validatePaste } from './validation.mjs';
import { renderPaste, renderError } from './views.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const PUBLIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
});

function headers(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('CDN-Cache-Control', 'no-store');
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function send(response, status, body, type = 'application/json; charset=utf-8', head = false) {
  response.statusCode = status;
  response.setHeader('Content-Type', type);
  response.end(head ? undefined : type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Use Content-Type: application/json.');
  }
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpError(413, 'The JSON request body must be 1 MiB or smaller.');
  }
  // Vercel may expose the already-parsed body through a lazy getter.
  let parsed;
  try { parsed = request.body; } catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
  if (parsed !== undefined) {
    if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_BODY_BYTES) {
      throw new HttpError(413, 'The JSON request body must be 1 MiB or smaller.');
    }
    return parsed;
  }
  let bytes = 0;
  const chunks = [];
  // Keep the request socket open so an oversized chunked request gets JSON 413.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      request.resume();
      throw new HttpError(413, 'The JSON request body must be 1 MiB or smaller.');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'The request body is not valid JSON.'); }
}

function requireMethod(request, response, allowed) {
  if (!allowed.includes(request.method)) {
    response.setHeader('Allow', allowed.join(', '));
    throw new HttpError(405, 'This HTTP method is not supported for this route.');
  }
}

export function createApp({ store, testMode = false, baseUrl, trustProxy = false }) {
  return async function app(request, response) {
    headers(response);
    let isApi = true;
    try {
      // Parse the path without relying on an untrusted Host header for routing.
      const path = new URL(request.url, 'http://request.invalid').pathname;
      isApi = path === '/api' || path.startsWith('/api/');
      if (path === '/api/healthz') {
        requireMethod(request, response, ['GET', 'HEAD']);
        let ok = false;
        try { ok = Boolean(await store.health()); } catch { /* HTTP 200 with false reports a failed dependency. */ }
        return send(response, 200, { ok }, undefined, request.method === 'HEAD');
      }
      if (path === '/api/pastes') {
        requireMethod(request, response, ['POST']);
        const body = await jsonBody(request);
        const paste = validatePaste(body, expiryNow(request, testMode));
        const origin = requestOrigin(request, baseUrl, trustProxy);
        for (let attempt = 0; attempt < 3; attempt++) {
          const id = randomBytes(18).toString('base64url');
          if (await store.create({ id, ...paste })) {
            return send(response, 201, { id, url: `${origin}/p/${id}` });
          }
        }
        throw new Error('Failed to allocate a unique identifier.');
      }
      const match = /^\/(api\/pastes|p)\/([^/]+)$/.exec(path);
      if (match) {
        // Deliberately reject HEAD: link probes must not silently consume a view.
        requireMethod(request, response, ['GET']);
        const id = match[2];
        const now = expiryNow(request, testMode);
        const paste = /^[A-Za-z0-9_-]{24}$/.test(id) ? await store.consume(id, now) : null;
        if (!paste) throw new HttpError(404, 'This paste is unavailable. It may have expired, reached its view limit, or never existed.');
        return isApi
          ? send(response, 200, paste)
          : send(response, 200, renderPaste(paste), 'text/html; charset=utf-8');
      }
      if (Object.hasOwn(PUBLIC_FILES, path)) {
        requireMethod(request, response, ['GET', 'HEAD']);
        const [filename, type] = PUBLIC_FILES[path];
        const body = await readFile(new URL(`../public/${filename}`, import.meta.url));
        return send(response, 200, body, type, request.method === 'HEAD');
      }
      throw new HttpError(404, 'The requested page does not exist.');
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof HttpError ? error.status : 503;
      const message = error instanceof HttpError ? error.message : 'Storage is temporarily unavailable. Please try again shortly.';
      // Never serialize storage exceptions: they can contain URLs or credentials.
      return isApi
        ? send(response, status, { error: message }, undefined, request.method === 'HEAD')
        : send(response, status, renderError(status, message), 'text/html; charset=utf-8', request.method === 'HEAD');
    }
  };
}
