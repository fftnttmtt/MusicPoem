export function exportFrameCount(duration,fps){return Math.ceil((duration+.55)*fps)}
export function exportFrameTime(index,fps,duration){const visualTime=index/fps;return{time:Math.min(duration,visualTime),visualTime}}
const png=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('无法生成视频帧。')),'image/png'));
const abortError=()=>new DOMException('导出已取消。','AbortError');
function delay(ms,signal){return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(abortError());return}
 const stop=()=>{clearTimeout(timer);reject(abortError())},timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve()},ms);
 signal?.addEventListener('abort',stop,{once:true});
})}
async function request(url,options={},label='视频请求',retry=false){
 const attempts=retry?4:1;
 for(let n=0;n<attempts;n++){
  if(options.signal?.aborted)throw abortError();
  const controller=new AbortController(),abort=()=>controller.abort();
  options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,60000);
  try{
   const r=await fetch(url,{cache:'no-store',...options,signal:controller.signal,headers:{'X-Spectra-Client':'1',...options.headers}});
   const data=await r.json();
   if(!r.ok){const error=Error(label+'：'+(data.error||'视频服务返回错误。'));error.serverResponse=true;throw error}
   return data;
  }catch(error){
   if(options.signal?.aborted)throw abortError();
   if(error.serverResponse)throw error;
   if(n===attempts-1)throw Error(label+'：本机视频服务连接中断或响应超时'+(retry?'，自动重试3次仍未恢复':'')+'。请查看 start_lab.bat 的启动窗口是否仍在运行。原始错误：'+error.message);
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort)}
  await delay([250,750,1500][n],options.signal);
 }
}
export async function exportOfflineVideo({runId,bundle,scene,referenceWidth,referenceHeight,width,height,fps,audioStem,paint,onProgress,signal,createCanvas=()=>document.createElement('canvas')}){
 let session=null,stage='创建视频导出任务';const root='/api/lab/videos/';
 const onExit=()=>{if(session)fetch(root+session.id+'/cancel',{method:'POST',headers:{'X-Spectra-Client':'1'},keepalive:true}).catch(()=>{})};
 globalThis.addEventListener?.('pagehide',onExit);
 try{
  if(signal?.aborted)throw new DOMException('导出已取消。','AbortError');
  const duration=bundle.audio.duration_seconds,frames=exportFrameCount(duration,fps);
  // Client-generated identity makes even a lost creation reply safe to retry.
  const exportId=globalThis.crypto?.randomUUID?.().replaceAll('-','')||Array.from({length:32},()=>Math.floor(Math.random()*16).toString(16)).join('');
  session={id:exportId};
  session=await request('/api/lab/runs/'+runId+'/video',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({export_id:exportId,width,height,fps,audio_stem:audioStem,scene,reference_width:referenceWidth,reference_height:referenceHeight})},stage,true);
  if(session.frames!==frames)throw Error('音频时长已变化，请重新加载实验。');
  const canvas=createCanvas();canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw Error('浏览器无法创建导出画布。');
  // Render in the preview's logical coordinates, at the output resolution.
  ctx.setTransform(width/referenceWidth,0,0,height/referenceHeight,0,0);ctx.font='10px Consolas,monospace';
  for(let i=0;i<frames;i++){
   if(signal?.aborted)throw new DOMException('导出已取消。','AbortError');
   stage=`渲染第 ${i+1}/${frames} 帧（${(i/fps).toFixed(2)} 秒）`;
   const at=exportFrameTime(i,fps,duration);paint(ctx,bundle,at.time,at.visualTime,scene,referenceWidth,referenceHeight);
   const body=await png(canvas);
   stage=`上传第 ${i+1}/${frames} 帧（${(i/fps).toFixed(2)} 秒）`;
   const ack=await request(root+session.id+'/frame?index='+i,{method:'POST',headers:{'Content-Type':'image/png'},body,signal},stage,true);
   if(ack.received!==i+1)throw Error('编码服务返回的帧序号不一致。');
   onProgress?.({phase:'frames',completed:i+1,total:frames,fraction:(i+1)/frames*.98});
  }
  if(signal?.aborted)throw new DOMException('导出已取消。','AbortError');
  onProgress?.({phase:'encoding',completed:frames,total:frames,fraction:.98});
  stage='封装 MP4';
  let status=await request(root+session.id+'/finish',{method:'POST',signal},stage,true);
  while(!status.url&&status.state!=='done'){
   if(status.error||status.state==='error')throw Error(status.error||'视频编码失败。');
   await delay(300,signal);
   status=await request(root+session.id+'/status',{method:'POST',signal},'读取视频编码进度',true);
  }
  const result=status.result||status;session=null;
  onProgress?.({phase:'done',completed:frames,total:frames,fraction:1});return result;
 }catch(error){
  if(error.name==='AbortError')throw error;
  throw Error(stage+'失败。'+error.message+(session?'；诊断文件：本曲实验目录 videos/'+session.id+'.log 和 .settings.json。':''));
 }finally{
  globalThis.removeEventListener?.('pagehide',onExit);
  if(session)await request(root+session.id+'/cancel'+(signal?.aborted?'':'?preserve=1'),{method:'POST'},'停止视频编码',true).catch(()=>{});
 }
}
