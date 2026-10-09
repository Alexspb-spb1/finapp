import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
const BASE = path.join(REPO, 'docs/remediation/evidence/M1-STAGING-RECON-REMAINDER-PREP-04/package-recon-source');
const hash = b => createHash('sha256').update(b).digest('hex');
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]).sort();
export function buildRemainder(output) {
  if (fs.existsSync(output)) throw new Error('OUTPUT_EXISTS');
  if (hash(fs.readFileSync(path.join(BASE, 'CODE-SHA256SUMS.txt'))) !== 'af4aef5c35cb58a2b03f074d39e34a2a10d34afcbc8e7d9abfaf51d8510e67b6') throw new Error('BASE_MANIFEST_CHANGED');
  const before = Object.fromEntries(walk(BASE).map(f => [f, hash(fs.readFileSync(path.join(BASE, f)))]));
  for (const line of fs.readFileSync(path.join(BASE, 'CODE-SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!m || before[m[2]] !== m[1]) throw new Error('BASE_BYTES_CHANGED');
  }
  fs.cpSync(BASE, output, { recursive: true, force: false, errorOnExist: true });
  const pinsPath = path.join(output, 'recon-pins.mjs');
  let pins = fs.readFileSync(pinsPath, 'utf8');
  for (const [a, b] of [
    ["taskId: 'M1-STAGING-RECON-REMAINDER-PREP-04'", "taskId: 'M1-STAGING-RECON-REMAINDER-PREP-05'"],
    ["evidenceName: 'm1-stg-readonly-recon-04'", "evidenceName: 'm1-stg-readonly-recon-05'"],
    ["consumedNames: Object.freeze(['m1-stg-readonly-recon-03'", "consumedNames: Object.freeze(['m1-stg-readonly-recon-04', 'm1-stg-readonly-recon-03'"]
  ]) {
    if (pins.split(a).length !== 2) throw new Error('ANCHOR_NOT_UNIQUE');
    pins = pins.replace(a, b);
  }
  fs.writeFileSync(pinsPath, pins);
  const sums = walk(output).filter(f => f !== 'CODE-SHA256SUMS.txt').map(f => `${hash(fs.readFileSync(path.join(output, f)))}  ${f}`).join('\n') + '\n';
  fs.writeFileSync(path.join(output, 'CODE-SHA256SUMS.txt'), sums);
  const after = Object.fromEntries(walk(output).map(f => [f, hash(fs.readFileSync(path.join(output, f)))]));
  const changed = Object.keys(after).filter(f => after[f] !== before[f]);
  if (JSON.stringify(changed.sort()) !== JSON.stringify(['CODE-SHA256SUMS.txt', 'recon-pins.mjs'])) throw new Error('UNEXPECTED_CHANGED_FILE');
  return { baseHead: '99407f21f81bf201e5ef9ff58398dadce00397bf', files: Object.keys(after).length, changed, hashes: after, manifestSha256: after['CODE-SHA256SUMS.txt'], pinsSha256: after['recon-pins.mjs'] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildRemainder(path.resolve(process.argv[2])), null, 2));
