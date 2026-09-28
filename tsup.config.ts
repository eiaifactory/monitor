import { defineConfig } from 'tsup';

// Cada entrada sale entera en su archivo (sin chunks compartidos): el navegador se mide solo
// contra su presupuesto de 4 KB gzip, y Deno importa un único archivo.
export default defineConfig({
  entry: { browser: 'src/browser/index.ts', deno: 'src/deno/index.ts' },
  format: 'esm',
  platform: 'neutral',
  target: 'es2020',
  splitting: false,
  minify: true,
  dts: true,
  clean: true,
});
