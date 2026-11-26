// Fixed, synthetic test. No real credentials, network destinations or host paths.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const [root, portText] = process.argv.slice(2);
const own = path.join(root, 'work');
const secret = path.join(root, 'protected', 'sentinel.txt');
const tool = path.join(root, 'tool', 'sentinel.txt');
const sibling = path.join(root, 'sibling', 'sentinel.txt');
const checks = [];
function denied(name, fn) {
  let error;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error && ['EACCES','EPERM'].includes(error.code), name + ': expected access denied');
  checks.push(name);
}
async function loopbackDenied() {
  await new Promise((resolve, reject) => {
    const client = net.createConnection({host:'127.0.0.1',port:Number(portText)});
    client.once('connect', () => { client.destroy(); reject(new Error('Unexpected loopback connection')); });
    client.once('error', () => { client.destroy(); resolve(); });
    client.setTimeout(2000, () => { client.destroy(); resolve(); });
  });
  checks.push('loopback-no-connect');
}
(async () => {
  assert.equal(process.env.DSU_SYNTHETIC_PRIVATE_ENV, undefined);
  checks.push('environment-isolated');
  fs.writeFileSync(path.join(own,'positive.txt'),'approved');
  assert.equal(fs.readFileSync(path.join(own,'positive.txt'),'utf8'),'approved');
  checks.push('workspace-write-read');
  assert.equal(fs.readFileSync(tool,'utf8'),'synthetic');
  checks.push('tool-read');
  denied('tool-write', () => fs.writeFileSync(tool,'unexpected'));
  denied('protected-read', () => fs.readFileSync(secret,'utf8'));
  denied('protected-write', () => fs.writeFileSync(secret,'unexpected'));
  denied('protected-delete', () => fs.unlinkSync(secret));
  denied('sibling-read', () => fs.readFileSync(sibling,'utf8'));
  denied('sibling-write', () => fs.writeFileSync(sibling,'unexpected'));
  await loopbackDenied();
  fs.writeFileSync(path.join(own,'report.json'),JSON.stringify({checks,arch:process.arch}));
})().catch(e=>{
  console.error('Synthetic probe failed after checks:',JSON.stringify(checks));
  console.error(e && e.code ? e.code : 'ASSERTION', e.message);
  process.exitCode=1;
});
