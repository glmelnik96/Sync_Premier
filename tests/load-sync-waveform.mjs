import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/sync-waveform.js');

export function loadSyncWaveform() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = { Array, Object, Math, String, Number, JSON, Error, console, undefined,
    Float64Array,
    module: { exports: {} }, exports: {} };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.SyncWaveform || ctx.module.exports;
}
