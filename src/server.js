'use strict';
const { loadDotEnv, buildConfig } = require('./config');
loadDotEnv();

const { createProvider } = require('./provider');
const { createServer } = require('./app');

async function main() {
  const cfg = buildConfig();
  const provider = await createProvider(cfg);
  if (provider.error) throw new Error('Downloader library missing - run "npm install" (or rebuild the Docker image).');
  const server = createServer(cfg, { provider });

  if (!cfg.apiKeys.length) {
    console.warn('WARNING: API_KEYS is empty - anyone who finds this server can use it. Set API_KEYS in .env');
  }
  server.listen(cfg.port, cfg.host, () => {
    console.log(`dlhub-api listening on http://${cfg.host}:${cfg.port}  (provider=${provider.name}, auth=${cfg.apiKeys.length ? 'on' : 'OFF'})`);
  });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`${sig} received, shutting down...`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref(); // don't wait forever on long downloads
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
