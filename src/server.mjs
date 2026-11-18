import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createStore } from './store/index.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');

const store = await createStore();
const server = createServer(createApp({
  store,
  testMode: process.env.TEST_MODE === '1',
  baseUrl: process.env.APP_BASE_URL,
  trustProxy: process.env.TRUST_PROXY === '1',
}));
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`Listening on port ${port}`);
  console.log(`Local: ${new URL(`http://${process.env.HOST || '127.0.0.1'}:${port}`).href}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => {
    store.close?.();
    process.exit(0);
  }));
}
