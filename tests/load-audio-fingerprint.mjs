import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../client/shared/audio-fingerprint.js');

export function loadAudioFingerprint() {
  const code = readFileSync(SRC, 'utf8');
  const ctx = {
    Array, Object, Math, String, Number, JSON, Error, RegExp,
    Float32Array, Float64Array, Int32Array, Map, console, Infinity, undefined,
    module: { exports: {} }, exports: {}
  };
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.AudioFingerprint || ctx.module.exports;
}
