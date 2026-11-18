import { createRedisStore } from './redis.mjs';

export async function createStore(env = process.env, { serverless = env.VERCEL === '1' } = {}) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  const driver = env.STORAGE_DRIVER || (url || token || serverless ? 'redis' : 'sqlite');
  if (driver === 'redis') {
    if (!url || !token) throw new Error('Redis requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    return createRedisStore({ url, token });
  }
  if (driver !== 'sqlite') throw new Error('STORAGE_DRIVER must be sqlite or redis.');
  if (serverless) throw new Error('Vercel requires shared Redis persistence. Set STORAGE_DRIVER=redis.');
  const { createSqliteStore } = await import('./sqlite.mjs');
  return createSqliteStore(env.DATABASE_PATH || './data/pastes.sqlite');
}
