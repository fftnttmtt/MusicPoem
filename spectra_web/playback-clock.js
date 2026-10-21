// AudioContext.currentTime is the render clock, ahead of audible output.
// getOutputTimestamp maps the actual output clock onto performance.now().
export function audibleContextTime(audio,nowMs){
 const renderTime=audio.currentTime;
 if(typeof audio.getOutputTimestamp==='function'){
  const stamp=audio.getOutputTimestamp();
  if(Number.isFinite(stamp?.contextTime)&&stamp.contextTime>0&&Number.isFinite(stamp.performanceTime)&&
     stamp.performanceTime>0&&nowMs>=stamp.performanceTime&&nowMs-stamp.performanceTime<1000){
   return Math.min(renderTime,stamp.contextTime+(nowMs-stamp.performanceTime)/1000);
  }
 }
 // baseLatency and outputLatency describe separate stages. This fallback is
 // used only when no valid timestamp is available; never subtract them twice.
 const latency=[audio.baseLatency,audio.outputLatency].reduce((sum,n)=>sum+(Number.isFinite(n)&&n>0?n:0),0);
 return renderTime-latency;
}

export function playbackTime(state,nowMs){
 const duration=state.buffer?.duration||0;
 if(!state.playing)return Math.max(0,Math.min(duration,state.offset));
 // During startup/resume the output may still contain the previous silence.
 // Freeze at the requested offset until the newly scheduled audio is audible.
 const elapsed=Math.max(0,audibleContextTime(state.audio,nowMs)-state.startedAt);
 return Math.max(0,Math.min(duration,state.offset+elapsed));
}

export function playbackHasStarted(state,nowMs){
 if(state.wantPlaying&&!state.playing)return false;
 return !state.playing||audibleContextTime(state.audio,nowMs)>=state.startedAt;
}
