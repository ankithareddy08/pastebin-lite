export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_DATE_MS = 8_640_000_000_000_000;

export function expiryNow(request, testMode) {
  const header = request.headers['x-test-now-ms'];
  if (!testMode || header === undefined) return Date.now();
  if (typeof header !== 'string' || !/^-?\d+$/.test(header)) {
    throw new HttpError(400, 'x-test-now-ms must be an integer timestamp in milliseconds.');
  }
  const value = Number(header);
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_DATE_MS) {
    throw new HttpError(400, 'x-test-now-ms must be a valid timestamp in milliseconds.');
  }
  return value;
}

export function validatePaste(body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'The request body must be a JSON object.');
  }
  if (typeof body.content !== 'string' || body.content.length === 0) {
    throw new HttpError(400, 'content is required and must be a non-empty string.');
  }
  for (const key of ['ttl_seconds', 'max_views']) {
    if (Object.hasOwn(body, key) && (!Number.isSafeInteger(body[key]) || body[key] < 1)) {
      throw new HttpError(400, `${key} must be an integer greater than or equal to 1.`);
    }
  }
  const expiresAt = body.ttl_seconds === undefined ? null : now + body.ttl_seconds * 1000;
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || Math.abs(expiresAt) > MAX_DATE_MS)) {
    throw new HttpError(400, 'ttl_seconds produces an expiry date outside the supported range.');
  }
  return { content: body.content, expiresAt, maxViews: body.max_views ?? null };
}

export function requestOrigin(request, baseUrl, trustProxy) {
  const protocol = trustProxy
    ? request.headers['x-forwarded-proto']?.split(',')[0].trim() || 'https'
    : request.socket.encrypted ? 'https' : 'http';
  const host = (trustProxy && request.headers['x-forwarded-host']?.split(',')[0].trim()) || request.headers.host;
  try {
    const url = new URL(baseUrl || `${protocol}://${host}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname ||
        (!baseUrl && (url.pathname !== '/' || url.search || url.hash))) throw new Error();
    return url.origin;
  } catch {
    throw new HttpError(400, 'Cannot determine a valid origin for the share link.');
  }
}
