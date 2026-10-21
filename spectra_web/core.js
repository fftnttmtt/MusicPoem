export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const lerp=(a,b,t)=>a+(b-a)*t;
export const smoothstep=t=>{t=clamp(t,0,1);return t*t*(3-2*t)};

// Onset-envelope autocorrelation estimates a regular beat grid, not a time signature.
export function estimateTempo(energy,rate=100){
  if(energy.length<rate*3)return {bpm:120,offset:0,confidence:0};
  const onset=new Float32Array(energy.length);
  let mean=0;
  for(let i=1;i<energy.length;i++){
    const previous=(energy[Math.max(0,i-1)]+energy[Math.max(0,i-2)])/2;
    onset[i]=Math.max(0,energy[i]-previous);mean+=onset[i];
  }
  mean/=onset.length;
  if(mean<1e-8)return {bpm:120,offset:0,confidence:0};
  const minLag=Math.floor(rate*60/180),maxLag=Math.ceil(rate*60/60);
  const correlations=[];
  for(let lag=minLag;lag<=maxLag;lag++){
    let xy=0,xx=0,yy=0;
    for(let i=lag;i<onset.length;i++){
      const a=onset[i]-mean,b=onset[i-lag]-mean;xy+=a*b;xx+=a*a;yy+=b*b;
    }
    correlations.push({lag,corr:xy/Math.sqrt(xx*yy||1)});
  }
  const candidates=correlations.filter((p,i)=>p.corr>=(correlations[i-1]?.corr??-1)&&p.corr>=(correlations[i+1]?.corr??-1));
  candidates.sort((a,b)=>(b.corr-.1*Math.abs(Math.log2(60*rate/b.lag/120)))-(a.corr-.1*Math.abs(Math.log2(60*rate/a.lag/120))));
  const best=candidates[0]||{lag:rate/2,corr:0};
  let phase=0,bestValue=-1;
  for(let i=0;i<best.lag;i++){
    let sum=0;
    for(let j=i;j<onset.length;j+=best.lag)sum+=onset[j]+.5*(onset[j-1]||0)+.5*(onset[j+1]||0);
    if(sum>bestValue){bestValue=sum;phase=i}
  }
  return {bpm:60*rate/best.lag,offset:phase/rate,confidence:clamp(best.corr,0,1)};
}

export async function analyzeRhythm(buffer,onProgress=()=>{}){
  const sr=buffer.sampleRate,step=Math.max(1,Math.floor(sr/100));
  const channels=Array.from({length:Math.min(2,buffer.numberOfChannels)},(_,i)=>buffer.getChannelData(i));
  const energy=new Float32Array(Math.ceil(buffer.length/step));
  // At most the first 150 s are needed for a global tempo estimate.
  const count=Math.min(energy.length,15000);let previous=0;
  for(let k=0;k<count;k++){
    let power=0;const end=Math.min(buffer.length,(k+1)*step);
    for(let i=k*step;i<end;i+=2){
      let x=0;for(const channel of channels)x+=channel[i];x/=channels.length;
      const high=x-previous;previous=x;power+=x*x+.6*high*high;
    }
    energy[k]=Math.log1p(200*Math.sqrt(power/Math.max(1,(end-k*step)/2)));
    if(k%1500===1499){onProgress(k/count);await new Promise(resolve=>setTimeout(resolve,0))}
  }
  return estimateTempo(energy.subarray(0,count),sr/step);
}

export function hashString(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
export function randomGenerator(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
export const MOODS=[
  {name:'愉悦',sides:0,angle:0,kind:'curve',double:true},
  {name:'希望',sides:0,angle:0,kind:'curve',double:false},
  {name:'兴趣',sides:0,angle:0,kind:'curve',double:false},
  {name:'愤怒',sides:3,angle:Math.PI/2,kind:'sharp',double:true},
  {name:'不安',sides:3,angle:Math.PI/2,kind:'sharp',double:true},
  {name:'惊喜',sides:3,angle:-Math.PI/2,kind:'sharp',double:true},
  {name:'活跃',sides:4,angle:Math.PI/4,kind:'sharp',double:false}
];
const PALETTES=[
  [161,187,231],[221,162,142],[180,163,222],[157,204,183],
  [227,198,132],[187,203,224],[220,151,171],[140,194,207]
];
export function createScenes(seed,count=100){
  const rnd=randomGenerator(seed);let previous=-1;
  return Array.from({length:count},()=>{let m=Math.floor(rnd()*MOODS.length);if(m===previous)m=(m+1)%MOODS.length;previous=m;return{mood:MOODS[m],color:PALETTES[Math.floor(rnd()*PALETTES.length)]}});
}
export function sceneAt(scenes,time,bpm,offset=0){
  const beat=Math.max(0,(time-offset)*bpm/60),index=Math.floor(beat/32)%scenes.length;
  const current=scenes[index],previous=scenes[(index-1+scenes.length)%scenes.length];
  const progress=index===0&&beat<1?1:smoothstep((beat%32)/.75);
  return{current,previous,progress,beat};
}
export function shapeRadius(angle,mood){
  if(!mood.sides)return 1;
  const step=2*Math.PI/mood.sides;
  const q=((angle-mood.angle-Math.PI/mood.sides+step/2)%step+step)%step-step/2;
  return Math.cos(Math.PI/mood.sides)/Math.cos(q);
}
