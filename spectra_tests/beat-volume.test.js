import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sampleBeatVolume,stemStatesAt,prepareStemPrediction} from '../spectra_web/stem-player.js';

test('beat volume is continuous over the full beat, starts at beat boundary and is seek deterministic',()=>{
 const v={rows:[{index:1,start_seconds:0,end_seconds:1,mean_rms:.1,from_rms:.1,target_rms:.1},
  {index:2,start_seconds:1,end_seconds:9,mean_rms:.9,from_rms:.1,target_rms:.9},
  {index:3,start_seconds:9,end_seconds:10,mean_rms:0,from_rms:.9,target_rms:0}]};
 assert.equal(sampleBeatVolume(v,.9999).rms,.1);assert.equal(sampleBeatVolume(v,1).rms,.1);
 assert.equal(sampleBeatVolume(v,5).rms,.5);assert.equal(sampleBeatVolume(v,9).rms,.9);
 assert.ok(sampleBeatVolume(v,8.99).rms>.899);assert.ok(sampleBeatVolume(v,9.5).rms<.5);
 const remembered=sampleBeatVolume(v,5);for(const t of [0,9.5,2])sampleBeatVolume(v,t);
 assert.deepEqual(sampleBeatVolume(v,5),remembered);
});
test('non-drums use beat-average RMS for area and visibility, drums always retain realtime RMS',()=>{
 const raw=JSON.parse(readFileSync(new URL('./fixtures/stems-prediction.json',import.meta.url),'utf8'));
 raw.volume.reference_rms=1;
 for(const t of raw.stems){
  t.motion.rms=t.motion.rms.map(()=>.04);
  t.beat_volume={rows:[{index:1,start_seconds:0,end_seconds:12,mean_rms:.16,from_rms:.16,target_rms:.16}]};
 }
 const at=()=>stemStatesAt(raw,4,4,{size:1.5,beatVolume:true},1200,800);
 let actors=at(),bass=actors.find(a=>a.id==='bass'),drums=actors.find(a=>a.id==='drums');
 assert.equal(bass.rms,.16);assert.equal(bass.realtime_rms,.04);assert.equal(drums.rms,.04);
 assert.equal(bass.volume_mode,'beat_average');assert.equal(drums.volume_mode,'realtime');
 assert.ok(Math.abs(bass.radius/drums.radius-2)<1e-12);
 for(const t of raw.stems)t.motion.rms=t.motion.rms.map(()=>0);
 actors=at();assert.ok(actors.some(a=>a.id==='bass'));assert.ok(!actors.some(a=>a.id==='drums'));
});
test('Python beat-volume export validates and malformed or incomplete timelines are rejected',()=>{
 const p=JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
 const validated=prepareStemPrediction(p,12);
 assert.ok(!validated.stems.find(t=>t.id==='drums').beat_volume);
 for(const track of validated.stems.filter(t=>t.id!=='drums')){
  assert.equal(track.beat_volume.rows.length,24);
  const row=track.beat_volume.rows[1];assert.equal(sampleBeatVolume(track.beat_volume,row.start_seconds).rms,row.from_rms);
 }
 p.stems[0].beat_volume.rows[0].mean_rms=-1;assert.throws(()=>prepareStemPrediction(p,12),/拍均音量/);
 p.stems[0].beat_volume.rows[0].mean_rms=0;p.stems[0].beat_volume.rows[0].start_seconds=.1;assert.throws(()=>prepareStemPrediction(p,12),/拍均音量/);
});
