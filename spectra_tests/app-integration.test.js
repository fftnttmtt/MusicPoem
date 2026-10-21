// App wiring smoke test in a DOM/audio stub. This does not replace browser QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as core from '../spectra_web/core.js';
import * as chroma from '../spectra_web/chroma.js';
import * as analysis from '../spectra_web/analysis.js';
import * as events from '../spectra_web/beat-events.js';
import * as visuals from '../spectra_web/visuals.js';
import * as prediction from '../spectra_web/prediction.js';
import * as demo from '../spectra_web/demo-audio.js';
import * as clock from '../spectra_web/playback-clock.js';
import * as clicks from '../spectra_web/beat-clicks.js';
import * as presence from '../spectra_web/presence.js';
import * as stemPlayer from '../spectra_web/stem-player.js';

test('existing app accepts imported predictions, uses model beats and keeps seek anchors',async()=>{
 const html=readFileSync(new URL('../spectra_web/index.html',import.meta.url),'utf8');
 const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,{
  id,hidden:false,checked:false,disabled:false,value:0,clientWidth:1200,clientHeight:800,
  style:{setProperty(){}},listeners:{},classList:{add(){},remove(){}},
  addEventListener(name,callback){this.listeners[name]=callback},setAttribute(name,value){this[name]=value},focus(){},click(){}
 }]));
 let paintedBackground;const radii=[],strokeWidths=[];
 const ctx=new Proxy({stroke(){strokeWidths.push(this.lineWidth)},arc(x,y,r){radii.push(r)},fillRect(x,y,w,h){if(x===0&&y===0&&w===1200&&h===800)paintedBackground=this.fillStyle}},{get:(target,key)=>target[key]??(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
 nodes.get('stage').getContext=()=>ctx;
 let worker;
 class MockWorker{constructor(){worker=this}terminate(){}postMessage(data){this.lastMessage=data}}
 const document={getElementById:id=>{assert.ok(nodes.has(id),'missing DOM node '+id);return nodes.get(id)},querySelectorAll:()=>[],addEventListener(){}};
 class Audio{
  currentTime=0;state='running';destination={};sampleRate=100;
  createGain(){return{connect(){}}}async resume(){}async decodeAudioData(){return{duration:8,length:800,sampleRate:100,numberOfChannels:1,getChannelData:()=>new Float32Array(800).fill(.1)}}
  createBufferSource(){return{connect(){},disconnect(){},start(){},stop(){}}}
  createBuffer(channels,length,sampleRate){const samples=new Float32Array(length);return{getChannelData:()=>samples}}
 }
 const window={AudioContext:Audio,devicePixelRatio:1,addEventListener(){}};
 let wallTime=1000;
 const sandbox={...core,...chroma,...analysis,...events,...visuals,...prediction,...demo,...clock,...clicks,...presence,...stemPlayer,window,document,performance:{now:()=>wallTime},
  fetch:async()=>({ok:false}),crypto:{},setTimeout:()=>1,clearTimeout(){},requestAnimationFrame(){},
  Worker:MockWorker,ResizeObserver:class{observe(){}},URL,AbortController,Blob,Float32Array,console};
 vm.createContext(sandbox);
 const script=readFileSync(new URL('../spectra_web/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('../spectra_web/app.js',import.meta.url).href));
 vm.runInContext(script,sandbox);
 assert.equal(nodes.get('build-info').textContent,'六声部版 R56 · epic 双框净间距 3 px');
 assert.equal(window.spectra.status.settings.showSpectrum,true);
 assert.equal(window.spectra.status.settings.beatClicks,true);
 assert.equal(nodes.get('beat-clicks').checked,true);
 assert.equal(window.spectra.status.settings.spacing,2);
 assert.equal(window.spectra.status.settings.size,1.5);
 assert.equal(window.spectra.status.settings.hoverStrength,4);
 assert.equal(window.spectra.status.settings.positionGamma,.5);
 assert.equal(nodes.get('show-spectrum').checked,true);
 assert.equal(nodes.get('spectrum-button')['aria-pressed'],'true');
 sandbox.testFile={name:'music.wav',type:'audio/wav',arrayBuffer:async()=>new ArrayBuffer(8)};
 await vm.runInContext('loadFile(testFile)',sandbox);
 const model={count:100,frames:801,frameStep:.01,duration:8,beats:[0,.5,1,2,3,4,5,6,7],levels:new Float32Array(80100),
  events:[0,1,2,4].map((born,i)=>({id:i+1,born,end:8,beat:i,bar:i,level:.5,keys:[{time:born,value:1}],
   motion:Float32Array.of(born,.5,.4,1,.5,8,.5,.4,1,.5),baseY:.5,vertical:{distance:.03},bindings:[{time:born,bar:i}],cycles:[]})),
  viewport:{width:1200,height:800},estimate:{bpm:120,offset:0,confidence:1}};
 worker.onmessage({data:{type:'model',id:worker.lastMessage.id,model}});
 const {bundle}=JSON.parse(readFileSync(new URL('./fixtures/default-prediction.json',import.meta.url),'utf8'));
 await nodes.get('prediction-input').listeners.change({target:{files:[{text:async()=>JSON.stringify(bundle)}],value:''}});
 assert.deepEqual(Array.from(worker.lastMessage.customBeats),bundle.beats);
 worker.onmessage({data:{type:'model',id:worker.lastMessage.id,model}});
 assert.equal(window.spectra.status.prediction.unit,'bar');
 assert.ok(model.events.every(e=>e.motif));
 assert.equal(nodes.get('auto-bpm').disabled,true);
 assert.equal(nodes.get('bpm').disabled,true);
 assert.equal(nodes.get('prediction-download').disabled,false);
 assert.match(nodes.get('mode-label').textContent,/模型预测/);
 vm.runInContext('seekTo(4);draw()',sandbox);
 assert.equal(window.spectra.status.time,4);
 const color=prediction.predictedBackground(prediction.preparePrediction(bundle,8),4);
 assert.equal(paintedBackground,'rgb('+color.join(',')+')');
 assert.ok(window.spectra.status.visible.every(e=>e.motif));
 await new Promise(resolve=>setImmediate(resolve));
 vm.runInContext('state.audio.currentTime=state.startedAt+.001;draw()',sandbox);
 // Measure actual canvas geometry: spacing has no size cap; the size slider
 // changes radius immediately without waiting for a worker model rebuild.
 const measuredRadius=()=>{radii.length=0;vm.runInContext('draw()',sandbox);assert.ok(radii.length);return radii[0]};
 const initialRadius=measuredRadius();
 vm.runInContext('state.offset=0;state.startedAt=0;state.audio.currentTime=4.11;draw()',sandbox);
 assert.ok(measuredRadius()>initialRadius*1.04);
 vm.runInContext('state.audio.currentTime=4.001;draw()',sandbox);
 assert.ok(strokeWidths.length&&strokeWidths.every(w=>w===4.8));
 nodes.get('spacing').listeners.input({target:{value:'0'}});
 assert.equal(measuredRadius(),initialRadius);
 nodes.get('shape-size').listeners.input({target:{value:'160'}});
 assert.ok(Math.abs(measuredRadius()/initialRadius-160/150)<1e-10);
 nodes.get('spacing').listeners.input({target:{value:'12'}});
 assert.ok(Math.abs(measuredRadius()/initialRadius-160/150)<1e-10);
 // Simulate a 200 ms output buffer: all drawing must use audible t=3.9,
 // while the audio rendering clock has already reached 4.1 seconds.
 vm.runInContext('state.offset=0;state.startedAt=0;state.audio.currentTime=4.1;state.audio.outputLatency=.2;state.playing=true;draw()',sandbox);
 assert.ok(Math.abs(window.spectra.status.time-3.9)<1e-10);
 const audibleColor=prediction.predictedBackground(prediction.preparePrediction(bundle,8),3.9);
 assert.equal(paintedBackground,'rgb('+audibleColor.join(',')+')');
 nodes.get('beat-clicks').listeners.change({target:{checked:true}});
 assert.equal(window.spectra.status.settings.beatClicks,true);
 nodes.get('beat-clicks').listeners.change({target:{checked:false}});
 // A real worker-generated final event remains visible at EOF, then fades
 // using wall time while the audio timeline remains at its final timestamp.
 const finalEvent=events.buildEvents({levels:Float32Array.from({length:801*12},(_,i)=>i%12===4?.8:0),
  frames:801,frameStep:.01,duration:8},[0,.5,1,2,3,4,5,6,7],{count:12,mass:8})[0];
 finalEvent.motif=prediction.EMOTION_GROUPS[5];model.events=[finalEvent];
 const hoverY=value=>{
  nodes.get('hover-strength').listeners.input({target:{value:String(value)}});
  vm.runInContext('draw()',sandbox);return window.spectra.status.visible[0].position.y;
 };
 const requestId=worker.lastMessage.id,flat=hoverY(0),normal=hoverY(100),strong=hoverY(400);
 assert.notEqual(normal,flat);
 assert.ok(Math.abs((strong-flat)-4*(normal-flat))<1e-10);
 assert.equal(worker.lastMessage.id,requestId);
 hoverY(400);
 const originalY=window.spectra.status.visible[0].position.y;
 nodes.get('position-gamma').listeners.input({target:{value:'1'}});
 vm.runInContext('draw()',sandbox);
 assert.ok(window.spectra.status.visible[0].position.y>originalY);
 assert.equal(nodes.get('position-gamma-value').textContent,'1.00');
 assert.equal(worker.lastMessage.id,requestId);
 nodes.get('position-gamma').listeners.input({target:{value:'0.5'}});
 vm.runInContext('draw()',sandbox);
 assert.equal(window.spectra.status.visible[0].position.y,originalY);
 vm.runInContext('state.sourceEnded=true;state.audio.currentTime=8;frame()',sandbox);
 assert.equal(window.spectra.status.playing,true);
 assert.ok(Math.abs(window.spectra.status.time-7.8)<1e-10);
 vm.runInContext('state.audio.currentTime=8.2;frame()',sandbox);
 assert.equal(window.spectra.status.playing,false);
 assert.equal(window.spectra.status.time,8);
 assert.equal(window.spectra.status.visible.length,1);
 const yAtEnd=window.spectra.status.visible[0].position.y;
 const alphaAtEnd=window.spectra.status.visible[0].alpha;
 wallTime+=finalEvent.vertical.fallDuration*500;
 vm.runInContext('frame()',sandbox);
 assert.equal(window.spectra.status.time,8);
 assert.ok(window.spectra.status.visible[0].alpha<alphaAtEnd);
 assert.ok(Math.abs(window.spectra.status.visible[0].alpha-events.displayOpacityAt(finalEvent,8+finalEvent.vertical.fallDuration/2))<1e-8);
 assert.ok(window.spectra.status.visible[0].position.y>yAtEnd);
 wallTime+=finalEvent.vertical.fallDuration*500+10;
 vm.runInContext('frame()',sandbox);
 assert.equal(window.spectra.status.visible.length,0);
 vm.runInContext('seekTo(4)',sandbox);
 const paused=window.spectra.status.visible.map(e=>({alpha:e.alpha,y:e.position.y}));
 wallTime+=1000;vm.runInContext('frame()',sandbox);
 assert.deepEqual(window.spectra.status.visible.map(e=>({alpha:e.alpha,y:e.position.y})),paused);
 // Tail release follows the audible clock, fades all actors from their
 // current positions instead of hiding instantly,
 // survives seeks into silence and restores actors when seeking before it.
 vm.runInContext('state.loudness={rms:Float32Array.from([.1,.001,.001,.001]),frameStep:2,duration:8}',sandbox);
 nodes.get('tail-silence').listeners.input({target:{value:'-70'}});
 assert.ok(window.spectra.status.visible.length>0);
 nodes.get('tail-silence').listeners.input({target:{value:'-40'}});
 assert.equal(window.spectra.status.tailClearAt,2.15);
 assert.equal(window.spectra.status.visible.length,0);
 vm.runInContext('seekTo(2.15);draw()',sandbox);
 const atRelease=window.spectra.status.visible[0];assert.ok(atRelease);
 vm.runInContext('seekTo(2.4);draw()',sandbox);
 const releasing=window.spectra.status.visible[0];assert.ok(releasing);
 assert.ok(releasing.alpha<atRelease.alpha);
 assert.ok(releasing.position.y>atRelease.position.y);
 const duringRelease=JSON.stringify(window.spectra.status.visible);
 wallTime+=2000;vm.runInContext('draw()',sandbox);
 assert.equal(JSON.stringify(window.spectra.status.visible),duringRelease);
 vm.runInContext('seekTo(2.8);draw()',sandbox);
 assert.equal(window.spectra.status.visible.length,0);
 vm.runInContext('seekTo(1);draw()',sandbox);
 assert.ok(window.spectra.status.visible.length>0);
 vm.runInContext('seekTo(6);draw()',sandbox);
 assert.equal(window.spectra.status.visible.length,0);
 radii.length=0;vm.runInContext('draw()',sandbox);assert.equal(radii.length,0);
 // The same interface also automatically predicts on the local server.
 sandbox.requestPrediction=async(file,unit,onProgress)=>{
  assert.equal(file.name,'music.wav');assert.equal(unit,'bar');
  onProgress('working',.5);return bundle;
 };
 vm.runInContext('state.localEngine=true;settings.stemMode=false',sandbox);
 await vm.runInContext('loadFile(testFile)',sandbox);
 assert.deepEqual(Array.from(worker.lastMessage.customBeats),bundle.beats);
 worker.onmessage({data:{type:'model',id:worker.lastMessage.id,model:{...model,beats:bundle.beats}}});
 assert.equal(window.spectra.status.prediction.unit,'bar');
 assert.equal(window.spectra.status.beatMode,'Beat This! 预测节拍');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(window.spectra.status.time,0);
 assert.equal(window.spectra.status.visible.length,0); // output has not reached the scheduled start
 vm.runInContext('state.audio.currentTime=state.startedAt+state.audio.outputLatency+.001;draw()',sandbox);
 assert.ok(window.spectra.status.visible.length>0);
 // Exercise the new path through the real app: backend result -> canonical
 // playback waveform -> worker shared beats -> six-source rendering.
 const stemBundle=JSON.parse(readFileSync(new URL('./fixtures/stems-prediction.json',import.meta.url),'utf8'));
 sandbox.requestStemPrediction=async(file,options,onProgress)=>{
  assert.equal(file.name,'music.wav');assert.equal(options.chunkSeconds,0);onProgress('six stems',1);return stemBundle;
 };
 nodes.get('sw-weights').value='';nodes.get('sw-chunk').value='0';
 const fetched=[];sandbox.fetch=async url=>{fetched.push(url);return{ok:true,arrayBuffer:async()=>new ArrayBuffer(8)}};
 vm.runInContext("settings.stemMode=true;state.audio.decodeAudioData=async()=>({duration:12,length:1200,sampleRate:100,numberOfChannels:1,getChannelData:()=>new Float32Array(1200).fill(.1)})",sandbox);
 await vm.runInContext('loadFile(testFile)',sandbox);
 assert.ok(fetched.includes(stemBundle.audio.playback_url));
 assert.equal(worker.lastMessage.settings.stemMode,true);
 assert.deepEqual(Array.from(worker.lastMessage.customBeats),stemBundle.beats);
 worker.onmessage({data:{type:'model',id:worker.lastMessage.id,model:{...model,duration:12,frames:1201,events:[],levels:new Float32Array(120100),beats:stemBundle.beats}}});
 await new Promise(resolve=>setImmediate(resolve));
 vm.runInContext('state.audio.currentTime=state.startedAt+state.audio.outputLatency+4;draw()',sandbox);
 assert.equal(window.spectra.status.mode,'stems');assert.equal(window.spectra.status.stemActors.length,5);
 assert.equal(paintedBackground,'rgb(0,0,0)');
 assert.equal(nodes.get('legacy-triggers').hidden,true);assert.equal(nodes.get('predict-per-beat').disabled,true);
 assert.equal(nodes.get('prediction-download').disabled,false);
 vm.runInContext('pause()',sandbox);const frozen=JSON.stringify(window.spectra.status.stemActors);
 wallTime+=1000;vm.runInContext('frame()',sandbox);
 assert.equal(JSON.stringify(window.spectra.status.stemActors),frozen);
 vm.runInContext('seekTo(6);draw()',sandbox);assert.equal(window.spectra.status.time,6);

});
