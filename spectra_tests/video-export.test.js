import test from 'node:test';
import assert from 'node:assert/strict';
import {exportOfflineVideo,exportFrameCount,exportFrameTime} from '../spectra_web/lab/video-export.js';
function setup(duration=.2){
 const controller=new AbortController(),calls=[],times=[],progress=[],frames=exportFrameCount(duration,30);
 const canvas={getContext(){return{setTransform(...a){calls.push(['transform',...a])}}},toBlob(fn){fn(new Blob(['png'],{type:'image/png'}))}};
 return{controller,calls,times,progress,frames,options:{runId:'a'.repeat(32),bundle:{audio:{duration_seconds:duration}},scene:{size:1},referenceWidth:960,referenceHeight:540,width:1920,height:1080,fps:30,audioStem:'mix',createCanvas:()=>canvas,paint:(ctx,b,t,v)=>times.push([t,v]),signal:controller.signal,onProgress:p=>progress.push(p)}};
}
test('offline export renders every exact timestamp, awaits each upload and appends a complete release tail',async()=>{
 const h=setup(),old=global.fetch;let received=0,concurrent=0;
 global.fetch=async(url,options)=>{
  h.calls.push([url,options]);assert.equal(options.headers['X-Spectra-Client'],'1');
  if(url.endsWith('/video'))return{ok:true,json:async()=>({id:'b'.repeat(32),frames:h.frames})};
  if(url.includes('/frame?')){assert.equal(Number(url.split('=').at(-1)),received++);assert.equal(concurrent++,0);await new Promise(r=>setImmediate(r));concurrent--;return{ok:true,json:async()=>({received})}}
  assert.ok(url.endsWith('/finish'));return{ok:true,json:async()=>({url:'out.mp4'})};
 };
 try{
  const result=await exportOfflineVideo(h.options);assert.equal(result.url,'out.mp4');assert.equal(received,h.frames);
  assert.equal(h.times.length,h.frames);for(const [i,[t,v]] of h.times.entries()){assert.equal(v,i/30);assert.equal(t,Math.min(.2,i/30))}
  assert.ok(h.times.at(-1)[1]>=.7);assert.equal(h.progress.at(-1).fraction,1);assert.deepEqual(h.calls.find(a=>a[0]==='transform'),['transform',2,0,0,2,0,0]);
 }finally{global.fetch=old}
});
test('cancellation stops new frames and cancels the encoder session without finishing a partial video',async()=>{
 const h=setup(),old=global.fetch;let received=0,cancelled=0;
 global.fetch=async(url)=>{
  if(url.endsWith('/video'))return{ok:true,json:async()=>({id:'b'.repeat(32),frames:h.frames})};
  if(url.includes('/frame?')){if(++received===3)h.controller.abort();return{ok:true,json:async()=>({received})}}
  assert.ok(url.endsWith('/cancel'));cancelled++;return{ok:true,json:async()=>({cancelled:true})};
 };
 try{await assert.rejects(exportOfflineVideo(h.options),{name:'AbortError'});assert.equal(received,3);assert.equal(cancelled,1)}finally{global.fetch=old}
});
test('failed frame uploads report the error and clean the unfinished encoder; frame count covers noninteger durations',async()=>{
 const h=setup(),old=global.fetch;let cancelled=false;
 global.fetch=async(url)=>url.endsWith('/video')?{ok:true,json:async()=>({id:'b'.repeat(32),frames:h.frames})}:url.includes('/cancel')?(cancelled=true,{ok:true,json:async()=>({})}):{ok:false,json:async()=>({error:'disk full'})};
 try{await assert.rejects(exportOfflineVideo(h.options),/disk full/);assert.equal(cancelled,true)}finally{global.fetch=old}
 assert.equal(exportFrameCount(10.123,60),641);assert.deepEqual(exportFrameTime(640,60,10.123),{time:10.123,visualTime:640/60});
});

test('a lost frame acknowledgement retries the identical PNG without painting or advancing twice',async()=>{
 const h=setup(),old=global.fetch;let failed=false,received=0,lastBody=null,retries=0;
 global.fetch=async(url,options)=>{
  if(url.endsWith('/video'))return{ok:true,json:async()=>({id:'b'.repeat(32),frames:h.frames})};
  if(url.includes('/frame?')){
   const i=Number(url.split('=').at(-1));
   if(i===4&&!failed){failed=true;received++;lastBody=options.body;throw TypeError('Failed to fetch')}
   if(i===4){retries++;assert.equal(options.body,lastBody);assert.equal(received,5)}else{assert.equal(i,received);received++}
   return{ok:true,json:async()=>({received})};
  }
  return{ok:true,json:async()=>({url:'complete.mp4'})};
 };
 try{assert.equal((await exportOfflineVideo(h.options)).url,'complete.mp4');assert.equal(retries,1);assert.equal(h.times.length,h.frames);assert.equal(received,h.frames)}finally{global.fetch=old}
});

test('lost finish response recovers by retrying and polling, without cancelling a finished MP4',async()=>{
 const h=setup(),old=global.fetch;let finishes=0,polls=0,cancelled=false;
 global.fetch=async url=>{
  if(url.endsWith('/video'))return{ok:true,json:async()=>({id:'b'.repeat(32),frames:h.frames})};
  if(url.includes('/frame?'))return{ok:true,json:async()=>({received:Number(url.split('=').at(-1))+1})};
  if(url.endsWith('/finish')){if(++finishes===1)throw TypeError('Failed to fetch');return{ok:true,json:async()=>({state:'encoding'})}}
  if(url.endsWith('/status')){polls++;return{ok:true,json:async()=>({state:'done',result:{url:'recovered.mp4'}})}}
  cancelled=true;return{ok:true,json:async()=>({})};
 };
 try{assert.equal((await exportOfflineVideo(h.options)).url,'recovered.mp4');assert.equal(finishes,2);assert.equal(polls,1);assert.equal(cancelled,false)}finally{global.fetch=old}
});

test('permanent connection failure reports the frame, retries finitely and preserves diagnostics',async()=>{
 const h=setup(),old=global.fetch;let tries=0,cleanup='';
 global.fetch=async url=>{
  if(url.endsWith('/video'))return{ok:true,json:async()=>({id:'b'.repeat(32),frames:h.frames})};
  if(url.includes('/frame?')){tries++;throw TypeError('Failed to fetch')}
  cleanup=url;return{ok:true,json:async()=>({})};
 };
 try{
  await assert.rejects(exportOfflineVideo(h.options),e=>/第 1\/23 帧/.test(e.message)&&/重试3次/.test(e.message)&&/\.log/.test(e.message));
  assert.equal(tries,4);assert.equal(h.times.length,1);assert.match(cleanup,/cancel\?preserve=1$/);
 }finally{global.fetch=old}
});

test('a lost session creation response retries the same client export identity',async()=>{
 const h=setup(),old=global.fetch;let created=null,attempts=0;
 global.fetch=async(url,options)=>{
  if(url.endsWith('/video')){
   const body=JSON.parse(options.body);assert.match(body.export_id,/^[0-9a-f]{32}$/);
   if(++attempts===1){created=body;throw TypeError('Failed to fetch')}
   assert.deepEqual(body,created);return{ok:true,json:async()=>({id:body.export_id,frames:h.frames})};
  }
  if(url.includes('/frame?'))return{ok:true,json:async()=>({received:Number(url.split('=').at(-1))+1})};
  return{ok:true,json:async()=>({url:'out.mp4'})};
 };
 try{await exportOfflineVideo(h.options);assert.equal(attempts,2)}finally{global.fetch=old}
});
