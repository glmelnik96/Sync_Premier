/**
 * Загружает ES5-IIFE DSP-модули плагина (client/shared) в общий vm-контекст и
 * возвращает их глобалы. Переиспользует протестированный движок без изменений:
 * SyncCore (FFT-NCC), SyncGraph (граф комнат), SyncRunner, AudioEnvelope (ffmpeg).
 *
 * В отличие от тест-лоадера, прокидывает РАБОЧИЙ require/process/Buffer, чтобы
 * AudioEnvelope.extractEnvelope реально вызывал ffmpeg.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sharedDir = resolve(__dirname, '../client/shared');

export function loadDsp() {
  const realRequire = createRequire(import.meta.url);
  const ctx = {
    Array, Object, Math, String, Number, JSON, Error, RegExp, console, undefined,
    Float64Array, Float32Array, Int16Array, Uint8Array, Map, Promise, setTimeout, Date,
    require: realRequire, process, Buffer,
    module: { exports: {} }, exports: {}
  };
  ctx.global = ctx; ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['sync-core.js', 'sync-graph.js', 'track-extractor.js', 'audio-envelope.js', 'sync-runner.js']) {
    vm.runInContext(readFileSync(resolve(sharedDir, f), 'utf8'), ctx, { filename: f });
  }
  return {
    SyncCore: ctx.SyncCore,
    SyncGraph: ctx.SyncGraph,
    SyncRunner: ctx.SyncRunner,
    AudioEnvelope: ctx.AudioEnvelope,
    TrackExtractor: ctx.TrackExtractor
  };
}
