// Самодостаточный замер качества синка vs Syncaila. Генерит out-XML и меряет:
//  (1) наложения на дорожках (Premiere выкидывает клипы),
//  (2) взаимный десинк между УСТРОЙСТВАМИ (ошибка взаимного смещения пар, кадры; 0=идеал),
//  (3) число «битых» клипов (|Δ − мода| > 1000f, реальный рассинхрон).
// Usage: node measure.mjs 3 4 5   (или без аргументов = 3 4 5)
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadDsp } from './standalone/load-dsp.mjs';

const CASES = process.argv.slice(2).length ? process.argv.slice(2) : ['3','4','5'];
const CLEAN = N => `C:/Users/Глеб/Downloads/Синхрон/XML/Чистые/${N}.xml`;
const SYN   = N => `C:/Users/Глеб/Downloads/Синхрон/XML/Экспорт синкалии/${N} - synced.xml`;

const dsp = loadDsp(); const T = dsp.FcpXmlTransform;

function parseSeqClips(xml){ // name→{start,end} (первый) + список по трекам для наложений
  const seq = xml.slice(xml.indexOf('<sequence'), xml.indexOf('</sequence>'));
  const byName = new Map();
  const cre = /<clipitem\b[^>]*>([\s\S]*?)<\/clipitem>/g; let m;
  while((m=cre.exec(seq))){ const c=m[1]; const nm=(c.match(/<name>([^<]*)/)||[])[1]||'?';
    const st=+(c.match(/<start>(-?\d+)/)||[])[1]; const en=+(c.match(/<end>(-?\d+)/)||[])[1];
    if(!(st>=0))continue; if(!byName.has(nm)) byName.set(nm,{start:st,end:en}); }
  return byName;
}
function overlaps(xml){ // по каждому <track> верхнего уровня — пересечения
  const seq = xml.slice(xml.indexOf('<sequence'), xml.indexOf('</sequence>'));
  let bad=0; const tre=/<track\b[^>]*>|<\/track>/g; let depth=0,tstart=-1,mm;
  const body=[];
  while((mm=tre.exec(seq))){ if(mm[0][1]!=='/'){ if(depth===0)tstart=mm.index+mm[0].length; depth++; }
    else { depth--; if(depth===0) body.push(seq.slice(tstart,mm.index)); } }
  for(const b of body){ const cs=[]; const cre=/<clipitem\b[^>]*>([\s\S]*?)<\/clipitem>/g; let m;
    while((m=cre.exec(b))){ const c=m[1]; const st=+(c.match(/<start>(-?\d+)/)||[])[1]; const en=+(c.match(/<end>(-?\d+)/)||[])[1];
      if(st>=0&&en>st)cs.push({st,en}); }
    cs.sort((a,b)=>a.st-b.st); for(let i=1;i<cs.length;i++) if(cs[i].st<cs[i-1].en) bad++; }
  return bad;
}
function dev(name){ const n=name.replace(/\.[^.]*$/,''); const i=n.indexOf('_'); return i>0?n.slice(0,i):n; }

for (const N of CASES) {
  const xml = readFileSync(CLEAN(N),'utf8');
  const rate = T.deriveRate(xml); const { clips } = T.parseXml(xml);
  const snap = T.buildSnapshot(clips, rate.frameSec);
  const rows = await dsp.SyncRunner.runClipSync(snap,
    { extractEnvelope: dsp.AudioEnvelope.extractEnvelope },
    { refGate: 0.45, clipGate: 0.4, coarseWindowMs: 20 });
  const xopt = { frameSec: rate.frameSec, ticksPerFrame: rate.ticksPerFrame };
  let res = T.applySyncToXml(xml, clips, rows, xopt);
  if (res.stretch) { // Ф3.1: warp stretch-камеры (двухпроходная схема, как sync-xml.mjs)
    const sw = await dsp.StretchWarp.computeTargets(res.stretch,
      { extractEnvelope: dsp.AudioEnvelope.extractEnvelope, SyncCore: dsp.SyncCore });
    console.log(`  stretch-warp: ${sw.report}`);
    if (Object.keys(sw.targets).length)
      res = T.applySyncToXml(xml, clips, rows, { ...xopt, stretchTargets: sw.targets, stretchPinned: sw.pinned });
  }
  const outFile = `tmp_new${N}.xml`; writeFileSync(outFile, res.xml, 'utf8');

  const O = parseSeqClips(res.xml);
  const S = parseSeqClips(readFileSync(SYN(N),'utf8'));
  const names = [...S.keys()].filter(n=>O.has(n));
  // (3) битые: мода дельты старта, отклонения >1000f
  const deltas = names.map(n=>O.get(n).start - S.get(n).start);
  const freq={}; for(const d of deltas) freq[d]=(freq[d]||0)+1;
  const mode = +Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0];
  let broken=0, maxErr=0;
  for(const n of names){ const e=Math.abs((O.get(n).start-S.get(n).start)-mode); if(e>1000){broken++; if(e>maxErr)maxErr=e;} }
  // (2) взаимный десинк по парам устройств (перекрытие в эталоне)
  const arr = names.map(n=>({n,d:dev(n),s:S.get(n).start,e:S.get(n).end})).sort((a,b)=>a.s-b.s);
  const pd=new Map();
  for(let i=0;i<arr.length;i++) for(let j=i+1;j<arr.length;j++){
    if(arr[j].s>=arr[i].e)break; if(arr[i].d===arr[j].d)continue;
    const err=(O.get(arr[i].n).start-O.get(arr[j].n).start)-(S.get(arr[i].n).start-S.get(arr[j].n).start);
    const k=[arr[i].d,arr[j].d].sort().join(' ↔ '); if(!pd.has(k))pd.set(k,[]); pd.get(k).push(Math.abs(err)); }
  const worst=[...pd].map(([k,v])=>{v.sort((a,b)=>a-b); return {k,med:v[v.length>>1],max:v[v.length-1],n:v.length};})
    .sort((a,b)=>b.med-a.med).slice(0,4);

  console.log(`\n===== КЕЙС ${N} =====`);
  console.log(`  наложения: ${overlaps(res.xml)} | битых клипов(|Δ−мода|>1000f): ${broken}/${names.length} | maxErr=${maxErr}f | мода=${mode}f`);
  console.log(`  худшие пары устройств (взаимный десинк, med/max f):`);
  for(const w of worst) console.log(`    ${w.k.padEnd(22)} пар=${String(w.n).padStart(4)}  med=${String(w.med).padStart(6)}f  max=${String(w.max).padStart(7)}f  ${w.med>12?'← ДЕСИНК':'ok'}`);
}
