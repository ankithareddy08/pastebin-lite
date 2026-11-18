import { createApp } from '../src/app.mjs';
import { createStore } from '../src/store/index.mjs';

export default async function handler(request, response) {
  let store;
  try {
    store = await createStore(process.env, { serverless: true });
  } catch {
    // Keep health and error responses valid JSON even when env setup is missing.
    store = {
      health: () => false,
      create: () => { throw new Error('Storage is not configured.'); },
      consume: () => { throw new Error('Storage is not configured.'); },
    };
  }
  return createApp({ store, testMode: process.env.TEST_MODE === '1', baseUrl: process.env.APP_BASE_URL, trustProxy: true })(request, response);
}
