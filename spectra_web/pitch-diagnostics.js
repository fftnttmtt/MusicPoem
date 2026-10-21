import {samplePitch} from './pitch-player.js?v=r56';
const finite=Number.isFinite;
const notes=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
export function midiNote(midi){if(!finite(midi))return '—';const n=Math.round(midi);return notes[((n%12)+12)%12]+(Math.floor(n/12)-1)}
export function frameIndex(times,time){let lo=0,hi=times.length;while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<=time)lo=mid+1;else hi=mid}return lo-1}
export function diagnosticFrame(raw,pitch,index){
 const hz=raw?.f0_hz?.[index],midi=finite(hz)&&hz>0?69+12*Math.log2(hz/440):null;
 const probability=raw?.voiced_probability?.[index],rms=raw?.rms?.[index],voiced=raw?.voiced_flag?.[index]===true;
 const gate=10**((pitch?.gate_dbfs??-55)/20),threshold=pitch?.confidence_threshold??.6;
 const reason=!finite(rms)||rms<gate?'quiet':midi===null?'no_f0':!voiced?'unvoiced':!finite(probability)||probability<threshold?'low_probability':'accepted';
 return{index,time:raw?.times?.[index]??null,hz:midi===null?null:hz,midi,note:midiNote(midi),probability,rms,voiced,accepted:reason==='accepted',reason};
}
export const REASONS={quiet:'低于音量门限',no_f0:'算法未给出基频',unvoiced:'未检测到有效旋律/有声',low_probability:'低于所选算法置信值门限',accepted:'有效音高'};
export function pitchConfidenceLabel(pitch,raw){return (pitch?.method||raw?.method)==='melodia'?'Melodia 显著度置信值':'pYIN 有声概率'}
const cache=new WeakMap();
export function diagnosticSummary(raw,pitch){
 if(!raw?.times?.length)return null;
 const previous=cache.get(raw);if(previous?.pitch===pitch)return previous.value;
 const counts={quiet:0,no_f0:0,unvoiced:0,low_probability:0,accepted:0},octaves=[];let last=null,clipped=0;
 for(let i=0;i<raw.times.length;i++){
  const f=diagnosticFrame(raw,pitch,i);counts[f.reason]++;
  if(f.accepted){
   if(last&&f.time-last.time<=.15&&Math.abs(Math.abs(f.midi-last.midi)-12)<=1)octaves.push({time:f.time,from:last.midi,to:f.midi});
   last=f;
   if(finite(pitch?.midi_p5)&&finite(pitch?.midi_p95)&&(f.midi<pitch.midi_p5||f.midi>pitch.midi_p95))clipped++;
  }
 }
 const value={counts,octaves,clipped,total:raw.times.length,span:finite(pitch?.midi_p5)&&finite(pitch?.midi_p95)?pitch.midi_p95-pitch.midi_p5:null};
 cache.set(raw,{pitch,value});return value;
}
export function diagnosticAt(raw,pitch,time,mode='beat_summary',footeCurve=null){
 const index=frameIndex(raw?.times||[],time),frame=index>=0?diagnosticFrame(raw,pitch,index):null;
 return{frame,beat:samplePitch(pitch,time,'beat_summary',footeCurve),position:samplePitch(pitch,time,mode,footeCurve)};
}
const palette={grid:'#293342',text:'#96a6ba',raw:'#697889',accepted:'#96debf',beat:'#eac880',position:'#90bceb',probability:'#be9fe8',warning:'#ef9e86'};
function axis(ctx,left,right,top,bottom,low,high,step,label){
 ctx.font='10px Consolas,monospace';ctx.textAlign='right';
 for(let value=Math.ceil(low/step)*step;value<=high+1e-8;value+=step){
  const y=bottom-(value-low)/(high-low)*(bottom-top);ctx.strokeStyle=palette.grid;ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
  ctx.fillStyle=palette.text;ctx.fillText(label(value),left-7,y+3);
 }
 ctx.textAlign='left';
}
function curve(ctx,points,x,y,color,width=1.2,maxGap=Infinity){
 ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();let last=null;
 for(const p of points){if(!finite(p.value)){last=null;continue}const px=x(p.time),py=y(p.value);if(!last||p.time-last.time>maxGap)ctx.moveTo(px,py);else ctx.lineTo(px,py);last=p}ctx.stroke();
}
export function drawPitchDiagnostics(ctx,width,height,{raw,pitch,beats=[],time=0,start=0,end=1,mode='beat_summary',footeCurve=null,layers={}}){
 const left=68,right=width-12,top=28,midiBottom=height*.56,probTop=height*.65,probBottom=height*.77,posTop=height*.85,posBottom=height-27;
 ctx.clearRect(0,0,width,height);ctx.font='10px Consolas,monospace';
 if(!pitch||!raw?.times?.length){ctx.fillStyle=palette.text;ctx.fillText('暂无原始音高数据；鼓使用质心，其他声部在完成音高映射后可查看。',15,35);return{left,right,start,end}}
 const x=t=>left+(t-start)/(end-start)*(right-left),clip=(callback)=>{ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,posBottom-top);ctx.clip();callback();ctx.restore()};
 const first=Math.max(0,frameIndex(raw.times,start)),frames=[];
 for(let i=first;i<raw.times.length&&raw.times[i]<=end;i++)if(raw.times[i]>=start)frames.push(diagnosticFrame(raw,pitch,i));
 const beatRows=pitch.rows.filter(r=>r.start_seconds<end&&r.end_seconds>start),values=frames.map(f=>f.midi).filter(finite);
 for(const row of beatRows)if(finite(row.midi))values.push(row.midi);
 if(finite(pitch.midi_p5))values.push(pitch.midi_p5);if(finite(pitch.midi_p95))values.push(pitch.midi_p95);
 let low=values.length?Math.floor(values.reduce((a,b)=>Math.min(a,b),Infinity))-1:48,high=values.length?Math.ceil(values.reduce((a,b)=>Math.max(a,b),-Infinity))+1:84;
 if(high-low<12){const center=(high+low)/2;low=Math.floor(center-6);high=low+12}
 const confidenceMax=pitch.method==='melodia'?frames.reduce((high,f)=>finite(f.probability)?Math.max(high,f.probability):high,Math.max(1,pitch.confidence_threshold)):1;
 const ym=m=>midiBottom-(m-low)/(high-low)*(midiBottom-top),yp=p=>probBottom-p/confidenceMax*(probBottom-probTop),yy=p=>posBottom-p*(posBottom-posTop);
 axis(ctx,left,right,top,midiBottom,low,high,high-low>36?12:high-low>18?6:2,v=>midiNote(v)+' '+v);
 axis(ctx,left,right,probTop,probBottom,0,confidenceMax,confidenceMax/2,v=>v.toFixed(1));axis(ctx,left,right,posTop,posBottom,0,1,.5,v=>v.toFixed(1));
 ctx.fillStyle=palette.text;ctx.fillText('绝对 MIDI 音高（未归一化）',left,15);ctx.fillText(''+pitchConfidenceLabel(pitch,raw)+' · 门限 '+pitch.confidence_threshold.toFixed(2),left,probTop-8);ctx.fillText('最终纵坐标 0 → 1 · '+(mode==='continuous'?'连续跟随':'逐拍概括'),left,posTop-8);
 clip(()=>{
  for(const beat of beats)if(beat>=start&&beat<=end){ctx.strokeStyle='#46526155';ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(x(beat),top);ctx.lineTo(x(beat),posBottom);ctx.stroke()}
  const block=raw.settings?Math.max(1,Math.round(raw.settings.chunk_seconds*raw.settings.sample_rate/raw.settings.hop_length))*raw.settings.hop_length/raw.settings.sample_rate:null;
  if(block)for(let t=Math.ceil(start/block)*block;t<=end;t+=block)if(t>0){ctx.save();ctx.strokeStyle='#ef9e8655';ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(x(t),top);ctx.lineTo(x(t),midiBottom);ctx.stroke();ctx.restore();ctx.fillStyle=palette.warning;ctx.fillText('分块',x(t)+3,top+10)}
  if(layers.raw!==false){
   curve(ctx,frames.map(f=>({time:f.time,value:f.midi})),x,ym,palette.raw,1,.06);
   ctx.fillStyle=palette.raw;for(const f of frames)if(finite(f.midi))ctx.fillRect(x(f.time)-1,ym(f.midi)-1,2,2);
  }
  if(layers.accepted!==false){ctx.fillStyle=palette.accepted;for(const f of frames)if(f.accepted)ctx.fillRect(x(f.time)-1.5,ym(f.midi)-1.5,3,3)}
  if(layers.beat!==false)for(const row of beatRows)if(row.status==='ok'){
   ctx.strokeStyle=palette.beat;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x(Math.max(start,row.start_seconds)),ym(row.midi));ctx.lineTo(x(Math.min(end,row.end_seconds)),ym(row.midi));ctx.stroke();
  }
  for(const [name,value] of [['P5',pitch.midi_p5],['P95',pitch.midi_p95]])if(finite(value)){
   ctx.save();ctx.strokeStyle='#96debf77';ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(left,ym(value));ctx.lineTo(right,ym(value));ctx.stroke();ctx.restore();ctx.fillStyle=palette.accepted;ctx.fillText(name+' '+value.toFixed(1),right-58,ym(value)-4);
  }
  const jumps=diagnosticSummary(raw,pitch)?.octaves||[];
  ctx.fillStyle=palette.warning;for(const jump of jumps)if(jump.time>=start&&jump.time<=end){const px=x(jump.time),py=ym(jump.to);ctx.beginPath();ctx.moveTo(px,py-8);ctx.lineTo(px-4,py-14);ctx.lineTo(px+4,py-14);ctx.closePath();ctx.fill()}
  curve(ctx,frames.map(f=>({time:f.time,value:f.probability})),x,yp,palette.probability,1.2,.06);
  ctx.save();ctx.strokeStyle=palette.beat;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(left,yp(pitch.confidence_threshold));ctx.lineTo(right,yp(pitch.confidence_threshold));ctx.stroke();ctx.restore();
  if(layers.position!==false){
   const samples=[];for(let i=0;i<=Math.max(120,Math.min(1200,Math.round(right-left)));i++){const t=start+(end-start)*i/Math.max(120,Math.min(1200,Math.round(right-left))),p=samplePitch(pitch,t,mode,footeCurve);if(p)samples.push({time:t,value:p.y,midi:p.midi})}
   curve(ctx,samples,x,yy,palette.position,1.8);curve(ctx,samples.map(p=>({time:p.time,value:p.midi})),x,ym,palette.position,1.4);
  }
 });
 ctx.fillStyle=palette.text;for(let i=0;i<=5;i++){const t=start+(end-start)*i/5;ctx.fillText(t.toFixed(2)+'s',Math.min(right-42,x(t)),height-8)}
 if(time>=start&&time<=end){ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x(time),top);ctx.lineTo(x(time),posBottom);ctx.stroke()}
 return{left,right,start,end,midiLow:low,midiHigh:high};
}
