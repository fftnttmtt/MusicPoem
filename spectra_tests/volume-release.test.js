import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stemStatesAt} from '../spectra_web/stem-player.js';
function source(){
 const p=JSON.parse(readFileSync(new URL('./fixtures/stems-prediction.json',import.meta.url),'utf8'));
 p.audio.duration_seconds=3;p.volume.reference_rms=.1;
 const t=p.stems.find(t=>t.id==='drums'),ok={...t.segments[0],status:'ok',start_seconds:0,end_seconds:1,x_normalized:.5,arousal:5,valence:5,rgb:[210,100,40]};
 t.segments=[ok,{status:'silent',start_seconds:1,end_seconds:3}];t.transition=null;
 t.motion={times:[0,.5,.99,1,1.001,3],rms:[.1,.1,.1,0,0,0],centroid_hz:[500,500,500,500,500,500],centroid_normalized:[.5,.5,.5,.5,.5,.5],gate_dbfs:-55};
 delete t.beat_volume;p.stems=[t];return p;
}
const settings={parametricShape:true,geometry:{texture_enabled:false},size:1};
test('temporary silence retains the previous style and shrinks continuously below two pixels to exactly zero',()=>{
 const p=source(),at=t=>stemStatesAt(p,t,t,settings,960,540)[0];
 const a=at(.99),b=at(1.05),c=at(1.2),tiny=at(1.39);
 assert.ok(a.radius>b.radius&&b.radius>c.radius&&c.radius>tiny.radius&&tiny.radius>0&&tiny.radius<2);
 assert.equal(tiny.alpha,1);assert.equal(tiny.form.kind,'diamond');assert.deepEqual(tiny.rgb,a.rgb);
 assert.equal(at(1.46),undefined);assert.equal(at(2.8),undefined);
 const remembered=at(1.2);for(const t of [.1,2.8,1.01])at(t);assert.deepEqual(at(1.2),remembered);
});

const IDS=['bass','drums','other','vocals','guitar','piano'];
function discontinuous(stem){
 const p=source(),t=p.stems[0];t.id=stem;
 const valid=t.segments[0];
 t.segments=[{status:'silent',start_seconds:0,end_seconds:.5},
  {...valid,start_seconds:.5,end_seconds:1},
  {status:'pending',start_seconds:1,end_seconds:1.8},
  {...valid,start_seconds:1.8,end_seconds:2.2},
  {status:'error',start_seconds:2.2,end_seconds:3}];
 t.motion.rms=t.motion.rms.map(()=>.1);
 if(stem!=='drums')t.beat_volume={rows:[{index:1,start_seconds:0,end_seconds:3,mean_rms:.1,from_rms:.1,target_rms:.1}]};
 return p;
}
test('all six stems remain continuous on starts, bar/status changes, re-entry, silence and song end',()=>{
 for(const stem of IDS){
  const p=discontinuous(stem),radius=t=>stemStatesAt(p,t,t,settings,960,540)[0]?.radius??0;
  assert.equal(radius(.5),0);assert.equal(radius(.499999),0);assert.ok(radius(.52)>0);
  for(const t of [0,.5,.51,.56,.6,1,1.01,1.35,1.45,1.8,1.81,2.2,2.55,2.65,3,3.5]){
   const coarse=Math.abs(radius(t+1e-4)-radius(t-1e-4)),fine=Math.abs(radius(t+1e-7)-radius(t-1e-7));
   assert.ok(fine<.002,`${stem} jump at ${t}: ${fine}`);
   assert.ok(fine<=coarse*.002+1e-8,`${stem} fails convergence at ${t}`);
  }
  for(const t of [1,2.2]){
   const before=radius(t-1e-7),after=radius(t+1e-7);assert.ok(before>200);assert.ok(Math.abs(before-after)<.002);
   const held=stemStatesAt(p,t+.1,t+.1,settings,960,540)[0];assert.ok(held?.radius>0);assert.equal(held.alpha,1);
   assert.equal(radius(t+.5),0);
  }
  assert.equal(radius(1.7),0);assert.equal(radius(2.9),0);
  const remembered=radius(2.35);for(const t of [2.9,.6,1.3,0])radius(t);assert.equal(radius(2.35),remembered);
 }
});
test('growth and shrink rates are continuous at feature knots, not just the radius itself',()=>{
 for(const stem of IDS){
  const p=discontinuous(stem),r=t=>stemStatesAt(p,t,t,settings,960,540)[0]?.radius??0,h=1e-6;
  for(const t of [.5,.51,.56,.6,1,1.01,1.35,1.45,1.8,2.2,2.55]){
   const left=(r(t)-r(t-h))/h,right=(r(t+h)-r(t))/h;
   assert.ok(Math.abs(left-right)<1,`${stem} rate discontinuity ${t}: ${left} / ${right}`);
  }
 }
});
test('rapid loud/quiet changes and abrupt legacy beat means cannot bypass continuous scaling',()=>{
 for(const stem of IDS){
  const p=discontinuous(stem),t=p.stems[0];t.segments=[{...t.segments[1],start_seconds:0,end_seconds:3}];
  t.motion={...t.motion,times:[0,.1,.12,.14,.3,.31,.5,.7,1,1.01,1.03,1.9,2.2,2.21,3],
   rms:[0,.1,0,.4,0,.001,.1,0,.4,0,.2,0,.4,0,0]};
  for(const key of ['centroid_hz','centroid_normalized'])t.motion[key]=t.motion.times.map(()=>key==='centroid_hz'?500:.5);
  if(stem!=='drums')t.beat_volume={rows:[0,.5,1,1.2,2,3].slice(0,-1).map((start,i)=>({index:i+1,start_seconds:start,end_seconds:[.5,1,1.2,2,3][i],mean_rms:i%2?.4:0,from_rms:i%2?.4:0,target_rms:i%2?.4:0}))};
  const radius=time=>stemStatesAt(p,time,time,settings,960,540)[0]?.radius??0;
  for(let i=1;i<300;i++){
   const at=i/100,coarse=Math.abs(radius(at+1e-4)-radius(at-1e-4)),fine=Math.abs(radius(at+1e-7)-radius(at-1e-7));
   assert.ok(fine<.0025,`${stem} volume jump ${at}: ${fine}`);
   assert.ok(fine<=coarse*.002+1e-8,`${stem} volume limit failed at ${at}`);
  }
 }
});
test('terminal and early-tail shrink uses advancing visual time and reaches zero before removal',()=>{
 for(const stem of IDS){
  const p=discontinuous(stem),t=p.stems[0],valid={...t.segments[1],start_seconds:0,end_seconds:3};t.segments=[valid];
  const radius=(time,visual,cutoff=Infinity)=>stemStatesAt(p,time,visual,settings,960,540,cutoff)[0]?.radius??0;
  const before=radius(3-1e-7,3-1e-7),start=radius(3,3);
  assert.ok(Math.abs(before-start)<.002);assert.ok(start>200);
  assert.ok(radius(3,3.1)>radius(3,3.3));assert.ok(radius(3,3.3)>radius(3,3.38));
  assert.ok(radius(3,3.38)>0);assert.equal(radius(3,3.5),0);
  assert.ok(Math.abs(radius(1.5-1e-7,1.5-1e-7,1.5)-radius(1.5,1.5,1.5))<.002);
  assert.ok(radius(1.5,1.6,1.5)>radius(1.5,1.8,1.5));assert.equal(radius(1.5,2,1.5),0);
 }
});
test('near-gate levels do not make a positive sized shape vanish through opacity or size cutoffs',()=>{
 const p=source(),t=p.stems[0];t.segments[0].end_seconds=3;t.segments.pop();
 t.motion.rms=t.motion.rms.map(()=>10**(-55/20)*.02);
 const a=stemStatesAt(p,2,2,settings,960,540)[0];assert.ok(a.radius>0&&a.radius<2);assert.equal(a.alpha,1);
 t.segments[0].status='pending';assert.deepEqual(stemStatesAt(p,2,2,settings,960,540),[]);
});
test('new 100 percent equals prior 300 percent, retaining identical positions and silhouette areas',()=>{
 const p=source();const before=stemStatesAt(p,.5,.5,{...settings,size:3,sizeMultiplier:3},960,540)[0];
 const after=stemStatesAt(p,.5,.5,{...settings,size:1,sizeMultiplier:9},960,540)[0];
 assert.ok(Math.abs(after.radius-before.radius)<1e-10);assert.equal(after.x,before.x);assert.equal(after.y,before.y);
});
