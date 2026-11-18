// All constraint checks and view consumption run inside one Redis operation.
// Native Redis TTL is deliberately omitted: assignment tests can override time.
const CREATE = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1],
  'content_json', ARGV[1], 'expires_at', ARGV[2], 'remaining_views', ARGV[3])
return 1
`;

const CONSUME = `
local paste = redis.call('HMGET', KEYS[1], 'content_json', 'expires_at', 'remaining_views')
if not paste[1] then
  return nil
end
if paste[2] ~= '' and tonumber(ARGV[1]) >= tonumber(paste[2]) then
  redis.call('DEL', KEYS[1])
  return nil
end
if paste[3] ~= '' then
  if tonumber(paste[3]) <= 0 then
    redis.call('DEL', KEYS[1])
    return nil
  end
  redis.call('HINCRBY', KEYS[1], 'remaining_views', -1)
  paste[3] = redis.call('HGET', KEYS[1], 'remaining_views')
  if paste[3] == '0' then
    redis.call('DEL', KEYS[1])
  end
end
return paste
`;

function unavailable() {
  // Never include the upstream body, URL or credentials in errors/logs.
  return new Error('Persistence service is unavailable.');
}

export function createRedisStore({ url, token, prefix = 'pastebin:' }) {
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error('Redis requires a valid REST endpoint.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Redis REST endpoint must be an HTTPS origin without credentials.');
  }
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('Redis requires a REST token.');
  }
  if (typeof prefix !== 'string' || !prefix) {
    throw new Error('Redis requires a non-empty key prefix.');
  }

  async function command(args) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response.ok) throw unavailable();
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || payload.error ||
          !Object.hasOwn(payload, 'result')) {
        throw unavailable();
      }
      return payload.result;
    } catch {
      // A request may have committed before its response was lost. Retrying a
      // consume operation would spend another view, so there are no retries.
      throw unavailable();
    }
  }

  return {
    async health() {
      try {
        return await command(['PING']) === 'PONG';
      } catch {
        return false;
      }
    },

    async create({ id, content, expiresAt, maxViews }) {
      const result = await command([
        'EVAL', CREATE, 1, prefix + id, JSON.stringify(content),
        expiresAt === null ? '' : String(expiresAt),
        maxViews === null ? '' : String(maxViews),
      ]);
      if (result !== 0 && result !== 1) throw unavailable();
      return result === 1;
    },

    async consume(id, now) {
      const result = await command(['EVAL', CONSUME, 1, prefix + id, String(now)]);
      if (result === null) return null;
      if (!Array.isArray(result) || result.length !== 3 ||
          result.some(value => typeof value !== 'string')) throw unavailable();
      try {
        const content = JSON.parse(result[0]);
        const remaining = result[2] === '' ? null : Number(result[2]);
        if (typeof content !== 'string' ||
            (remaining !== null && (!Number.isSafeInteger(remaining) || remaining < 0))) {
          throw unavailable();
        }
        return {
          content,
          remaining_views: remaining,
          expires_at: result[1] === '' ? null : new Date(Number(result[1])).toISOString(),
        };
      } catch {
        throw unavailable();
      }
    },

    close() {},
  };
}
