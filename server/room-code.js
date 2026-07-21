const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE = /^[A-Z2-9]{8}$/;

function isRoomCode(value) {
  return typeof value === 'string' && ROOM_CODE.test(value);
}

function randomRoomCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

module.exports = { isRoomCode, randomRoomCode };
