import {clamp,smoothstep} from './core.js?v=stems-r33';
import {intervalAt} from './prediction.js?v=stems-r33';
import {footeProgress,footeProgressRate,footeIntegral,footeResponse,prepareFooteCurve} from './foote-motion.js?v=r56';
import {sampleHeldCurve} from './c1-motion.js?v=r56';
const finite=Number.isFinite;
export function validatePitch(pitch,duration){
 const bounded=x=>finite(x)&&x>=0&&x<=1;
 if(!['pyin','melodia'].includes(pitch.method)||!bounded(pitch.coverage)||!finite(pitch.continuous_tau_seconds)||pitch.continuous_tau_seconds<=0)throw Error('音高统计或连续跟随参数无效。');
 if(!((pitch.midi_p5===null&&pitch.midi_p95===null)||(finite(pitch.midi_p5)&&finite(pitch.midi_p95)&&pitch.midi_p95>=pitch.midi_p5)))throw Error('音高P5/P95标尺无效。');
 for(const key of ['rows','continuous']){
  const rows=pitch[key];
  if(!Array.isArray(rows)||!rows.length||rows.some((r,i)=>!finite(r.start_seconds)||!finite(r.end_seconds)||r.end_seconds<=r.start_seconds||Math.abs(r.start_seconds-(i?rows[i-1].end_seconds:0))>1e-5||!['ok','unvoiced'].includes(r.status)||!bounded(r.from_normalized)||!bounded(r.target_normalized)||['from_midi','target_midi'].some(k=>r[k]!==null&&!finite(r[k]))||(r.status==='ok'&&!finite(r.midi)))||Math.abs(rows.at(-1).end_seconds-duration)>1e-5)throw Error('音高时间轴或位置无效。');
 }
}
const continuousCache=new WeakMap();
function footeContinuous(pitch,curve){
 if(!prepareFooteCurve(curve))return null;
 let cache=continuousCache.get(pitch);if(!cache){cache=new WeakMap();continuousCache.set(pitch,cache)}
 if(cache.has(curve))return cache.get(curve);
 const original=pitch.continuous,duration=original.at(-1)?.end_seconds,mean=footeIntegral(curve,0,duration)/duration;
 if(!finite(mean)||mean<=1e-12){cache.set(curve,null);return null}
 const rows=[];let display=null,previous=null;
 for(const source of original){
  if(previous?.status==='ok'&&finite(display)){
   const u=footeResponse(curve,previous.start_seconds,source.start_seconds,pitch.continuous_tau_seconds,mean);
   display=previous.target_midi+(previous.from_midi-previous.target_midi)*(1-u);
  }
  const target=source.status==='ok'&&finite(source.midi)?source.midi:display;
  if(display===null&&finite(target))display=target;
  const row={...source,from_midi:display,target_midi:target};rows.push(row);previous=row;
 }
 const result={rows,mean};cache.set(curve,result);return result;
}
const beatCache=new WeakMap();
function beatRows(pitch){
 const stored=beatCache.get(pitch);if(stored?.source===pitch.rows)return stored.rows;
 const rows=[],center=finite(pitch.midi_p5)&&finite(pitch.midi_p95)?(pitch.midi_p5+pitch.midi_p95)/2:null;
 for(const source of pitch.rows){
  const previous=rows.at(-1),from=previous?.target_normalized??source.from_normalized;
  const fromMidi=previous?(previous.target_midi??center):source.from_midi;
  rows.push({...source,from_normalized:from,from_midi:fromMidi,
   target_normalized:source.status==='ok'?source.target_normalized:from,
   target_midi:source.status==='ok'?source.target_midi:fromMidi});
 }
 beatCache.set(pitch,{source:pitch.rows,rows});return rows;
}
function rawSamplePitch(pitch,time,mode='beat_summary',foote=null){
 if(!pitch)return null;
 const continuous=mode==='continuous',warped=continuous&&foote?footeContinuous(pitch,foote):null,row=intervalAt(continuous?(warped?.rows??pitch.continuous):beatRows(pitch),time);if(!row)return null;
 let midi,y,velocityY=0;
 if(continuous){
  const u=warped?footeResponse(foote,row.start_seconds,time,pitch.continuous_tau_seconds,warped.mean):1-Math.exp(-Math.max(0,time-row.start_seconds)/pitch.continuous_tau_seconds);
  midi=finite(row.from_midi)&&finite(row.target_midi)?row.from_midi+(row.target_midi-row.from_midi)*u:null;
  const low=pitch.midi_p5,high=pitch.midi_p95;
  y=midi===null||!finite(low)||!finite(high)||high-low<=1e-9?.5:clamp((midi-low)/(high-low),0,1);
 }else{
  const u=foote?footeProgress(foote,row.start_seconds,row.end_seconds,time):smoothstep(clamp((time-row.start_seconds)/(row.end_seconds-row.start_seconds),0,1));
  y=row.from_normalized+(row.target_normalized-row.from_normalized)*u;
  midi=finite(row.from_midi)&&finite(row.target_midi)?row.from_midi+(row.target_midi-row.from_midi)*u:null;
  const linear=clamp((time-row.start_seconds)/(row.end_seconds-row.start_seconds),0,1);
  const rate=foote?footeProgressRate(foote,row.start_seconds,row.end_seconds,time):6*linear*(1-linear)/(row.end_seconds-row.start_seconds);
  velocityY=(row.target_normalized-row.from_normalized)*rate;
 }
 return{y,midi,beatMedian:continuous?null:row.midi,rawMidi:row.midi,status:row.status,
  confidence:continuous?row.confidence:row.confidence_median,mode,velocityY};
}

const smoothCache=new WeakMap();
function continuousCurve(pitch,foote){
 let variants=smoothCache.get(pitch);if(!variants){variants=new Map();smoothCache.set(pitch,variants)}
 const previous=variants.get(foote);
 if(previous&&previous.rows===pitch.continuous&&previous.low===pitch.midi_p5&&previous.high===pitch.midi_p95&&previous.tau===pitch.continuous_tau_seconds)return previous;
 const end=pitch.continuous.at(-1).end_seconds,times=new Set([0,end]);
 for(const r of pitch.continuous){times.add(r.start_seconds);times.add(r.end_seconds)}
 if(foote)for(const t of foote.times||[])if(t>0&&t<end)times.add(t);
 for(let i=0;i*.005<end;i++)times.add(i*.005);
 const ordered=[...times].sort((a,b)=>a-b),values=[],midi=[];
 const center=finite(pitch.midi_p5)&&finite(pitch.midi_p95)?(pitch.midi_p5+pitch.midi_p95)/2:0;
 for(const t of ordered){const at=rawSamplePitch(pitch,t,'continuous',foote);values.push(at?.y??.5);midi.push(at?.midi??center)}
 const data={rows:pitch.continuous,low:pitch.midi_p5,high:pitch.midi_p95,tau:pitch.continuous_tau_seconds,
  y:{times:ordered,values},midi:{times:ordered,values:midi}};
 variants.set(foote,data);return data;
}
export function samplePitch(pitch,time,mode='beat_summary',foote=null){
 if(!pitch)return null;
 const end=(mode==='continuous'?pitch.continuous:pitch.rows).at(-1)?.end_seconds;
 const raw=rawSamplePitch(pitch,Math.min(time,end),mode,foote);
 if(!raw||mode!=='continuous')return raw;
 const data=continuousCurve(pitch,foote),y=sampleHeldCurve(data.y,time),midi=sampleHeldCurve(data.midi,time);
 return{...raw,y:y.value,velocityY:y.velocity,midi:raw.midi===null?null:midi.value};
}
