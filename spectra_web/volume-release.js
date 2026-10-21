import {clamp,smoothstep} from './core.js?v=stems-r33';
import {intervalAt} from './prediction.js?v=stems-r33';

export const VOLUME_RELEASE_SECONDS=.35;
export const VOLUME_SMOOTH_SECONDS={drums:.06,other:.10};
const STEP=.01,cache=new WeakMap();
const lowerBound=(a,t)=>{let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m]<t)l=m+1;else h=m}return l};

// Integral of a causal Hann kernel. The kernel and its derivative are zero at
// both ends. Each interval contributes a continuous function, even when raw
// volume or prediction status changes instantaneously.
function hannIntegral(age,seconds){
 if(age<=0)return 0;if(age>=seconds)return 1;
 const u=age/seconds;return u-Math.sin(2*Math.PI*u)/(2*Math.PI);
}

function nodes(track,reference,useBeatVolume,sampleBeatVolume,sampleMotion,end){
 const beatRows=useBeatVolume?track.beat_volume?.rows:null;
 const identity={rms:track.motion.rms,times:track.motion.times,segments:track.segments,beatRows,
  reference,gate:track.motion.gate_dbfs??-55,end};
 let modes=cache.get(track);if(!modes){modes=new Map();cache.set(track,modes)}
 const mode=!!beatRows,previous=modes.get(mode);
 if(previous&&Object.keys(identity).every(k=>previous.identity[k]===identity[k]))return previous.data;
 const times=new Set([0,end,end+VOLUME_RELEASE_SECONDS+STEP]);
 for(const t of track.motion.times)if(t>=0&&t<end)times.add(t);
 for(const r of track.segments||[])for(const t of [r.start_seconds,r.end_seconds])if(t>=0&&t<end)times.add(t);
 for(const r of beatRows||[])for(const t of [r.start_seconds,r.end_seconds])if(t>=0&&t<end)times.add(t);
 for(let i=0;i*STEP<end+VOLUME_RELEASE_SECONDS+STEP;i++)times.add(i*STEP);
 const ordered=[...times].sort((a,b)=>a-b),gate=10**(identity.gate/20),scale=Math.sqrt(Math.max(reference,1e-12));
 const raw=ordered.map(t=>{
  const row=intervalAt(track.segments||[],t);
  if(t>=end||row?.status!=='ok'||!row.rgb||row.x_normalized===null)return 0;
  const rms=mode?sampleBeatVolume(track.beat_volume,t)?.rms??0:sampleMotion(track.motion,t).rms;
  return clamp(Math.sqrt(Math.max(0,rms))*smoothstep(clamp(rms/gate,0,1))/scale,0,1);
 });
 // Finite release of raw peaks, then smooth *both* growth and shrinkage.
 // No recursive peak feedback: true silence reaches exactly zero.
 const gains=[];let first=0;
 for(let i=0;i<ordered.length;i++){
  while(ordered[first]<ordered[i]-VOLUME_RELEASE_SECONDS)first++;
  let gain=raw[i];
  for(let j=first;j<i;j++)gain=Math.max(gain,raw[j]*(1-smoothstep(clamp((ordered[i]-ordered[j])/VOLUME_RELEASE_SECONDS,0,1))));
  gains.push(gain);
 }
 const data={times:ordered,gains};modes.set(mode,{identity,data});return data;
}

// Preview, overlap scan and video export sample the same curve. No frame
// history, future audio, minimum radius, or numerical snap to zero.
export function volumeRadiusGain(track,time,_rms,reference,useBeatVolume,sampleBeatVolume,sampleMotion,cutoff=Infinity){
 const end=Math.min(cutoff,track.motion.times.at(-1));
 const data=nodes(track,reference,useBeatVolume,sampleBeatVolume,sampleMotion,end);
 const seconds=track.id==='drums'?VOLUME_SMOOTH_SECONDS.drums:VOLUME_SMOOTH_SECONDS.other;
 let gain=0;
 for(let i=Math.max(0,lowerBound(data.times,time-seconds)-1);i<data.times.length-1&&data.times[i]<time;i++){
  gain+=data.gains[i]*(hannIntegral(time-data.times[i],seconds)-hannIntegral(time-data.times[i+1],seconds));
 }
 return clamp(gain,0,1);
}
