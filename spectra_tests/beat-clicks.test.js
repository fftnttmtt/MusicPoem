import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleBeatClicks} from '../spectra_web/beat-clicks.js';

test('diagnostic clicks use original predicted times and the exact music start/seek mapping',()=>{
 const nodes=[];
 const audio={sampleRate:48000,currentTime:10,
  createBuffer(c,n,sr){const samples=new Float32Array(n);return{getChannelData:()=>samples}},
  createBufferSource(){const node={connect(){},disconnect(){this.disconnected=true},start(when){this.when=when},stop(){this.stopped=true}};nodes.push(node);return node}
 };
 const track=scheduleBeatClicks(audio,{},[0,1,2.5,3,4],10.03,2.5,4);
 assert.deepEqual(nodes.map(n=>n.when),[10.03,10.53]);
 assert.ok(nodes[0].buffer.getChannelData(0).some(n=>n!==0));
 track.stop();assert.ok(nodes.every(n=>n.stopped&&n.disconnected));
 audio.currentTime=20;
 const resumed=scheduleBeatClicks(audio,{},[0,1,2.5,3,4],20.03,3.2,5);
 assert.ok(Math.abs(nodes.at(-1).when-20.83)<1e-10);
 resumed.stop();
});
