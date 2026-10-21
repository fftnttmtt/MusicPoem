import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';

test('analysis worker transfers a model and retains audio analysis for subsequent parameter changes',async()=>{
 const moduleURL=new URL('../spectra_web/analyzer-worker.js',import.meta.url).href;
 const bridge=`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(message,transfer)=>parentPort.postMessage(message,transfer)};import(${JSON.stringify(moduleURL)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({type:'booted'})}).catch(error=>{throw error});`;
 const worker=new Worker(bridge,{eval:true});
 const waitFor=predicate=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('worker response timeout'))},5000);
  const onError=error=>{cleanup();reject(error)};
  const onMessage=data=>{if(data.type==='error'){cleanup();reject(new Error(data.message))}else if(predicate(data)){cleanup();resolve(data)}};
  function cleanup(){clearTimeout(timer);worker.off('message',onMessage);worker.off('error',onError)}
  worker.on('message',onMessage);worker.on('error',onError);
 });
 try{
  await waitFor(d=>d.type==='booted');
  const sampleRate=22050,pcm=Float32Array.from({length:sampleRate*2},(_,i)=>{
   const t=i/sampleRate,phase=t%.5;return phase<.25?.35*Math.sin(2*Math.PI*440*t)*Math.exp(-phase*12):0;
  });
  const first=waitFor(d=>d.type==='model'&&d.id===1);
  worker.postMessage({type:'analyze',id:1,pcm,sampleRate,settings:{mass:1,count:100,smoothing:.04,threshold:1.2,spacing:4,decay:.8},customBeats:[0,.5,1,1.5]},[pcm.buffer]);
  const a=(await first).model;assert.equal(a.count,100);assert.ok(a.events.length>0);assert.ok(a.events.every(e=>e.mass===1));assert.ok(a.events.every(e=>e.motion instanceof Float32Array&&e.motion.byteLength>0));
  const next=waitFor(d=>d.type==='model'&&d.id===2);
  worker.postMessage({type:'configure',id:2,settings:{mass:8,count:41,smoothing:.08,threshold:.8,spacing:3,decay:.7},customBeats:[0,1]});
  const b=(await next).model;assert.equal(b.count,41);assert.equal(b.frames,a.frames);assert.equal(b.levels.length,b.frames*41);assert.deepEqual(b.beats,[0,1]);assert.ok(b.events.length>0&&b.events.every(e=>e.mass===8));
  assert.ok(Math.abs(b.events[0].vertical.riseAcceleration/a.events[0].vertical.riseAcceleration-1/8)<1e-9);
 }finally{await worker.terminate()}
});
