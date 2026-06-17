/**
 * Sync_Premier standalone CLI — FCP7 XML round-trip синхронизатор.
 * Использует общий движок client/shared/fcpxml-transform.js (тот же, что и плагин-гибрид).
 *
 * Usage: node standalone/sync-xml.mjs вход.xml [выход.xml]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadDsp } from './load-dsp.mjs';

async function main() {
  const IN = process.argv[2] || 'tmp_syroi.xml';
  const OUT = process.argv[3] || 'tmp_syroi_synced.xml';
  const dsp = loadDsp();        // грузит client/shared в Node vm (включая FcpXmlTransform)
  const T = dsp.FcpXmlTransform;
  if (!T) throw new Error('FcpXmlTransform не загружен (проверь load-dsp.mjs)');

  const xml = readFileSync(IN, 'utf8');
  const rate = T.deriveRate(xml);
  const { clips } = T.parseXml(xml);
  console.log(`parsed ${clips.length} clipitems @ ${rate.timebase}${rate.ntsc ? '(ntsc)' : ''}fps`);

  const snapshot = T.buildSnapshot(clips, rate.frameSec);
  console.log('running DSP (ffmpeg-огибающие + FFT-NCC + граф комнат)…');
  const rows = await dsp.SyncRunner.runClipSync(snapshot,
    { extractEnvelope: dsp.AudioEnvelope.extractEnvelope },
    { refGate: 0.45, clipGate: 0.4, coarseWindowMs: 20 });

  const res = T.applySyncToXml(xml, clips, rows, { frameSec: rate.frameSec, ticksPerFrame: rate.ticksPerFrame });
  writeFileSync(OUT, res.xml, 'utf8');
  const s = res.stats;
  console.log(`_SYNCED: ${s.synced} клипов синхронно (0–${s.syncedEndSec}s)` +
    (s.tcRescued ? `, ${s.tcRescued} по timecode` : '') +
    (s.hasUnsynced ? `, ${s.unsynced} без связи в конце (красные, до ${s.unsyncedEndSec}s)` : '') +
    ` → ${OUT}`);
}

main().catch((e) => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
