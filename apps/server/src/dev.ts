import { createApp, startLocalServer } from './app.js';

process.env.NODE_ENV = 'development';
const port = Number(process.env.PORT ?? 4780);
const app = createApp({ port, devMode: true, discoveryEnv: {} });
await startLocalServer(app, port);
const shutdown = async () => { await app.close(); process.exit(0); };
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
