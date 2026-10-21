import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareStemPrediction,stemStatesAt,barPositionAt} from '../spectra_web/stem-player.js';

const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/stems-prediction.json',import.meta.url),'utf8'));
const settings={size:1.5,mass:8,fadeOut:.18,breath:1};
test('Python six-source export is accepted and selects one actual highest tag per active stem',()=>{
 const raw=fixture(),p=prepareStemPrediction(raw,12,raw.audio.sha256);
 const actors=stemStatesAt(p,4,4,settings,1200,800);
 assert.equal(actors.length,5);assert.equal(new Set(actors.map(a=>a.id)).size,5);
 assert.ok(actors.every(a=>a.tag==='happy'&&a.motif.shape==='circle'&&a.motif.double));
 assert.ok(actors.every(a=>a.motif.body.startsWith('rgb(')&&a.motif.lines==='#ff9900'));
 assert.ok(!actors.some(a=>a.id==='piano'));
 const remembered=JSON.stringify(actors);
 for(const t of [8,.5,11,2])stemStatesAt(p,t,t,settings,1200,800);
 assert.equal(JSON.stringify(stemStatesAt(p,4,4,settings,1200,800)),remembered);
});
test('coordinates use independent normalized source values and area uses a shared volume scale',()=>{
 const raw=fixture();raw.volume.reference_rms=.4;
 raw.stems.forEach((track,i)=>{
  track.segments.forEach((r,j)=>Object.assign(r,{status:'ok',rgb:[50,100,150],hex:'#326496',arousal:1+i,
   x_normalized:j===0?0:j===1?.5:1,tag_scores:{epic:.8,funny:1},dominant_tag:'epic'}));
  track.transition=null;
  track.motion={times:[0,6,12],rms:[i===0?.1:.4,i===0?.1:.4,i===0?.1:.4],
   centroid_hz:[100*(i+1),200*(i+1),100*(i+1)],centroid_normalized:[0,1,0],gate_dbfs:-55};
 });
 const p=prepareStemPrediction(raw,12),early=stemStatesAt(p,1,1,settings,1200,800),middle=stemStatesAt(p,6,6,settings,1200,800),late=stemStatesAt(p,10,10,settings,1200,800);
 assert.equal(early.length,6);assert.ok(early[0].x<middle[0].x&&middle[0].x<late[0].x);
 assert.ok(middle[0].y<early[0].y);
 assert.equal(early[0].x,early[5].x);assert.equal(early[0].y,early[5].y);
 assert.ok(Math.abs((early[1].radius/early[0].radius)**2-4)<1e-10);
 assert.ok(early.every(a=>a.tag==='epic'&&a.motif.shape==='up'&&a.motif.lines==='#0000ff'));
});
test('tail silence initiates continuous normal falling; EOF also completes the release',()=>{
 const p=prepareStemPrediction(fixture(),12),start=4;
 const a=stemStatesAt(p,start,start,settings,1200,800,start),normal=stemStatesAt(p,start,start,settings,1200,800);
 assert.deepEqual(a,normal);
 const half=stemStatesAt(p,5,start+.18*Math.sqrt(8)/2,settings,1200,800,start);
 assert.equal(half.length,a.length);
 assert.ok(half.every((actor,i)=>actor.alpha<a[i].alpha&&actor.vy>0&&Math.abs(actor.vx)<1e-8));
 assert.equal(stemStatesAt(p,6,6,settings,1200,800,start).length,0);
 assert.equal(stemStatesAt(p,12,13,settings,1200,800).length,0);
});
test('malformed or mismatched six-source imports fail before rendering',()=>{
 const p=fixture();assert.throws(()=>prepareStemPrediction(p,10),/时长/);
 assert.throws(()=>prepareStemPrediction(p,12,'wrong'),/另一份/);
 p.stems[0].motion.centroid_normalized[0]=NaN;assert.throws(()=>prepareStemPrediction(p,12),/质心/);
 const bad=fixture();bad.stems[1].id=bad.stems[0].id;assert.throws(()=>prepareStemPrediction(bad,12),/六条/);
});
test('bar position starts transitioning exactly at the boundary, never anticipates and is seek deterministic',()=>{
 const track={segments:[{status:'ok',start_seconds:0,end_seconds:2,x_normalized:0},
  {status:'ok',start_seconds:2,end_seconds:6,x_normalized:1},
  {status:'ok',start_seconds:6,end_seconds:6.4,x_normalized:.2},
  {status:'ok',start_seconds:6.4,end_seconds:9,x_normalized:.8}]};
 assert.equal(barPositionAt(track,1.999,.25),0);
 assert.equal(barPositionAt(track,2,.25),0);
 assert.equal(barPositionAt(track,2.5,.25),.5);
 assert.equal(barPositionAt(track,3,.25),1);
 assert.equal(barPositionAt(track,6,.25),1);
 assert.ok(Math.abs(barPositionAt(track,6.4,.25)-.2)<1e-10);
 // Legacy zero-duration interpolation must no longer introduce a hard snap.
 assert.equal(barPositionAt(track,2,0),0);assert.equal(barPositionAt(track,6,0),1);
 const remembered=barPositionAt(track,6.05,.25);
 for(const t of [8,0,6.4,2])barPositionAt(track,t,.25);
 assert.equal(barPositionAt(track,6.05,.25),remembered);
 track.segments[0].status='pending';assert.equal(barPositionAt(track,2.1,.25),1);
});
test('new size multiplier triples linear radius and keeps RMS area ratios',()=>{
 const p=prepareStemPrediction(fixture(),12);
 const old=stemStatesAt(p,4,4,{...settings,size:1},1600,900);
 const enlarged=stemStatesAt(p,4,4,{...settings,size:1,sizeMultiplier:3},1600,900);
 assert.equal(old.length,enlarged.length);
 enlarged.forEach((a,i)=>assert.ok(Math.abs(a.radius/old[i].radius-3)<1e-12));
 assert.ok(Math.abs((enlarged[1].radius/enlarged[0].radius)**2-(old[1].radius/old[0].radius)**2)<1e-12);
});
