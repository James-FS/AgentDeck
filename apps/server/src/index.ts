import { createApp, startLocalServer } from './app.js';

process.env.NODE_ENV ??= 'production';
const app = createApp({ port: Number(process.env.PORT ?? 4780) });
await startLocalServer(app, Number(process.env.PORT ?? 4780));

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
