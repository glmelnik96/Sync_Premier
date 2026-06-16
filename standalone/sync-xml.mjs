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

  // ── Фаза 5: глобальный сдвиг СИНХРОННЫХ к 0 (самый ранний синхронный клип в 0) ──
  let gmin = null;
  for (const c of clips) if (c.plan && !c.plan.drop && c.plan.status !== 'unsynced') { if (gmin === null || c.plan.start < gmin) gmin = c.plan.start; }
  if (gmin === null) gmin = 0;
  for (const c of clips) if (c.plan && !c.plan.drop && c.plan.status !== 'unsynced') { c.plan.start -= gmin; c.plan.end -= gmin; }

  // конец синхронного контента (после сдвига)
  let syncedEnd = 0;
  for (const c of clips) if (c.plan && !c.plan.drop && c.plan.status !== 'unsynced') { if (c.plan.end > syncedEnd) syncedEnd = c.plan.end; }

  // ── Фаза 5b: несвязанные → сдвиг к 0 (для ОТДЕЛЬНОЙ секвенции _UNSYNCED).
  // Несвязанные НЕЛЬЗЯ держать в той же секвенции после синхронного контента: Premiere
  // обрезает воспроизводимую длительность по концу основного контента → клип за границей
  // виден в превью, но play туда не доходит и отскакивает в начало. Поэтому несвязанные
  // выносим в свою секвенцию (модель Syncaila — отдельный таймлайн), полностью играбельную. */
  let umin = null;
  for (const c of clips) if (c.plan && !c.plan.drop && c.plan.status === 'unsynced') { if (umin === null || c.plan.start < umin) umin = c.plan.start; }
  if (umin === null) umin = 0;
  console.log(`trim: head=${trimmedHead}f tail=${trimmedTail}f dropped=${dropped} | synced shift→0 by ${gmin}f`);

  // ── Фаза 6: собрать ДВЕ секвенции в одном xmeml ──
  const TICKS_PER_FRAME = 10594584000;
  function genUuid() { const h = () => Math.floor(Math.random() * 16).toString(16); let s = ''; for (let i = 0; i < 32; i++) s += (i === 8 || i === 12 || i === 16 || i === 20) ? '-' + h() : h(); return s; }

  let synced = 0, unsynced = 0, syncedEndF = 0, unsyncedEndF = 0;
  function renderClip(c, mode) {
    if (!c.plan || c.plan.drop) return '';                 // нет плана / lone-аудио → убрать
    const isUns = c.plan.status === 'unsynced';
    if (mode === 'synced' && isUns) return '';             // несвязанные не в главной
    if (mode === 'unsynced' && !isUns) return '';          // синхронные не в _UNSYNCED
    let s = c.plan.start, e = c.plan.end;
    if (mode === 'unsynced') { s -= umin; e -= umin; }     // сдвиг несвязанных к 0
    let block = c.fullMatch
      .replace(/<start>-?\d+<\/start>/, `<start>${s}</start>`)
      .replace(/<end>-?\d+<\/end>/, `<end>${e}</end>`)
      .replace(/<in>-?\d+<\/in>/, `<in>${c.plan.inP}</in>`)
      .replace(/<out>-?\d+<\/out>/, `<out>${c.plan.out}</out>`)
      // КРИТИЧНО: Premiere читает pproTicksIn/Out (source in/out в тиках), ИГНОРИРУЯ
      // обобщённые <in>/<out>. Без их обновления обрезка inPoint не применяется →
      // рассинхрон рекордеров (in сбрасывается в исходный). Тики = кадры * 10594584000.
      .replace(/<pproTicksIn>-?\d+<\/pproTicksIn>/, `<pproTicksIn>${c.plan.inP * TICKS_PER_FRAME}</pproTicksIn>`)
      .replace(/<pproTicksOut>-?\d+<\/pproTicksOut>/, `<pproTicksOut>${c.plan.out * TICKS_PER_FRAME}</pproTicksOut>`);
    if (isUns) block = block.replace(/<labels>[\s\S]*?<\/labels>/, '<labels>\n\t\t\t\t\t\t<label2>Rose</label2>\n\t\t\t\t\t</labels>');
    if (mode === 'synced') { synced++; if (e > syncedEndF) syncedEndF = e; }
    else { unsynced++; if (e > unsyncedEndF) unsyncedEndF = e; }
    return block;
  }

  // единственный исходный <sequence>...</sequence> → шаблон для обеих
  const seqM = xml.match(/<sequence\b[\s\S]*?<\/sequence>/);
  if (!seqM) throw new Error('<sequence> не найден');
  const seqTemplate = seqM[0];
  const xmlHead = xml.slice(0, seqM.index);
  const xmlTail = xml.slice(seqM.index + seqTemplate.length);

  function buildSeq(mode, nameSuffix, endFrames) {
    let blk = seqTemplate;
    for (const c of clips) { const rep = renderClip(c, mode); if (rep !== c.fullMatch) blk = blk.replace(c.fullMatch, rep); }
    const endTicks = endFrames * TICKS_PER_FRAME;
    blk = blk.replace(/(<sequence\b[^>]*?)>/, (full, h) => {
      h = h.replace(/MZ\.EditLine="[0-9]+"/, 'MZ.EditLine="0"');
      h = h.replace(/MZ\.WorkInPoint="[0-9]+"/, 'MZ.WorkInPoint="0"');
      h = h.replace(/MZ\.WorkOutPoint="[0-9]+"/, `MZ.WorkOutPoint="${endTicks}"`);
      h = h.replace(/Monitor\.ProgramZoomOut="[0-9]+"/, `Monitor.ProgramZoomOut="${endTicks}"`);
      h = h.replace(/Monitor\.ProgramZoomIn="[0-9]+"/, 'Monitor.ProgramZoomIn="0"');
      return h + '>';
    });
    blk = blk.replace(/(<\/uuid>\s*<duration>)\d+(<\/duration>)/, `$1${endFrames}$2`);
    blk = blk.replace(/<name>([^<]*)<\/name>/, (m, n) => `<name>${n}${nameSuffix}</name>`);
    return blk;
  }

  // сначала прогон 'synced' (заполнит syncedEndF), затем 'unsynced'
  const mainSeq = buildSeq('synced', '_SYNCED', 0);
  const mainSeqFixed = mainSeq.replace(/(<\/uuid>\s*<duration>)\d+(<\/duration>)/, `$1${syncedEndF}$2`)
    .replace(/MZ\.WorkOutPoint="[0-9]+"/, `MZ.WorkOutPoint="${syncedEndF * TICKS_PER_FRAME}"`)
    .replace(/Monitor\.ProgramZoomOut="[0-9]+"/, `Monitor.ProgramZoomOut="${syncedEndF * TICKS_PER_FRAME}"`);
  const hasUnsynced = clips.some((c) => c.plan && !c.plan.drop && c.plan.status === 'unsynced');
  let out = xmlHead + mainSeqFixed;
  if (hasUnsynced) {
    let unsSeq = buildSeq('unsynced', '_UNSYNCED', 1);
    unsSeq = unsSeq.replace(/(<\/uuid>\s*<duration>)\d+(<\/duration>)/, `$1${unsyncedEndF}$2`)
      .replace(/MZ\.WorkOutPoint="[0-9]+"/, `MZ.WorkOutPoint="${unsyncedEndF * TICKS_PER_FRAME}"`)
      .replace(/Monitor\.ProgramZoomOut="[0-9]+"/, `Monitor.ProgramZoomOut="${unsyncedEndF * TICKS_PER_FRAME}"`)
      .replace(/<uuid>[^<]*<\/uuid>/, `<uuid>${genUuid()}</uuid>`)
      // УНИКАЛЬНЫЙ id секвенции: Premiere дедуплицирует по <sequence id>, при дубле
      // импортирует только одну. Переименовываем id и ВСЕ внутренние id (clipitem/file/
      // masterclip/track) с суффиксом, чтобы не конфликтовали с первой секвенцией.
      .replace(/<sequence id="sequence-1"/, '<sequence id="sequence-2"')
      .replace(/(id=")(clipitem|file|masterclip)-(\d+)(")/g, '$1$2-u$3$4')
      .replace(/(<(?:masterclipid|linkclipref)>)(clipitem|masterclip)-(\d+)(<)/g, '$1$2-u$3$4');
    out += '\n\t' + unsSeq;
  }
  out += xmlTail;

  writeFileSync(OUT, out, 'utf8');
  console.log(`MAIN _SYNCED: ${synced} клипов, конец ${Math.round(syncedEndF * FRAME)}s`);
  console.log(`UNSYNCED: ${unsynced} клипов, конец ${Math.round(unsyncedEndF * FRAME)}s ${hasUnsynced ? '(отдельная секвенция)' : '(нет)'} → ${OUT}`);
}

main().catch((e) => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
