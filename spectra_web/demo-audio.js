import {randomGenerator} from './core.js?v=stems-r33';
export function makeDemoPCM(sampleRate=44100){
  const duration=16.5,pcm=new Float32Array(Math.round(sampleRate*duration)),random=randomGenerator(42);
  const beats=Array.from({length:32},(_,i)=>.25+i*.5);
  const add=(start,length,fn)=>{const from=Math.round(start*sampleRate),n=Math.round(length*sampleRate);
    for(let i=0;i<n&&from+i<pcm.length;i++)pcm[from+i]+=fn(i/sampleRate,i);
  };
  for(let beat=0;beat<beats.length;beat++){
    const start=beats[beat];
    if(beat%4!==3)add(start,.34,t=>.52*Math.sin(2*Math.PI*(45*t+55*(1-Math.exp(-t*25))/25))*Math.exp(-t*15));
    if(beat%4===1||beat%4===3)add(start,.18,t=>(random()*2-1)*.2*Math.exp(-t*26)+.1*Math.sin(2*Math.PI*190*t)*Math.exp(-t*25));
    add(start,.07,t=>(random()*2-1)*.07*Math.exp(-t*65));
    if(beat%4!==3)add(start+.25,.05,t=>(random()*2-1)*.045*Math.exp(-t*85));
    const bass=[110,130.81,146.83,98][Math.floor(beat/8)%4];
    add(start,.43,t=>(Math.sin(2*Math.PI*bass*t)+.35*Math.sin(4*Math.PI*bass*t))*.16*(1-Math.exp(-t*300))*Math.exp(-t*8));
    const melody=[440,523.25,659.25,587.33,392,493.88,783.99,659.25][beat%8];
    add(start,.36,t=>(Math.sin(2*Math.PI*melody*t)+.22*Math.sin(4*Math.PI*melody*t))*.08*(1-Math.exp(-t*200))*Math.exp(-t*10));
  }
  // Two sustained tones make cross-beat retention visible.
  for(const start of [2.25,10.25])add(start,2.8,t=>.055*Math.sin(2*Math.PI*261.63*t)*Math.min(1,t/.04)*Math.min(1,(2.8-t)/.6));
  for(let i=0;i<pcm.length;i++)pcm[i]=Math.tanh(pcm[i]);
  return{pcm,sampleRate,beats,duration};
}
