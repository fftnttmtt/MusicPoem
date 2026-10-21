import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {barPositionAt,barMotionAt,sampleBeatCentroid,sampleMotion,stemStatesAt} from '../spectra_web/stem-player.js';
import {samplePitch} from '../spectra_web/pitch-player.js';
import {brakeMotion} from '../spectra_web/c1-motion.js';

const curve={times:[0,.8,1,1.2,1.5,2,2.2,3,4],values:[1,0,2,2,0,1,4,1,2]};
const points=[0,1,0,1];
const rows=points.map((y,i)=>({status:'ok',start_seconds:i,end_seconds:i+1,x_normalized:y,
 from_normalized:points[Math.max(0,i-1)],target_normalized:y,centroid_hz:y*800+100,
 from_centroid_hz:points[Math.max(0,i-1)]*800+100,target_centroid_hz:y*800+100,
 midi:y*12+60,from_midi:points[Math.max(0,i-1)]*12+60,target_midi:y*12+60}));
function c1(at,t,label,tolerance=.002){
 const h=1e-6,center=at(t),left=(center-at(t-h))/h,right=(at(t+h)-center)/h;
 assert.ok(Number.isFinite(left)&&Number.isFinite(right),label+' finite');
 assert.ok(Math.abs(left-right)<tolerance,`${label} at ${t}: left=${left}, right=${right}`);
}
test('Foote-driven X, drum height and beat pitch reach and reverse at anchors with continuous velocity',()=>{
 const pitch={midi_p5:60,midi_p95:72,rows};
 for(const foote of [null,curve,{times:[0,4],values:[1,1]},{times:[0,4],values:[0,0]}]){
  const x=t=>barPositionAt({segments:rows},t,1,foote),y=t=>sampleBeatCentroid({rows},t,foote)?.y??points.at(-1),p=t=>samplePitch(pitch,t,'beat_summary',foote)?.y??points.at(-1);
  for(const at of [x,y,p]){
   for(const t of [1,2,3]){
    c1(at,t,'turn');assert.ok(Math.abs((at(t)-at(t-1e-6))/1e-6)<.001);
   }
   for(const t of [.8,1.2,1.5,2.2])c1(at,t,'Foote knot');
   assert.equal(at(1),0);assert.equal(at(2),1);assert.equal(at(3),0);
   const remembered=at(1.45);for(const t of [3.9,.1,2.2])at(t);assert.equal(at(1.45),remembered);
  }
 }
});
test('X holds through an invalid bar and resumes from the held position, without jumping on re-entry',()=>{
 const track={segments:[rows[0],{...rows[1],status:'silent'},rows[2],rows[3]]};
 for(const f of [curve,null]){
  const at=t=>barPositionAt(track,t,1,f);
  assert.equal(at(1.8),0);assert.equal(at(2),0);c1(at,2,'re-entry');c1(at,3,'next beat');
  assert.ok(Math.abs(barMotionAt(track,2,1,f).velocity)<1e-12);
 }
});
test('continuous pitch has no velocity jumps at frame targets, missing voicing or percentile clipping',()=>{
 const times=[0,.5,.55,.7,.75,1,1.2,1.5,1.6,2,2.5,3];
 const levels=[60,84,48,72,null,60,72,84,null,48,60];
 const continuous=levels.map((m,i)=>({start_seconds:times[i],end_seconds:times[i+1],status:m===null?'unvoiced':'ok',midi:m,from_midi:i?levels[i-1]??72:60,target_midi:m??72,confidence:.9}));
 const pitch={midi_p5:60,midi_p95:72,continuous_tau_seconds:.06,rows,continuous};
 for(const f of [null,curve]){
  const at=t=>samplePitch(pitch,t,'continuous',f).y;
  for(const t of [...times.slice(1,-1),.8,1.005,1.06,1.205,2.06])c1(at,t,'continuous pitch',.01);
  for(let i=0;i<=300;i++){const y=at(i/100);assert.ok(y>=-1e-10&&y<=1+1e-10)}
  assert.equal(at(.499),0);assert.equal(at(.5),0);
  for(const t of [.6,.82,1.15,2.4]){
   const h=1e-6,v=(at(t+h)-at(t-h))/(2*h);
   assert.ok(Math.abs(v-samplePitch(pitch,t,'continuous',f).velocityY)<.001);
  }
 }
});
test('legacy centroid interpolation has continuous velocity at every sample and stops at local extrema',()=>{
 const motion={times:[0,.2,.3,.6,1],rms:[.1,.1,.1,.1,.1],centroid_hz:[100,500,900,500,100],centroid_normalized:[0,.5,1,.5,0]};
 const at=t=>sampleMotion(motion,t).y;
 for(const t of motion.times)c1(at,t,'legacy centroid');
 assert.equal(sampleMotion(motion,.3).velocityY,0);
 for(let i=0;i<100;i++)assert.ok(at(i/100)>=0&&at(i/100)<=1);
});
test('terminal braking keeps incoming velocity, remains bounded and stops smoothly near viewport edges',()=>{
 for(const [p,v] of [[.5,2],[.95,4],[.05,-4],[.5,-2]]){
  const at=t=>t<0?p+v*t:brakeMotion(p,v,t).value;c1(at,0,'start braking');
  const duration=Math.min(.12,2*(v>0?1-p:p)/Math.abs(v));c1(at,duration,'stop braking');
  for(let i=0;i<100;i++){const s=brakeMotion(p,v,i/100);assert.ok(s.value>=0&&s.value<=1)}
  assert.equal(brakeMotion(p,v,.3).velocity,0);
 }
});
test('actual six-stem pixel paths keep velocity through early/end release in both pitch modes and Foote states',()=>{
 const prediction=JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
 for(const mode of ['beat_summary','continuous'])for(const foote of [false,true])for(const end of [2.25,12]){
  const settings={size:.4,parametricShape:true,motionFraction:1,beatCentroid:true,pitchMode:mode,footeMotion:foote};
  const at=t=>stemStatesAt(prediction,Math.min(t,end),t,settings,960,540,end);
  for(const initial of at(end))for(const axis of ['x','y']){
   const value=t=>at(t).find(a=>a.id===initial.id)?.[axis]??initial[axis];
   c1(value,end,mode+' '+initial.id+' '+axis+' terminal',.1);
   for(const delta of [.02,.06,.12])if(at(end+delta).some(a=>a.id===initial.id))c1(value,end+delta,'braking '+axis,.1);
   const key=axis==='x'?'vx':'vy',h=1e-6,actual=at(end+.02).find(a=>a.id===initial.id);
   if(actual)assert.ok(Math.abs((value(end+.02+h)-value(end+.02-h))/(2*h)-actual[key])<.01);
  }
 }
});
test('actual pixel velocities converge across all cached beat, bar, Foote and pitch frame boundaries',()=>{
 const prediction=JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
 const knots=new Set(prediction.beats);
 for(const track of prediction.stems){
  for(const r of track.segments)knots.add(r.start_seconds);
  for(const t of track.motion_foote?.times||[])knots.add(t);
  for(const r of track.pitch?.continuous||[])knots.add(r.start_seconds);
 }
 for(const mode of ['beat_summary','continuous'])for(const enabled of [false,true]){
  const settings={size:.4,parametricShape:true,motionFraction:1,beatCentroid:true,pitchMode:mode,footeMotion:enabled};
  const at=t=>stemStatesAt(prediction,t,t,settings,960,540);
  for(const t of knots){
   if(t<=0||t>=12)continue;
   const a=at(t-1e-4),b=at(t-1e-6),c=at(t),d=at(t+1e-6),e=at(t+1e-4);
   for(const actor of c){
    const all=[a,b,d,e].map(list=>list.find(v=>v.id===actor.id));if(all.some(v=>!v))continue;
    for(const axis of ['x','y']){
     const coarse=Math.abs((actor[axis]-all[0][axis])/1e-4-(all[3][axis]-actor[axis])/1e-4);
     const fine=Math.abs((actor[axis]-all[1][axis])/1e-6-(all[2][axis]-actor[axis])/1e-6);
     assert.ok(fine<coarse*.03+.01,`${mode} Foote=${enabled} ${actor.id} ${axis} at ${t}: ${coarse} -> ${fine}`);
    }
   }
  }
 }
});
