import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateTempo,shapeRadius,MOODS,createScenes,sceneAt} from '../spectra_web/core.js';

test('regular onset envelopes produce the expected beat grid',()=>{
  for(const bpm of [90,120,150]){
    const envelope=new Float32Array(6000);
    const period=6000/bpm;
    for(let k=0;k<150;k++){const index=Math.round(9+k*period);if(index<envelope.length){envelope[index]=1;envelope[index+1]=.35}}
    const result=estimateTempo(envelope,100);
    assert.ok(Math.abs(result.bpm-bpm)<2,`expected ${bpm}, got ${result.bpm}`);
    assert.ok(result.confidence>.3);
  }
  assert.equal(estimateTempo(new Float32Array(1000)).confidence,0);
});
test('geometry is finite through each shape; mock scenes are repeatable and timed',()=>{
  for(const mood of MOODS)for(let angle=-Math.PI*3;angle<Math.PI*3;angle+=.01){const r=shapeRadius(angle,mood);assert.ok(Number.isFinite(r)&&r>0&&r<=1.00001)}
  const scenes=createScenes(123);assert.deepEqual(scenes,createScenes(123));
  assert.equal(sceneAt(scenes,0,120).current,scenes[0]);
  assert.equal(sceneAt(scenes,16.5,120).current,scenes[1]);
});
