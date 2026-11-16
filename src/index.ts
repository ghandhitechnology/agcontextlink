import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { config } from './config.ts';
import { pool, runMigrations } from './db/client.ts';
import { startListening, stopListening } from './core/events.ts';
import { sweepEndedRooms } from './core/rooms.ts';

await runMigrations();
await startListening();

const sweep = () => sweepEndedRooms().catch((error) => console.error('sweep', error.message));
await sweep();
const sweeper = setInterval(sweep, 60_000);

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`agcontextlink on :${port} as ${config.publicUrl}`);
});

async function shutdown() {
  clearInterval(sweeper);
  server.close();
  await stopListening();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
