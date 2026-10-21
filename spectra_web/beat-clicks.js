// Clicks share the exact AudioBufferSource time mapping used by the music.
// This is a diagnostic overlay, not another beat estimator.
export function scheduleBeatClicks(audio,destination,beats,startedAt,offset,duration){
 const length=Math.max(1,Math.ceil(audio.sampleRate*.025)),buffer=audio.createBuffer(1,length,audio.sampleRate);
 const samples=buffer.getChannelData(0);
 for(let i=0;i<length;i++){
  const t=i/audio.sampleRate;
  samples[i]=.18*Math.sin(2*Math.PI*1600*t)*Math.exp(-t*180);
 }
 const sources=new Set(),now=audio.currentTime;
 for(const beat of beats){
  const when=startedAt+beat-offset;
  if(beat<offset||beat>=duration||when<now)continue;
  const source=audio.createBufferSource();source.buffer=buffer;source.connect(destination);sources.add(source);
  source.onended=()=>{sources.delete(source);source.disconnect()};
  source.start(when);
 }
 return {stop(){for(const source of sources){source.onended=null;try{source.stop()}catch{}source.disconnect()}sources.clear()}};
}
