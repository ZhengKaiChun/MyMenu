import { buildApp } from './app.mjs';
import { pruneHistory } from './jobs/retention.mjs';
const { app, db, config } = await buildApp();
await pruneHistory(db);
const timer = setInterval(
  () => pruneHistory(db).catch(() => app.log.error('Retention job failed')),
  6 * 60 * 60 * 1000,
);
timer.unref();
await app.listen({ host: config.host, port: config.port });
console.log('给我饭 API: ' + config.origin);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  });
