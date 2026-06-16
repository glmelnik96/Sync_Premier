/**
 * Sync_Premier standalone — FCP7 XML round-trip синхронизатор.
 * Вход: FCP7 XML (экспорт секвенции из Premiere). Выход: FCP7 XML со
 * синхронизированной раскладкой (импортируется в Premiere как новая секвенция).
 *
 * Пайплайн: parse XML → snapshot.clips → SyncRunner.runClipSync (FFT-NCC + граф
 * комнат, ffmpeg-огибающие реальных медиа) → переписать clipitem <start>/<end>;
 * несвязанные клипы → в конец + красный label (Rose). Никакой мутации живого
 * таймлайна: Premiere строит свежую секвенцию импортом.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadDsp } from './load-dsp.mjs';

const FRAME = 1001 / 24000; // сек/кадр @23.976 (timebase 24, ntsc TRUE)

function decodePathUrl(u) {
  let s = String(u).replace(/^file:\/\/localhost\//, '').replace(/^file:\/\//, '');
  try { s = decodeURIComponent(s); } catch (e) {}
  return s; // напр. D:/ClientFirst №4/Proxy/A048_..._Proxy.mov
}

/** Парс FCP7 XML → {clipitems:[{id,start,end,inP,out,path,type,block}], audioRegionStart} */
function parseXml(xml) {
  // граница аудио-региона секвенции (после неё clipitem'ы — аудио)
  const audioRegionStart = xml.indexOf('\n\t\t\t<audio>');
  // file id → pathurl (только из полных <file> блоков с телом)
  const fileById = {};
  const fileRe = /<file id="([^"]+)"\s*>([\s\S]*?)<\/file>/g;
  let fm;
  while ((fm = fileRe.exec(xml))) {
    const pm = fm[2].match(/<pathurl>([\s\S]*?)<\/pathurl>/);
    if (pm) fileById[fm[1]] = decodePathUrl(pm[1]);
  }
  // clipitem'ы
  const clips = [];
  const ciRe = /<clipitem id="([^"]+)"[^>]*>([\s\S]*?)<\/clipitem>/g;
  let cm;
  while ((cm = ciRe.exec(xml))) {
    const id = cm[1], body = cm[2], offset = cm.index;
    const num = (re) => { const x = body.match(re); return x ? parseInt(x[1], 10) : null; };
    const start = num(/<start>(-?\d+)<\/start>/);
    const end = num(/<end>(-?\d+)<\/end>/);
    const inP = num(/<in>(-?\d+)<\/in>/);
    const out = num(/<out>(-?\d+)<\/out>/);
    const fidM = body.match(/<file id="([^"]+)"/);
    const fid = fidM ? fidM[1] : null;
    const nameM = body.match(/<name>([\s\S]*?)<\/name>/);
    const type = offset < audioRegionStart ? 'video' : 'audio';
    clips.push({ id, start, end, inP, out, fid, path: fid ? fileById[fid] : null,
      name: nameM ? nameM[1] : id, type, fullMatch: cm[0] });
  }
  return { clips, fileById };
}

async function main() {
  const IN = process.argv[2] || 'tmp_syroi.xml';
  const OUT = process.argv[3] || 'tmp_syroi_synced.xml';
  const dsp = loadDsp();
  let xml = readFileSync(IN, 'utf8');
  const { clips } = parseXml(xml);
  console.log(`parsed ${clips.length} clipitems (${clips.filter(c => c.type === 'video').length} video, ${clips.filter(c => c.type === 'audio').length} audio)`);

  // snapshot для DSP: все клипы, кадры → секунды
  const snapClips = clips.map((c) => ({
    nodeId: c.id, name: c.name, trackType: c.type, mediaPath: c.path,
    trackIndex: 0,
    startSec: c.start * FRAME, endSec: c.end * FRAME, inPointSec: c.inP * FRAME
  }));
  const snapshot = { clips: snapClips };

  console.log('running DSP (ffmpeg-огибающие + FFT-NCC + граф комнат)…');
  const rows = await dsp.SyncRunner.runClipSync(snapshot,
    { extractEnvelope: dsp.AudioEnvelope.extractEnvelope },
    { refGate: 0.45, clipGate: 0.4, coarseWindowMs: 20 });

  // target/status по ключу (path + исходный startFrame): связанные video+audio совпадают
  const keyOf = (path, startFrames) => path + '|' + startFrames;
  const targetByKey = {}, statusByKey = {}, compByKey = {};
  // сопоставить строки с исходными аудио-клипами по nodeId
  const clipById = {}; clips.forEach((c) => { clipById[c.id] = c; });
  for (const r of rows) {
    const c = clipById[r.nodeId]; if (!c) continue;
    const k = keyOf(c.path, c.start);
    targetByKey[k] = r.targetSec;
    statusByKey[k] = r.status;
    compByKey[k] = r.component;
  }

  // применить: переписать <start>/<end> и label для КАЖДОГО clipitem (video+audio)
  let synced = 0, unsynced = 0, untouched = 0, maxEndFrames = 0;
  for (const c of clips) {
    const k = keyOf(c.path, c.start);
    let block = c.fullMatch;
    if (targetByKey.hasOwnProperty(k)) {
      const dur = c.end - c.start;
      let newStart = Math.round(targetByKey[k] / FRAME);
      if (newStart < 0) newStart = 0;
      const newEnd = newStart + dur;
      block = block
        .replace(/<start>-?\d+<\/start>/, `<start>${newStart}</start>`)
        .replace(/<end>-?\d+<\/end>/, `<end>${newEnd}</end>`);
      if (newEnd > maxEndFrames) maxEndFrames = newEnd;
      if (statusByKey[k] === 'unsynced') {
        block = block.replace(/<labels>[\s\S]*?<\/labels>/, '<labels>\n\t\t\t\t\t\t<label2>Rose</label2>\n\t\t\t\t\t</labels>');
        unsynced++;
      } else synced++;
    } else {
      untouched++;
    }
    if (block !== c.fullMatch) xml = xml.replace(c.fullMatch, block);
  }

  // имя секвенции
  xml = xml.replace(/<name>([^<]*)<\/name>/, (m, n) => `<name>${n}_SYNCED</name>`);

  // ВАЖНО: привязать параметры секвенции к реальному концу контента, иначе остаётся
  // фантомный пустой хвост от исходной секвенции, а унаследованный playhead (MZ.EditLine)
  // садится в пустую зону → «play улетает в начало», стоп-кадры в превью.
  const TICKS_PER_FRAME = 10594584000;
  const endTicks = maxEndFrames * TICKS_PER_FRAME;
  xml = xml.replace(/(<sequence\b[^>]*?)>/, (full, head) => {
    let h = head;
    h = h.replace(/MZ\.EditLine="[0-9]+"/, 'MZ.EditLine="0"');
    h = h.replace(/MZ\.WorkInPoint="[0-9]+"/, 'MZ.WorkInPoint="0"');
    h = h.replace(/MZ\.WorkOutPoint="[0-9]+"/, `MZ.WorkOutPoint="${endTicks}"`);
    h = h.replace(/Monitor\.ProgramZoomOut="[0-9]+"/, `Monitor.ProgramZoomOut="${endTicks}"`);
    h = h.replace(/Monitor\.ProgramZoomIn="[0-9]+"/, 'Monitor.ProgramZoomIn="0"');
    return h + '>';
  });
  // <duration> секвенции (первый <duration> после <uuid>) → конец контента в кадрах
  xml = xml.replace(/(<\/uuid>\s*<duration>)\d+(<\/duration>)/, `$1${maxEndFrames}$2`);

  writeFileSync(OUT, xml, 'utf8');
  console.log(`seq duration → ${maxEndFrames} frames (${Math.round(maxEndFrames * FRAME)}s), playhead → 0`);
  console.log(`synced=${synced} unsynced(Rose)=${unsynced} untouched=${untouched} → ${OUT}`);
  // краткая сводка строк
  const bySrc = {};
  for (const r of rows) {
    const c = clipById[r.nodeId]; if (!c) continue;
    const nm = (c.path || '').split(/[\/\\]/).pop();
    if (!bySrc[nm]) bySrc[nm] = { status: r.status, comp: r.component, conf: +(r.confidence || 0).toFixed(2), tgt: Math.round(r.targetSec) };
  }
  console.log('sources:', JSON.stringify(bySrc, null, 0));
}

main().catch((e) => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
