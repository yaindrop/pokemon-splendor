const path = require('path');
const { createRoomServer } = require('./room-server.js');

const app = createRoomServer({
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  dataDir: path.resolve(process.env.DATA_DIR || './data/rooms'),
  allowedOrigins: String(process.env.PUBLIC_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean),
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'shutdown_failed', message: error.message }));
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void stop('SIGTERM'); });
process.on('SIGINT', () => { void stop('SIGINT'); });

app.listen().then(() => {
  const address = app.address();
  console.log(JSON.stringify({ level: 'info', event: 'listening', host: address.address, port: address.port }));
}).catch((error) => {
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed', message: error.message }));
  process.exit(1);
});
