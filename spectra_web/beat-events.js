import {clamp,lerp,smoothstep,randomGenerator,hashString} from './core.js?v=stems-r33';
import {findSpectrumPeaks,createChromaPlot} from './chroma.js?v=stems-r33';

export function selectRatePeaks(scores,threshold,spacing){
  const candidates=findSpectrumPeaks(scores).map(p=>({bar:Math.floor(p.bar),rate:p.level})).filter(p=>p.rate>threshold);
  candidates.sort((a,b)=>b.rate-a.rate||a.bar-b.bar);
  const chosen=[];
  for(const peak of candidates)if(chosen.every(p=>Math.abs(p.bar-peak.bar)>spacing))chosen.push(peak);
  return chosen;
}
export function beatIndexAt(beats,time){
  let left=0,right=beats.length;
  while(left<right){const mid=(left+right)>>1;if(beats[mid]<=time)left=mid+1;else right=mid}
  return left-1;
}
function keyOpacity(event,time,keys){
  if(time<event.born||time>=event.end)return 0;
  let left=0,right=keys.length;
  while(left<right){const mid=(left+right)>>1;if(keys[mid].time<=time)left=mid+1;else right=mid}
  const a=keys[Math.max(0,left-1)],b=keys[left];
  return b?lerp(a.value,b.value,clamp((time-a.time)/(b.time-a.time||1),0,1)):a.value;
}
// Motion follows the mass-scaled envelope; visible appearance does not.
export function opacityAt(event,time){return keyOpacity(event,time,event.keys)}
function appearanceEnvelopeAt(event,time){return keyOpacity(event,time,event.appearanceKeys||event.keys)}
export function displayOpacityAt(event,time){
  let alpha=appearanceEnvelopeAt(event,time);
  const sustain=event.sustain;
  if(sustain&&time>sustain.start){
    const ageBeats=Math.max(0,continuousBeat(sustain.beats,time)-sustain.startBeat);
    // Gradually recede over four beats at the top; the final release still
    // fades all the way to zero. This never affects the motion envelope.
    alpha*=1-.75*smoothstep(ageBeats/4);
  }
  return alpha;
}
function ramp(event,time,target,duration){
  const current=opacityAt(event,time);
  const displayCurrent=appearanceEnvelopeAt(event,time);
  event.keys=event.keys.filter(k=>k.time<time);
  event.keys.push({time,value:current},{time:time+duration,value:target});
  if(event.appearanceKeys){
    const displayDuration=target>displayCurrent?event.appearanceFadeIn:duration;
    event.appearanceKeys=event.appearanceKeys.filter(k=>k.time<time);
    event.appearanceKeys.push({time,value:displayCurrent},{time:time+displayDuration,value:target});
  }
}
// Build a playback-only release view; keep original events intact for seeks.
export function releaseEventsAt(events,time){
  if(!Number.isFinite(time))return events;
  return events.filter(event=>event.born<time&&event.end>time&&displayOpacityAt(event,time)>0).map(event=>{
    const next=event.keys.find(key=>key.time>time);
    // An existing fall already has the correct trajectory and finish time.
    if(next?.value===0&&opacityAt(event,time)>0)return event;
    const released={...event,keys:event.keys.slice(),appearanceKeys:event.appearanceKeys?.slice()};
    ramp(released,time,0,event.vertical.fallDuration);
    released.end=time+event.vertical.fallDuration;
    return released;
  });
}
export function neighborhoodMax(levels,count,frame,bar){
  let value=0;
  for(let j=Math.max(0,bar-1);j<=Math.min(count-1,bar+1);j++)value=Math.max(value,levels[frame*count+j]);
  return value;
}
export function preTriggerBackground(levels,count,frames,frameStep,bar,born,window=.06,backgroundWindow=.15){
  // The background ends BEFORE the trigger window, keeping the attack out of the baseline.
  const end=Math.min(frames-1,Math.ceil((born-window)/frameStep)-1);
  const start=Math.max(0,Math.ceil((born-window-backgroundWindow)/frameStep)),values=[];
  for(let frame=start;frame<=end;frame++)values.push(neighborhoodMax(levels,count,frame,bar));
  if(!values.length)return 0;
  values.sort((a,b)=>a-b);const mid=values.length>>1;
  return values.length%2?values[mid]:(values[mid-1]+values[mid])/2;
}
export function verticalMotion({mass=8,breath=1,fadeIn=.18,fadeOut=.18}={}){
  const weight=clamp(mass,1,8),distance=.03*breath;
  // Fixed force for a given amplitude and base duration: a = F / m.
  // Covering the same distance therefore takes sqrt(m) times as long.
  return{mass:weight,distance,riseDuration:fadeIn*Math.sqrt(weight),fallDuration:fadeOut*Math.sqrt(weight),
    riseAcceleration:2*distance/(fadeIn*fadeIn*weight),fallAcceleration:2*distance/(fadeOut*fadeOut*weight)};
}
function continuousBeat(beats,time){
  if(beats.length<2)return time/.5;
  const i=clamp(beatIndexAt(beats,time),0,beats.length-2);
  return i+(time-beats[i])/(beats[i+1]-beats[i]);
}
export function hoverOffset(event,time,alpha=opacityAt(event,time)){
  const hover=event.hover;
  if(!hover||time<=hover.start||time>=event.end)return 0;
  // Hover uses elapsed audible seconds, so sparse/very long beats cannot
  // freeze it. Beat-triggered size pulses remain tied to the actual beat list.
  const phase=hover.phase+2*Math.PI*(time-hover.start)/hover.periodSeconds;
  // Both envelopes have zero slope at their ends: no position/velocity jump
  // when entering hover or starting the fall. The offset vanishes at release.
  return hover.amplitude*smoothstep((time-hover.start)/hover.fadeIn)*smoothstep(alpha)*Math.sin(phase);
}
export function bubbleHeight(event,time,hoverStrength=1,positionGamma=.5){
  const alpha=opacityAt(event,time),distance=event.vertical.distance;
  // Keep the original mass-controlled rise/fall, with a tiny hover offset.
  const baseY=event.baseY+birthHeight(event.level,positionGamma)-birthHeight(event.level);
  return baseY-distance*(2*alpha-alpha*alpha)+hoverStrength*hoverOffset(event,time,alpha);
}
function buildBubbleMotion(event,{frameStep,count,width,height,mass,breath}){
  const plot=createChromaPlot(width,height,count),stop=event.end;
  event.mass=mass;event.breath=breath;event.baseY=birthHeight(event.level);
  const moments=[event.born,stop,...event.keys.map(k=>k.time),...event.bindings.map(b=>b.time)];
  for(let time=Math.ceil(event.born/frameStep)*frameStep;time<stop;time+=frameStep)moments.push(time);
  const times=[...new Set(moments)].filter(t=>t>=event.born&&t<=stop).sort((a,b)=>a-b);
  const x=plot.x(event.bar)/width,motion=[];
  for(const time of times){
    const bar=bindingAt(event,time).bar;
    // Peak binding still monitors survival; it no longer moves the shape.
    motion.push(time,x,bubbleHeight(event,time),bar,event.level);
  }
  event.motion=Float32Array.from(motion);
}
// Stretch the original 21–50% upper-half band to 18–86% of the viewport.
// Preserve its strength ordering; spectrum bars retain their original layout.
// Gamma < 1 spreads low strengths upwards; gamma = 1 restores linear placement.
export function birthHeight(level,gamma=.5){return .86-.68*Math.pow(clamp(level,0,1),Number.isFinite(gamma)&&gamma>0?gamma:.5)}
export function positionAt(event,time,hoverStrength=1,positionGamma=.5){
  const data=event.motion,stride=5,length=data.length/stride;
  let left=0,right=length;
  while(left<right){const mid=(left+right)>>1;if(data[mid*stride]<=time)left=mid+1;else right=mid}
  const a=Math.max(0,left-1)*stride,b=Math.min(left,length-1)*stride;
  const mix=a===b?0:clamp((time-data[a])/(data[b]-data[a]),0,1);
  return{x:lerp(data[a+1],data[b+1],mix),y:bubbleHeight(event,time,hoverStrength,positionGamma),
    targetBar:lerp(data[a+3],data[b+3],mix),targetLevel:lerp(data[a+4],data[b+4],mix)};
}
export function bindingAt(event,time){
  const bindings=event.bindings;let left=0,right=bindings.length;
  while(left<right){const mid=(left+right)>>1;if(bindings[mid].time<=time)left=mid+1;else right=mid}
  return bindings[Math.max(0,left-1)];
}
export function nextBoundColumn(levels,count,frame,bar){
  const row=levels.subarray(frame*count,(frame+1)*count),current=row[bar];
  const choices=findSpectrumPeaks(row).map(p=>Math.floor(p.bar))
    .filter(j=>Math.abs(j-bar)===1&&row[j]>current+1e-7);
  choices.sort((a,b)=>row[b]-row[a]||a-b);
  return choices[0]??bar;
}
export function buildEvents({levels,frames,frameStep,duration},beats,{
  count=100,threshold=1.2,spacing=4,decay=.5,confirm=.05,fadeIn=.18,fadeOut=.18,window=.06,lag=.05,
  backgroundWindow=.15,mass=8,breath=1,width=1200,height=800,hover=true
}={}){
  const vertical=verticalMotion({mass,breath,fadeIn,fadeOut});
  mass=vertical.mass;
  const lagFrames=Math.max(1,Math.round(lag/frameStep)),lagTime=lagFrames*frameStep;
  const at=time=>clamp(Math.round(time/frameStep),0,frames-1);
  const candidates=beats.map(time=>{
    const scores=new Float32Array(count),start=at(Math.max(0,time-window)),end=at(Math.min(duration,time+window));
    for(let frame=start;frame<=end;frame++){
      const previous=frame-lagFrames;
      for(let j=0;j<count;j++){
        const rate=(levels[frame*count+j]-(previous>=0?levels[previous*count+j]:0))/lagTime;
        if(rate>scores[j])scores[j]=rate;
      }
    }
    return selectRatePeaks(scores,threshold,spacing);
  });
  const events=[],active=new Map();let beatCursor=0,nextId=1;
  const removeFinished=time=>{for(const [bar,item] of active)if(item.closing<=time)active.delete(bar)};
  const startCycle=(bar,born,index)=>{
    const baseline=preTriggerBackground(levels,count,frames,frameStep,bar,born,window,backgroundWindow);
    return{time:born,baseline,peakDelta:Math.max(0,neighborhoodMax(levels,count,index,bar)-baseline)};
  };
  for(let frame=0;frame<frames;frame++){
    const time=frame*frameStep;
    while(beatCursor<beats.length&&beats[beatCursor]<=time+1e-8){
      const born=beats[beatCursor],next=beats[beatCursor+1]??duration,index=at(born);removeFinished(born);
      for(const peak of candidates[beatCursor]){
        const level=levels[index*count+peak.bar],old=active.get(peak.bar);
        if(old){
          ramp(old.event,born,1,vertical.riseDuration);old.event.end=Infinity;old.cycle=startCycle(peak.bar,born,index);
          old.event.cycles.push(old.cycle);old.baseline=old.cycle.baseline;old.baselines=new Map([[peak.bar,old.baseline]]);
          old.event.bindings.push({time:born,bar:peak.bar,baseline:old.baseline});old.hold=Math.max(next,born+vertical.riseDuration);old.below=null;old.closing=Infinity;
          old.event.refreshes.push(born);continue;
        }
        if([...active.keys()].some(bar=>Math.abs(bar-peak.bar)<=spacing))continue;
        const cycle=startCycle(peak.bar,born,index);
        const event={id:nextId++,bar:peak.bar,level,rate:peak.rate,beat:beatCursor,born,end:Infinity,baseline:cycle.baseline,cycles:[cycle],vertical:{...vertical},
          appearanceFadeIn:fadeIn,appearanceKeys:[{time:born,value:.35},{time:born+fadeIn,value:1}],
          keys:[{time:born,value:0},{time:born+vertical.riseDuration,value:1}],bindings:[{time:born,bar:peak.bar,baseline:cycle.baseline}],refreshes:[]};
        events.push(event);active.set(peak.bar,{event,cycle,bar:peak.bar,baseline:cycle.baseline,baselines:new Map([[peak.bar,cycle.baseline]]),hold:Math.max(next,born+vertical.riseDuration),below:null,closing:Infinity});
      }
      beatCursor++;
    }
    removeFinished(time);
    // Snapshot the map: rekeying a binding must not process the same object twice in this frame.
    const items=[...active.values()];
    const moves=items.map(item=>({item,to:nextBoundColumn(levels,count,frame,item.bar)}))
      .filter(move=>move.to!==move.item.bar)
      .sort((a,b)=>levels[frame*count+b.to]-levels[frame*count+a.to]||a.item.event.id-b.item.event.id);
    for(const {item,to} of moves){
      if(active.has(to))continue;
      active.delete(item.bar);item.bar=to;active.set(to,item);
      if(!item.baselines.has(to))item.baselines.set(to,preTriggerBackground(levels,count,frames,frameStep,to,item.cycle.time,window,backgroundWindow));
      item.baseline=item.baselines.get(to);item.below=null;
      item.event.bindings.push({time,bar:to,baseline:item.baseline});
    }
    for(const item of items){
      // Binding still follows the spectrum for survival; motion is generated independently.
      const bar=item.bar;
      if(item.closing!==Infinity)continue;
      const delta=Math.max(0,neighborhoodMax(levels,count,frame,bar)-item.baseline);
      item.cycle.peakDelta=Math.max(item.cycle.peakDelta,delta);
      if(time+1e-8<item.hold){item.below=null;continue}
      if(delta<=item.cycle.peakDelta*decay+1e-7){
        item.below??=time;
        if(time-item.below>=confirm-1e-8){
          ramp(item.event,time,0,vertical.fallDuration);item.closing=time+vertical.fallDuration;item.event.end=item.closing;
        }
      }else item.below=null;
    }
  }
  for(const event of events){
    // A sustained final note may never cross the decay threshold. Give it
    // an explicit release, rendered after audible EOF by the visual tail clock.
    if(event.end===Infinity){
      ramp(event,duration,0,vertical.fallDuration);
      event.end=duration+vertical.fallDuration;
    }
    const arrived=event.keys.find(key=>key.value>=1-1e-9);
    if(arrived)event.sustain={start:arrived.time,startBeat:continuousBeat(beats,arrived.time),beats};
    if(hover&&arrived){
      const random=randomGenerator(hashString(event.born+':'+event.bar+':'+event.id));
      event.hover={start:arrived.time,startBeat:continuousBeat(beats,arrived.time),
        amplitude:(2+2*random())/Math.max(1,height),periodBeats:4+4*random(),
        phase:2*Math.PI*random(),fadeIn:.3,beats};
      event.hover.periodSeconds=event.hover.periodBeats*.5;
    }
    buildBubbleMotion(event,{frameStep,count,width,height,mass,breath});
  }
  return events;
}
