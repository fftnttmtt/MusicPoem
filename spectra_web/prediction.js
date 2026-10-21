import {hashString,randomGenerator} from './core.js?v=stems-r33';
import {findColorSegment,transitionColor,startAlignedTransition} from './color-transition.js?v=stems-r33';

// Group scores before rounding: calm/nature and romantic/love share a motif.
export const EMOTION_GROUPS=[
 {id:'calm',tags:['calm','nature'],name:'平静 / 自然',shape:'circle',body:'#008000',lines:'#0000ff',double:false},
 {id:'love',tags:['romantic','love'],name:'浪漫 / 爱',shape:'circle',body:'#ff0000',lines:'#ffc0cb',double:false},
 {id:'dream',tags:['dream'],name:'梦幻',shape:'circle',body:'#ffffff',lines:'#ffff00',double:false},
 {id:'sad',tags:['sad'],name:'悲伤',shape:'down',body:'#0000ff',lines:'#808080',double:false},
 {id:'epic',tags:['epic'],name:'史诗',shape:'up',body:'#ffff00',lines:'#0000ff',double:true},
 {id:'happy',tags:['happy'],name:'快乐',shape:'circle',body:'#ffff00',lines:'#ff9900',double:true},
 {id:'energetic',tags:['energetic'],name:'活力',shape:'circle',body:'#ff9900',lines:'#ffff00',double:false}
];
export const PREDICTION_TAGS=EMOTION_GROUPS.flatMap(g=>g.tags);
export const MOTIF_SCORE_GAMMA=2;
const finite=Number.isFinite;
const fail=message=>{throw new Error(message)};

export function preparePrediction(value,duration,sha256=null){
 if(value?.schema!=='spectra-prediction-v1')fail('请选择“导出 SPECTRA 预测 JSON”生成的文件；完整旧结果可先用本地程序转换。');
 if(!finite(value.audio?.duration_seconds)||Math.abs(value.audio.duration_seconds-duration)>.25)fail('预测结果与这首音乐的时长不一致，请选择对应结果。');
 if(sha256&&value.audio.sha256&&sha256!==value.audio.sha256)fail('预测结果属于另一份音频文件，请选择相同音乐的结果。');
 if(!Array.isArray(value.beats)||value.beats.some((t,i)=>!finite(t)||t<0||t>duration+.02||(i>0&&t<=value.beats[i-1])))fail('预测节拍时间无效。');
 const intervals=(rows,name)=>{
  if(!Array.isArray(rows)||!rows.length)fail('预测文件缺少'+name+'。');
  let end=-Infinity;
  for(const r of rows){
   if(!finite(r.start_seconds)||!finite(r.end_seconds)||r.start_seconds<0||r.end_seconds>duration+.25||r.end_seconds<=r.start_seconds||r.start_seconds<end-1e-6)fail(name+'的时间范围无效。');
   end=r.end_seconds;
  }
 };
 intervals(value.segments,'情绪片段');intervals(value.bars,'小节');
 const rows=value.segments.map(row=>{
  const scores={};
  for(const tag of PREDICTION_TAGS){const score=row.tag_scores?.[tag];if(finite(score)&&score>=0&&score<=1)scores[tag]=score}
  const validColor=row.status==='ok'&&/^#[0-9a-f]{6}$/i.test(row.hex)&&Array.isArray(row.rgb)&&row.rgb.length===3&&row.rgb.every(v=>finite(v)&&v>=0&&v<=255);
  return {...row,tag_scores:scores,hex:validColor?row.hex:null,rgb:validColor?row.rgb:null};
 });
 // Validate curves used by the renderer; malformed imported data never reaches rAF.
 const curve=value.transition;
 if(curve?.enabled){
  if(!['boundary_hold','boundary_start'].includes(curve.mode)||!Array.isArray(curve.runs))fail('预测文件的颜色过渡格式无效，请用当前版本重新导出。');
  for(const run of curve.runs){
   if(!Array.isArray(run.times)||!run.times.length||!Array.isArray(run.labs)||run.labs.length!==run.times.length||
      run.times.some((t,i)=>!finite(t)||(i&&t<=run.times[i-1]))||run.labs.some(l=>!Array.isArray(l)||l.length!==3||l.some(x=>!finite(x)))||
      !finite(run.start)||!finite(run.end)||run.end<run.start||!Array.isArray(run.events))fail('颜色过渡节点无效。');
   for(const e of run.events)if(![e.start_seconds,e.end_seconds,e.duration_seconds,e.boundary_seconds,e.receiving_duration_seconds,e.anchor_interval_seconds,e.requested_duration_seconds].every(finite)||e.duration_seconds<0||e.end_seconds<e.start_seconds||e.receiving_duration_seconds<=0||e.anchor_interval_seconds<=0||
      !Number.isInteger(e.from_index)||!Number.isInteger(e.to_index)||!run.labs[e.from_index]||!run.labs[e.to_index])fail('颜色过渡区间无效。');
  }
 }
 const transition=startAlignedTransition(curve);
 return {...value,defaults:{...value.defaults,transition_mode:transition?.mode,motif_score_gamma:MOTIF_SCORE_GAMMA},transition,segments:rows,beats:value.beats.filter(t=>t<duration),bars:value.bars.map((bar,index)=>{
  const tag_scores=Object.fromEntries(PREDICTION_TAGS.map(tag=>[tag,0]));let covered=0;
  // Beat-mode and forced splits are pooled only for motif allocation, using
  // original target overlap. Prediction context windows never shift ownership.
  for(const row of rows){
   const overlap=Math.min(row.end_seconds,bar.end_seconds)-Math.max(row.start_seconds,bar.start_seconds);
   if(overlap<=0||!Object.keys(row.tag_scores).length||row.prediction_status==='error')continue;
   for(const tag of PREDICTION_TAGS)tag_scores[tag]+=overlap*(row.tag_scores[tag]||0);
   covered+=overlap;
  }
  if(covered)for(const tag of PREDICTION_TAGS)tag_scores[tag]/=covered;
  return {...bar,index,tag_scores,hasPrediction:covered>0};
 })};
}

export function intervalAt(rows,time){return findColorSegment(rows,time,!!rows.length&&Math.abs(time-rows[rows.length-1].end_seconds)<1e-8)}
export function predictedBackground(prediction,time){
 const row=intervalAt(prediction.segments,time);
 if(!row?.rgb)return [0,0,0];
 return transitionColor(prediction.transition,time)?.rgb||row.rgb;
}

// Hamilton / largest remainder gives exact N counts, then seeded Fisher-Yates
// randomizes placement. The tie-break is random; it has no palette-order bias.
export function apportionMotifs(tagScores,count,seed){
 const random=randomGenerator(seed),weights=EMOTION_GROUPS.map(g=>g.tags.reduce((sum,t)=>{
  // Transform each tag before combining tags that share a shape.
  const x=tagScores[t];return sum+(finite(x)&&x>0&&x<=1?x**MOTIF_SCORE_GAMMA:0);
 },0));
 const total=weights.reduce((a,b)=>a+b,0);
 if(!total||!count)return [];
 const quotas=weights.map((w,index)=>{const exact=count*w/total;return{index,n:Math.floor(exact),remainder:exact-Math.floor(exact),tie:random()}});
 let left=count-quotas.reduce((sum,q)=>sum+q.n,0);
 const order=[...quotas].sort((a,b)=>b.remainder-a.remainder||a.tie-b.tie);
 for(let i=0;i<left;i++)order[i].n++;
 const motifs=quotas.flatMap(q=>Array(q.n).fill(EMOTION_GROUPS[q.index]));
 for(let i=motifs.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[motifs[i],motifs[j]]=[motifs[j],motifs[i]]}
 return motifs;
}

export function assignEventMotifs(events,prediction,seed){
 const groups=new Map();
 for(const event of events){
  delete event.motif;delete event.predictionBar;
  const bar=intervalAt(prediction.bars,event.born);
  if(!bar?.hasPrediction)continue;
  if(!groups.has(bar.index))groups.set(bar.index,[]);
  groups.get(bar.index).push(event);
 }
 for(const [index,items] of groups){
  // Stable across seeks, replays and unchanged rebuilds.
  items.sort((a,b)=>a.born-b.born||a.id-b.id);
  const bar=prediction.bars[index],motifs=apportionMotifs(bar.tag_scores,items.length,hashString(seed+':'+bar.start_seconds));
  items.forEach((event,i)=>{event.motif=motifs[i]||null;event.predictionBar=bar.id});
 }
 return events;
}

export async function requestPrediction(file,unit,onProgress,signal){
 const response=await fetch('/api/analyze?unit='+encodeURIComponent(unit),{
  method:'POST',body:file,signal,headers:{'Content-Type':'application/octet-stream','X-Spectra-Client':'1','X-Audio-Name':encodeURIComponent(file.name)}
 });
 const data=await response.json();
 if(!response.ok)throw new Error(data.error||'无法提交预测任务。');
 for(;;){
  signal?.throwIfAborted();
  const status=await fetch('/api/jobs/'+data.job_id,{signal,cache:'no-store'});
  if(!status.ok)throw new Error('预测任务已失效，请重新选择音乐。');
  const job=await status.json();
  if(job.status==='error')throw new Error(job.message);
  if(job.status==='done')return job.result;
  onProgress(job.message,job.progress);
  await new Promise(resolve=>setTimeout(resolve,700));
 }
}
