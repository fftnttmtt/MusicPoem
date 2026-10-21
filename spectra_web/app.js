import {clamp,lerp,hashString} from './core.js?v=stems-r33';
import {chromaBarCount,createChromaPlot,paintChromaBars} from './chroma.js?v=stems-r33';
import {parseBeatTimes} from './analysis.js?v=stems-r33';
import {beatIndexAt,displayOpacityAt,positionAt,bindingAt,releaseEventsAt} from './beat-events.js?v=stems-r33';
import {demoScene,backgroundAt,paintMotif,EPIC_OUTLINE_GAP} from './visuals.js?v=stems-r33';
import {preparePrediction,predictedBackground,assignEventMotifs,intervalAt,requestPrediction} from './prediction.js?v=stems-r33';
import {makeDemoPCM} from './demo-audio.js?v=stems-r33';
import {playbackTime,playbackHasStarted} from './playback-clock.js?v=stems-r33';
import {scheduleBeatClicks} from './beat-clicks.js?v=stems-r33';
import {measureLoudness,tailClearTime,beatPulseScale} from './presence.js?v=stems-r33';
import {prepareStemPrediction,requestStemPrediction,stemStatesAt} from './stem-player.js?v=stems-r33';
const $=id=>document.getElementById(id);
$('build-info').textContent='六声部版 R56 · epic 双框净间距 '+EPIC_OUTLINE_GAP+' px';
const icons={
 plus:'<path d="M12 5v14M5 12h14"/>',play:'<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
 pause:'<path d="M9 5v14M15 5v14" stroke-width="2.8"/>',restart:'<path d="M4 9a8 8 0 1 1 0 6M4 4v5h5"/>',
 upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4"/>',
 sliders:'<path d="M4 7h8m4 0h4M4 17h3m4 0h9"/><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
 expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',collapse:'<path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>'
};
function icon(el,name){el.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+icons[name]+'</svg>'}
document.querySelectorAll('[data-icon]').forEach(el=>icon(el,el.dataset.icon));
const canvas=$('stage'),context=canvas.getContext('2d',{alpha:false}),app=$('app');
const settings={threshold:1.2,spacing:2,decay:.5,smoothing:.04,window:.06,fadeIn:.18,fadeOut:.18,mass:8,breath:1,hoverStrength:4,positionGamma:.5,size:1.5,showSpectrum:true,beatClicks:true,tailSilenceDb:-50,stemMode:true,manualTempo:false,bpm:120,beatOffset:0};
const state={audio:null,gain:null,source:null,buffer:null,model:null,worker:null,playing:false,wantPlaying:false,
 offset:0,startedAt:0,clickTrack:null,sourceEnded:false,tailStartedAt:null,loading:false,rebuilding:false,loadId:0,requestId:0,playRequest:0,seed:1,
 prediction:null,stemPrediction:null,demo:false,localEngine:false,predictionController:null,audioHash:null,loudness:null,tailClearAt:Infinity,tailEvents:[],
 customBeats:null,beatMode:'自动估计',focus:false,nativeFullscreen:false};
let width=0,height=0,toastTimer,rebuildTimer,dragDepth=0,displayLevels=new Float32Array(0),lastHud='';
const formatTime=s=>{s=Math.max(0,Math.floor(s||0));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
const currentTime=()=>playbackTime(state,performance.now());
// Only natural EOF runs this clock. Pausing still freezes the whole scene.
const visualTime=()=>state.tailStartedAt===null?currentTime():
 (state.buffer?.duration||0)+Math.max(0,performance.now()-state.tailStartedAt)/1000;
function updateTailEvents(){state.tailEvents=state.model?releaseEventsAt(state.model.events,state.tailClearAt):[]}
function renderEventsAt(time){return time>=state.tailClearAt?state.tailEvents:state.model?.events||[]}
function stemActors(){return state.stemPrediction?stemStatesAt(state.stemPrediction,currentTime(),visualTime(),settings,width,height,state.tailClearAt):[]}
function updateModeControls(){
 const stems=!!state.stemPrediction||(!state.buffer&&settings.stemMode);
 $('legacy-triggers').hidden=stems;$('legacy-motion').hidden=stems;
 $('predict-per-beat').disabled=stems||!state.localEngine;
}
function notify(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500)}
function ensureAudio(){
 if(state.audio)return state.audio;
 const AudioContext=window.AudioContext||window.webkitAudioContext;
 if(!AudioContext)throw new Error('当前浏览器不支持音频分析，请使用新版 Chrome、Edge 或 Safari。');
 state.audio=new AudioContext();state.gain=state.audio.createGain();state.gain.connect(state.audio.destination);return state.audio;
}
function updatePlayButton(){icon($('play-button'),state.playing?'pause':'play');$('play-button').setAttribute('aria-label',state.playing?'暂停':'播放')}
function syncBeatClicks(){
 state.clickTrack?.stop();state.clickTrack=null;
 if(settings.beatClicks&&state.playing&&state.model)state.clickTrack=scheduleBeatClicks(state.audio,state.gain,state.model.beats,state.startedAt,state.offset,Math.min(state.buffer.duration,state.tailClearAt));
}
function stopSource(){state.clickTrack?.stop();state.clickTrack=null;state.sourceEnded=false;if(state.source){state.source.onended=null;try{state.source.stop()}catch{}state.source.disconnect();state.source=null}}
function pause(){state.playRequest++;state.wantPlaying=false;if(!state.playing)return;state.offset=currentTime();state.playing=false;stopSource();updatePlayButton()}
async function play(){
 if(!state.buffer||!state.model||state.loading||state.playing)return;
 state.wantPlaying=true;const request=++state.playRequest;
 try{
  await ensureAudio().resume();if(request!==state.playRequest||state.playing)return;
  if(state.audio.state!=='running'){state.wantPlaying=false;notify('点击播放以启用音频。');return}
  if(state.offset>=state.buffer.duration-.015)state.offset=0;
  state.tailStartedAt=null;stopSource();const source=state.audio.createBufferSource();source.buffer=state.buffer;source.connect(state.gain);state.source=source;
  const startedAt=state.audio.currentTime+.03;state.startedAt=startedAt;state.playing=true;
  source.onended=()=>{if(state.source===source)state.sourceEnded=true};
  source.start(startedAt,state.offset);syncBeatClicks();updatePlayButton();
 }catch(error){if(request!==state.playRequest)return;state.playing=false;state.wantPlaying=false;updatePlayButton();notify(error.message||'音频播放失败。')}
}
function seekTo(time){if(!state.buffer||state.loading)return;const resume=state.playing||state.wantPlaying;pause();state.tailStartedAt=null;state.offset=clamp(time,0,state.buffer.duration);updateTimeline();if(resume)void play()}
function updateTimeline(){const time=currentTime(),duration=state.buffer?.duration||0;$('current-time').textContent=formatTime(time);$('seek').value=String(time);$('seek').style.setProperty('--progress',(duration?time/duration*100:0)+'%')}
function loadingUI(loading){state.loading=loading;$('loading').hidden=!loading;$('welcome').hidden=loading||!!state.buffer;$('player').hidden=loading||!state.buffer;$('track-hud').hidden=loading||!state.buffer}
function updateBeatUI(){
 const model=state.model;if(!model)return;
 const imported=!!state.customBeats;
 $('auto-bpm').disabled=!!(state.prediction||state.stemPrediction);$('choose-beats').disabled=!!(state.prediction||state.stemPrediction);
 if(!settings.manualTempo&&!imported){settings.bpm=model.estimate.bpm;settings.beatOffset=model.estimate.offset}
 $('bpm').value=String(settings.bpm);$('bpm-value').textContent=settings.bpm.toFixed(1)+' BPM';
 $('beat-offset').value=String(Math.round(settings.beatOffset*1000));$('beat-offset-value').textContent=Math.round(settings.beatOffset*1000)+' ms';
 $('bpm').disabled=imported;$('beat-offset').disabled=imported;
 $('auto-bpm').setAttribute('aria-pressed',String(!settings.manualTempo&&!imported));
 $('beat-source').textContent=state.beatMode+' · '+model.beats.length+' 个节拍';
 $('tempo-label').textContent=(imported?state.beatMode:'≈ '+settings.bpm.toFixed(1)+' BPM')+(state.rebuilding?' · 更新中':'');
}
function config(){return{...settings,stemMode:!!state.stemPrediction,count:chromaBarCount(width),width,height}}
function rebuild(){
 if(!state.worker||!state.buffer||state.loading)return;
 clearTimeout(rebuildTimer);state.rebuilding=true;updateBeatUI();
 state.worker.postMessage({type:'configure',id:++state.requestId,settings:config(),customBeats:state.customBeats});
}
function scheduleRebuild(){clearTimeout(rebuildTimer);rebuildTimer=setTimeout(rebuild,180)}
function updatePredictionUI(){
 const predicted=!!(state.prediction||state.stemPrediction);
 $('prediction-download').disabled=!predicted;
 $('mode-label').textContent=state.stemPrediction?'六声部 / 小节情绪':predicted?'节拍 / 情绪 · 模型预测':state.demo?'情绪 / 背景 · 示例':'情绪 / 背景 · 待预测';
 const whole=state.prediction?.whole_song_color;
 $('song-color').style.background=whole?.hex||'';
 $('song-color').hidden=!!state.stemPrediction;
 $('prediction-mode').title=whole?.hex?'整曲色彩标签 '+whole.hex.toUpperCase():'';
 $('prediction-note').textContent=state.stemPrediction?'原曲统一小节 · SW 六声部 · 各轨独立情绪与坐标'+(state.stemPrediction.cache_hit?' · 已复用缓存':''):state.localEngine?'本机 CUDA · final0 · 默认六声部；模式更改后重新选择音乐。':'请启动本地程序计算，或导入已有预测 JSON。';
 updateModeControls();
}
async function detectEngine(){
 try{const response=await fetch('/api/config',{cache:'no-store'});if(response.ok){const value=await response.json();state.localEngine=value.engine==='spectra-local-v1'}}catch{}
 updatePredictionUI();
 updateModeControls();
}
const engineReady=detectEngine();
function failLoading(message){state.buffer=null;state.model=null;state.prediction=null;state.stemPrediction=null;state.demo=false;state.rebuilding=false;state.worker?.terminate();state.worker=null;updatePredictionUI();loadingUI(false);notify(message)}
async function canonicalBuffer(value,fallback,audio,signal,required=true){
 const url=value.audio?.playback_url;
 try{
  if(!/^\/api\/stems\/[0-9a-f]{32}\/mixture\.wav$/.test(url||''))throw new Error('六声部结果缺少有效的缓存原曲地址。');
  const response=await fetch(url,{signal,cache:'no-store'});if(!response.ok)throw new Error('对应的缓存原曲不存在，请重新分析。');
  return await audio.decodeAudioData(await response.arrayBuffer());
 }catch(error){if(required||error.name==='AbortError')throw error;notify('未找到同次分析的缓存原曲，使用当前所选音频播放。');return fallback}
}
function beginAnalysis(buffer,name,providedBeats=null,prediction=null,demo=false,stemPrediction=null){
 state.tailStartedAt=null;
 state.loudness=measureLoudness(buffer);state.tailClearAt=tailClearTime(state.loudness,settings.tailSilenceDb);
 state.prediction=prediction;state.stemPrediction=stemPrediction;state.demo=demo;updatePredictionUI();
 state.worker?.terminate();state.buffer=buffer;state.model=null;state.offset=0;state.customBeats=providedBeats;
 state.beatMode=stemPrediction?'Beat This! final0 · 原曲统一节拍':prediction?'Beat This! '+(prediction.prediction_parameters?.beat_model||'预测节拍'):providedBeats?'示例节拍':'自动估计';settings.manualTempo=false;
 state.seed=hashString(name+':'+buffer.duration);loadingUI(true);
 $('track-name').textContent=name;$('track-name').title=name;$('seek').max=String(buffer.duration);$('duration').textContent=formatTime(buffer.duration);
 const pcm=new Float32Array(buffer.length),channels=buffer.numberOfChannels;
 for(let c=0;c<channels;c++){const samples=buffer.getChannelData(c);for(let i=0;i<pcm.length;i++)pcm[i]+=samples[i]/channels}
 const worker=new Worker(new URL('./analyzer-worker.js?v=stems-r33',import.meta.url),{type:'module'});state.worker=worker;
 worker.onmessage=({data})=>{
  if(state.worker!==worker)return;
  if(data.type==='progress'){$('loading-text').textContent='分析频谱与节拍… '+Math.round(data.progress*100)+'%';return}
  if(data.id!==state.requestId)return;
  if(data.type==='error'){if(state.loading)failLoading(data.message);else{state.rebuilding=false;updateBeatUI();notify(data.message)}return}
  if(data.type==='model'){
   const initial=state.loading;state.model=data.model;if(state.prediction)assignEventMotifs(state.model.events,state.prediction,state.seed);state.rebuilding=false;displayLevels=new Float32Array(data.model.count);lastHud='';
   updateTailEvents();updateModeControls();updateBeatUI();updateTimeline();loadingUI(false);if(!initial)syncBeatClicks();
   if(initial){void play();if(!state.prediction&&!state.stemPrediction&&!state.demo)notify('已读取音乐；请在设置中导入对应的 SPECTRA 预测 JSON。');if(data.model.estimate.confidence<.08&&!providedBeats)notify('节拍不明显，暂用估计速度；可手动校准或导入节拍 JSON。')}
   if(data.model.events.length===0&&!!(state.prediction||state.demo))notify('当前阈值下没有图形，可在设置中降低“上升率阈值”。');
  }
 };
 worker.onerror=event=>{event.preventDefault();if(state.loading)failLoading('分析未能完成，请换一首音乐重试。');else notify('重新计算失败，请重新选择音乐。')};
 $('loading-text').textContent='分析频谱与节拍…';
 worker.postMessage({type:'analyze',id:++state.requestId,pcm,sampleRate:buffer.sampleRate,settings:config(),customBeats:providedBeats},[pcm.buffer]);
}
async function loadFile(file){
 if(!file)return;
 if(!(file.type.startsWith('audio/')||/\.(mp3|wav|wave|flac|ogg|oga|m4a|aac|opus|aif|aiff|webm|mp4)$/i.test(file.name))){notify('请选择 MP3、WAV、M4A 或 FLAC 等音频文件。');return}
 const id=++state.loadId;state.predictionController?.abort();state.predictionController=null;state.prediction=null;state.stemPrediction=null;state.demo=false;state.audioHash=null;updatePredictionUI();pause();clearTimeout(rebuildTimer);state.worker?.terminate();state.worker=null;state.buffer=null;state.model=null;loadingUI(true);$('loading-text').textContent='正在读取声音…';
 try{const audio=ensureAudio();await audio.resume();const bytes=await file.arrayBuffer();if(id!==state.loadId)return;
  let buffer=await audio.decodeAudioData(bytes);if(id!==state.loadId)return;
  if(!buffer.duration)throw new Error('这个文件没有可播放的音频。');
  if(crypto.subtle)state.audioHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('');
  await engineReady;if(id!==state.loadId)return;
  let prediction=null,stemPrediction=null;
  if(state.localEngine){
   const controller=new AbortController();state.predictionController=controller;
   const progress=(message,fraction)=>{if(id===state.loadId)$('loading-text').textContent=message+' '+Math.round(fraction*100)+'%'};
   if(settings.stemMode){
    $('loading-text').textContent='提交六声部 CUDA 分析…';
    const value=await requestStemPrediction(file,{chunkSeconds:Number($('sw-chunk').value)||0,weights:$('sw-weights').value.trim(),useAmp:$('sw-amp').checked},progress,controller.signal);
    if(id!==state.loadId)return;
    buffer=await canonicalBuffer(value,buffer,audio,controller.signal);
    if(id!==state.loadId)return;
    stemPrediction=prepareStemPrediction(value,buffer.duration,state.audioHash);
   }else{
    const unit=$('predict-per-beat').checked?'beat':'bar';$('loading-text').textContent='提交本机 CUDA 预测…';
    const value=await requestPrediction(file,unit,progress,controller.signal);
    if(id!==state.loadId)return;
    prediction=preparePrediction(value,buffer.duration,state.audioHash);
   }
  }
  beginAnalysis(buffer,file.name.replace(/\.[^.]+$/,''),stemPrediction?.beats??prediction?.beats??null,prediction,false,stemPrediction);
  if(prediction)reportPrediction(prediction);
  if(stemPrediction){const errors=stemPrediction.stems.flatMap(t=>t.segments).filter(r=>r.prediction_status==='error').length;if(errors)notify(errors+' 个分轨小节预测失败，已保留空缺；详情见导出 JSON。')}
 }catch(error){if(id!==state.loadId)return;failLoading(error.name==='EncodingError'?'无法解码这个音频，请尝试 MP3 或 WAV。':error.message)}
}
async function playDemo(){
 const id=++state.loadId;state.predictionController?.abort();state.predictionController=null;state.prediction=null;state.stemPrediction=null;state.demo=false;state.audioHash=null;updatePredictionUI();pause();clearTimeout(rebuildTimer);state.worker?.terminate();state.worker=null;state.buffer=null;state.model=null;loadingUI(true);$('loading-text').textContent='准备示例音乐…';
 try{const audio=ensureAudio();await audio.resume();if(id!==state.loadId)return;
  const demo=makeDemoPCM(audio.sampleRate),buffer=audio.createBuffer(1,demo.pcm.length,demo.sampleRate);buffer.copyToChannel(demo.pcm,0);
  beginAnalysis(buffer,'SPECTRA · 节拍示例',demo.beats,null,true);
 }catch(error){if(id===state.loadId)failLoading(error.message)}
}
function chooseFile(){try{void ensureAudio().resume();$('file-input').click()}catch(error){notify(error.message)}}
$('choose-initial').addEventListener('click',chooseFile);$('replace-button').addEventListener('click',chooseFile);$('demo-button').addEventListener('click',()=>void playDemo());
$('file-input').addEventListener('change',event=>{void loadFile(event.target.files[0]);event.target.value=''});
$('play-button').addEventListener('click',()=>(state.playing||state.wantPlaying)?pause():void play());
$('restart-button').addEventListener('click',()=>{if(!state.buffer)return;pause();state.offset=0;updateTimeline();void play()});$('seek').addEventListener('input',event=>seekTo(Number(event.target.value)));
function openSettings(open){$('settings-panel').hidden=!open;$('panel-scrim').hidden=!open;$('settings-button').setAttribute('aria-expanded',String(open));(open?$('close-settings'):$('settings-button')).focus()}
$('settings-button').addEventListener('click',()=>openSettings($('settings-panel').hidden));$('close-settings').addEventListener('click',()=>openSettings(false));$('panel-scrim').addEventListener('click',()=>openSettings(false));
const bindings=[['position-gamma','positionGamma',v=>v.toFixed(2),1],['threshold','threshold',v=>v.toFixed(1)+' /s',1],['spacing','spacing',v=>v+' 根',1],['decay','decay',v=>v+'%',100],['smoothing','smoothing',v=>v+' ms',1000],['birth-window','window',v=>'±'+v+' ms',1000],['mass','mass',v=>v.toFixed(1),1],['breath','breath',v=>v+'%',100],['hover-strength','hoverStrength',v=>v+'%',100],['fade-in','fadeIn',v=>v+' ms',1000],['fade-out','fadeOut',v=>v+' ms',1000],['shape-size','size',v=>v+'%',100]];
for(const [id,key,format,divisor] of bindings)$(id).addEventListener('input',event=>{const value=Number(event.target.value);settings[key]=value/divisor;$(id+'-value').textContent=format(value);if(['mass','fadeIn','fadeOut'].includes(key))updateMotionLabels();if(!['size','hoverStrength','positionGamma'].includes(key))scheduleRebuild()});
function updateMotionLabels(){
 for(const [id,key] of [['fade-in','fadeIn'],['fade-out','fadeOut']]){
  const base=Math.round(settings[key]*1000),actual=Math.round(base*Math.sqrt(settings.mass));
  $(id+'-value').textContent=id==='fade-in'?base+' ms · 升起 '+actual+' ms':base+' → '+actual+' ms';
 }
}
updateMotionLabels();
$('beat-clicks').checked=settings.beatClicks;
$('stem-mode').checked=settings.stemMode;
$('sw-amp').checked=true;
$('stem-mode').addEventListener('change',event=>{settings.stemMode=event.target.checked;updateModeControls();notify('分析模式将在下次选择音乐时生效。')});
$('tail-silence').addEventListener('input',event=>{
 settings.tailSilenceDb=Number(event.target.value);$('tail-silence-value').textContent=settings.tailSilenceDb+' dBFS';
 state.tailClearAt=tailClearTime(state.loudness,settings.tailSilenceDb);updateTailEvents();syncBeatClicks();
});
$('beat-clicks').addEventListener('change',event=>{settings.beatClicks=event.target.checked;syncBeatClicks()});
for(const id of ['bpm','beat-offset'])$(id).addEventListener('input',event=>{settings.manualTempo=true;state.customBeats=null;state.beatMode='手动校准';settings[id==='bpm'?'bpm':'beatOffset']=Number(event.target.value)/(id==='bpm'?1:1000);updateBeatUI();scheduleRebuild()});
$('auto-bpm').addEventListener('click',()=>{settings.manualTempo=false;state.customBeats=null;state.beatMode='自动估计';rebuild()});
$('choose-beats').addEventListener('click',()=>{if(!state.buffer||state.loading){notify('请先选择音乐。');return}$('beat-input').click()});
$('beat-input').addEventListener('change',async event=>{
 const file=event.target.files[0];event.target.value='';if(!file||!state.buffer)return;const loadId=state.loadId;
 try{const value=JSON.parse(await file.text());if(loadId!==state.loadId)return;state.customBeats=parseBeatTimes(value,state.buffer.duration);state.beatMode='导入节拍';rebuild();notify('已导入 '+state.customBeats.length+' 个节拍。')}
 catch(error){notify(error instanceof SyntaxError?'节拍文件不是有效的 JSON。':error.message)}
});
function reportPrediction(prediction){
 const missing=prediction.segments.filter(r=>r.status!=='ok').length;
 if(missing)notify(missing+' 个片段没有有效颜色，已保留空缺；没有使用示例数据替代。');
 else if(!prediction.beats.length)notify('模型未检测到可用节拍，已显示预测颜色；没有补造拍点。');
}
$('choose-prediction').addEventListener('click',()=>{if(!state.buffer||state.loading){notify('请先选择对应音乐。');return}$('prediction-input').click()});
$('prediction-input').addEventListener('change',async event=>{
 const file=event.target.files[0];event.target.value='';if(!file||!state.buffer)return;
 const id=state.loadId;
 try{
  const value=JSON.parse((await file.text()).replace(/^\uFEFF/,''));if(id!==state.loadId)return;
  if(value.schema==='spectra-stems-v1'){
   const buffer=await canonicalBuffer(value,state.buffer,ensureAudio(),null,false);if(id!==state.loadId)return;
   const prediction=prepareStemPrediction(value,buffer.duration,state.audioHash);
   pause();beginAnalysis(buffer,$('track-name').textContent,prediction.beats,null,false,prediction);
   notify('已导入六声部情绪与实时特征。');return;
  }
  const prediction=preparePrediction(value,state.buffer.duration,state.audioHash);
  state.prediction=prediction;state.stemPrediction=null;state.demo=false;settings.manualTempo=false;
  state.customBeats=prediction.beats;state.beatMode='Beat This! '+(prediction.prediction_parameters?.beat_model||'预测节拍');
  updatePredictionUI();rebuild();reportPrediction(prediction);
  notify('已接入 '+prediction.bars.length+' 个小节 / '+prediction.beats.length+' 个节拍。'+(prediction.segments.some(r=>r.status!=='ok')?'部分颜色缺失，请查看导出结果。':''));
 }catch(error){notify(error instanceof SyntaxError?'预测文件不是有效 JSON。':error.message)}
});
$('prediction-download').addEventListener('click',()=>{
 const prediction=state.stemPrediction||state.prediction;if(!prediction)return;
 const blob=new Blob([JSON.stringify(prediction)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=($('track-name').textContent||'prediction')+'.spectra.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
function showSpectrum(show){settings.showSpectrum=show;$('show-spectrum').checked=show;$('spectrum-button').setAttribute('aria-pressed',String(show));$('spectrum-button').setAttribute('aria-label',show?'隐藏频谱参考':'显示频谱参考')}
$('show-spectrum').addEventListener('change',event=>showSpectrum(event.target.checked));$('spectrum-button').addEventListener('click',()=>showSpectrum(!settings.showSpectrum));
showSpectrum(settings.showSpectrum);
async function exitFocus(){state.focus=false;app.classList.remove('focus-mode');$('exit-focus').hidden=true;if(document.fullscreenElement)try{await document.exitFullscreen()}catch{}state.nativeFullscreen=false;resize()}
async function enterFocus(){openSettings(false);state.focus=true;app.classList.add('focus-mode');$('exit-focus').hidden=false;if(window.matchMedia('(pointer:coarse)').matches)app.classList.add('touch-controls');if(app.requestFullscreen)try{await app.requestFullscreen();state.nativeFullscreen=true}catch{}resize()}
$('fullscreen-button').addEventListener('click',()=>state.focus?void exitFocus():void enterFocus());$('exit-focus').addEventListener('click',()=>void exitFocus());
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&state.nativeFullscreen)void exitFocus()});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'){if(state.focus)void exitFocus();else if(!$('settings-panel').hidden)openSettings(false);return}
 if(event.target.matches('input,textarea,select,button,a,[contenteditable]'))return;
 if(event.code==='Space'&&state.buffer){event.preventDefault();(state.playing||state.wantPlaying)?pause():void play()}
 else if(event.key==='ArrowRight'&&state.buffer){event.preventDefault();seekTo(currentTime()+5)}
 else if(event.key==='ArrowLeft'&&state.buffer){event.preventDefault();seekTo(currentTime()-5)}
 else if(event.key.toLowerCase()==='f')state.focus?void exitFocus():void enterFocus();
});
document.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();dragDepth++;$('drop-overlay').hidden=false}});
document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy'}});
document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').hidden=true});
document.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;void loadFile(event.dataTransfer?.files[0])});window.addEventListener('blur',()=>{dragDepth=0;$('drop-overlay').hidden=true});
function resize(){
 width=app.clientWidth;height=app.clientHeight;const dpr=Math.min(window.devicePixelRatio||1,2);
 canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);context.setTransform(dpr,0,0,dpr,0,0);
 if(state.model&&(chromaBarCount(width)!==state.model.count||Math.abs(width-state.model.viewport.width)>1||Math.abs(height-state.model.viewport.height)>1))scheduleRebuild();
}
new ResizeObserver(resize).observe(app);resize();
function draw(){
 const model=state.model,time=currentTime(),background=state.stemPrediction?[0,0,0]:model?(state.prediction?predictedBackground(state.prediction,time):state.demo?backgroundAt(state.seed,model.beats,model.duration,time):[0,0,0]):[0,0,0];
 const eventTime=visualTime(),ready=playbackHasStarted(state,performance.now());
 context.fillStyle='rgb('+background.join(',')+')';context.fillRect(0,0,width,height);
 if(!model||state.loading)return;
 const frame=clamp(time/model.frameStep,0,model.frames-1),a=Math.floor(frame),b=Math.min(a+1,model.frames-1);
 for(let j=0;j<model.count;j++)displayLevels[j]=lerp(model.levels[a*model.count+j],model.levels[b*model.count+j],frame-a);
 const plot=createChromaPlot(width,height,model.count);
 if(settings.showSpectrum){context.save();context.globalAlpha=.17;paintChromaBars(context,plot,displayLevels,[255,255,255]);context.restore()}
 if(state.stemPrediction){
  const actors=ready?stemActors():[];
  for(const actor of actors)paintMotif(context,actor.motif,actor.x,actor.y,actor.radius,actor.alpha);
  const bar=intervalAt(state.stemPrediction.bars,time),beat=beatIndexAt(model.beats,time);
  $('mood-label').textContent=actors.map(a=>a.label+' · '+a.tag).join(' / ')||'静音';
  $('peak-label').textContent=(bar?.label||'')+' · 第 '+Math.max(0,beat+1)+' 拍 · '+actors.length+' 个声部';
  if(state.playing)updateTimeline();return;
 }
 // Size is independent of peak spacing; overlapping motifs are allowed.
 const radius=68*settings.size/2.6;let visible=0;
 for(const event of renderEventsAt(eventTime)){
  const alpha=ready?displayOpacityAt(event,eventTime):0;if(alpha<=.005)continue;
  const motif=state.prediction?event.motif:state.demo?demoScene(state.seed,Math.floor(event.beat/16)).motif:null;
  if(!motif)continue;visible++;
  const position=positionAt(event,eventTime,settings.hoverStrength,settings.positionGamma);
  paintMotif(context,motif,position.x*width,position.y*height,radius*beatPulseScale(event,model.beats,time),alpha);
 }
 const beat=beatIndexAt(model.beats,time),bar=state.prediction?intervalAt(state.prediction.bars,time):null;
 const row=state.prediction?intervalAt(state.prediction.segments,time):null;
 const top=row?Object.entries(row.tag_scores).sort((a,b)=>b[1]-a[1]).slice(0,2):[];
 const mood=state.prediction?(top.length?top.map(([tag,score])=>tag+' '+score.toFixed(2)).join(' / '):'本段预测缺失'):state.demo?demoScene(state.seed,Math.floor(Math.max(0,beat)/16)).motif.name:'等待情绪预测';
 const key=beat+':'+visible+':'+mood+':'+bar?.id;
 if(lastHud!==key){$('mood-label').textContent=mood+(state.demo?' · 示例':'');$('peak-label').textContent=(bar?bar.label+' · ':'')+(beat>=0?'第 '+(beat+1)+' 拍':'等待节拍')+' · '+visible+' 个图形';lastHud=key}
 if(state.playing)updateTimeline();
}
function frame(){
 if(state.playing&&state.sourceEnded&&currentTime()>=state.buffer.duration-1e-6){
  state.offset=state.buffer.duration;state.playing=false;state.wantPlaying=false;state.tailStartedAt=performance.now();stopSource();updatePlayButton();updateTimeline();
 }
 draw();requestAnimationFrame(frame);
}requestAnimationFrame(frame);
window.spectra={get status(){const time=currentTime(),eventTime=visualTime(),ready=playbackHasStarted(state,performance.now());return{playing:state.playing,time,visualTime:eventTime,tailClearAt:state.tailClearAt,barCount:state.model?.count||0,beatMode:state.beatMode,mode:state.stemPrediction?'stems':'mix',stemActors:ready?stemActors():[],
 beats:state.model?.beats.slice(),prediction:state.prediction?{unit:state.prediction.prediction_unit,bars:state.prediction.bars,whole_song_color:state.prediction.whole_song_color}:null,settings:{...settings},visible:renderEventsAt(eventTime).filter(e=>ready&&displayOpacityAt(e,eventTime)>.005).map(e=>({id:e.id,motif:e.motif?.id,predictionBar:e.predictionBar,birthBar:e.bar,bar:bindingAt(e,eventTime).bar,binding:bindingAt(e,eventTime),born:e.born,end:e.end,baseline:e.baseline,cycles:e.cycles.map(c=>({...c})),position:positionAt(e,eventTime,settings.hoverStrength,settings.positionGamma),alpha:displayOpacityAt(e,eventTime)}))||[],eventCount:state.model?.events.length||0}}};
