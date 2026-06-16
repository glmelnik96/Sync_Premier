#!/usr/bin/env node
/**
 * Проверка качества синхронизации на РЕАЛЬНОМ медиа (разные микрофоны одного события).
 * Берёт два полных исходника, строит огибающие, ищет глобальный офсет кросс-корреляцией.
 * Сравнивает с ground-truth офсетом, выведенным из синхронного монтажа Draft_2.
 *
 * Запуск: node spike/global-sync-test.mjs "<fileA>" "<fileB>" [expectedOffsetSec]
 *   offset положительный = B отстаёт от A (B надо сдвинуть назад, чтобы совпало).
 */
import { execFileSync } from 'node:child_process';

const FFMPEG = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const SR = 4000;        // для глобального поиска хватает 4 кГц
const WIN_MS = 20;      // огибающая 20 мс (грубее L0 5мс — для скорости на длинных файлах)

function extractEnv(path) {
  const buf = execFileSync(FFMPEG, ['-hide_banner','-nostats','-v','error','-i',path,
    '-map','0:a:0?','-vn','-ac','1','-ar',String(SR),'-f','s16le','-'],
    { maxBuffer: 1024*1024*1024 });
  const n = Math.floor(buf.length/2);
  const win = Math.round(WIN_MS/1000*SR);
  const m = Math.floor(n/win);
  const env = new Float64Array(m);
  for (let k=0;k<m;k++){ let s=0; for(let j=0;j<win;j++){ const v=buf.readInt16LE((k*win+j)*2)/32768; s+=v*v; } env[k]=Math.sqrt(s/win); }
  return { env, dt: win/SR };
}

function zeroMean(a){ let m=0; for(let i=0;i<a.length;i++)m+=a[i]; m/=a.length||1; const o=new Float64Array(a.length); for(let i=0;i<a.length;i++)o[i]=a[i]-m; return o; }
function norm(a){ let s=0; for(let i=0;i<a.length;i++)s+=a[i]*a[i]; return Math.sqrt(s); }

/** Нормализованная кросс-корреляция a vs b, лаги [-maxLag,maxLag]. Возвращает {lag,corr}. */
function xcorr(a,b,maxLag){
  const za=zeroMean(a), zb=zeroMean(b);
  const denom=(norm(za)*norm(zb))||1e-12;
  let best={lag:0,corr:-Infinity};
  for(let lag=-maxLag; lag<=maxLag; lag++){
    let s=0; const lo=Math.max(0,-lag), hi=Math.min(za.length, zb.length-lag);
    if (hi-lo < za.length*0.05) continue;        // требуем ≥5% перекрытия
    for(let i=lo;i<hi;i++) s+=za[i]*zb[i+lag];
    const c=s/denom*(za.length/(hi-lo));          // компенсация частичного перекрытия
    if(c>best.corr) best={lag,corr:c};
  }
  return best;
}

const [pathA, pathB, expected] = process.argv.slice(2);
console.log('A:', pathA);
console.log('B:', pathB);
console.log('Извлечение огибающих (' + WIN_MS + 'мс @' + SR + 'Гц)…');
const A = extractEnv(pathA), B = extractEnv(pathB);
console.log('  A: ' + A.env.length + ' точек (' + Math.round(A.env.length*A.dt) + 'с), B: ' + B.env.length + ' точек (' + Math.round(B.env.length*B.dt) + 'с)');

const dt = A.dt;
const maxLag = Math.round(500/dt);    // ищем офсет до ±500с
console.log('Поиск офсета (±500с, ' + maxLag + ' лагов)…');
const t0 = Date.now();
const r = xcorr(A.env, B.env, maxLag);
const offsetSec = r.lag * dt;
console.log('\n=== РЕЗУЛЬТАТ ===');
console.log('Найденный офсет B отн. A: ' + offsetSec.toFixed(2) + 'с  (corr=' + r.corr.toFixed(3) + ', ' + ((Date.now()-t0)/1000).toFixed(1) + 'с)');
if (expected != null) {
  const err = offsetSec - parseFloat(expected);
  console.log('Ground truth (из монтажа): ' + parseFloat(expected).toFixed(2) + 'с');
  console.log('Ошибка: ' + err.toFixed(3) + 'с (' + (Math.abs(err)/0.04).toFixed(1) + ' кадров @25fps)');
  console.log(Math.abs(err) < 0.1 ? '→ ЗЕЛЁНЫЙ: офсет найден точно' : (Math.abs(err) < 1 ? '→ ЖЁЛТЫЙ: близко, нужна тонкая доводка' : '→ КРАСНЫЙ: офсет не совпал'));
}
