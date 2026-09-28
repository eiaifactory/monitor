// El presupuesto del spec: la entrada del navegador pesa ≤ 4 KB gzip. Corre después del build.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const PRESUPUESTO = 4 * 1024;
const bytes = gzipSync(readFileSync(new URL('../dist/browser.js', import.meta.url)), { level: 9 }).length;

console.log(`dist/browser.js: ${bytes} B gzip (presupuesto ${PRESUPUESTO} B)`);
if (bytes > PRESUPUESTO) {
  console.error(`Se pasó del presupuesto por ${bytes - PRESUPUESTO} B.`);
  process.exit(1);
}
