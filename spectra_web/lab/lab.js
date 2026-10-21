import {scanOverlapCoverage,coverageMatches} from '../overlap-coverage.js?v=r56';
import {paintLabScene} from './lab-scene.js?v=r56';
import {exportOfflineVideo} from './video-export.js?v=r56';
import {paintPaperTexture} from '../material-texture.js?v=r56';
import {PRESENTATION_DEFAULTS,STEMS,LABELS,TAGS,STAGES,STATUS,TAG_HUES,fmt,timeLabel,rowAt,windowBounds,stageEnabled,changedParameters,selectedRange,scoreRows,labBackgroundAt} from './lab-model.js?v=r56';
import {stemStatesAt,sampleMotion,sampleBeatCentroid,sampleBeatVolume} from '../stem-player.js?v=lab-r56';
import {GEOMETRY_DEFAULTS,SHAPE_LABELS,INSTRUMENT_SHAPES,orderActorsForPainting,geometryParameters,paintEmotionShape} from '../emotion-shape.js?v=r56';
import {drawPitchDiagnostics,diagnosticAt,diagnosticSummary,REASONS,midiNote,pitchConfidenceLabel} from '../pitch-diagnostics.js?v=r56';
import {samplePitch} from '../pitch-player.js?v=r56';
import {playbackTime} from '../playback-clock.js?v=stems-r33';

import {paintOverlapShapes} from '../overlap-color.js?v=r56';

const $=id=>document.getElementById(id), el=(tag,text,cls)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x};
const state={manifest:null,inspect:null,bundle:null,stem:'bass',row:0,busy:false,dirty:false,audio:null,source:null,buffer:null,bufferKey:'',playing:false,offset:0,startedAt:0,clickNodes:[],nextClick:0,loadToken:0,lastChart:0,lastFollow:-1,pitchHover:null,videoExporting:false,videoAbort:null,coverageScanning:false};
const parameterFields=[];
const groups=[
 ['计算 / 模型',[
  ['device','计算设备','select',['cuda','cpu']],['beat_model','Beat This! 模型','select',['final0','small0']],
  ['chunk_seconds','SW 计算块','select',[[0,'原配置'],[4,'4 秒'],[2,'2 秒']]],['amp','SW 半精度（CUDA）','bool'],['sw_weights','SW 权重路径（留空自动查找）','text']]],
 ['音频特征 / 预测窗口',[
  ['target_seconds','上下文目标时长 / 秒','number',3,120,.5],['boundary_threshold','强边界阈值','number',0,1,.05],['context_seconds','Foote 比较窗口 / 秒','number',.1,20,.1],
  ['gate_dbfs','静音门限 / dBFS','number',-100,-5,1],['frame_seconds','实时特征步长 / 秒','number',.01,.2,.01]]],
 ['音高 / 主旋律',[
  ['pitch_method','音高算法','select',[['hybrid','Melodia 复音 / pYIN 人声贝斯'],['melodia','Melodia 全部非鼓声部'],['pyin','pYIN 全部非鼓声部']]],
  ['melodia_high_pitch_bias','Melodia 高音偏好 · 0关闭 / 4较强','number',0,6,.5],
  ['melodia_voicing_tolerance','Melodia 旋律保留容差 · 越大越少漏检','number',-1,1.4,.1],
  ['melodia_confidence_threshold','Melodia 最低显著度置信值（非概率）','number',0,1000,.01],
  ['pitch_confidence_threshold','pYIN 最低有声概率','number',0,1,.05]]],
 ['混音重叠色 / 可选计算',[
  ['overlap_colors_enabled','预测实际交叠区域的混音色（按需计算）','bool']]],
 ['几何 / 运动 / 描边与旋转（即时预览）',[
  ['outline_enabled','黑色描边总开关','bool'],
  ...['vocals','drums','other','piano','guitar','bass'].flatMap(s=>[
   ['outline_'+s+'_enabled',LABELS[s]+'描边','bool'],
   ['outline_'+s+'_multiplier',LABELS[s]+'描边粗细倍率','number',0,10,.05]]),
  ['foote_motion_enabled','Foote 控制位移速度（X / Y）','bool'],
  ['rotation_enabled','愉悦度控制旋转（各轨 P10 / P90）','bool'],
  ['drums_outline_gap','鼓声双线净间距 · 540p基准像素','number',.5,30,.5],
  ['drums_inner_ratio','鼓声内线 / 外线宽度比','number',.1,.8,.05],
  ['outline_arousal_scale','全局描边系数 · 像素 / 唤醒度','number',.01,10,.1]]],
 ['肌理 / 纸与颜料（即时预览）',[
  ['texture_enabled','开启绘画肌理','bool'],
  ['texture_paper_strength','纸纹 / 细颗粒强度','number',0,1,.05],
  ['texture_pigment_strength','颜料浓淡强度','number',0,1,.05],
  ['texture_edge_strength','边缘手绘痕迹强度','number',0,1,.05]]],
 ['HSV / 伽马 / Sigmoid',[
  ['hue_gamma','H 标签权重 γ','number',.1,10,.1],['saturation_gamma','S γ','number',.1,10,.1],['value_gamma','V γ','number',.1,10,.1],
  ['saturation_k','S Sigmoid 斜率 k','number',0,40,.5],['value_k','V Sigmoid 斜率 k','number',0,40,.5],['use_song_mean_centers','每轨均值作为敏感中心','bool']]],
 ['S / V 变化增强',[
  ['enhance_sv','开启增强','bool'],['enhancement_strength','增强强度','number',0,1,.05],['percentile_low','低分位点 / %','number',0,49,1],['percentile_high','高分位点 / %','number',51,100,1],
  ['max_gain','最大增强倍数','number',1,10,.5],['saturation_range','S 输出范围','range'],['value_range','V 输出范围','range']]],
 ['颜色过渡',[
  ['transition_strength','Foote 过渡响应强度','number',0,50,.5],['boundary_radius','边界统计半径 / 秒','number',.01,5,.05],['max_transition_fraction','最多占小节起点间隔（0–1）','number',0,1,.01]]]
];

function message(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error)}
async function api(path,options={}){
 const attempts=(!options.method||options.method==='GET')?4:1;
 for(let i=0;i<attempts;i++){
  let response,data;
  try{response=await fetch(path,{cache:'no-store',...options});data=await response.json()}
  catch(error){
   if(i<attempts-1){await new Promise(resolve=>setTimeout(resolve,250*(i+1)));continue}
   throw Error('本机服务连接中断或响应不完整：'+path+'。请检查 start_lab.bat 启动窗口。原始错误：'+error.message);
  }
  if(!response.ok)throw Error(data.error||'请求失败');return data;
 }
}
const base=()=>'/api/lab/runs/'+state.manifest.id;
const fileUrl=path=>base()+'/files/'+path.split('/').map(encodeURIComponent).join('/');
function busy(value){state.busy=value;$('upload').disabled=value;renderStages();$('apply').disabled=value||!state.dirty||!!state.geometryError;for(const f of parameterFields)for(const input of f.inputs)input.disabled=value||!state.manifest;$('runs').disabled=value;$('set-defaults').disabled=value||!state.manifest||!!state.geometryError;$('apply-defaults').disabled=value||!state.manifest}
function buildParameters(p){
 p={...GEOMETRY_DEFAULTS,...p};
 parameterFields.length=0;$('parameters').replaceChildren();
 groups.forEach(([name,fields],index)=>{const details=el('details',undefined,'parameter-group');details.open=index<2||name.startsWith('几何');details.append(el('summary',name));
  fields.forEach(([key,name,type,...bounds])=>{const label=el('label',name,type==='bool'?'check':'');let inputs=[];
   if(type==='range'){const pair=el('div',undefined,'two');for(let i=0;i<2;i++){const input=el('input');Object.assign(input,{type:'number',min:0,max:1,step:.01,value:p[key][i]});pair.append(input);inputs.push(input)}label.append(pair)}
   else{let input=el(type==='select'?'select':'input');if(type==='select'){for(const item of bounds[0]){const [value,text]=Array.isArray(item)?item:[item,item];const option=el('option',text);option.value=value;input.append(option)}input.value=p[key]}
    else if(type==='bool'){input.type='checkbox';input.checked=p[key]}
    else{input.type=type;input.value=p[key];if(type==='number')[input.min,input.max,input.step]=bounds}
    type==='bool'?label.prepend(input):label.append(input);inputs=[input]}
   for(const input of inputs)input.addEventListener('input',dirtyChanged);parameterFields.push({key,type,inputs});details.append(label)
  });if(name.startsWith('音高'))details.append(el('p','首次使用先运行 install_melodia.bat。默认复音声部用Melodia，人声/贝斯用pYIN；保存后点第5步映射，只补算音高。高音偏好加权候选，不抬高音符；0调用原版（保留容差独立设置），4在搜索音域高端相对低端约×16；同帧重归一化避免偏好抬高整体显著度。置信值与pYIN概率不可直接比较。','hint'));if(name.startsWith('肌理'))details.append(el('p','固定纸纹与哑光颜料，颗粒随图形移动/旋转；人声和伴奏略柔，鼓与钢琴略实。三个强度可独立关闭，保存无需重新预测。鼓声双线为外粗内细，净间距可在几何组调节。','hint'));if(name.startsWith('混音'))details.append(el('p','先计算各声部，再映射位置；一键执行和映射会自动筛选当前布局，只补算实际交叠组合×小节。尺寸/运动/音高模式变化后点“补齐当前交叠色”；复用已有混音预测。','hint'));$('parameters').append(details)
 });$('params-json').textContent=JSON.stringify(p,null,2);state.dirty=false;dirtyChanged();
}
function draft(){const values={};for(const f of parameterFields){values[f.key]=f.type==='bool'?f.inputs[0].checked:f.type==='range'?f.inputs.map(i=>Number(i.value)):f.type==='number'||f.key==='chunk_seconds'?Number(f.inputs[0].value):f.inputs[0].value}return values}
function geometryForPreview(){
 const candidate={...state.manifest?.parameters};
 for(const f of parameterFields)if(f.key in GEOMETRY_DEFAULTS)candidate[f.key]=f.type==='bool'?f.inputs[0].checked:Number(f.inputs[0].value);
 try{const config=geometryParameters(candidate);state.geometryError='';return config}
 catch(error){state.geometryError=error.message;return geometryParameters(state.manifest?.parameters||{})}
}
function dirtyChanged(){geometryForPreview();state.dirty=!!state.manifest&&(Object.keys(changedParameters(state.manifest.parameters,draft())).length>0||Object.keys(changedParameters({...PRESENTATION_DEFAULTS,...state.manifest.presentation},presentationDraft())).length>0);$('dirty').textContent=state.dirty?'未保存':'已保存';$('dirty').classList.toggle('dirty',state.dirty);$('apply').disabled=state.busy||!state.dirty||!!state.geometryError;renderStages()}
function renderStages(){
 $('run-all').disabled=!state.manifest||state.busy||!!state.geometryError;
 $('stages').replaceChildren();for(const [id,name] of STAGES){const value=state.manifest?.stages[id]||{status:'pending'};const row=el('div',undefined,'stage');row.dataset.status=value.status;const text=el('span',name);let detail=STATUS[value.status]||value.status;
  if(value.counts)detail+=` · 有效 ${value.counts.ok} / 静音 ${value.counts.silent} / 待测 ${value.counts.pending} / 错误 ${value.counts.error}`;
  if(value.overlap_counts)detail+=` · 混音 有效 ${value.overlap_counts.ok} / 待测 ${value.overlap_counts.pending} / 错误 ${value.overlap_counts.error}`;
  if(value.background_status)detail+=' · 动态背景 '+(value.background_status==='ok'?'已预测':'失败');
  if(value.song_status)detail+=' · 整曲 '+(value.song_status==='ok'?'已预测':'失败');
  text.append(el('small',detail));if(value.error||value.reason)text.title=value.error||value.reason;
  const button=el('button',id==='emotion'?'试算':id==='mapping'?'映射':'运行');button.disabled=!stageEnabled(id,state.manifest,state.busy,state.dirty);button.onclick=()=>runStage(id);row.append(text,button);$('stages').append(row)
 }
}
function renderManifest(){
 const m=state.manifest;if(!m)return;renderStages();$('song-name').textContent=m.name;$('song-info').textContent=`${timeLabel(m.duration_seconds)} · ${m.sample_rate.toLocaleString()} Hz · 原曲统一节拍 · 六声部独立映射`;
 $('directory').textContent='实验目录：'+m.directory;$('logs').textContent=m.logs.join('\n')||'尚无日志';
 $('files').replaceChildren();for(const item of m.artifacts){const tr=el('tr');if(!item.current)tr.className='stale';const name=el('td',item.path),stage=el('td',item.stage?(STATUS[m.stages[item.stage].status]+' / '+item.stage):'原始 / 记录'),size=el('td',item.bytes>1048576?(item.bytes/1048576).toFixed(1)+' MB':(item.bytes/1024).toFixed(1)+' KB'),actions=el('td');
  if(item.path.endsWith('.wav')){const button=el('button','试听');button.onclick=()=>auditionUrl(fileUrl(item.path));actions.append(button)}
  else if(/\.(json|csv|log)$/.test(item.path)&&item.bytes<3*1048576){const button=el('button','查看');button.onclick=async()=>{try{const r=await fetch(fileUrl(item.path));if(!r.ok)throw Error('无法读取文件');$('file-name').textContent=item.path;$('file-content').textContent=await r.text();$('file-preview').open=true}catch(e){message(e.message,true)}};actions.append(button)}
  const link=el('a','下载');link.href=fileUrl(item.path);link.download=item.path.split('/').pop();actions.append(link);tr.append(name,stage,size,actions);$('files').append(tr)
 }
 $('export').disabled=m.stages.mapping.status!=='ready';$('video-export').disabled=m.stages.mapping.status!=='ready'||state.videoExporting;
 const ready=m.stages.separation.status==='ready';$('pitch-listen').disabled=!ready;for(const option of $('listen').options)if(option.value!=='mix')option.disabled=!ready;
 const count=state.inspect?.meter?.segments.length||m.stages.meter.bars||0;$('bar-start').max=$('bar-end').max=count||1;
 if(count&&Number($('bar-end').value)>count)$('bar-end').value=count;
 if(count&&Number($('bar-start').value)>count)$('bar-start').value=1;
}
async function listRuns(selected){const data=await api('/api/lab/runs');$('runs').replaceChildren(el('option','恢复已有实验…'));$('runs').firstChild.value='';for(const run of data.runs){const option=el('option',run.name+' · '+timeLabel(run.duration_seconds));option.value=run.id;$('runs').append(option)}$('runs').value=selected||''}
async function loadRun(id,reset=false){
 pause();$('video-download').hidden=true;state.manifest=await api('/api/lab/runs/'+id);state.inspect=null;state.bundle=null;if(reset){state.row=0;state.offset=0;state.bufferKey='';state.buffer=null;$('listen').value='mix'}
 buildParameters(state.manifest.parameters);renderManifest();await loadInspect();
 if(state.manifest.stages.mapping.status==='ready'){state.bundle=await api(fileUrl('mapped.json'));await loadMotionFoote()}
 if(reset){applyPresentation({...PRESENTATION_DEFAULTS,pitch_mode:state.bundle?.movement?.pitch_preview_mode||'beat_summary',...state.manifest.presentation});dirtyChanged()}
 $('background-info').textContent=state.bundle?.background?'背景：原曲逐小节预测 + Foote 过渡': '背景：等待原曲逐小节动态预测';
 $('warnings').hidden=!state.bundle?.warnings?.length;$('warnings').textContent=state.bundle?.warnings?.join(' ')||'';
 if(reset){const n=state.inspect?.meter?.segments.length||0;$('bar-end').value=Math.min(3,n)||3}
 await loadAudio();renderInspector();drawCharts(now());renderTable();localStorage.setItem('spectra-lab-run',id);await listRuns(id);
}
async function loadMotionFoote(){
 const bundle=state.bundle;if(!bundle?.stems?.some(track=>!track.motion_foote))return;
 try{const data=await api(base()+'/motion');for(const track of bundle.stems)if(!track.motion_foote&&data.tracks?.[track.id])track.motion_foote=data.tracks[track.id]}
 catch(error){bundle.warnings=[...(bundle.warnings||[]),'Foote运动曲线暂不可用，使用原固定缓动：'+error.message]}
}
function activeMotionFoote(stem=state.stem){return geometryForPreview().foote_motion_enabled?state.bundle?.stems.find(t=>t.id===stem)?.motion_foote||null:null}
async function loadInspect(){const token=++state.loadToken;if(!state.manifest)return;const data=await api(base()+'/inspect?stem='+state.stem);if(token!==state.loadToken)return;state.inspect=data;const rows=data.meter?.segments||[];state.row=Math.max(0,Math.min(state.row,rows.length-1));$('bar').replaceChildren();rows.forEach((r,i)=>{const option=el('option',`${i+1}. ${r.label} · ${fmt(r.start,2)}–${fmt(r.end,2)}s`);option.value=i;$('bar').append(option)});if(!rows.length){const option=el('option','尚无小节');option.value=0;$('bar').append(option)}$('bar').value=state.row;renderInspector();renderTable()}
async function waitJob(id){let lastRefresh=0;for(;;){const job=await api('/api/jobs/'+id);message(job.message,job.status==='error');$('progress').value=job.progress||0;
 if(job.status==='error')throw Error(job.message);if(job.status==='done')return job.result;
 if(state.manifest&&performance.now()-lastRefresh>2000){state.manifest=await api(base());renderManifest();lastRefresh=performance.now()}
 await new Promise(r=>setTimeout(r,600))}}
async function runStage(stage){if(!state.manifest||state.busy)return;pause();$('clip-player').pause();busy(true);$('progress').hidden=false;const id=state.manifest.id;
 try{const options={stage,parameters:['configure','all'].includes(stage)?changedParameters(state.manifest.parameters,draft()):{}};
  if(['configure','all'].includes(stage)&&Object.keys(changedParameters({...PRESENTATION_DEFAULTS,...state.manifest.presentation},presentationDraft())).length)options.presentation=presentationDraft();
  if(stage==='emotion'){options.stems=[...document.querySelectorAll('[data-stem-check]')].filter(x=>x.checked).map(x=>x.value);if(!options.stems.length)throw Error('至少选择一个声部。');Object.assign(options,selectedRange($('bar-start').value,$('bar-end').value,state.inspect?.meter?.segments.length||0));options.force=$('force').checked}
  const data=await api(base()+'/action',{method:'POST',headers:{'Content-Type':'application/json','X-Spectra-Client':'1'},body:JSON.stringify(options)});await waitJob(data.job_id);await loadRun(id);
  if(['all','mapping'].includes(stage))await prepareCurrentOverlaps();
  if(stage==='all'){for(const input of document.querySelectorAll('[data-stem-check]'))input.checked=true;$('bar-start').value=1;$('bar-end').value=state.inspect?.meter?.segments.length||1}
  message(stage==='all'?'全部过程完成：六声部全部小节、原曲动态背景与预览已就绪。':stage==='configure'?'参数已保存；几何参数已生效，其余需重跑的步骤已标记。':'该步骤已完成。可继续检查文件、试听或运行下一步。')
 }catch(e){message(e.message,true);try{await loadRun(id)}catch(_){} }
 finally{busy(false);$('progress').hidden=true}
}
async function upload(file){if(!file||state.busy)return;pause();busy(true);$('progress').hidden=false;try{message('上传并解码原曲；不会自动运行模型…');const data=await api('/api/lab/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Spectra-Client':'1','X-Audio-Name':encodeURIComponent(file.name)},body:file});const result=await waitJob(data.job_id);await loadRun(result.id,true);message('原曲已导入。先运行“原曲节拍 / 小节”，逐步检查结果。')}catch(e){message(e.message,true)}finally{busy(false);$('progress').hidden=true;$('upload').value=''}}

function now(){return playbackTime(state,performance.now())}
function stopClicks(){for(const node of state.clickNodes)try{node.stop()}catch(_){}state.clickNodes=[]}
function pause(){if(state.playing)state.offset=now();state.playing=false;state.endedWall=null;const source=state.source;state.source=null;if(source){source.onended=null;try{source.stop()}catch(_){}}stopClicks();$('play').textContent='播放'}
async function loadAudio(){
 if(!state.manifest)return;const listen=$('listen').value;const path=listen==='mix'?'listen.wav':`previews/${listen}.wav`;const key=state.manifest.id+':'+path+':'+state.manifest.preview_gain+':'+(state.manifest.stages.separation.finished||0);if(key===state.bufferKey&&state.buffer){$('play').disabled=false;return}
 const offset=state.offset;pause();$('play').disabled=true;state.audio??=new AudioContext();const response=await fetch(fileUrl(path));if(!response.ok)throw Error('试听文件尚未生成，请先运行分轨。');const buffer=await state.audio.decodeAudioData(await response.arrayBuffer());state.buffer=buffer;state.bufferKey=key;state.offset=Math.min(offset,buffer.duration);$('seek').max=buffer.duration;$('play').disabled=false;
}
async function play(){if(state.playing){pause();return}if(!state.buffer)return;$('clip-player').pause();await state.audio.resume();if(state.offset>=state.buffer.duration-.001)state.offset=0;const source=state.audio.createBufferSource();source.buffer=state.buffer;source.connect(state.audio.destination);state.startedAt=state.audio.currentTime+.04;source.start(state.startedAt,state.offset);state.source=source;state.playing=true;state.renderEnded=false;state.endedWall=null;state.nextClick=state.inspect?.meter?.beats?.findIndex(t=>t>=state.offset)??-1;source.onended=()=>{if(state.source===source)state.renderEnded=true};$('play').textContent='暂停'}
async function seek(t){const resume=state.playing;pause();state.offset=Math.max(0,Math.min(state.manifest?.duration_seconds||0,t));$('seek').value=state.offset;if(resume)await play();drawCharts(state.offset)}
function scheduleClicks(){const beats=state.inspect?.meter?.beats;if(!state.playing||!beats||state.nextClick<0||!$('clicks').checked)return;const rendered=state.audio.currentTime;state.clickNodes=state.clickNodes.filter(n=>n._end>rendered);while(state.nextClick<beats.length){const beat=beats[state.nextClick],at=state.startedAt+beat-state.offset;if(at>rendered+.12)break;state.nextClick++;if(at<rendered)continue;const oscillator=state.audio.createOscillator(),gain=state.audio.createGain();oscillator.frequency.value=(state.inspect.meter.downbeats||[]).some(t=>Math.abs(t-beat)<.025)?1300:900;gain.gain.setValueAtTime(.045,at);gain.gain.exponentialRampToValueAtTime(.0001,at+.025);oscillator.connect(gain);gain.connect(state.audio.destination);oscillator.start(at);oscillator.stop(at+.03);oscillator._end=at+.03;state.clickNodes.push(oscillator)}}
function auditionUrl(url){pause();const audio=$('clip-player');audio.src=url;audio.play().catch(e=>message(e.message,true))}
function current(){const i=state.row;return{bar:state.inspect?.meter?.segments[i],plan:state.inspect?.plan?.segment_rows[i],raw:state.inspect?.emotion?.segments[i],mapped:state.bundle?.stems.find(t=>t.id===state.stem)?.segments[i],track:state.bundle?.stems.find(t=>t.id===state.stem)}}
function selectRow(i,jump=true){const rows=state.inspect?.meter?.segments||[];if(!rows.length)return;state.row=Math.max(0,Math.min(rows.length-1,i));$('bar').value=state.row;renderInspector();renderTable();if(jump)seek(rows[state.row].start);else drawCharts(now())}
function renderInspector(){const {bar,plan,raw,mapped,track}=current();$('bar').value=state.row;const status=raw?.status||'pending';$('row-status').textContent={ok:'预测成功',silent:'静音',pending:'未预测',error:'预测错误'}[status]||status;$('swatch').style.background=mapped?.hex||'';$('swatch').textContent=mapped?.hex?`${mapped.hex} · ${mapped.dominant_tag||'—'}`:'尚无有效颜色';
 $('metrics').replaceChildren();for(const [label,value] of [['A · 唤醒度',fmt(raw?.arousal)],['V · 愉悦度',fmt(raw?.valence)],['H · 色相',fmt(mapped?.hue_degrees,1)+'°'],['S / V',fmt(mapped?.saturation,2)+' / '+fmt(mapped?.value,2)]]){const m=el('div',undefined,'metric');m.append(el('span',label),el('b',value));$('metrics').append(m)}
 $('scores').replaceChildren();const scores=raw?.scores?Object.fromEntries(raw.scores.map(s=>[s.tag,s.score])):{};const rows=scoreRows(scores,state.manifest?.parameters.hue_gamma||2),max=Math.max(...rows.map(r=>r.score??-1));for(const r of rows){const line=el('div',undefined,'score'+(r.score!==null&&r.score===max?' top':'')),track=el('div',undefined,'track'),fill=el('div',undefined,'fill');fill.style.width=((r.score??0)*100)+'%';track.append(fill);line.append(el('span',r.tag),track,el('span',fmt(r.score,3),'value'));line.title=`H ${r.hue}° · γ 后权重占比 ${(r.weight*100).toFixed(1)}%`; $('scores').append(line)}
 const n=track?.normalization;$('normalization').textContent=n?`A P5/P95：${fmt(n.arousal_min)} → ${fmt(n.arousal_max)}；${track.pitch?`音高 P5/P95：${fmt(n.pitch_midi_p5,1)} → ${fmt(n.pitch_midi_p95,1)} MIDI · 有效帧 ${(track.pitch.coverage*100).toFixed(1)}% · ${track.pitch.method==='melodia'?'Melodia显著度门限':'pYIN概率门限'} ${fmt(track.pitch.confidence_threshold,2)}`:`拍均质心 P5/P95：${fmt(n.centroid_min_hz,1)} → ${fmt(n.centroid_max_hz,1)} Hz`}。区间外夹紧；恒定值置中；无有效音高保持。`:'尚未映射。全曲相同值将放在画面中间。';
 $('window-info').textContent=plan?`目标段 ${fmt(plan.start_seconds)}–${fmt(plan.end_seconds)}s（${fmt(plan.duration_seconds)}s）；模型输入 ${fmt(plan.prediction_start_seconds)}–${fmt(plan.prediction_end_seconds)}s（${fmt(plan.prediction_end_seconds-plan.prediction_start_seconds)}s）；同轨上下文，最短 3s。`:bar?`目标段 ${fmt(bar.start)}–${fmt(bar.end)}s；运行特征步骤以生成预测窗口。`:'尚无小节结果。';
 $('row-json').textContent=JSON.stringify({target:bar||null,context:plan||null,prediction:raw?{status:raw.status,arousal:raw.arousal,valence:raw.valence,scores:raw.scores,error:raw.error,error_traceback:raw.error_traceback}:null,mapped:mapped||null},null,2);$('audition-target').disabled=$('audition-context').disabled=!plan;
}
function renderTable(){const rows=state.inspect?.emotion?.segments||[];const colors=state.bundle?.stems.find(t=>t.id===state.stem)?.segments||[];$('result-table').replaceChildren();for(const [i,r] of rows.entries()){const color=colors[i],tr=el('tr');tr.dataset.row=i;if(i===state.row)tr.className='selected';const scores=[...(r.scores||[])].sort((a,b)=>b.score-a.score);for(const text of [r.label||r.segment,fmt(r.start_seconds,2)+'–'+fmt(r.end_seconds,2),r.status,fmt(r.arousal,2)+' / '+fmt(r.valence,2),scores[0]?.tag||'—',color?.hex||'—',fmt(color?.x_normalized)])tr.append(el('td',text));tr.onclick=()=>selectRow(i);$('result-table').append(tr)}}

const colors={grid:'#283140',text:'#8b9aaf',mint:'#96debf',amber:'#eac880',purple:'#be9fe8',muted:'#4c5a6b'};
function canvas(id){const element=$(id);element.dataset.logicalHeight??=element.getAttribute('height');const width=Math.max(1,element.clientWidth),height=id==='preview'?width*9/16:Number(element.dataset.logicalHeight),dpr=devicePixelRatio||1;if(element.width!==Math.round(width*dpr)||element.height!==Math.round(height*dpr)){element.width=Math.round(width*dpr);element.height=Math.round(height*dpr)}element.style.height=height+'px';const ctx=element.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.font='10px Consolas,monospace';return{ctx,width,height}}
function axes(c,a,b,left=54,bottom=20){const {ctx,width,height}=c,x=t=>left+(width-left-8)*(t-a)/Math.max(1e-6,b-a);ctx.strokeStyle=colors.grid;ctx.fillStyle=colors.text;for(let i=0;i<=4;i++){const t=a+(b-a)*i/4,p=x(t);ctx.beginPath();ctx.moveTo(p,6);ctx.lineTo(p,height-bottom);ctx.stroke();ctx.fillText(t.toFixed(1)+'s',Math.min(width-38,p),height-5)}return x}
function pointer(c,x,t){if(!Number.isFinite(t))return;const {ctx,height,width}=c,p=x(t);if(p<0||p>width)return;ctx.strokeStyle='#fff';ctx.globalAlpha=.8;ctx.beginPath();ctx.moveTo(p,4);ctx.lineTo(p,height-20);ctx.stroke();ctx.globalAlpha=1}
function line(ctx,times,values,x,y,a,b,color){ctx.beginPath();let first=true;for(let i=0;i<times.length;i++){if(times[i]<a||times[i]>b||!Number.isFinite(values[i]))continue;const px=x(times[i]),py=y(values[i]);first?ctx.moveTo(px,py):ctx.lineTo(px,py);first=false}ctx.strokeStyle=color;ctx.lineWidth=1.2;ctx.stroke()}
function drawTimeline(t){const c=canvas('timeline'),{ctx,width}=c,d=state.manifest?.duration_seconds||1,x=axes(c,0,d,54,20),bars=state.inspect?.meter?.segments||[];STEMS.forEach((stem,i)=>{const y=8+i*22;ctx.fillStyle=colors.text;ctx.fillText(LABELS[stem],0,y+12);for(const [j,b] of bars.entries()){const r=state.bundle?.stems.find(t=>t.id===stem)?.segments[j];ctx.fillStyle=r?.hex||'#28313e';ctx.fillRect(x(b.start),y,Math.max(.6,x(b.end)-x(b.start)-.5),17)} });const backgroundRows=state.bundle?.background?.segments||[];ctx.fillStyle=colors.text;ctx.fillText('原曲背景',0,152);for(const r of backgroundRows){ctx.fillStyle=r.hex||'#28313e';ctx.fillRect(x(r.start_seconds),140,Math.max(.6,x(r.end_seconds)-x(r.start_seconds)-.5),17)}for(const beat of state.inspect?.meter?.downbeats||[]){ctx.strokeStyle='#acb4bf55';ctx.beginPath();ctx.moveTo(x(beat),5);ctx.lineTo(x(beat),159);ctx.stroke()}pointer(c,x,t);if(!bars.length){ctx.fillStyle=colors.text;ctx.fillText('先运行原曲节拍；颜色映射完成后显示色带。',60,75)}$('timeline')._domain=[0,d,54,width-8]}
function drawBeatVolumes(c,x,a,b,reference){
 const rows=state.inspect?.beat_volume?.rows;if(state.stem==='drums'||!rows)return;
 const times=[],values=[];
 for(const r of rows){if(r.end_seconds<a||r.start_seconds>b)continue;for(let j=0;j<=16;j++){const t=r.start_seconds+(r.end_seconds-r.start_seconds)*j/16;times.push(t);values.push(sampleBeatVolume(state.inspect.beat_volume,t).rms)}}
 line(c.ctx,times,values,x,v=>c.height-28-v/reference*(c.height-44),a,b,colors.mint);
}
function drawWindow(t){const {bar,plan}=current(),duration=state.manifest?.duration_seconds||1,[a,b]=windowBounds(plan||bar,duration),c=canvas('waveform'),{ctx,height,width}=c,x=axes(c,a,b,54,20),wave=state.inspect?.waveform;
 if(plan){ctx.fillStyle='#be9fe822';ctx.fillRect(x(plan.prediction_start_seconds),8,x(plan.prediction_end_seconds)-x(plan.prediction_start_seconds),height-30)}
 if(bar){ctx.fillStyle='#96debf33';ctx.fillRect(x(bar.start),8,x(bar.end)-x(bar.start),height-30);ctx.fillStyle=colors.mint;ctx.fillText('目标段',Math.max(55,x(bar.start)+4),20)}
 if(wave){let peak=wave.peaks.reduce((n,v)=>Math.max(n,v),1e-6);ctx.strokeStyle='#8aa0b4';ctx.beginPath();wave.times.forEach((v,i)=>{if(v<a||v>b)return;const px=x(v),value=wave.peaks[i]/peak*(height-48)/2;ctx.moveTo(px,(height-20)/2-value);ctx.lineTo(px,(height-20)/2+value)});ctx.stroke()}
 else{ctx.fillStyle=colors.text;ctx.fillText('分轨后显示该声部波形。',60,60)}for(const beat of state.inspect?.meter?.beats||[]){if(beat<a||beat>b)continue;ctx.fillStyle='#e3e5e8';ctx.fillRect(x(beat),height-28,1,8)}pointer(c,x,t);$('waveform')._domain=[a,b,54,width-8];
 const f=canvas('features'),fx=axes(f,a,b,54,20),motion=state.inspect?.motion,diag=state.inspect?.plan?.diagnostic,ref=state.bundle?.volume.reference_rms||Math.max(state.manifest?.stages.features.reference_rms||0,1e-8);if(motion){line(f.ctx,motion.times,motion.rms,fx,v=>f.height-28-v/ref*(f.height-44),a,b,state.stem!=='drums'&&state.inspect?.beat_volume?'#657583':colors.mint);drawBeatVolumes(f,fx,a,b,ref);state.inspect?.pitch?drawPitch(f.ctx,state.inspect.pitch,fx,a,b,16,f.height-28):drawBeatCentroids(f.ctx,state.inspect?.beat_motion,fx,a,b,16,f.height-28)}if(diag)line(f.ctx,diag.time_s,diag.novelty,fx,v=>f.height-28-v*(f.height-44),a,b,colors.purple);f.ctx.fillStyle=colors.text;f.ctx.fillText('1',25,16);f.ctx.fillText('0',25,f.height-28);pointer(f,fx,t);$('features')._domain=[a,b,54,f.width-8]
}
function drawBeatCentroids(ctx,motion,x,a,b,top,bottom){
 if(!motion)return;
 for(const row of motion.rows){
  if(row.end_seconds<a||row.start_seconds>b)continue;
  const left=Math.max(a,row.start_seconds),right=Math.min(b,row.end_seconds),y=v=>bottom-(bottom-top)*v;
  if(row.status==='ok'){ctx.strokeStyle=colors.amber;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x(left),y(row.normalized));ctx.lineTo(x(right),y(row.normalized));ctx.stroke()}
  ctx.strokeStyle='#90adc9';ctx.lineWidth=1.2;ctx.beginPath();
  for(let i=0;i<=24;i++){const t=left+(right-left)*i/24,point=sampleBeatCentroid(motion,t,activeMotionFoote());if(!point)continue;i?ctx.lineTo(x(t),y(point.y)):ctx.moveTo(x(t),y(point.y))}
  ctx.stroke();
 }
}
function drawPitch(ctx,pitch,x,a,b,top,bottom){
 const y=v=>bottom-(bottom-top)*v;
 for(const row of pitch.rows){if(row.status!=='ok'||row.end_seconds<a||row.start_seconds>b)continue;ctx.strokeStyle=colors.amber;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x(Math.max(a,row.start_seconds)),y(row.normalized));ctx.lineTo(x(Math.min(b,row.end_seconds)),y(row.normalized));ctx.stroke()}
 const times=[],values=[];for(let i=0;i<=240;i++){const t=a+(b-a)*i/240,p=samplePitch(pitch,t,$('pitch-mode').value||'beat_summary',activeMotionFoote());if(p){times.push(t);values.push(p.y)}}line(ctx,times,values,x,y,a,b,'#90adc9');
}
function drawHeatmap(t){const c=canvas('heatmap'),{ctx,width}=c,d=state.manifest?.duration_seconds||1,x=axes(c,0,d,64,20),rows=state.inspect?.emotion?.segments||[];TAGS.forEach((tag,i)=>{const y=6+i*18;ctx.fillStyle=colors.text;ctx.fillText(tag,0,y+11);for(const r of rows){const score=r.status==='ok'?r.scores.find(s=>s.tag===tag)?.score:null;ctx.fillStyle=Number.isFinite(score)?`hsl(${TAG_HUES[tag]} 45% ${10+score*65}%)`:'#242e3c';ctx.fillRect(x(r.start_seconds),y,Math.max(.6,x(r.end_seconds)-x(r.start_seconds)-.5),15)}});
 ctx.fillStyle=colors.text;ctx.fillText('A / V',0,193);const mid=state.inspect?.meter?.segments||[];for(const [key,color] of [['arousal',colors.mint],['valence',colors.amber]]){ctx.strokeStyle=color;ctx.lineWidth=1.4;ctx.beginPath();for(const r of rows){if(r.status!=='ok'||!Number.isFinite(r[key]))continue;const y=212-(r[key]-1)/8*38;ctx.moveTo(x(r.start_seconds),y);ctx.lineTo(x(r.end_seconds),y)}ctx.stroke()}pointer(c,x,t);$('heatmap')._domain=[0,d,64,width-8];if(!mid.length){ctx.fillStyle=colors.text;ctx.fillText('情绪试算后显示标签分数。',70,200)}}
function drawPitchPanel(t){
 const c=canvas('pitch-chart'),raw=state.inspect?.pitch_raw,pitch=state.inspect?.pitch;
 const duration=state.manifest?.duration_seconds||1,{bar,plan}=current();
 const [a,b]=$('pitch-span').value==='song'?[0,duration]:windowBounds(plan||bar,duration);
 const layers={raw:$('pitch-show-raw').checked,accepted:$('pitch-show-accepted').checked,beat:$('pitch-show-beat').checked,position:$('pitch-show-position').checked};
 const domain=drawPitchDiagnostics(c.ctx,c.width,c.height,{raw,pitch,beats:state.inspect?.meter?.beats||[],time:t,start:a,end:b,mode:$('pitch-mode').value||'beat_summary',footeCurve:activeMotionFoote(),layers});
 $('pitch-chart')._domain=[a,b,domain.left,domain.right];
 if(!pitch||!raw){$('pitch-summary').textContent=state.stem==='drums'?'鼓声继续使用频谱质心，不估计旋律音高。':'暂无原始音高；保存音高参数并运行第5步映射，已有分轨和情绪会复用。';$('pitch-hover').textContent='移动查看Hz、音名、MIDI及过滤原因；点击定位。';return}
 const stats=diagnosticSummary(raw,pitch),count=stats.counts;
 $('pitch-summary').textContent=`${LABELS[state.stem]} · ${pitch.method==='melodia'?`Melodia · 高音偏好 ${raw.settings?.high_pitch_bias??0} · 保留容差 ${raw.settings?.voicing_tolerance??.2}`:'pYIN'} · 全曲有效 ${count.accepted}/${stats.total} 帧（${(count.accepted/stats.total*100).toFixed(1)}%） · 低置信值 ${count.low_probability} · 无基频/无声 ${count.no_f0+count.unvoiced} · 低音量 ${count.quiet} · P5/P95跨度 ${fmt(stats.span,2)} 半音 · 超出标尺 ${stats.clipped} 帧 · ≈八度跳变 ${stats.octaves.length} 处（候选，未自动纠正）${stats.span!==null&&stats.span<2?' · 音域很窄，细微抖动会被放大':''}${pitch.method!=='melodia'&&['piano','guitar','other'].includes(state.stem)?' · 多音声部：pYIN单条基频可能不是旋律线':''}`;
 const hovering=state.pitchHover!==null&&state.pitchHover>=a&&state.pitchHover<=b,probe=hovering?state.pitchHover:t,data=diagnosticAt(raw,pitch,probe,$('pitch-mode').value||'beat_summary',activeMotionFoote()),f=data.frame;
 $('pitch-hover').textContent=`${hovering?'指针':'播放'} ${timeLabel(probe)} · ${f?`${fmt(f.hz,1)} Hz / ${f.note} / MIDI ${fmt(f.midi,2)} · ${pitchConfidenceLabel(pitch,raw)} ${fmt(f.probability,3)} · ${REASONS[f.reason]}`:'尚无音高帧'} · 每拍中位数 ${fmt(data.beat?.beatMedian,2)} · 平滑音高 ${fmt(data.position?.midi,2)} · 实际Y ${fmt(data.position?.y,3)}`;
}
function drawCharts(t){drawTimeline(t);drawWindow(t);drawHeatmap(t);drawPitchPanel(t)}
function sceneOptions(){return{size:Number($('size').value)/100,pitchMode:$('pitch-mode').value||'beat_summary',geometry:geometryForPreview(),solo:$('solo').checked,stem:state.stem,overlap:$('overlap-preview').checked,guides:$('guides').checked}}
function drawPreview(t,visualTime=t){
 const c=canvas('preview'),{ctx,width,height}=c,bundle=state.bundle;
 const {background,actors,mixed,overlapReport}=paintLabScene(ctx,bundle,t,visualTime,sceneOptions(),width,height);
 $('preview-empty').hidden=!!bundle;if(!bundle)return;
 $('background-info').textContent='背景 #'+background.rgb.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('')+' · '+(background.source==='bar'?'原曲片段 '+background.segment+' / Foote 过渡':background.source==='held'?'静音/缺失片段，保持上一有效颜色':'整曲参考色');
 const layoutReady=coverageMatches(bundle.overlap?.coverage,bundle,sceneOptions(),width,height),count=bundle.overlap?.coverage?.required_count,total=bundle.overlap?.coverage?.theoretical_count;
 $('overlap-readout').textContent=bundle.overlap?.enabled?(mixed?'混音重叠色已开启 · '+(layoutReady?`当前布局需要 ${count} / ${total} 个组合×小节`:'布局尚未筛选或已变化，请补齐当前交叠色')+(overlapReport?.missing?' · 可见区域仍有缺失，暂用普通层叠色':''):'混音重叠色预览已关闭'):'混音重叠色未开启';
 $('overlap-fill').disabled=state.busy||!bundle.overlap?.enabled;

 const selected=actors.find(a=>a.id===state.stem),motion=state.inspect?.motion?sampleMotion(state.inspect.motion,t):null;
 const positionInfo=selected?.y_source==='pitch'?`${selected.pitch_mode==='continuous'?'连续音高':'逐拍音高中位数'} · 当前 ${fmt(selected.pitch_midi,2)} MIDI · 本拍目标 ${fmt(selected.beat_pitch_midi,2)} · 置信值 ${fmt(selected.pitch_confidence,2)}${selected.pitch_status==='unvoiced'?' · 无有效音高，保持位置':''}`:selected?`拍均质心 ${fmt(selected.beat_mean_centroid_hz,1)} Hz · 插值位置 ${fmt(selected.centroid_hz,1)} Hz`:'';
 $('live-readout').textContent=selected?`${LABELS[state.stem]} · A ${fmt(selected.arousal)} · ${positionInfo} · ${selected.foote_motion?'Foote速度 · F '+fmt(selected.foote_level,3):'原固定缓动'} · RMS ${fmt(selected.rms,5)}（${selected.volume_mode==='beat_average'?'拍均整拍插值':'实时'}，尺寸连续包络） · X ${fmt(selected.x/width,3)} / Y ${fmt(selected.y/height,3)}（画布比例，含边距）`:motion?`${LABELS[state.stem]} · 当前片段无有效图形（待测 / 静音 / 无效），音高无效时位置保持`:'当前尚无可预览数据。';
 const form=selected?.form,identity=INSTRUMENT_SHAPES[state.stem];
 $('geometry-readout').textContent=state.geometryError?state.geometryError+'（暂用已保存值）':`${LABELS[state.stem]} · 固定形态：${SHAPE_LABELS[identity.kind]}${identity.aspect?'（宽高比 '+identity.aspect+'）':''} · ${form?`原始 A 目标 ${fmt(form.target.arousal)} → 当前 ${fmt(form.arousal)} · 描边${form.outline_enabled?' '+fmt(form.outline_width*height/540)+' px':'关闭'} · 旋转 ${fmt(form.rotation_offset_degrees,1)}° / 目标 ${fmt(form.target.rotation_offset_degrees,1)}° · V P10/P90 ${fmt(form.rotation_reference.valence_low)}/${fmt(form.rotation_reference.valence_high)}${form.rotation_reference.complete?'':'（局部试算）'}`:'当前无有效图形'} · 轮廓身份固定`;
}
function timeFromEvent(event,element){const [a,b,left,right]=element._domain||[0,1,0,element.clientWidth],x=event.clientX-element.getBoundingClientRect().left;return a+Math.max(0,Math.min(1,(x-left)/(right-left)))*(b-a)}
for(const id of ['timeline','waveform','features','heatmap','pitch-chart'])$(id).addEventListener('click',e=>{const t=timeFromEvent(e,$(id));if(state.inspect?.meter?.segments.length)selectRow(rowAt(state.inspect.meter.segments,t),false);seek(t)});
$('heatmap').addEventListener('mousemove',e=>{const element=$('heatmap'),t=timeFromEvent(e,element),y=e.clientY-element.getBoundingClientRect().top,tag=TAGS[Math.floor((y-6)/18)],rows=state.inspect?.emotion?.segments||[],row=rows[rowAt(rows,t)];if(!tag||!row)return;$('heatmap-hint').textContent=`${timeLabel(t)} · ${row.label||row.segment} · ${tag} = ${fmt(row.status==='ok'?row.scores.find(s=>s.tag===tag)?.score:null)} · ${row.status}`});
for(const stem of STEMS){const option=el('option',LABELS[stem]);option.value=stem;$('stem').append(option);const listen=el('option','试听 '+LABELS[stem]);listen.value=stem;listen.disabled=true;$('listen').append(listen);const label=el('label',undefined,'check'),input=el('input');input.type='checkbox';input.value=stem;input.checked=stem==='bass';input.dataset.stemCheck='1';label.append(input,document.createTextNode(LABELS[stem]));$('stem-checks').append(label)}
$('parameters').onsubmit=e=>e.preventDefault();$('upload').onchange=()=>upload($('upload').files[0]);$('runs').onchange=()=>{if($('runs').value)loadRun($('runs').value,true).catch(e=>message(e.message,true))};$('apply').onclick=()=>runStage('configure');$('play').onclick=()=>play().catch(e=>message(e.message,true));$('seek').oninput=()=>seek(Number($('seek').value));$('listen').onchange=async()=>{const was=state.playing;pause();try{await loadAudio();if(was)await play()}catch(e){message(e.message,true)}};$('clip-player').onplay=()=>pause();$('stem').onchange=async()=>{state.stem=$('stem').value;try{await loadInspect();drawCharts(now())}catch(e){message(e.message,true)}};$('bar').onchange=()=>selectRow(Number($('bar').value));$('prev').onclick=()=>selectRow(state.row-1);$('next').onclick=()=>selectRow(state.row+1);$('size').oninput=()=>{$('size-value').textContent=$('size').value+'%';dirtyChanged()};$('clicks').onchange=()=>{stopClicks();if(state.playing){const t=now();state.nextClick=state.inspect?.meter?.beats.findIndex(b=>b>=t)??-1}};
$('run-all').onclick=()=>runStage('all');$('audition-target').onclick=()=>auditionUrl(base()+`/clip?stem=${state.stem}&row=${state.row+1}&kind=target`);$('audition-context').onclick=()=>auditionUrl(base()+`/clip?stem=${state.stem}&row=${state.row+1}&kind=context`);$('export').onclick=()=>{if(!state.bundle)return;const config=geometryForPreview(),value={...state.bundle,defaults:{...state.bundle.defaults,...config},movement:{...state.bundle.movement,velocity_continuity:'C1',foote_motion_rule:'quintic easing of normalized Foote integral; continuous pitch with causal 60ms Hann smoothing',terminal_braking_seconds:.12,continuous_motion_smoothing_seconds:.06,pitch_preview_mode:$('pitch-mode').value||'beat_summary',foote_motion_enabled:config.foote_motion_enabled},geometry:{...state.bundle.geometry,revision:47,renderer_revision:56,semicircle_base_pose:'arc down, straight edge above; high-valence target',volume_envelope:{method:'causal Hann smoothing of finite peak release',drums_smoothing_seconds:.06,other_smoothing_seconds:.10,target_step_seconds:.01,continuity:'continuous radius and rate; no positive-radius cutoff'},type:'instrument_identity',default_size_percent:100,size_multiplier:9,size_reference:'R56 100% = R51 300%',outline:config.outline_enabled,outline_color:'#000000',material:{revision:1,style:'matte_paint_on_fine_paper',seed:'fixed per instrument; object-local pattern; static background',overlap:'apply material over predicted mixed-audio color'},drums_outline:{lines:2,outer:'arousal driven',inner_ratio:config.drums_inner_ratio,gap_540p:config.drums_outline_gap,tiny_shape:'compress both widths and gap inside silhouette'},outline_instruments:Object.fromEntries(STEMS.map(s=>[s,config['outline_'+s+'_enabled']])),outline_multipliers:Object.fromEntries(STEMS.map(s=>[s,config['outline_'+s+'_multiplier']])),rotation:{...state.bundle.geometry.rotation,enabled:config.rotation_enabled},parameters:config}},url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download=state.manifest.name+'.stems.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>{for(const b of document.querySelectorAll('[data-tab]')){const active=b===button;b.classList.toggle('active',active);$('tab-'+b.dataset.tab).hidden=!active}};
function frame(timestamp){if(state.videoExporting||state.coverageScanning){requestAnimationFrame(frame);return}const t=now();if(state.playing&&state.renderEnded&&t>=state.buffer.duration-1e-6){state.playing=false;state.offset=state.buffer.duration;state.source=null;state.endedWall=timestamp;stopClicks();$('play').textContent='播放'}$('clock').textContent=timeLabel(t)+' / '+timeLabel(state.manifest?.duration_seconds||0);$('seek').value=t;scheduleClicks();if(state.playing&&$('follow').checked&&state.inspect?.meter?.segments.length){const index=rowAt(state.inspect.meter.segments,t);if(index!==state.row){state.row=index;$('bar').value=index;renderInspector();renderTable()}}if(timestamp-state.lastChart>100){drawCharts(t);state.lastChart=timestamp}const visualTime=state.endedWall===null||state.endedWall===undefined?t:t+Math.max(0,timestamp-state.endedWall)/1000;drawPreview(t,visualTime);requestAnimationFrame(frame)}
renderStages();busy(false);listRuns().then(()=>{const id=localStorage.getItem('spectra-lab-run');if(id&&[...$('runs').options].some(o=>o.value===id))return loadRun(id,true)}).catch(e=>message('无法连接本地实验服务：'+e.message,true));requestAnimationFrame(frame);
window.spectraLab={state,seek,selectRow,runStage};

$('pitch-mode').addEventListener('change',()=>{drawCharts(now());drawPreview(now())});

for(const id of ['pitch-span','pitch-show-raw','pitch-show-accepted','pitch-show-beat','pitch-show-position'])$(id).addEventListener('change',()=>{state.pitchHover=null;drawPitchPanel(now())});
$('pitch-chart').addEventListener('mousemove',e=>{state.pitchHover=timeFromEvent(e,$('pitch-chart'));drawPitchPanel(now())});
$('pitch-chart').addEventListener('mouseleave',()=>{state.pitchHover=null;drawPitchPanel(now())});
$('pitch-listen').onclick=async()=>{if(!state.manifest)return;pause();$('listen').value=state.stem;try{await loadAudio();await play()}catch(error){message(error.message,true)}};

async function exportVideo(){
 if(!state.bundle||state.busy||state.videoExporting)return;
 pause();$('clip-player').pause();geometryForPreview();if(state.geometryError){message(state.geometryError,true);return}
 busy(true);try{await prepareCurrentOverlaps()}catch(e){const detail='导出前的交叠色检查失败：'+e.message;$('video-status').textContent=detail;message(detail,true);busy(false);return}busy(false);
 const bundle=JSON.parse(JSON.stringify(state.bundle)),scene=sceneOptions();
 const referenceWidth=Math.max(1,$('preview').clientWidth),referenceHeight=referenceWidth*9/16;
 const height=Number($('video-resolution').value)||1080,width=height*16/9,fps=Number($('video-fps').value)||30;
 const locked=['play','seek','listen','stem','bar','prev','next','size','solo','guides','overlap-preview','pitch-mode','video-resolution','video-fps'].map(id=>[id,$(id).disabled]);
 for(const [id] of locked)$(id).disabled=true;
 state.videoExporting=true;state.videoAbort=new AbortController();busy(true);
 $('video-export').disabled=true;$('video-cancel').disabled=false;$('video-download').hidden=true;$('video-progress').hidden=false;$('video-progress').value=0;
 message('正在离线逐帧渲染视频；可取消。');
 try{
  const result=await exportOfflineVideo({runId:state.manifest.id,bundle,scene,referenceWidth,referenceHeight,width,height,fps,audioStem:$('listen').value||'mix',paint:paintLabScene,signal:state.videoAbort.signal,
   onProgress:p=>{$('video-progress').value=p.fraction;$('video-status').textContent=p.phase==='encoding'?'正在整理MP4与音频…':p.phase==='done'?'导出完成':`渲染 ${p.completed} / ${p.total} 帧 · ${(p.fraction/0.98*100).toFixed(1)}%`}});
  const link=$('video-download');link.href=result.url;link.download=state.manifest.name.replace(/\.[^.]+$/,'')+'.mp4';link.textContent='下载 MP4 · '+(result.bytes/1048576).toFixed(1)+' MB';link.hidden=false;
  message('视频导出完成，已保存在本曲实验目录的 videos 文件夹。');
 }catch(e){$('video-status').textContent=e.name==='AbortError'?'导出已取消':e.message;message(e.name==='AbortError'?'视频导出已取消。':e.message,e.name!=='AbortError')}
 finally{state.videoExporting=false;state.videoAbort=null;for(const [id,disabled] of locked)$(id).disabled=disabled;busy(false);$('video-export').disabled=!state.bundle;$('video-cancel').disabled=true;drawPreview(now())}
}
$('video-export').onclick=()=>exportVideo();$('video-cancel').onclick=()=>state.videoAbort?.abort();

function presentationDraft(){return{size_percent:Number($('size').value)||100,pitch_mode:$('pitch-mode').value||'beat_summary',overlap_preview:$('overlap-preview').checked,guides:$('guides').checked,clicks:$('clicks').checked,follow:$('follow').checked,video_resolution:Number($('video-resolution').value)||1080,video_fps:Number($('video-fps').value)||30}}
function applyPresentation(value){
 const p={...PRESENTATION_DEFAULTS,...value};$('size').value=p.size_percent;$('size-value').textContent=p.size_percent+'%';$('pitch-mode').value=p.pitch_mode;
 for(const [id,key] of [['overlap-preview','overlap_preview'],['guides','guides'],['clicks','clicks'],['follow','follow']])$(id).checked=p[key];
 $('video-resolution').value=p.video_resolution;$('video-fps').value=p.video_fps;
}
async function saveNewDefaults(){
 if(!state.manifest||state.busy)return;geometryForPreview();if(state.geometryError){message(state.geometryError,true);return}
 busy(true);try{
  await api('/api/lab/defaults',{method:'POST',headers:{'Content-Type':'application/json','X-Spectra-Client':'1'},body:JSON.stringify({parameters:draft(),presentation:presentationDraft()})});
  message('已设置为新的默认参数。新导入歌曲会自动使用；当前实验尚未保存的修改仍可点“保存参数”。');
 }catch(e){message(e.message,true)}finally{busy(false)}
}
async function applyDefaults(){
 if(!state.manifest||state.busy)return;busy(true);try{
  const profile=await api('/api/lab/defaults');buildParameters(profile.parameters);applyPresentation(profile.presentation);dirtyChanged();drawCharts(now());drawPreview(now());
  message('已载入默认参数。点击“保存参数”应用到当前歌曲；需要重算的步骤会按实际改动标记。');
 }catch(e){message(e.message,true)}finally{busy(false)}
}
$('set-defaults').onclick=()=>saveNewDefaults();$('apply-defaults').onclick=()=>applyDefaults();
for(const id of ['pitch-mode','overlap-preview','guides','follow','video-resolution','video-fps'])$(id).addEventListener('input',dirtyChanged);
$('clicks').addEventListener('input',dirtyChanged);

async function prepareCurrentOverlaps(){
 const bundle=state.bundle,scene=sceneOptions();if(!bundle?.overlap?.enabled||!scene.overlap)return;
 const width=Math.max(1,$('preview').clientWidth),height=width*9/16;
 if(coverageMatches(bundle.overlap.coverage,bundle,scene,width,height)&&bundle.overlap.coverage_status==='ready')return;
 const locked=['play','seek','stem','bar','prev','next','listen','size','solo','guides','overlap-preview','pitch-mode'].map(id=>[id,$(id).disabled]);for(const [id] of locked)$(id).disabled=true;
 state.coverageScanning=true;try{
  message('正在筛选实际交叠区域：按60帧/秒及原始特征时刻检查位置、尺寸、旋转与退场…');
  const coverage=await scanOverlapCoverage(bundle,scene,width,height,{onProgress:f=>{$('progress').value=f*.25}});
  message(`实际需要 ${coverage.required_count} / ${coverage.theoretical_count} 个组合×小节，正在复用缓存并补算缺失项…`);
  const data=await api(base()+'/action',{method:'POST',headers:{'Content-Type':'application/json','X-Spectra-Client':'1'},body:JSON.stringify({stage:'overlap',coverage})});
  await waitJob(data.job_id);await loadRun(state.manifest.id);
  const output=state.bundle.overlap;if(!coverageMatches(output.coverage,state.bundle,sceneOptions(),Math.max(1,$('preview').clientWidth),Math.max(1,$('preview').clientWidth)*9/16))throw Error('预览布局在计算期间发生变化，请重新补齐当前交叠色。');if(output.coverage_status!=='ready')throw Error('可见混音仍有未成功预测的小节，请点击“补齐当前交叠色”重试。');
 }finally{state.coverageScanning=false;for(const [id,disabled] of locked)$(id).disabled=disabled}
}
$('overlap-fill').onclick=async()=>{if(state.busy||!state.bundle)return;pause();busy(true);$('progress').hidden=false;try{await prepareCurrentOverlaps();message('当前布局的交叠色已补齐，已有声部与混音预测均复用。')}catch(e){message(e.message,true)}finally{busy(false);$('progress').hidden=true}};
