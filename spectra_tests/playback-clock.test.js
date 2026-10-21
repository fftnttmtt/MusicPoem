import test from 'node:test';
import assert from 'node:assert/strict';
import {audibleContextTime,playbackTime,playbackHasStarted} from '../spectra_web/playback-clock.js';

test('output timestamp compensates render-ahead once, including device latency',()=>{
 const audio={currentTime:10,baseLatency:.02,outputLatency:.1,getOutputTimestamp:()=>({contextTime:9.8,performanceTime:1000})};
 assert.ok(Math.abs(audibleContextTime(audio,1050)-9.85)<1e-10);
 const state={audio,playing:true,startedAt:7,offset:2,buffer:{duration:100}};
 assert.ok(Math.abs(playbackTime(state,1050)-4.85)<1e-10);
 assert.equal(audibleContextTime(audio,1500),10); // cannot extrapolate past rendered audio
});
test('a beat at song zero must not appear during scheduled start/output buffering',()=>{
 const s={audio:{currentTime:5,outputLatency:.2},startedAt:5.03,playing:true,offset:0,buffer:{duration:8}};
 assert.equal(playbackTime(s,0),0);assert.equal(playbackHasStarted(s,0),false);
 s.audio.currentTime=5.24;assert.equal(playbackHasStarted(s,0),true);
 s.playing=false;assert.equal(playbackHasStarted(s,0),true); // paused seek previews remain available
 s.wantPlaying=true;assert.equal(playbackHasStarted(s,0),false); // async resume is still pending
});
test('missing or startup/stale timestamps fall back to reported latency, never a fixed song shift',()=>{
 const audio={currentTime:10,baseLatency:.02,outputLatency:.1};
 assert.equal(audibleContextTime(audio,1500),9.88);
 for(const stamp of [{contextTime:0,performanceTime:0},{contextTime:1,performanceTime:1},{contextTime:9,performanceTime:2000}]){
  audio.getOutputTimestamp=()=>stamp;assert.equal(audibleContextTime(audio,1500),9.88);
 }
 assert.equal(audibleContextTime({currentTime:10,baseLatency:NaN,outputLatency:-1},1500),10);
});
test('resume/seek wait for audible new audio, pause freezes, and end clamps without drift',()=>{
 const state={audio:{currentTime:10,outputLatency:.2},startedAt:10,offset:4,buffer:{duration:8},playing:true};
 assert.equal(playbackTime(state,0),4);
 state.audio.currentTime=10.3;assert.ok(Math.abs(playbackTime(state,0)-4.1)<1e-10);
 state.playing=false;state.offset=4.1;state.audio.currentTime=20;assert.equal(playbackTime(state,0),4.1);
 state.playing=true;assert.equal(playbackTime(state,0),8);
});
