import test from 'node:test';
import assert from 'node:assert/strict';
import {measureLoudness,tailClearTime,beatPulseScale} from '../spectra_web/presence.js';

function buffer(channels,sampleRate=1000){return{sampleRate,length:channels[0].length,duration:channels[0].length/sampleRate,numberOfChannels:channels.length,getChannelData:i=>channels[i]}}
test('tail detection ignores interior rests and confirms final silence across stereo channels',()=>{
 const left=Float32Array.from({length:6000},(_,i)=>i<1000||i>=3000&&i<4000?.1:0),right=left.map(x=>-x);
 const envelope=measureLoudness(buffer([left,right]));
 assert.ok(Math.abs(tailClearTime(envelope)-4.15)<1e-9);
 assert.equal(tailClearTime(measureLoudness(buffer([left.subarray(0,4050),right.subarray(0,4050)]))),Infinity);
 assert.equal(tailClearTime(measureLoudness(buffer([new Float32Array(6000)]))),0);
 assert.equal(tailClearTime(measureLoudness(buffer([new Float32Array(6000).fill(.1)]))),Infinity);
});
test('tail threshold is adjustable and a later audible return prevents early clearing',()=>{
 const samples=Float32Array.from({length:6000},(_,i)=>i<1000?.1:i<3000?.004:0);
 const envelope=measureLoudness(buffer([samples]));
 assert.ok(Math.abs(tailClearTime(envelope,-40)-1.15)<1e-9);
 assert.ok(Math.abs(tailClearTime(envelope,-50)-3.15)<1e-9);
 samples[5999]=.8;
 assert.equal(tailClearTime(measureLoudness(buffer([samples])),-50),Infinity);
});
test('long-lived geometry pulses once after each subsequent real beat without anticipation or drift',()=>{
 const beats=[0,.5,1.2,2,2.4],event={born:0,end:3};
 assert.equal(beatPulseScale(event,beats,.11),1);
 assert.equal(beatPulseScale(event,beats,.4999),1);
 for(const beat of [.5,1.2,2]){
  assert.equal(beatPulseScale(event,beats,beat),1);
  assert.ok(Math.abs(beatPulseScale(event,beats,beat+.1)-1.049)<.002);
  assert.equal(beatPulseScale(event,beats,beat+.23),1);
 }
 assert.equal(beatPulseScale({...event,end:.5},beats,.11),1);
 assert.equal(beatPulseScale({...event,born:1.2},beats,1.31),1);
 assert.equal(beatPulseScale(event,beats,3.1),1);
 assert.equal(beatPulseScale(event,[],1),1);
 const original=beatPulseScale(event,beats,1.3);
 for(const t of [2.1,.3,1.8])beatPulseScale(event,beats,t);
 assert.equal(beatPulseScale(event,beats,1.3),original);
});
