import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {barPositionAt,sampleBeatCentroid,sampleBeatVolume,sampleMotion,stemStatesAt,prepareStemPrediction} from '../spectra_web/stem-player.js';
import {samplePitch} from '../spectra_web/pitch-player.js';
import {labBackgroundAt} from '../spectra_web/lab/lab-model.js';

const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
test('both axes keep moving throughout the complete current bar/beat with no anticipation',()=>{
 const track={segments:[{status:'ok',start_seconds:0,end_seconds:2,x_normalized:0},
  {status:'ok',start_seconds:2,end_seconds:6,x_normalized:1}]};
 assert.equal(barPositionAt(track,1.999,1),0);assert.equal(barPositionAt(track,2,1),0);
 assert.equal(barPositionAt(track,3,1),.15625);assert.equal(barPositionAt(track,4,1),.5);
 assert.equal(barPositionAt(track,5,1),.84375);assert.equal(barPositionAt(track,6,1),1);
 const beats={rows:[
  {index:1,status:'ok',start_seconds:0,end_seconds:1,centroid_hz:100,from_centroid_hz:100,target_centroid_hz:100,from_normalized:0,target_normalized:0},
  {index:2,status:'ok',start_seconds:1,end_seconds:3,centroid_hz:900,from_centroid_hz:100,target_centroid_hz:900,from_normalized:0,target_normalized:1},
  {index:3,status:'silent',start_seconds:3,end_seconds:4,centroid_hz:null,from_centroid_hz:900,target_centroid_hz:900,from_normalized:1,target_normalized:1}]};
 assert.equal(sampleBeatCentroid(beats,.999).centroid,100);
 assert.equal(sampleBeatCentroid(beats,1).centroid,100);
 assert.equal(sampleBeatCentroid(beats,1.5).centroid,225);
 assert.equal(sampleBeatCentroid(beats,2).centroid,500);
 assert.equal(sampleBeatCentroid(beats,2.5).centroid,775);
 assert.equal(sampleBeatCentroid(beats,3).centroid,900);
 assert.equal(sampleBeatCentroid(beats,3.5).centroid,900);
 assert.equal(sampleBeatCentroid(beats,3.5).mean,null);
});
test('Python beat means determine positions and non-drum size while drums remain realtime, including seeks and EOF',()=>{
 const p=prepareStemPrediction(fixture(),12),settings={footeMotion:false,size:1.5,sizeMultiplier:3,motionFraction:1,beatCentroid:true};
 const t=2.25,actors=stemStatesAt(p,t,t,settings,1600,900);
 assert.equal(actors.length,5);
 for(const actor of actors){const track=p.stems.find(s=>s.id===actor.id),beat=sampleBeatCentroid(track.beat_motion,t);
  assert.equal(actor.y_normalized_display,track.pitch?samplePitch(track.pitch,t).y:beat.y);
  assert.equal(actor.centroid_hz,beat.centroid);
  assert.equal(actor.beat_mean_centroid_hz,beat.mean);
  assert.equal(actor.realtime_rms,sampleMotion(track.motion,t).rms);
  assert.equal(actor.rms,track.id==='drums'?sampleMotion(track.motion,t).rms:sampleBeatVolume(track.beat_volume,t).rms);
  assert.equal(actor.x_normalized_display,barPositionAt(track,t,1));
 }
 const expected=JSON.stringify(actors);
 for(const t of [0,7,2.49,11,4])stemStatesAt(p,t,t,settings,1600,900);
 assert.equal(JSON.stringify(stemStatesAt(p,2.25,2.25,settings,1600,900)),expected);
 assert.equal(stemStatesAt(p,12,13,settings,1600,900).length,0);
 p.stems[0].beat_motion.rows[0].from_normalized=NaN;
 assert.throws(()=>prepareStemPrediction(p,12),/拍均/);
});
test('dynamic background uses original-mix bar colors, holds through gaps and never selects a future bar',()=>{
 const p=fixture(),early=labBackgroundAt(p,1),later=labBackgroundAt(p,5);
 assert.equal(early.source,'bar');assert.equal(later.source,'bar');assert.notDeepEqual(early.rgb,later.rgb);
 const before=labBackgroundAt(p,2-1e-6);
 assert.deepEqual(before.rgb,p.background.segments[0].rgb);
 p.background.segments[1].status='prediction_error';p.background.segments[1].rgb=null;
 const held=labBackgroundAt(p,4);
 assert.equal(held.source,'held');assert.deepEqual(held.rgb,p.background.segments[0].rgb);
 assert.deepEqual(labBackgroundAt(null,0).rgb,[0,0,0]);
});
