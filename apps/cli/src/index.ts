#!/usr/bin/env node
import { createApp, startLocalServer } from '@agentdeck/server';

const [command = 'help', ...args] = process.argv.slice(2);
if (command === 'serve') {
  process.env.NODE_ENV ??= 'production';
  const portArg = args.find(arg => arg.startsWith('--port='))?.slice('--port='.length);
  const port = Number(portArg ?? process.env.PORT ?? 4780);
  const app = createApp({ port });
  await startLocalServer(app, port);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
} else {
  process.stdout.write('AgentDeck CLI\n\nUsage: agentdeck serve [--port=4780]\n\nFirst-round CLI support is limited to starting the local web service.\n');
}
