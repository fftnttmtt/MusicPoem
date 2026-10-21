import {beatIndexAt} from './beat-events.js?v=stems-r33';

// All channels are measured separately, so opposite stereo phases cannot
// cancel into false silence. The cached 20 ms envelope is independent of FFT.
export function measureLoudness(buffer){
 const step=Math.max(1,Math.round(buffer.sampleRate*.02)),rms=new Float32Array(Math.ceil(buffer.length/step));
 for(let channel=0;channel<buffer.numberOfChannels;channel++){
  const samples=buffer.getChannelData(channel);
  for(let frame=0;frame<rms.length;frame++){
   const start=frame*step,end=Math.min(start+step,samples.length);let power=0;
   for(let i=start;i<end;i++)power+=samples[i]*samples[i];
   rms[frame]=Math.max(rms[frame],Math.sqrt(power/(end-start)));
  }
 }
 return{rms,frameStep:step/buffer.sampleRate,duration:buffer.duration};
}
export function tailClearTime(envelope,thresholdDb=-50){
 if(!envelope)return Infinity;
 const threshold=10**(thresholdDb/20);let last=envelope.rms.length-1;
 while(last>=0&&envelope.rms[last]<threshold)last--;
 if(last<0)return 0;
 const clearAt=(last+1)*envelope.frameStep+.15;
 // Only a confirmed quiet suffix counts. Mid-song rests never clear actors.
 return clearAt<=envelope.duration?clearAt:Infinity;
}
export function beatPulseScale(event,beats,time){
 if(time<event.born||time>=event.end||beats.length<2)return 1;
 const birth=beatIndexAt(beats,event.born+1e-6),next=birth+1,index=beatIndexAt(beats,time);
 if(next>=beats.length||event.end<=beats[next]||index<next)return 1;
 const beatLength=index+1<beats.length?beats[index+1]-beats[index]:beats[index]-beats[index-1];
 const phase=(time-beats[index])/Math.min(.22,beatLength*.45);
 // One gentle expansion/release starts on the original beat, never before it.
 return phase>=0&&phase<1?1+.05*Math.sin(Math.PI*phase)**2:1;
}
