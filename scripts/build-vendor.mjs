// Rebuilds vendor/: one ESM bundle of the JS libraries, plus DuckDB-WASM's worker + wasm files.
// Run: npm install && npm run build:vendor
import { build } from 'esbuild';
import fs from 'node:fs';
const dist = 'node_modules/@duckdb/duckdb-wasm/dist/';
await build({ entryPoints: ['src/vendor-entry.js'], bundle: true, format: 'esm', minify: true, target: 'es2020', outfile: 'vendor/lib.js', legalComments: 'none', logLevel: 'info' });
fs.mkdirSync('vendor/duckdb', { recursive: true });
for (const f of ['duckdb-eh.wasm', 'duckdb-mvp.wasm', 'duckdb-browser-eh.worker.js', 'duckdb-browser-mvp.worker.js']) fs.copyFileSync(dist + f, 'vendor/duckdb/' + f);
// strip sourceMappingURL comments so browsers don't 404 on missing .map files
for (const f of ['duckdb-browser-eh.worker.js', 'duckdb-browser-mvp.worker.js']) { const p = 'vendor/duckdb/' + f; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '')); }
const ver = JSON.parse(fs.readFileSync('node_modules/@duckdb/duckdb-wasm/package.json', 'utf8')).version;
fs.writeFileSync('vendor/VERSIONS.txt', `@duckdb/duckdb-wasm ${ver} (DuckDB engine v1.4.3)\nExtensions in ext/ come from https://extensions.duckdb.org/v1.4.3/<platform>/ (signed by DuckDB)\n`);
console.log('vendor built for duckdb-wasm', ver);
