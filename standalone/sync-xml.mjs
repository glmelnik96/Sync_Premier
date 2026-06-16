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
  const planByKey = {}; /* key → {targetFrames, status, comp} */
  const clipById = {}; clips.forEach((c) => { clipById[c.id] = c; });
  for (const r of rows) {
    const c = clipById[r.nodeId]; if (!c) continue;
    planByKey[keyOf(c.path, c.start)] = {
      targetFrames: Math.max(0, Math.round(r.targetSec / FRAME)),
      status: r.status, comp: r.component
    };
  }

  // ── Фаза 1: вычислить план каждого clipitem (start/end/in/out в кадрах, comp, status) ──
  for (const c of clips) {
    const p = planByKey[keyOf(c.path, c.start)];
    if (!p) { c.plan = null; continue; }
    const dur = c.end - c.start;
    c.plan = {
      start: p.targetFrames, end: p.targetFrames + dur,
      inP: c.inP, out: c.out,           // источник не сдвигается (только позиция)
      comp: p.comp, status: p.status, enabled: true, drop: false
    };
  }

  // ── Фаза 2: покрытие ВИДЕО по комнатам (для обрезки lone-аудио) ──
  const vCover = {}; /* comp → {vs, ve} в target-кадрах */
  for (const c of clips) {
    if (c.type !== 'video' || !c.plan || c.plan.status === 'unsynced') continue;
    const k = c.plan.comp;
    if (!vCover[k]) vCover[k] = { vs: c.plan.start, ve: c.plan.end };
    else { if (c.plan.start < vCover[k].vs) vCover[k].vs = c.plan.start; if (c.plan.end > vCover[k].ve) vCover[k].ve = c.plan.end; }
  }

  // ── Фаза 3 (Syncaila): обрезать lone-аудио до покрытия видео своей комнаты ──
  // Убирает стоп-кадры: и 3-мин чёрное интро (рекордер до камер), и хвост (камера off).
  let trimmedHead = 0, trimmedTail = 0, dropped = 0;
  for (const c of clips) {
    if (c.type !== 'audio' || !c.plan || c.plan.status === 'unsynced') continue;
    const cov = vCover[c.plan.comp]; if (!cov) continue;
    if (c.plan.start < cov.vs) { const d = cov.vs - c.plan.start; c.plan.start += d; c.plan.inP += d; trimmedHead += d; }
    if (c.plan.end > cov.ve) { const d = c.plan.end - cov.ve; c.plan.end -= d; c.plan.out -= d; trimmedTail += d; }
    if (c.plan.end <= c.plan.start) { c.plan.drop = true; dropped++; } // полностью вне видео
  }

  // ── Фаза 4: несвязанные клипы → выключить (enabled=FALSE) + красный label ──
  for (const c of clips) if (c.plan && c.plan.status === 'unsynced') c.plan.enabled = false;

  // ── Фаза 5: глобальный сдвиг к 0 (самый ранний оставшийся клип в 0) ──
  let gmin = null;
  for (const c of clips) if (c.plan && !c.plan.drop) { if (gmin === null || c.plan.start < gmin) gmin = c.plan.start; }
  if (gmin === null) gmin = 0;
  for (const c of clips) if (c.plan && !c.plan.drop) { c.plan.start -= gmin; c.plan.end -= gmin; }

  // ── Фаза 6: записать XML ──
  let synced = 0, unsynced = 0, untouched = 0, maxEndFrames = 0;
  for (const c of clips) {
    let block = c.fullMatch;
    if (!c.plan) { untouched++; continue; }
    if (c.plan.drop) {
      // полностью lone-аудио → убрать clipitem из секвенции
      block = '';
    } else {
      block = block
        .replace(/<start>-?\d+<\/start>/, `<start>${c.plan.start}</start>`)
        .replace(/<end>-?\d+<\/end>/, `<end>${c.plan.end}</end>`)
        .replace(/<in>-?\d+<\/in>/, `<in>${c.plan.inP}</in>`)
        .replace(/<out>-?\d+<\/out>/, `<out>${c.plan.out}</out>`);
      if (c.plan.end > maxEndFrames) maxEndFrames = c.plan.end;
      if (!c.plan.enabled) {
        block = block.replace(/<enabled>TRUE<\/enabled>/, '<enabled>FALSE</enabled>');
        block = block.replace(/<labels>[\s\S]*?<\/labels>/, '<labels>\n\t\t\t\t\t\t<label2>Rose</label2>\n\t\t\t\t\t</labels>');
        unsynced++;
      } else synced++;
    }
    if (block !== c.fullMatch) xml = xml.replace(c.fullMatch, block);
  }
  console.log(`trim: head=${trimmedHead}f tail=${trimmedTail}f dropped=${dropped} | shift→0 by ${gmin}f`);

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
