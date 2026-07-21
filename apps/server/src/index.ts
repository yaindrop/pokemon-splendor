import path from 'node:path';
import { createRoomServer } from './room-server.js';

const app = createRoomServer({
  host: process.env['HOST'] ?? '0.0.0.0',
  port: Number(process.env['PORT'] ?? 3000),
  dataDir: path.resolve(process.env['DATA_DIR'] ?? './data/rooms'),
  allowedOrigins: (process.env['PUBLIC_ORIGIN'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
});

let stopping = false;

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: 'error', event: 'shutdown_failed', message }));
    process.exit(1);
  }
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

try {
  await app.listen();
  const address = app.address();
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'listening',
      host: address.address,
      port: address.port,
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed', message }));
  process.exit(1);
}
