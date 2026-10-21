import * as coverage from '../spectra_web/overlap-coverage.js';
import {paintLabScene as realPaintLabScene} from '../spectra_web/lab/lab-scene.js';
// DOM/audio stubs exercise wiring; these checks do not claim browser rendering QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as model from '../spectra_web/lab/lab-model.js';
import {stemStatesAt,sampleMotion,sampleBeatCentroid,sampleBeatVolume} from '../spectra_web/stem-player.js';
import * as geometry from '../spectra_web/emotion-shape.js';
import {paintOverlapShapes} from '../spectra_web/overlap-color.js';
import * as pitchDiagnostics from '../spectra_web/pitch-diagnostics.js';
import {samplePitch} from '../spectra_web/pitch-player.js';
import {playbackTime} from '../spectra_web/playback-clock.js';

function harness(){
 const html=readFileSync(new URL('../spectra_web/lab/index.html',import.meta.url),'utf8');
 class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.clientWidth=700;this._text='';this.classList={toggle(){}};this.attributes={height:'172'};this.width=0;this.height=0}
  set textContent(value){this._text=value}get textContent(){return this._text}
  get options(){return this.children}get firstChild(){return this.children[0]}
  append(...nodes){this.children.push(...nodes)}prepend(...nodes){this.children.unshift(...nodes)}replaceChildren(...nodes){this.children=[...nodes]}
  getAttribute(key){return this.attributes[key]}setAttribute(key,value){this.attributes[key]=value}
  addEventListener(name,fn){this['on'+name]=fn}getBoundingClientRect(){return{left:0,top:0}}
  getContext(){return ctx}pause(){this.paused=true}async play(){this.paused=false;this.onplay?.()}click(){this.onclick?.()}
 }
 const fills=[];
 const ctx=new Proxy({setTransform(){},clearRect(){},fillRect(x,y,w,h){fills.push({color:this.fillStyle,x,y,w,h})},fillText(){}},{get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>(o[k]=v,true)});
 const nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
 for(const [id,height] of [['preview',350],['features',156],['waveform',132],['timeline',172],['heatmap',244]])nodes.get(id).attributes.height=String(height);
 nodes.get('bar-start').value=1;nodes.get('bar-end').value=3;nodes.get('listen').value='mix';nodes.get('pitch-mode').value='beat_summary';nodes.get('pitch-span').value='context';for(const id of ['pitch-show-raw','pitch-show-accepted','pitch-show-beat','pitch-show-position','clicks','follow','guides','overlap-preview'])nodes.get(id).checked=true;nodes.get('size').value=Number(/id="size"[^>]*value="([^"]+)"/.exec(html)[1]);
 const painted=[];let wall=1000;
 const document={getElementById:id=>{assert.ok(nodes.has(id),'missing node '+id);return nodes.get(id)},createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),querySelectorAll:selector=>selector==='[data-stem-check]'?nodes.get('stem-checks').children.map(label=>label.children[0]):[]};
 class Audio{currentTime=0;outputLatency=.2;destination={};async resume(){}async decodeAudioData(){return{duration:12}}createBufferSource(){return{connect(){},start(){},stop(){}}}}
 const sandbox={...coverage,...model,...geometry,...pitchDiagnostics,paintPaperTexture(){},paintOverlapShapes,exportOfflineVideo:async()=>{throw Error("not stubbed")},AbortController,paintLabScene:(...args)=>realPaintLabScene(...args,{actorStates:(...a)=>sandbox.stemStatesAt(...a),paintShape:(...a)=>painted.push(a),paintPaper:(...a)=>sandbox.paintPaperTexture(...a),paintOverlap:(...a)=>sandbox.paintOverlapShapes(...a)}),samplePitch,stemStatesAt,sampleMotion,sampleBeatCentroid,sampleBeatVolume,playbackTime,paintEmotionShape:(...args)=>painted.push(args),document,window:{},devicePixelRatio:2,AudioContext:Audio,localStorage:{setItem(){},getItem(){return null}},Blob,URL:{createObjectURL(blob){sandbox.exportBlob=blob;return 'blob:test'},revokeObjectURL(){}},performance:{now:()=>wall},requestAnimationFrame(){},setTimeout,console,
  fetch:async()=>({ok:true,json:async()=>({runs:[]})})};
 vm.createContext(sandbox);const script=readFileSync(new URL('../spectra_web/lab/lab.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');vm.runInContext(script,sandbox);
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
 const stages=Object.fromEntries(model.STAGES.map(([s])=>[s,{status:'ready'}]));stages.features.reference_rms=fixture.volume.reference_rms;stages.emotion.counts={ok:15,silent:3,error:0,pending:0};
 const manifest={id:'a'.repeat(32),name:'test.wav',duration_seconds:12,sample_rate:44100,parameters:{pitch_method:'hybrid',melodia_high_pitch_bias:4,melodia_voicing_tolerance:1.2,melodia_confidence_threshold:0,...fixture.defaults,...geometry.GEOMETRY_DEFAULTS,chunk_seconds:0,amp:true,sw_weights:'',gate_dbfs:-55,frame_seconds:.02},stages,artifacts:[],directory:'experiment/test',logs:[]};
 const bars=fixture.bars.map(b=>({...b,start:b.start_seconds,end:b.end_seconds}));
 const raw=fixture.stems[0].segments.map((r,i)=>({...r,status:r.prediction_status,label:'bar '+(i+1),scores:Object.entries(r.tag_scores).map(([tag,score])=>({tag,score}))}));
 const pitch=fixture.stems[0].pitch;
 const pitch_raw={times:pitch.continuous.map(r=>r.start_seconds),f0_hz:pitch.continuous.map(r=>r.f0_hz),voiced_flag:pitch.continuous.map(r=>r.status==='ok'),voiced_probability:pitch.continuous.map(r=>r.confidence),rms:pitch.continuous.map(()=>.05)};
 const inspect={pitch,pitch_raw,meter:{segments:bars,beats:fixture.beats,downbeats:fixture.downbeats},emotion:{segments:raw},motion:fixture.stems[0].motion,beat_motion:fixture.stems[0].beat_motion,beat_volume:fixture.stems[0].beat_volume,plan:{segment_rows:raw,diagnostic:{time_s:[0,6,12],novelty:[0,.3,0]}},waveform:{times:[0,2,4,6,8,10],peaks:[.1,.2,.1,.2,.1,.1]}};
 Object.assign(sandbox,{fixture,manifest,inspect});vm.runInContext('state.manifest=manifest;state.inspect=inspect;state.bundle=fixture;state.buffer={duration:12};buildParameters(manifest.parameters);renderManifest();renderInspector();renderTable()',sandbox);
 return{sandbox,nodes,painted,fills,fixture,manifest,inspect,run:code=>vm.runInContext(code,sandbox),setWall:t=>wall=t};
}

test('job polling recovers when the JSON response body is interrupted',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));let calls=0;
 h.sandbox.fetch=async()=>({ok:true,json:async()=>{if(++calls===1)throw TypeError('Failed to fetch');return{status:'running',progress:.5}}});
 const result=await h.run("api('/api/jobs/retry-body')");
 assert.equal(result.status,'running');assert.equal(calls,2);
});

test('workbench renders process data and synchronized preview without canvas growth',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 h.run('drawCharts(2.2);drawPreview(2.2)');
 assert.ok(h.painted.length>0);assert.match(h.nodes.get('row-json').textContent,/prediction_start_seconds/);
 assert.equal(h.nodes.get('scores').children.length,9);
 const dimensions=['timeline','waveform','features','heatmap','preview'].map(id=>h.nodes.get(id).height);
 for(let i=0;i<5;i++)h.run('drawCharts(2.2);drawPreview(2.2)');
 assert.deepEqual(['timeline','waveform','features','heatmap','preview'].map(id=>h.nodes.get(id).height),dimensions);
 h.run('state.audio=new AudioContext();state.audio.currentTime=4.1;state.playing=true;state.startedAt=0;state.offset=0;frame(1000)');
 assert.match(h.nodes.get('clock').textContent,/00:03.900/);
 h.run('selectRow(2)');assert.equal(h.run('state.offset'),9);
 h.nodes.get('audition-context').onclick();assert.match(h.nodes.get('clip-player').src,/row=3&kind=context/);
 assert.equal(h.run('state.playing'),false);
});

test('mapping edits disable model buttons until saved, then only submit configure',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 h.run("parameterFields.find(f=>f.key==='hue_gamma').inputs[0].value=1;dirtyChanged()");
 assert.equal(h.run('state.dirty'),true);
 assert.ok(h.nodes.get('stages').children.every(row=>row.children[1].disabled));
 const submitted=[];let params={...h.manifest.parameters,hue_gamma:1};const saved={...h.manifest,parameters:params,stages:{...h.manifest.stages,mapping:{status:'stale'}}};
 h.sandbox.fetch=async(path,options)=>{
  if(options?.method==='POST'){submitted.push(JSON.parse(options.body));return{ok:true,json:async()=>({job_id:'job'})}}
  if(path==='/api/jobs/job')return{ok:true,json:async()=>({status:'done',result:saved})};
  if(path==='/api/lab/runs')return{ok:true,json:async()=>({runs:[{id:saved.id,name:saved.name,duration_seconds:12}]})};
  if(path.includes('/inspect?'))return{ok:true,json:async()=>h.inspect};
  if(path.includes('/files/listen.wav'))return{ok:true,arrayBuffer:async()=>new ArrayBuffer(8)};
  return{ok:true,json:async()=>saved};
 };
 await h.run("runStage('configure')");
 assert.deepEqual(submitted,[{stage:'configure',parameters:{hue_gamma:1}}]);
 assert.equal(h.run('state.bundle'),null);
 assert.equal(h.run('state.dirty'),false);
 assert.equal(h.run('state.busy'),false);
});

test('natural end waits for audible output and lets final shapes fall/fade',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 await h.run('state.audio=new AudioContext();play()');
 h.run('state.audio.currentTime=state.startedAt+12;state.source.onended();frame(2000)');
 assert.equal(h.run('state.playing'),true);
 assert.match(h.nodes.get('clock').textContent,/00:11.800/);
 h.run('state.audio.currentTime=state.startedAt+12.2;frame(2200)');
 assert.equal(h.run('state.playing'),false);
 h.painted.length=0;h.run('frame(3200)');assert.equal(h.painted.length,0);
});
test('preview stays 16:9 on resize, uses song background and rebased 100 percent geometry',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 delete h.fixture.background;h.fixture.whole_song_color={status:'ok',hex:'#527da8',rgb:[82,125,168]};
 h.run('drawPreview(4)');
 let bg=h.fills.at(-1);assert.equal(bg.color,'rgb(82,125,168)');assert.equal(bg.h,bg.w*9/16);
 assert.equal(h.nodes.get('preview').style.height,'393.75px');
 const old=stemStatesAt(h.fixture,4,4,{size:3,sizeMultiplier:3},700,700*9/16);
 h.painted.forEach(a=>{const previous=old.find(actor=>actor.id===a[1].stem);assert.ok(Math.abs(a[4]/previous.radius-1)<1e-12)});
 h.nodes.get('preview').clientWidth=960;h.run('drawPreview(4)');bg=h.fills.at(-1);assert.equal(bg.w,960);assert.equal(bg.h,540);
 assert.equal(h.nodes.get('preview').height,1080);
});
test('one-click sends all action with draft settings regardless of trial selection',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 h.run("parameterFields.find(f=>f.key==='hue_gamma').inputs[0].value=1;dirtyChanged()");
 assert.equal(h.nodes.get('run-all').disabled,false);
 const submitted=[],saved={...h.manifest,parameters:{...h.manifest.parameters,hue_gamma:1}};
 h.sandbox.fetch=async(path,options)=>{
  if(options?.method==='POST'){submitted.push(JSON.parse(options.body));return{ok:true,json:async()=>({job_id:'all'})}}
  if(path==='/api/jobs/all')return{ok:true,json:async()=>({status:'done',result:saved})};
  if(path==='/api/lab/runs')return{ok:true,json:async()=>({runs:[{id:saved.id,name:saved.name,duration_seconds:12}]})};
  if(path.includes('/inspect?'))return{ok:true,json:async()=>h.inspect};
  if(path.includes('/files/mapped.json'))return{ok:true,json:async()=>h.fixture};
  if(path.includes('/files/listen.wav'))return{ok:true,arrayBuffer:async()=>new ArrayBuffer(8)};
  return{ok:true,json:async()=>saved};
 };
 await h.run("runStage('all')");
 assert.deepEqual(submitted,[{stage:'all',parameters:{hue_gamma:1}}]);
 assert.ok(h.nodes.get('stem-checks').children.every(label=>label.children[0].checked));
 assert.equal(h.nodes.get('bar-end').value,3);
 assert.match(h.nodes.get('status').textContent,/全部过程完成/);
});

test('workbench uses beat means and full-period motion with a genuinely time-varying background',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));let settings;
 h.sandbox.stemStatesAt=(p,t,vt,s,...rest)=>{settings=s;return stemStatesAt(p,t,vt,s,...rest)};
 h.run('drawPreview(1)');const before=h.fills.at(-1).color;
 h.run('drawPreview(5)');const after=h.fills.at(-1).color;
 assert.notEqual(before,after);assert.equal(settings.motionFraction,1);assert.equal(settings.beatCentroid,true);assert.equal(settings.beatVolume,true);
 assert.match(h.nodes.get('background-info').textContent,/原曲片段/);
 assert.match(h.nodes.get('live-readout').textContent,/音高/);
 assert.match(h.nodes.get('normalization').textContent,/P5\/P95/);
});
test('stable instrument shapes default to rebased 100 percent and black borders preview while paused',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 h.run('drawPreview(4)');const first=h.painted.find(a=>a[1].stem==='bass')[1];assert.equal(first.kind,'rectangle');assert.equal(h.nodes.get('size').value,100);
 h.painted.length=0;
 h.run("parameterFields.find(f=>f.key==='outline_arousal_scale').inputs[0].value=3;dirtyChanged();drawPreview(4)");
 assert.equal(h.painted[0][1].outline_width,first.outline_width*2);
 assert.equal(h.run('state.playing'),false);assert.equal(h.run('state.dirty'),true);
 assert.match(h.nodes.get('geometry-readout').textContent,/固定形态：横矩形/);
 h.run("parameterFields.find(f=>f.key==='outline_arousal_scale').inputs[0].value=0;dirtyChanged()");
 assert.equal(h.nodes.get('apply').disabled,true);assert.equal(h.nodes.get('run-all').disabled,true);
});


test('preview paints requested layers and both checkboxes update immediately while paused',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 h.run('drawPreview(4)');
 assert.deepEqual(h.painted.map(a=>a[1].stem),['bass','guitar','other','drums','vocals']);
 assert.equal(h.painted.at(-1)[1].stem,'vocals');
 h.painted.length=0;
 h.run("parameterFields.find(f=>f.key==='outline_enabled').inputs[0].checked=false;parameterFields.find(f=>f.key==='rotation_enabled').inputs[0].checked=false;dirtyChanged();drawPreview(4)");
 assert.ok(h.painted.every(a=>a[1].outline_enabled===false&&a[1].rotation_offset_degrees===0));
 assert.equal(h.run('state.playing'),false);assert.equal(h.run('state.dirty'),true);
});

test('independent borders preview immediately, master preserves selections, and unsaved settings export',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 h.painted.length=0;h.run('drawPreview(4)');
 for(const a of h.painted)assert.equal(a[1].outline_enabled,['drums','piano','guitar'].includes(a[1].stem));
 h.run("parameterFields.find(f=>f.key==='outline_bass_enabled').inputs[0].checked=true;parameterFields.find(f=>f.key==='outline_guitar_enabled').inputs[0].checked=false;dirtyChanged()");
 h.painted.length=0;h.run('drawPreview(4)');
 assert.equal(h.painted.find(a=>a[1].stem==='bass')[1].outline_enabled,true);
 assert.equal(h.painted.find(a=>a[1].stem==='guitar')[1].outline_enabled,false);
 h.run("parameterFields.find(f=>f.key==='outline_enabled').inputs[0].checked=false;dirtyChanged()");
 h.painted.length=0;h.run('drawPreview(4)');assert.ok(h.painted.every(a=>!a[1].outline_enabled));
 h.run("parameterFields.find(f=>f.key==='outline_enabled').inputs[0].checked=true;dirtyChanged()");
 h.painted.length=0;h.run('drawPreview(4)');assert.equal(h.painted.find(a=>a[1].stem==='bass')[1].outline_enabled,true);
 h.nodes.get('export').onclick();const exported=JSON.parse(await h.sandbox.exportBlob.text());
 assert.equal(exported.geometry.revision,47);assert.equal(exported.geometry.parameters.outline_bass_enabled,true);
 assert.equal(exported.geometry.outline_instruments.bass,true);assert.equal(exported.geometry.outline_instruments.guitar,false);
 assert.equal(exported.defaults.outline_guitar_enabled,false);assert.deepEqual(exported.geometry.outline_multipliers,geometry.OUTLINE_MULTIPLIERS);
 assert.equal(h.run('state.playing'),false);assert.equal(h.run('state.dirty'),true);
});

test('mixed overlap preview uses cached combinations and can toggle back without inference',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));let calls=0;
 h.fixture.overlap={enabled:true,combinations:[]};h.nodes.get('overlap-preview').checked=true;
 h.sandbox.paintOverlapShapes=(ctx,actors,overlap,t,w,ht,scale)=>{calls++;assert.equal(overlap.enabled,true);return{painted:1,missing:0}};
 h.run('drawPreview(4)');assert.equal(calls,1);assert.match(h.nodes.get('overlap-readout').textContent,/已开启/);
 h.nodes.get('overlap-preview').checked=false;h.painted.length=0;
 h.run('drawPreview(4)');assert.equal(calls,1);assert.ok(h.painted.length>0);assert.match(h.nodes.get('overlap-readout').textContent,/预览已关闭/);
 assert.equal(h.run('state.playing'),false);
});

test('all six outline multipliers preview and export unsaved values while preserving geometry positions and sizes',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));h.painted.length=0;h.run('drawPreview(4)');
 const before=new Map(h.painted.map(args=>[args[1].stem,args]));
 for(const [i,stem] of model.STEMS.entries())h.run(`parameterFields.find(f=>f.key==='outline_${stem}_multiplier').inputs[0].value=${(i+1)/4}`);
 h.run('dirtyChanged()');h.painted.length=0;h.run('drawPreview(4)');
 for(const a of h.painted){const stem=a[1].stem,m=(model.STEMS.indexOf(stem)+1)/4;assert.equal(a[1].outline_multiplier,m);assert.equal(a[1].outline_width,1.5*m*a[1].arousal);assert.deepEqual(a.slice(2,5),before.get(stem).slice(2,5));}
 h.nodes.get('export').onclick();const data=JSON.parse(await h.sandbox.exportBlob.text());
 for(const [i,stem] of model.STEMS.entries()){const m=(i+1)/4;assert.equal(data.geometry.parameters['outline_'+stem+'_multiplier'],m);assert.equal(data.geometry.outline_multipliers[stem],m);assert.equal(data.defaults['outline_'+stem+'_multiplier'],m);}
 assert.equal(h.run('state.playing'),false);assert.equal(h.run('state.dirty'),true);
});

test('preview switches pitch modes while paused, shows MIDI/coverage and exports the selected mode',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));h.painted.length=0;h.run('drawPreview(4.25)');
 assert.match(h.nodes.get('live-readout').textContent,/逐拍音高中位数/);
 assert.match(h.nodes.get('normalization').textContent,/有效帧/);
 h.nodes.get('pitch-mode').value='continuous';h.nodes.get('pitch-mode').onchange();h.run('drawPreview(4.25)');
 assert.match(h.nodes.get('live-readout').textContent,/连续音高/);
 h.nodes.get('export').onclick();const data=JSON.parse(await h.sandbox.exportBlob.text());
 assert.equal(data.movement.pitch_preview_mode,'continuous');assert.equal(h.run('state.playing'),false);
 assert.ok(h.painted.length>0);
});

test('pitch diagnosis shows cached raw estimates, zooms, hovers and seeks without prediction requests',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));h.run('drawCharts(4)');
 assert.match(h.nodes.get('pitch-summary').textContent,/全曲有效/);
 assert.match(h.nodes.get('pitch-hover').textContent,/MIDI/);
 h.sandbox.fetch=async()=>{throw Error('diagnostic viewing must not request inference')};
 h.nodes.get('pitch-span').value='song';h.nodes.get('pitch-span').onchange();
 const domain=h.nodes.get('pitch-chart')._domain;assert.equal(domain[0],0);assert.equal(domain[1],12);
 h.nodes.get('pitch-chart').onmousemove({clientX:(domain[2]+domain[3])/2});
 assert.match(h.nodes.get('pitch-hover').textContent,/指针 00:06.000/);
 h.nodes.get('pitch-show-raw').checked=false;h.nodes.get('pitch-show-raw').onchange();
 h.nodes.get('pitch-chart').onclick({clientX:(domain[2]+domain[3])/2});assert.equal(h.run('state.offset'),6);
 h.nodes.get('pitch-chart').onmouseleave();assert.equal(h.run('state.pitchHover'),null);
});

test('Foote motion previews, switches off and exports without recalculation',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));h.painted.length=0;h.run('drawPreview(4)');
 const enabled=h.painted.map(a=>({stem:a[1].stem,x:a[2],y:a[3]}));assert.match(h.nodes.get('live-readout').textContent,/Foote速度/);
 h.run("parameterFields.find(f=>f.key==='foote_motion_enabled').inputs[0].checked=false;dirtyChanged()");h.painted.length=0;h.run('drawPreview(4)');
 assert.match(h.nodes.get('live-readout').textContent,/原固定缓动/);assert.ok(h.painted.some(a=>{const old=enabled.find(v=>v.stem===a[1].stem);return a[2]!==old.x||a[3]!==old.y}));
 h.nodes.get('export').onclick();const data=JSON.parse(await h.sandbox.exportBlob.text());
 assert.equal(data.defaults.foote_motion_enabled,false);assert.equal(data.movement.foote_motion_enabled,false);assert.equal(data.geometry.parameters.foote_motion_enabled,false);
});

test('older saved experiments hydrate Foote through a read-only request with no prediction job',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 const old=JSON.parse(JSON.stringify(h.fixture)),tracks=Object.fromEntries(old.stems.map(t=>[t.id,t.motion_foote]));for(const t of old.stems)delete t.motion_foote;
 const requested=[];h.sandbox.fetch=async(path,options)=>{
  requested.push({path,method:options?.method||'GET'});
  if(path.endsWith('/motion'))return{ok:true,json:async()=>({tracks,inference:false})};
  if(path.includes('/files/mapped.json'))return{ok:true,json:async()=>JSON.parse(JSON.stringify(old))};
  if(path.includes('/inspect?'))return{ok:true,json:async()=>h.inspect};
  if(path.includes('/files/listen.wav'))return{ok:true,arrayBuffer:async()=>new ArrayBuffer(8)};
  if(path==='/api/lab/runs')return{ok:true,json:async()=>({runs:[{id:h.manifest.id,name:'test.wav',duration_seconds:12}]})};
  return{ok:true,json:async()=>h.manifest};
 };
 await h.run('loadRun(manifest.id)');assert.equal(requested.filter(r=>r.path.endsWith('/motion')).length,1);
 assert.ok(requested.every(r=>r.method==='GET'));assert.ok(h.run('state.bundle.stems.every(t=>!!t.motion_foote)'));
 assert.ok(old.stems.every(t=>!t.motion_foote));
});

test('melody controls save engine/high-register preference and diagnostics report the actual cached engine',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));
 assert.equal(h.run("parameterFields.find(f=>f.key==='melodia_high_pitch_bias').inputs[0].value"),4);
 h.run("parameterFields.find(f=>f.key==='pitch_method').inputs[0].value='melodia';parameterFields.find(f=>f.key==='melodia_high_pitch_bias').inputs[0].value=3;dirtyChanged()");
 assert.equal(h.run('draft().pitch_method'),'melodia');assert.equal(h.run('draft().melodia_high_pitch_bias'),3);
 assert.equal(h.run('state.dirty'),true);
 h.inspect.pitch.method='melodia';h.inspect.pitch_raw.method='melodia';h.inspect.pitch_raw.settings={high_pitch_bias:4};
 h.run('drawPitchPanel(2)');
 assert.match(h.nodes.get('pitch-summary').textContent,/Melodia · 高音偏好 4/);
 assert.match(h.nodes.get('pitch-hover').textContent,/Melodia 显著度置信值/);
 assert.doesNotMatch(h.nodes.get('pitch-summary').textContent,/pYIN单条基频/);
});

test('material and double drum controls preview and export immediately without inference or geometry changes',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));h.painted.length=0;h.run('drawPreview(4)');
 const before=new Map(h.painted.map(args=>[args[1].stem,args]));
 let paperCalls=[];h.sandbox.paintPaperTexture=(ctx,w,height,config,scale)=>paperCalls.push({w,height,config,scale});
 h.run("parameterFields.find(f=>f.key==='texture_enabled').inputs[0].checked=false;parameterFields.find(f=>f.key==='texture_pigment_strength').inputs[0].value=.7;parameterFields.find(f=>f.key==='drums_outline_gap').inputs[0].value=10;parameterFields.find(f=>f.key==='drums_inner_ratio').inputs[0].value=.2;dirtyChanged()");
 h.painted.length=0;h.run('drawPreview(4)');assert.equal(paperCalls.at(-1).config.texture_enabled,false);
 for(const a of h.painted){assert.equal(a[1].texture_enabled,false);assert.equal(a[1].texture_pigment_strength,.7);assert.deepEqual(a.slice(2,5),before.get(a[1].stem).slice(2,5))}
 const drum=h.painted.find(a=>a[1].stem==='drums')[1];assert.equal(drum.drums_outline_gap,10);assert.equal(drum.drums_inner_ratio,.2);
 h.nodes.get('export').onclick();const data=JSON.parse(await h.sandbox.exportBlob.text());
 assert.equal(data.geometry.parameters.texture_pigment_strength,.7);assert.equal(data.defaults.texture_enabled,false);
 assert.equal(data.geometry.drums_outline.gap_540p,10);assert.equal(data.geometry.drums_outline.inner_ratio,.2);assert.equal(data.geometry.material.revision,1);
 assert.equal(h.run('state.playing'),false);assert.equal(h.run('state.dirty'),true);
});

test('video export freezes current scene and reference viewport, pauses preview, and exposes the completed MP4',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));let settings;
 h.nodes.get('video-resolution').value='720';h.nodes.get('video-fps').value='60';
 h.sandbox.exportOfflineVideo=async args=>{settings=args;assert.equal(h.run('state.videoExporting'),true);assert.equal(h.nodes.get('play').disabled,true);args.onProgress({phase:'done',fraction:1});return{url:'/movie.mp4',bytes:1048576}};
 await h.run('exportVideo()');assert.equal(settings.width,1280);assert.equal(settings.height,720);assert.equal(settings.fps,60);assert.equal(settings.scene.size,1);assert.equal(settings.referenceWidth,700);assert.equal(settings.referenceHeight,700*9/16);
 assert.equal(settings.audioStem,'mix');assert.notEqual(settings.bundle,h.fixture);assert.equal(settings.bundle.audio.duration_seconds,12);
 assert.equal(h.run('state.videoExporting'),false);assert.equal(h.run('state.busy'),false);assert.equal(h.nodes.get('video-download').hidden,false);assert.equal(h.nodes.get('video-download').href,'/movie.mp4');assert.equal(h.nodes.get('video-progress').value,1);
});

test('new defaults capture unsaved model, material, scale and export values without configuring the current experiment',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));const calls=[];
 h.run("parameterFields.find(f=>f.key==='hue_gamma').inputs[0].value=1.3;parameterFields.find(f=>f.key==='texture_pigment_strength').inputs[0].value=.65;$('size').value=160;$('video-fps').value=60;dirtyChanged()");
 h.sandbox.fetch=async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return{ok:true,json:async()=>({custom:true})}};
 const original=h.manifest.parameters.hue_gamma;await h.nodes.get('set-defaults').onclick();
 assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/lab/defaults');assert.equal(calls[0][1].parameters.hue_gamma,1.3);assert.equal(calls[0][1].parameters.texture_pigment_strength,.65);
 assert.equal(calls[0][1].presentation.size_percent,160);assert.equal(calls[0][1].presentation.video_fps,60);assert.equal(h.manifest.parameters.hue_gamma,original);assert.equal(h.run('state.dirty'),true);assert.match(h.nodes.get('status').textContent,/新的默认参数/);
});
test('applying the global defaults loads draft values and presentation without touching old results or starting models',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));const calls=[],profile={parameters:{...h.manifest.parameters,hue_gamma:1.4},presentation:{...model.PRESENTATION_DEFAULTS,size_percent:190,pitch_mode:'continuous',guides:false,video_resolution:720,video_fps:60}};
 h.sandbox.fetch=async(url,options)=>{calls.push([url,options]);return{ok:true,json:async()=>profile}};
 await h.nodes.get('apply-defaults').onclick();assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/lab/defaults');assert.ok(!calls[0][1]?.method);
 assert.equal(h.run("Number(parameterFields.find(f=>f.key==='hue_gamma').inputs[0].value)"),1.4);assert.equal(h.nodes.get('size').value,190);assert.equal(h.nodes.get('pitch-mode').value,'continuous');assert.equal(h.nodes.get('guides').checked,false);assert.equal(h.nodes.get('video-fps').value,60);
 assert.equal(h.run('state.dirty'),true);assert.notEqual(h.manifest.parameters.hue_gamma,1.4);assert.ok(Object.values(h.manifest.stages).every(s=>s.status==='ready'));
});

test('geometry preflight submits only visible requested bars, reuses an unchanged layout and rescans changed size',async()=>{
 const h=harness();await new Promise(r=>setImmediate(r));h.fixture.scene_revision='fixture';h.fixture.overlap={enabled:true,coverage_status:'needs_geometry',combinations:[]};h.manifest.parameters.overlap_colors_enabled=true;
 let scans=0,posted=[];
 h.sandbox.scanOverlapCoverage=async(bundle,scene,w,ht)=>{scans++;assert.equal(w,700);assert.equal(ht,393.75);return{revision:coverage.COVERAGE_REVISION,scene_revision:'fixture',profile:coverage.coverageProfile(scene,w,ht),requirements:{'bass+drums':[2]},required_count:1,theoretical_count:171}};
 h.sandbox.fetch=async(path,options)=>{
  if(options?.method==='POST'){
   const value=JSON.parse(options.body);posted.push(value);assert.equal(value.stage,'overlap');assert.deepEqual(value.coverage.requirements,{'bass+drums':[2]});
   h.fixture.overlap={enabled:true,coverage_status:'ready',coverage:value.coverage,combinations:[],counts:{ok:1,silent:0,error:0,pending:0}};
   return{ok:true,json:async()=>({job_id:'overlap'})};
  }
  if(path==='/api/jobs/overlap')return{ok:true,json:async()=>({status:'done',result:h.manifest})};
  if(path==='/api/lab/runs')return{ok:true,json:async()=>({runs:[]})};
  if(path.includes('/inspect?'))return{ok:true,json:async()=>h.inspect};
  if(path.includes('/files/listen.wav'))return{ok:true,arrayBuffer:async()=>new ArrayBuffer(8)};
  if(path.includes('/mapped.json'))return{ok:true,json:async()=>h.fixture};
  if(path.endsWith('/motion'))return{ok:true,json:async()=>({tracks:{}})};
  return{ok:true,json:async()=>h.manifest};
 };
 await h.run('prepareCurrentOverlaps()');assert.equal(scans,1);assert.equal(posted.length,1);
 await h.run('prepareCurrentOverlaps()');assert.equal(scans,1);
 h.nodes.get('size').value=110;await h.run('prepareCurrentOverlaps()');assert.equal(scans,2);assert.equal(posted.length,2);assert.equal(posted[1].coverage.profile.size,1.1);
});
