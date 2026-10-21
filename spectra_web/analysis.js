import {clamp,estimateTempo} from './core.js?v=stems-r33';

export const FFT_SIZE=2048,RAW_BINS=300;
export function makeFFT(size=FFT_SIZE){
  const bits=Math.log2(size),reverse=new Uint16Array(size),cos=new Float64Array(size/2),sin=new Float64Array(size/2);
  for(let i=0;i<size;i++){let n=i,r=0;for(let b=0;b<bits;b++){r=r*2+(n&1);n>>=1}reverse[i]=r}
  for(let i=0;i<size/2;i++){cos[i]=Math.cos(-2*Math.PI*i/size);sin[i]=Math.sin(-2*Math.PI*i/size)}
  return (real,imag)=>{
    for(let i=0;i<size;i++){const j=reverse[i];if(j>i){let a=real[i];real[i]=real[j];real[j]=a;a=imag[i];imag[i]=imag[j];imag[j]=a}}
    for(let length=2;length<=size;length*=2){const half=length/2,stride=size/length;
      for(let base=0;base<size;base+=length)for(let j=0;j<half;j++){
        const a=base+j,b=a+half,c=cos[j*stride],s=sin[j*stride];
        const re=real[b]*c-imag[b]*s,im=real[b]*s+imag[b]*c;
        real[b]=real[a]-re;imag[b]=imag[a]-im;real[a]+=re;imag[a]+=im;
      }
    }
  };
}

export async function analyzePCM(pcm,sampleRate,onProgress=()=>{}){
  const hop=Math.max(1,Math.round(sampleRate/100)),frameStep=hop/sampleRate;
  const frames=Math.floor(pcm.length/hop)+1,duration=pcm.length/sampleRate;
  const raw=new Uint8Array(frames*RAW_BINS),energy=new Float32Array(frames),rms=new Float32Array(frames);
  const real=new Float64Array(FFT_SIZE),imag=new Float64Array(FFT_SIZE),window=new Float64Array(FFT_SIZE),fft=makeFFT();
  for(let i=0;i<FFT_SIZE;i++)window[i]=.42-.5*Math.cos(2*Math.PI*i/FFT_SIZE)+.08*Math.cos(4*Math.PI*i/FFT_SIZE);
  for(let frame=0;frame<frames;frame++){
    const center=frame*hop,start=center-FFT_SIZE/2;let power=0;
    for(let i=0;i<FFT_SIZE;i++){const sample=pcm[start+i]||0;real[i]=sample*window[i];imag[i]=0;power+=sample*sample}
    rms[frame]=Math.sqrt(power/FFT_SIZE);energy[frame]=Math.log1p(200*rms[frame]);fft(real,imag);
    for(let bin=0;bin<RAW_BINS;bin++){
      const magnitude=Math.hypot(real[bin],imag[bin])/FFT_SIZE;
      // Fixed dB scale, with headroom for attacks. Never normalize each frame to its loudest bin.
      raw[frame*RAW_BINS+bin]=Math.round(clamp((20*Math.log10(magnitude+1e-12)+90)/80,0,1)*255);
    }
    if(frame%250===249){onProgress((frame+1)/frames);await new Promise(resolve=>setTimeout(resolve,0))}
  }
  const estimate=estimateTempo(energy.subarray(0,Math.min(frames,Math.round(150/frameStep))),1/frameStep);
  return{raw,rms,frames,frameStep,duration,estimate};
}

export function makeBeatGrid(duration,bpm=120,offset=0){
  const step=60/clamp(bpm,30,300),beats=[];
  for(let t=offset;t<duration;t+=step)if(t>=0)beats.push(t);
  return beats;
}
export function parseBeatTimes(value,duration){
  const source=Array.isArray(value)?value:(value?.beats??value?.beat_times??value?.timestamps);
  if(!Array.isArray(source)||!source.length)throw new Error('节拍 JSON 需要秒数数组，例如 [0.25, 0.75, 1.25]。');
  const times=source.map(v=>typeof v==='object'&&v!==null?v.time:v);
  if(times.some(t=>typeof t!=='number'||!Number.isFinite(t)||t<0))throw new Error('每个节拍时间必须是非负秒数。');
  const beats=[...new Set(times)].filter(t=>t<duration).sort((a,b)=>a-b);
  if(!beats.length)throw new Error('节拍时间都超出了这首音乐的时长。');
  return beats;
}
export function smoothBars(analysis,count,smoothing=.04){
  const {raw,frames,frameStep}=analysis,levels=new Float32Array(frames*count),previous=new Float64Array(count);
  for(let frame=0;frame<frames;frame++)for(let j=0;j<count;j++){
    const value=raw[frame*RAW_BINS+Math.floor(j*RAW_BINS/count)]/255;
    const tau=clamp(smoothing,.01,.15)*(value>previous[j]?1:1.5);
    previous[j]+=(value-previous[j])*(1-Math.exp(-frameStep/tau));levels[frame*count+j]=previous[j];
  }
  return levels;
}
