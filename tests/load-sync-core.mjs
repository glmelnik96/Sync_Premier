import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/sync-core.js');

export function loadSyncCore() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = {
    Array, Object, Math, String, Number, JSON, Error, RegExp,
    Float32Array, Float64Array, Map, console, undefined,
    module: { exports: {} }, exports: {}
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.SyncCore || ctx.module.exports;
}
