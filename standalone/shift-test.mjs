/**
 * M0 де-риск: сдвинуть КАЖДЫЙ клип на +10с, редактируя только clipitem <start>/<end>
 * (в кадрах @ timebase 24 ntsc=TRUE → 23.976fps, 1 кадр = 1001/24000 c).
 * Доказывает механику FCP7 XML round-trip изолированно от DSP.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const IN = process.argv[2] || 'tmp_syroi.xml';
const OUT = process.argv[3] || 'tmp_syroi_shifted.xml';
const SHIFT_SEC = 10;
const FRAME = 1001 / 24000;                 // сек/кадр @23.976
const SHIFT_FRAMES = Math.round(SHIFT_SEC / FRAME); // 240

let xml = readFileSync(IN, 'utf8');
let nStart = 0, nEnd = 0;
xml = xml.replace(/<start>(-?\d+)<\/start>/g, (m, n) => {
  const v = parseInt(n, 10);
  if (v < 0) return m;                        // -1 = клип не на таймлайне, не трогаем
  nStart++; return `<start>${v + SHIFT_FRAMES}</start>`;
});
xml = xml.replace(/<end>(-?\d+)<\/end>/g, (m, n) => {
  const v = parseInt(n, 10);
  if (v < 0) return m;
  nEnd++; return `<end>${v + SHIFT_FRAMES}</end>`;
});
// имя секвенции, чтобы не путать с оригиналом при импорте
xml = xml.replace(/<name>сырой<\/name>/, '<name>сырой_SHIFTED</name>');

writeFileSync(OUT, xml, 'utf8');
console.log(`shifted +${SHIFT_SEC}s (${SHIFT_FRAMES} frames): ${nStart} starts, ${nEnd} ends → ${OUT}`);
