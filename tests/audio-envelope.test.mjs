import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAudioEnvelope } from './load-audio-envelope.mjs';

test('pcmToEnvelope: окно 5мс @8кГц → dt=0.005, RMS корректен', () => {
  const AE = loadAudioEnvelope();
  const sr = 8000;
  const win = Math.round(0.005 * sr); // 40 сэмплов
  const pcm = new Float32Array(win * 3);
  for (let i = 0; i < win; i++) pcm[i] = 0;            // тишина
  for (let i = win; i < win * 2; i++) pcm[i] = 0.5;    // постоянный 0.5 → RMS=0.5
  for (let i = win * 2; i < win * 3; i++) pcm[i] = -1; // RMS=1
  const { dtSec, env } = AE.pcmToEnvelope(pcm, sr, 5);
  assert.ok(Math.abs(dtSec - 0.005) < 1e-9);
  assert.equal(env.length, 3);
  assert.ok(Math.abs(env[0] - 0) < 1e-6);
  assert.ok(Math.abs(env[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(env[2] - 1) < 1e-6);
});
