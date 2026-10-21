import {predictedBackground} from '../prediction.js?v=stems-r33';
export const STEMS=['bass','drums','other','vocals','guitar','piano'];
export const LABELS={bass:'贝斯',drums:'鼓',other:'其他伴奏',vocals:'人声',guitar:'吉他',piano:'钢琴'};
export const TAG_HUES={calm:180,romantic:310,dream:270,sad:240,epic:40,happy:60,love:330,nature:110,energetic:10};
export const TAGS=Object.keys(TAG_HUES);
export const STAGES=[['meter','1. 原曲节拍 / 小节'],['separation','2. SW 六声部分离'],['features','3. 特征 / 预测窗口'],['emotion','4. 声部 / 动态背景情绪'],['mapping','5. 颜色 / 坐标映射']];
export const PREREQUISITES={meter:[],separation:['meter'],features:['meter','separation'],emotion:['features'],mapping:['emotion']};
export const STATUS={pending:'未运行',ready:'已完成',partial:'部分完成',stale:'参数已变 / 需重跑',running:'运行中 / 若中断可重跑',error:'出错'};
export const fmt=(n,d=3)=>Number.isFinite(n)?n.toFixed(d):'—';
export function timeLabel(t){t=Math.max(0,t||0);const ms=Math.round(t*1000);return String(Math.floor(ms/60000)).padStart(2,'0')+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0')}
export function rowAt(rows,t){let lo=0,hi=rows.length;while(lo<hi){const m=(lo+hi)>>1;if((rows[m].start_seconds??rows[m].start)<=t)lo=m+1;else hi=m}return Math.max(0,Math.min(rows.length-1,lo-1))}
export function windowBounds(row,duration){if(!row)return[0,duration];const a=row.prediction_start_seconds??row.start??row.start_seconds,b=row.prediction_end_seconds??row.end??row.end_seconds;const pad=Math.max(.3,(b-a)*.1);return[Math.max(0,a-pad),Math.min(duration,b+pad)]}
export function stageEnabled(stage,manifest,busy,dirty){return !!manifest&&!busy&&!dirty&&PREREQUISITES[stage].every(k=>['ready','partial'].includes(manifest.stages[k].status))}
export function changedParameters(saved,draft){return Object.fromEntries(Object.entries(draft).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(saved[k])))}
export function selectedRange(start,end,count){start=Number(start);end=Number(end);if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>count)throw Error('请输入有效的片段序号范围。');return{bar_start:start,bar_end:end}}
export function scoreRows(scores,gamma=2){const list=TAGS.map(tag=>({tag,score:scores?.[tag]??null,hue:TAG_HUES[tag]}));const sum=list.reduce((n,r)=>n+(Number.isFinite(r.score)?r.score**gamma:0),0);return list.map(r=>({...r,weight:Number.isFinite(r.score)&&sum>0?r.score**gamma/sum:0}))}
export function labBackgroundAt(bundle,time){
 const background=bundle?.background,rows=background?.segments||[],index=rowAt(rows,time),row=rows[index];
 if(row?.status==='ok'&&row.rgb&&time>=row.start_seconds){return{rgb:predictedBackground(background,time),source:'bar',segment:row.segment}}
 for(let i=index;i>=0;i--){const r=rows[i];if(r?.status==='ok'&&r.rgb&&r.start_seconds<=time)return{rgb:r.rgb,source:'held',segment:r.segment}}
 return{rgb:bundle?.whole_song_color?.rgb||[0,0,0],source:bundle?.whole_song_color?.rgb?'whole_song':'unavailable',segment:null};
}

export const PRESENTATION_DEFAULTS={size_percent:100,pitch_mode:'beat_summary',overlap_preview:true,guides:true,clicks:true,follow:true,video_resolution:1080,video_fps:30};
