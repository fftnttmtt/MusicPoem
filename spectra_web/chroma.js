import {clamp,lerp} from './core.js?v=stems-r33';

// Sampling and bar geometry are taken directly from the uploaded CHROMA drawArt.
export const chromaBarCount=width=>Math.min(100,Math.max(24,Math.floor(width*.78/7)));
export function sampleChromaSpectrum(bytes,count){
  return Float32Array.from({length:count},(_,i)=>(bytes[Math.floor(i*300/count)]||0)/255);
}
export function createChromaPlot(width,height,count=chromaBarCount(width)){
  const gap=width<500?2:4,bw=Math.max(1,(width*.78-(count-1)*gap)/count),left=width*.11;
  const barHeight=level=>Math.max(2,clamp(level,0,1)*height*.58);
  return{width,height,count,gap,bw,left,center:height*.5,
    x:i=>left+i*(bw+gap)+bw/2,
    top:level=>height*.5-barHeight(level)/2,
    barHeight};
}
export function paintChromaBars(ctx,plot,levels,color){
  ctx.save();ctx.fillStyle=`rgb(${color.join(',')})`;
  for(let i=0;i<plot.count;i++){
    const level=levels[i]||0;
    ctx.fillRect(plot.left+i*(plot.bw+plot.gap),plot.top(level),plot.bw,plot.barHeight(level));
  }
  ctx.restore();
}

// A flat summit is one peak, located at the middle of its bars.
export function findSpectrumPeaks(levels){
  const peaks=[];
  for(let start=0;start<levels.length;){
    const level=levels[start];let end=start;
    while(end+1<levels.length&&levels[end+1]===level)end++;
    if(level>0&&level>(levels[start-1]??-Infinity)&&level>(levels[end+1]??-Infinity)){
      peaks.push({bar:(start+end)/2,level});
    }
    start=end+1;
  }
  return peaks;
}

