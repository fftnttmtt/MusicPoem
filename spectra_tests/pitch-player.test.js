import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {samplePitch,validatePitch} from '../spectra_web/pitch-player.js';
import {stemStatesAt,prepareStemPrediction} from '../spectra_web/stem-player.js';
const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
function simple(){
 const row=(a,b,from,to,status='ok')=>({start_seconds:a,end_seconds:b,status,midi:status==='ok'?to:null,from_midi:from,target_midi:to,from_normalized:from/12-5,target_normalized:to/12-5,confidence:.95,confidence_median:.95});
 const held=72-12*Math.exp(-1/.06);
 return{method:'pyin',coverage:.8,midi_p5:60,midi_p95:72,continuous_tau_seconds:.06,
  rows:[row(0,1,60,60),row(1,2,60,72),row(2,3,72,72,'unvoiced')],
  continuous:[row(0,1,60,60),row(1,2,60,72),row(2,3,held,held,'unvoiced')]};
}
test('beat MIDI target moves across the full beat, starts on its boundary and holds missing beats',()=>{
 const p=simple();validatePitch(p,3);
 assert.equal(samplePitch(p,.999).y,0);assert.equal(samplePitch(p,1).y,0);
 assert.equal(samplePitch(p,1.25).y,.15625);assert.equal(samplePitch(p,1.5).y,.5);
 assert.equal(samplePitch(p,1.75).y,.84375);assert.equal(samplePitch(p,2.5).y,1);
 assert.equal(samplePitch(p,2.5).status,'unvoiced');
});
test('continuous MIDI responds after its frame and smoothly settles at low confidence with deterministic seeks',()=>{
 const p=simple();assert.equal(samplePitch(p,.999,'continuous').y,0);assert.equal(samplePitch(p,1,'continuous').y,0);
 assert.ok(samplePitch(p,1.06,'continuous').y>0&&samplePitch(p,1.06,'continuous').y<1-Math.exp(-1));
 assert.ok(samplePitch(p,1.12,'continuous').y>samplePitch(p,1.06,'continuous').y);
 assert.ok(Math.abs(samplePitch(p,2.1,'continuous').y-samplePitch(p,2.9,'continuous').y)<1e-12);
 const expected=samplePitch(p,1.2,'continuous');for(const t of [2.5,0,2,1.5])samplePitch(p,t,'continuous');assert.deepEqual(samplePitch(p,1.2,'continuous'),expected);
 p.rows[0].target_normalized=NaN;assert.throws(()=>validatePitch(p,3),/音高/);
});
test('Python pitch exports drive non-drum height in both modes while drum height, size, X and colors stay consistent',()=>{
 const p=prepareStemPrediction(fixture(),12),a=stemStatesAt(p,4.25,4.25,{footeMotion:false,parametricShape:true,pitchMode:'beat_summary'},1600,900),b=stemStatesAt(p,4.25,4.25,{footeMotion:false,parametricShape:true,pitchMode:'continuous'},1600,900);
 assert.equal(a.length,b.length);
 for(const actor of a){const track=p.stems.find(t=>t.id===actor.id),other=b.find(t=>t.id===actor.id);
  assert.equal(actor.x,other.x);assert.equal(actor.radius,other.radius);assert.deepEqual(actor.rgb,other.rgb);
  if(actor.id==='drums'){assert.equal(actor.y_source,'centroid');assert.equal(actor.y,other.y)}
  else{assert.equal(actor.y_source,'pitch');assert.equal(actor.y_normalized_display,samplePitch(track.pitch,4.25).y);assert.equal(other.y_normalized_display,samplePitch(track.pitch,4.25,'continuous').y)}
 }
 p.stems.find(t=>t.pitch).pitch.continuous[0].end_seconds=-1;assert.throws(()=>prepareStemPrediction(p,12),/音高/);
});

test('full six-stem import accepts Melodia exports and preserves both motion modes',()=>{
 const value=fixture();
 for(const track of value.stems)if(track.pitch){track.pitch.method='melodia';track.pitch.confidence_kind='melodia_salience'}
 const p=prepareStemPrediction(value,12);
 for(const mode of ['beat_summary','continuous']){
  const actors=stemStatesAt(p,4.25,4.25,{parametricShape:true,pitchMode:mode},1600,900);
  assert.ok(actors.length>0);assert.ok(actors.every(actor=>Number.isFinite(actor.x)&&Number.isFinite(actor.y)));
 }
 const bad=simple();bad.method='unknown';assert.throws(()=>validatePitch(bad,3),/音高/);
});
