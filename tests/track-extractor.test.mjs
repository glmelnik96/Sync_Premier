import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTrackExtractor } from './load-track-extractor.mjs';

const SNAP = {
  clips: [
    { trackType: 'audio', trackIndex: 0, nodeId: 'a', startSec: 0,  endSec: 10, inPointSec: 5,  outPointSec: 15 },
    { trackType: 'audio', trackIndex: 0, nodeId: 'b', startSec: 12, endSec: 20, inPointSec: 0,  outPointSec: 8  },
    { trackType: 'audio', trackIndex: 1, nodeId: 'c', startSec: 3,  endSec: 9,  inPointSec: 2,  outPointSec: 8  }
  ]
};

test('clipsForTrack фильтрует по типу и индексу, сортирует по startSec', () => {
  const TE = loadTrackExtractor();
  const r = TE.clipsForTrack(SNAP, 'audio', 0);
  // r — массив из vm-контекста; сравниваем значения без привязки к прототипу realm
  assert.equal(Array.from(r, c => c.nodeId).join(','), 'a,b');
});

test('mediaToSequenceSec: media-время → sequence-время', () => {
  const TE = loadTrackExtractor();
  const clip = SNAP.clips[0]; // start=0, in=5
  // mediaSec=5 (начало in) → seq=0; mediaSec=7 → seq=2
  assert.ok(Math.abs(TE.mediaToSequenceSec(clip, 5) - 0) < 1e-9);
  assert.ok(Math.abs(TE.mediaToSequenceSec(clip, 7) - 2) < 1e-9);
});

test('trackCoverageSec суммирует длительности клипов дорожки', () => {
  const TE = loadTrackExtractor();
  assert.ok(Math.abs(TE.trackCoverageSec(SNAP, 'audio', 0) - 18) < 1e-9); // 10 + 8
});
