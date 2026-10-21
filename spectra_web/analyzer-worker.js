import {analyzePCM,makeBeatGrid,smoothBars} from './analysis.js?v=stems-r33';
import {buildEvents} from './beat-events.js?v=stems-r33';
let analysis=null;
self.onmessage=async({data})=>{
  const {id,type,settings,customBeats}=data;
  try{
    if(type==='analyze')analysis=await analyzePCM(data.pcm,data.sampleRate,progress=>self.postMessage({type:'progress',progress}));
    if(!analysis)throw new Error('尚未分析音频。');
    const bpm=settings.manualTempo?settings.bpm:analysis.estimate.bpm;
    const offset=settings.manualTempo?settings.beatOffset:analysis.estimate.offset;
    const beats=customBeats??makeBeatGrid(analysis.duration,bpm,offset);
    const levels=smoothBars(analysis,settings.count,settings.smoothing);
    const events=settings.stemMode?[]:buildEvents({...analysis,levels},beats,settings);
    self.postMessage({type:'model',id,model:{levels,events,beats,count:settings.count,frames:analysis.frames,
      frameStep:analysis.frameStep,duration:analysis.duration,estimate:analysis.estimate,bpm,offset,
      viewport:{width:settings.width??1200,height:settings.height??800}}},[levels.buffer,...events.map(event=>event.motion.buffer)]);
  }catch(error){self.postMessage({type:'error',id,message:error.message||'音频分析失败。'})}
};
