'use strict';

const assert = require('assert');
const { checkSource, isPublicHostname, isPublicIp } = require('../src/source-check');

async function main() {
  assert.strictEqual(isPublicHostname('localhost'), false);
  assert.strictEqual(isPublicHostname('192.168.1.20'), false);
  assert.strictEqual(isPublicIp('::ffff:127.0.0.1'), false);
  const lookupPublic = async () => [{ address: '203.0.113.22', family: 4 }];
  const lookupInternet = async () => [{ address: '8.8.8.8', family: 4 }];
  assert.strictEqual((await checkSource('https://video.example/good', { lookupImpl: lookupInternet, fetchImpl: async () => ({ status: 204 }) })).status, 'available');
  assert.strictEqual((await checkSource('https://video.example/gone', { lookupImpl: lookupInternet, fetchImpl: async () => ({ status: 404 }) })).status, 'missing');
  assert.strictEqual((await checkSource('https://video.example/redirect', { lookupImpl: lookupInternet, fetchImpl: async () => ({ status: 302 }) })).status, 'redirect');
  assert.strictEqual((await checkSource('https://rebinding.example/private', { lookupImpl: lookupPublic, fetchImpl: async () => { throw new Error('non deve essere chiamato'); } })).status, 'unsupported');
  assert.strictEqual((await checkSource('http://127.0.0.1/private', { fetchImpl: async () => { throw new Error('non deve essere chiamato'); } })).status, 'unsupported');
  console.log('Controllo link: esiti HTTP e blocco indirizzi locali verificati con risposte simulate.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
