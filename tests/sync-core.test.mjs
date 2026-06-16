import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSyncCore } from './load-sync-core.mjs';

test('SyncCore загружается и экспортирует normXCorr', () => {
  const SC = loadSyncCore();
  assert.equal(typeof SC.normXCorr, 'function');
});
