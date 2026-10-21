import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {footeProgress,footeProgressRate,footeIntegral,footeLevelAt,prepareFooteCurve} from '../spectra_web/foote-motion.js';
import {barPositionAt,sampleBeatCentroid,stemStatesAt,prepareStemPrediction} from '../spectra_web/stem-player.js';
import {samplePitch} from '../spectra_web/pitch-player.js';
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
function pitch(){const row=(a,b,m,from=m,status='ok')=>({start_seconds:a,end_seconds:b,midi:status==='ok'?m:null,status,from_midi:from,target_midi:m,from_normalized:(from-60)/12,target_normalized:(m-60)/12});return{midi_p5:60,midi_p95:72,continuous_tau_seconds:.06,rows:[row(0,1,60),row(1,3,72,60)],continuous:[row(0,1,60),row(1,2,72,60),row(2,3,72,72,'unvoiced')]}}

test('Foote progress preserves original anchors and smoothly brakes to zero speed at both ends',()=>{
 const c={times:[0,1],values:[0,1]};assert.equal(footeIntegral(c,0,1),.5);
 for(const t of [0,.1,.25,.5,.75,1]){const q=t*t;assert.ok(Math.abs(footeProgress(c,0,1,t)-(6*q**5-15*q**4+10*q**3))<1e-12)}
 const speed=t=>(footeProgress(c,0,1,t+1e-5)-footeProgress(c,0,1,t-1e-5))/2e-5;
 for(const t of [.25,.5,.75])assert.ok(Math.abs(speed(t)-footeProgressRate(c,0,1,t))<1e-7);
 assert.equal(footeProgressRate(c,0,1,0),0);assert.equal(footeProgressRate(c,0,1,1),0);
 assert.ok(speed(.5)>speed(.1));
 assert.equal(footeLevelAt(c,.25),.25);assert.equal(footeProgress(c,0,1,-1),0);assert.equal(footeProgress(c,0,1,2),1);
 const flat={times:[0,1],values:[1,1]};assert.equal(footeProgress(flat,0,1,.25),.103515625);
 const zero={times:[0,1],values:[0,0]};assert.equal(footeProgress(zero,0,1,.25),.15625);
 assert.equal(prepareFooteCurve({times:[0,1],values:[-1,1]}),null);
});
test('X, drum centroid and beat MIDI move faster where Foote rises without moving their beat/bar start',()=>{
 const c={times:[0,1,3,4],values:[0,0,2,2]},p=pitch(),centroid={rows:[{start_seconds:1,end_seconds:3,from_normalized:0,target_normalized:1,from_centroid_hz:100,target_centroid_hz:900,centroid_hz:900}]};
 assert.equal(samplePitch(p,.999,'beat_summary',c).y,0);assert.equal(samplePitch(p,1,'beat_summary',c).y,0);
 assert.equal(samplePitch(p,2,'beat_summary',c).y,.103515625);assert.equal(samplePitch(p,3,'beat_summary',c).y,1);
 assert.equal(sampleBeatCentroid(centroid,2,c).centroid,182.8125);
 const track={segments:[{status:'ok',start_seconds:0,end_seconds:1,x_normalized:0},{status:'ok',start_seconds:1,end_seconds:3,x_normalized:1}]};
 assert.equal(barPositionAt(track,.999,1,c),0);assert.equal(barPositionAt(track,1,1,c),0);assert.equal(barPositionAt(track,2,1,c),.103515625);assert.equal(barPositionAt(track,3,1,c),1);
});
test('continuous pitch integrates Foote, pauses in zero-change intervals and holds missing pitch with deterministic seeks',()=>{
 const p=pitch(),before=JSON.stringify(p),c={times:[0,1,1.5,1.6,3],values:[1,0,0,1,1]};
 assert.ok(Math.abs(samplePitch(p,1.25,'continuous',c).midi-60)<1e-12);
 assert.ok(samplePitch(p,1.7,'continuous',c).midi>70);
 assert.ok(Math.abs(samplePitch(p,2.1,'continuous',c).midi-samplePitch(p,2.9,'continuous',c).midi)<1e-12);
 const expected=samplePitch(p,1.55,'continuous',c);for(const t of [2.8,0,1.7,1])samplePitch(p,t,'continuous',c);assert.deepEqual(samplePitch(p,1.55,'continuous',c),expected);
 assert.equal(JSON.stringify(p),before);
 const flat={times:[0,3],values:[4,4]};assert.ok(Math.abs(samplePitch(p,1.2,'continuous',flat).midi-samplePitch(p,1.2,'continuous').midi)<1e-12);
});
test('Foote toggle changes only translation and rejects malformed imported curves',()=>{
 const p=fixture();for(const track of p.stems)track.motion_foote={times:[0,6,12],values:[0,1,0]};
 const run=enabled=>stemStatesAt(p,4,4,{parametricShape:true,footeMotion:enabled},1600,900),a=run(false),b=run(true);
 assert.equal(a.length,b.length);assert.ok(b.some((v,i)=>v.x!==a[i].x||v.y!==a[i].y));
 for(let i=0;i<a.length;i++){assert.equal(a[i].radius,b[i].radius);assert.equal(a[i].alpha,b[i].alpha);assert.deepEqual(a[i].form,b[i].form);assert.deepEqual(a[i].rgb,b[i].rgb);assert.equal(b[i].foote_motion,true)}
 p.stems[0].motion_foote={times:[0,1],values:[0,-1]};assert.throws(()=>prepareStemPrediction(p,12),/Foote/);
});
