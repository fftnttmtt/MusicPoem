import {volumeRadiusGain} from './volume-release.js?v=r56';
import {clamp,smoothstep} from './core.js?v=stems-r33';
import {EMOTION_GROUPS,preparePrediction,intervalAt} from './prediction.js?v=stems-r33';
import {transitionColor} from './color-transition.js?v=stems-r33';
import {emotionShapeAt} from './emotion-shape.js?v=r56';

import {samplePitch,validatePitch} from './pitch-player.js?v=r56';

import {footeProgress,footeProgressRate,footeLevelAt,prepareFooteCurve} from './foote-motion.js?v=r56';
import {brakeMotion,positionSlopes,samplePositionCurve} from './c1-motion.js?v=r56';

export const STEM_IDS=['bass','drums','other','vocals','guitar','piano'];
const finite=Number.isFinite;
const fail=message=>{throw new Error(message)};
export function prepareStemPrediction(value,duration,sha256=null){
 if(value?.schema!=='spectra-stems-v1')fail('请选择六声部模式导出的预测 JSON。');
 if(!finite(value.audio?.duration_seconds)||Math.abs(value.audio.duration_seconds-duration)>.25)fail('六声部结果与当前音乐时长不一致。');
 if(sha256&&value.audio.sha256&&sha256!==value.audio.sha256)fail('六声部结果属于另一份音乐文件。');
 if(!Array.isArray(value.stems)||value.stems.length!==6||new Set(value.stems.map(t=>t.id)).size!==6||value.stems.some(t=>!STEM_IDS.includes(t.id)))fail('六声部结果必须包含六条不同的指定分轨。');
 if(!finite(value.volume?.reference_rms)||value.volume.reference_rms<0)fail('六声部音量标尺无效。');
 const stems=value.stems.map(track=>{
  const prepared=preparePrediction({...value,schema:'spectra-prediction-v1',segments:track.segments,transition:track.transition},duration,sha256);
  if(prepared.segments.length!==value.bars.length)fail('每条分轨必须与原曲小节一一对应。');
  prepared.segments.forEach((row,i)=>{
   const bar=value.bars[i];
   if(Math.abs(row.start_seconds-bar.start_seconds)>1e-5||Math.abs(row.end_seconds-bar.end_seconds)>1e-5)fail('分轨小节没有与原曲对齐。');
   if(row.status==='ok'&&(!finite(row.x_normalized)||row.x_normalized<0||row.x_normalized>1||!finite(row.arousal)))fail('分轨唤醒度坐标无效。');
  });
  const motion=track.motion,n=motion?.times?.length;
  if(!n||['rms','centroid_hz','centroid_normalized'].some(k=>!Array.isArray(motion[k])||motion[k].length!==n||motion[k].some(x=>!finite(x)||x<0))||motion.centroid_normalized.some(x=>x>1)||motion.times.some((t,i)=>!finite(t)||t<0||t>duration+.02||(i&&t<=motion.times[i-1])))fail('分轨实时音量或频谱质心数据无效。');
  if(track.beat_motion){
   const rows=track.beat_motion.rows;
   if(!Array.isArray(rows)||!rows.length||rows.some((r,i)=>!finite(r.start_seconds)||!finite(r.end_seconds)||r.end_seconds<=r.start_seconds||Math.abs(r.start_seconds-(i?rows[i-1].end_seconds:0))>1e-5||!['ok','silent'].includes(r.status)||['from_normalized','target_normalized'].some(k=>!finite(r[k])||r[k]<0||r[k]>1)||['from_centroid_hz','target_centroid_hz'].some(k=>r[k]!==null&&(!finite(r[k])||r[k]<0))||(r.status==='ok'&&(!finite(r.centroid_hz)||r.centroid_hz<0)))||Math.abs(rows.at(-1).end_seconds-duration)>1e-5)fail('分轨拍均质心时间轴或坐标无效。');
  }
  if(track.motion_foote&&!prepareFooteCurve(track.motion_foote))fail('Foote运动曲线无效。');
  if(track.pitch)validatePitch(track.pitch,duration);
  if(track.beat_volume){
   const rows=track.beat_volume.rows;
   if(!Array.isArray(rows)||!rows.length||rows.some((r,i)=>!finite(r.start_seconds)||!finite(r.end_seconds)||r.end_seconds<=r.start_seconds||Math.abs(r.start_seconds-(i?rows[i-1].end_seconds:0))>1e-5||['mean_rms','from_rms','target_rms'].some(k=>!finite(r[k])||r[k]<0))||Math.abs(rows.at(-1).end_seconds-duration)>1e-5)fail('分轨拍均音量时间轴或数值无效。');
  }
  return{...track,segments:prepared.segments,transition:prepared.transition};
 });
 return{...value,stems,beats:[...value.beats]};
}
const positionCache=new WeakMap();
export function sampleMotion(motion,time){
 const times=motion.times;let lo=0,hi=times.length;
 while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<=time)lo=mid+1;else hi=mid}
 const a=Math.max(0,lo-1),b=Math.min(lo,times.length-1),u=a===b?0:clamp((time-times[a])/(times[b]-times[a]),0,1);
 const at=key=>motion[key][a]+(motion[key][b]-motion[key][a])*u;
 let stored=positionCache.get(motion);
 if(!stored||stored.times!==times||stored.values!==motion.centroid_normalized){stored={times,values:motion.centroid_normalized,slopes:positionSlopes(times,motion.centroid_normalized)};positionCache.set(motion,stored)}
 const y=samplePositionCurve(times,stored.values,stored.slopes,time);
 return{rms:at('rms'),centroid:at('centroid_hz'),y:y.value,velocityY:y.velocity};
}
export function barMotionAt(track,time,fraction=.25,foote=null){
 const row=intervalAt(track.segments,time);
 let index=row?track.segments.indexOf(row)-1:track.segments.length-1;
 while(index>=0&&(track.segments[index].start_seconds>time||track.segments[index].status!=='ok'||!finite(track.segments[index].x_normalized)))index--;
 const previous=track.segments[index];
 if(row?.status!=='ok'||!finite(row.x_normalized))return{value:previous?.x_normalized??.5,velocity:0};
 const amount=fraction>0?clamp(fraction,0,1):1,duration=(row.end_seconds-row.start_seconds)*amount;
 if(!duration||time>=row.start_seconds+duration||!previous)return{value:row.x_normalized,velocity:0};
 // Causal, seek-deterministic: the next position is never borrowed before its beat.
 const linear=clamp((time-row.start_seconds)/duration,0,1),u=foote?footeProgress(foote,row.start_seconds,row.start_seconds+duration,time):smoothstep(linear);
 const rate=foote?footeProgressRate(foote,row.start_seconds,row.start_seconds+duration,time):6*linear*(1-linear)/duration;
 return{value:previous.x_normalized+(row.x_normalized-previous.x_normalized)*u,velocity:(row.x_normalized-previous.x_normalized)*rate};
}
export function barPositionAt(track,time,fraction=.25,foote=null){return barMotionAt(track,time,fraction,foote).value}
export function sampleBeatCentroid(beatMotion,time,foote=null){
 const row=intervalAt(beatMotion?.rows||[],time);
 if(!row)return null;
 const u=foote?footeProgress(foote,row.start_seconds,row.end_seconds,time):smoothstep(clamp((time-row.start_seconds)/(row.end_seconds-row.start_seconds),0,1));
 const y=row.from_normalized+(row.target_normalized-row.from_normalized)*u;
 const centroid=finite(row.from_centroid_hz)&&finite(row.target_centroid_hz)?row.from_centroid_hz+(row.target_centroid_hz-row.from_centroid_hz)*u:null;
 const linear=clamp((time-row.start_seconds)/(row.end_seconds-row.start_seconds),0,1),rate=foote?footeProgressRate(foote,row.start_seconds,row.end_seconds,time):6*linear*(1-linear)/(row.end_seconds-row.start_seconds);
 return{y,velocityY:(row.target_normalized-row.from_normalized)*rate,centroid,mean:row.centroid_hz,beat:row.index,status:row.status};
}
export function sampleBeatVolume(beatVolume,time){
 const row=intervalAt(beatVolume?.rows||[],time);
 if(!row)return null;
 const u=smoothstep(clamp((time-row.start_seconds)/(row.end_seconds-row.start_seconds),0,1));
 return{rms:row.from_rms+(row.target_rms-row.from_rms)*u,mean:row.mean_rms,beat:row.index};
}
export function stemStatesAt(prediction,time,visualTime,settings,width,height,tailStart=Infinity){
 const releaseAt=Math.min(tailStart,prediction.audio.duration_seconds),releaseTime=Math.max(0,visualTime-releaseAt);
 const fallDuration=(settings.fadeOut??.18)*Math.sqrt(settings.mass??8);
 if(releaseTime>=fallDuration)return [];
 const at=Math.min(time,releaseAt),baseRadius=68*(settings.size??(settings.parametricShape?1:1.5))/2.6*(settings.sizeMultiplier??(settings.parametricShape?9:1));
 const padding=Math.min(Math.min(width,height)*.3,Math.max(30,baseRadius+32));
 const u=releaseTime/fallDuration,actors=[];
 const geometry={...prediction.defaults,...prediction.geometry?.parameters,...settings.geometry};
 for(const track of prediction.stems){
  const currentRow=intervalAt(track.segments,at);let row=currentRow,styleTime=at;
  // Invalid predictions get no new style. Retain only the preceding valid
  // style for its finite size release instead of removing a positive radius.
  if(row?.status!=='ok'||!row.rgb||row.x_normalized===null){
   let i=currentRow?track.segments.indexOf(currentRow)-1:track.segments.length-1;
   while(i>=0&&(track.segments[i].start_seconds>at||track.segments[i].status!=='ok'||!track.segments[i].rgb||track.segments[i].x_normalized===null))i--;
   row=track.segments[i];if(row?.status==='ok')styleTime=Math.max(row.start_seconds,row.end_seconds-1e-8);
  }
  if(row?.status!=='ok'||!row.rgb||row.x_normalized===null)continue;
  const useFoote=settings.footeMotion??geometry.foote_motion_enabled??prediction.movement?.foote_motion_enabled??false;
  const foote=useFoote&&prepareFooteCurve(track.motion_foote)?track.motion_foote:null;
  const frame=sampleMotion(track.motion,at);
  const beat=(settings.beatCentroid??!!track.beat_motion)?sampleBeatCentroid(track.beat_motion,at,foote):null;
  const pitch=track.id!=='drums'?samplePitch(track.pitch,at,settings.pitchMode??prediction.movement?.pitch_preview_mode??'beat_summary',foote):null;
  const volume=track.id!=='drums'&&(settings.beatVolume??!!track.beat_volume)?sampleBeatVolume(track.beat_volume,at):null;
  const rms=volume?.rms??frame.rms;
  const alpha=1-u;
  const radius=baseRadius*volumeRadiusGain(track,at+releaseTime,rms,prediction.volume.reference_rms,!!volume,sampleBeatVolume,sampleMotion,releaseAt)*(1-smoothstep(u));
  if(alpha<=0||radius<=0)continue;
  const tag=Object.entries(row.tag_scores).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const form=settings.parametricShape?emotionShapeAt(track,styleTime,geometry):null;
  const shape=EMOTION_GROUPS.find(g=>g.tags.includes(tag));if(!form&&!shape)continue;
  const rgb=transitionColor(track.transition,styleTime)?.rgb||row.rgb;
  const horizontal=barMotionAt(track,at,settings.motionFraction??prediction.movement?.fraction??0,foote);
  const xMotion=brakeMotion(horizontal.value,horizontal.velocity,releaseTime),position=xMotion.value;
  const x=padding+(width-2*padding)*position;
  const yMotion=brakeMotion(pitch?.y??beat?.y??frame.y,pitch?.velocityY??beat?.velocityY??frame.velocityY,releaseTime),yNormalized=yMotion.value;
  const y=height-padding-(height-2*padding)*yNormalized+.03*(settings.breath??1)*height*u*u;
  actors.push({id:track.id,label:track.label,tag,bar:row.segment,arousal:row.arousal,valence:row.valence,
   centroid_hz:beat?beat.centroid:frame.centroid,beat_mean_centroid_hz:beat?.mean??null,
   centroid_beat:beat?.beat??null,foote_motion:!!foote,foote_level:footeLevelAt(foote,at),y_source:pitch?'pitch':'centroid',pitch_midi:pitch?.midi??null,beat_pitch_midi:pitch?.beatMedian??null,pitch_confidence:pitch?.confidence??null,pitch_status:pitch?.status??null,pitch_mode:pitch?.mode??null,rms,realtime_rms:frame.rms,beat_mean_rms:volume?.mean??null,
   volume_mode:volume?'beat_average':'realtime',x,y,vx:(width-2*padding)*xMotion.velocity,vy:-(height-2*padding)*yMotion.velocity+.06*(settings.breath??1)*height*u/fallDuration,x_normalized_display:position,y_normalized_display:yNormalized,radius,alpha,rgb,
   form,motif:{...shape,body:'rgb('+rgb.join(',')+')'}});
 }
 return actors;
}
export async function requestStemPrediction(file,options,onProgress,signal){
 const query=new URLSearchParams({mode:'stems',unit:'bar',chunk_seconds:String(options.chunkSeconds||0),amp:options.useAmp===false?'0':'1'});
 if(options.weights)query.set('sw_weights',options.weights);
 const response=await fetch('/api/analyze?'+query,{method:'POST',body:file,signal,headers:{'Content-Type':'application/octet-stream','X-Spectra-Client':'1','X-Audio-Name':encodeURIComponent(file.name)}});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'无法提交六声部分析。');
 for(;;){
  signal?.throwIfAborted();
  const response=await fetch('/api/jobs/'+data.job_id,{signal,cache:'no-store'});
  if(!response.ok)throw new Error('六声部分析任务已失效。');
  const job=await response.json();if(job.status==='error')throw new Error(job.message);
  if(job.status==='done')return job.result;
  onProgress(job.message,job.progress);await new Promise(resolve=>setTimeout(resolve,700));
 }
}
