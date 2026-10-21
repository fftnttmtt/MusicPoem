import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEvents,opacityAt,displayOpacityAt,selectRatePeaks,beatIndexAt,positionAt,bindingAt,nextBoundColumn,hoverOffset,birthHeight,releaseEventsAt} from '../spectra_web/beat-events.js';
import {parseBeatTimes,makeBeatGrid,analyzePCM,makeFFT,smoothBars} from '../spectra_web/analysis.js';
import {makeDemoPCM} from '../spectra_web/demo-audio.js';
const step=.01,count=12,duration=2,frames=Math.round(duration/step)+1;
const fixture=fn=>{const levels=new Float32Array(count*frames);for(let f=0;f<frames;f++)for(let j=0;j<count;j++)levels[f*count+j]=fn(f*step,j);return{levels,frames,frameStep:step,duration}};
const note=t=>t<.18?0:t<.23?(t-.18)/.05*.9:t<.9?.9:.6;
// Isolate the original envelope physics here; hover behavior is tested below.
const at80=(analysis,beats,options={})=>buildEvents(analysis,beats,{decay:.8,mass:1,hover:false,...options});

test('rate peak suppression is strict, deterministic and non-transitive',()=>{
 const scores=new Float32Array(20);scores[10]=9;scores[13]=8;scores[16]=7;
 assert.deepEqual(selectRatePeaks(scores,1,3).map(p=>p.bar),[10,16]);
 assert.equal(selectRatePeaks(scores,9,3).length,0);
 scores[13]=10;assert.deepEqual(selectRatePeaks(scores,1,3).map(p=>p.bar),[13]);
 assert.deepEqual(selectRatePeaks([0,3,0,3,0],1,2).map(p=>p.bar),[1]);
});
test('birth occurs only on beats, retains identity across beats and releases after confirmed 80% decay',()=>{
 const events=at80(fixture((t,j)=>j===4?note(t):0),[.2,.7,1.2],{count,spacing:2});
 assert.equal(events.length,1);const e=events[0];assert.equal(e.born,.2);
 for(let t=e.born;t<e.end;t+=.01)assert.equal(positionAt(e,t).x,positionAt(e,e.born).x);assert.equal(e.bar,4);
 assert.equal(opacityAt(e,.19),0);assert.equal(opacityAt(e,.6),1);assert.equal(opacityAt(e,.92),1);
 assert.ok(e.end>1.11&&e.end<1.15);assert.ok(opacityAt(e,.98)>0&&opacityAt(e,.98)<1);assert.equal(opacityAt(e,1.2),0);
 const unchanged=JSON.stringify(e);for(const time of [.8,.3,1.5,.5])opacityAt(e,time);assert.equal(JSON.stringify(e),unchanged);
});
test('a fast drop within the birth beat cannot remove the shape before that beat ends',()=>{
 const data=fixture((t,j)=>j===4?(t<.3?note(t):.05):0),events=at80(data,[.2,.7,1.2],{count});
 assert.equal(events.length,1);assert.ok(events[0].end>=.8);assert.equal(opacityAt(events[0],.6),1);
});
test('same-bar retriggers refresh one event, while nearby occupied bars suppress new shapes',()=>{
 const value=t=>t<.4?note(t):t<.68?.1:t<.73?.1+(t-.68)/.05*.8:t<.95?.9:.05;
 const events=at80(fixture((t,j)=>j===4?value(t):0),[.2,.7,1.2],{count,spacing:2});
 assert.equal(events.length,1);assert.deepEqual(events[0].refreshes,[.7]);assert.ok(events[0].end>1.3);
 const nearby=at80(fixture((t,j)=>j===4?note(t):j===6?(t<.68?0:t<.73?(t-.68)/.05*.9:.9):0),[.2,.7,1.2],{count,spacing:2});
 assert.equal(nearby.length,1);assert.equal(nearby[0].bar,4);
});
test('a retrigger during fade preserves the earlier opacity history',()=>{
 const data=fixture((t,j)=>j===4?(t<.3?note(t):t<.77?.05:t<.82?.05+(t-.77)/.05*.9:t<1?.95:.05):0);
 const events=at80(data,[.2,.7,.78,1.2],{count});assert.equal(events.length,1);
 assert.deepEqual(events[0].refreshes,[.78]);
 assert.ok(opacityAt(events[0],.765)>.9&&opacityAt(events[0],.765)<.95);
 assert.ok(opacityAt(events[0],1.0)>.99);
});
test('silence produces no fallback shapes and steady loud notes do not retrigger every beat',()=>{
 assert.equal(at80(fixture(()=>0),[0,.5,1],{count}).length,0);
 const events=at80(fixture((t,j)=>j===4?.8:0),[0,.5,1,1.5],{count});
 assert.equal(events.length,1);assert.deepEqual(events[0].refreshes,[]);
});
test('sustained final shapes release after EOF with fixed x and accelerating downward motion',()=>{
 const e=buildEvents(fixture((t,j)=>j===4?.8:0),[0,.5,1,1.5],{count,mass:8,hover:false})[0];
 const fall=e.vertical.fallDuration;
 assert.equal(e.end,duration+fall);
 assert.equal(opacityAt(e,duration),1);
 assert.ok(Math.abs(opacityAt(e,duration+fall/2)-.5)<1e-10);
 assert.equal(opacityAt(e,duration+fall),0);
 const p=[0,.25,.5,.75,1].map(u=>positionAt(e,duration+fall*u));
 assert.ok(p.every(pos=>pos.x===p[0].x));
 const drops=p.slice(1).map((pos,i)=>pos.y-p[i].y);
 assert.ok(drops.every(d=>d>0));assert.ok(drops[1]>drops[0]&&drops[2]>drops[1]&&drops[3]>drops[2]);
});
test('beat import accepts seconds, rejects invalid values and grid starts on the supplied offset',()=>{
 assert.deepEqual(parseBeatTimes({beats:[.8,.2,.2,9]},2),[.2,.8]);
 assert.deepEqual(parseBeatTimes({beat_times:[{time:.3},{time:.7}]},2),[.3,.7]);
 for(const input of [[],[-1],[null],['1'],{beats:[Infinity]}])assert.throws(()=>parseBeatTimes(input,2));
 assert.deepEqual(makeBeatGrid(2,120,.25),[.25,.75,1.25,1.75]);
 assert.equal(beatIndexAt([.25,.75,1.25],.1),-1);assert.equal(beatIndexAt([.25,.75,1.25],.75),1);
});
test('FFT resolves a known tone and offline analysis keeps attack headroom',async()=>{
 const n=2048,re=new Float64Array(n),im=new Float64Array(n);for(let i=0;i<n;i++)re[i]=Math.sin(2*Math.PI*20*i/n);
 makeFFT()(re,im);assert.ok(Math.abs(Math.hypot(re[20],im[20])-n/2)<1e-7);
 const sr=44100,pcm=Float32Array.from({length:4410},(_,i)=>.5*Math.sin(2*Math.PI*(20*sr/n)*i/sr));
 const a=await analyzePCM(pcm,sr);const frame=5;
 assert.ok(a.raw[frame*300+20]>a.raw[frame*300+30]+30);assert.ok(a.raw[frame*300+20]<255);
});
test('the built-in playable demo generates beat-locked events through the full audio pipeline',async()=>{
 const demo=makeDemoPCM(44100),analysis=await analyzePCM(demo.pcm,demo.sampleRate),levels=smoothBars(analysis,100,.04);
 const events=at80({...analysis,levels},demo.beats,{count:100});
 assert.ok(events.length>20&&events.length<1000);assert.ok(events.every(e=>demo.beats.includes(e.born)));
 assert.ok(events.some(e=>e.end-e.born>.6));
 for(let time=0;time<demo.duration;time+=.07){const active=events.filter(e=>opacityAt(e,time)>.005);
  for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++)assert.ok(bindingAt(active[i],time).bar!==bindingAt(active[j],time).bar);
 }
});


test('decay uses attack increment above the pre-trigger background, not the absolute column height',()=>{
 const data=fixture((t,j)=>j===4?.7+(t<.18?0:t<.23?(t-.18)/.05*.2:t<.9?.2:.1):0);
 const events=at80(data,[.2,.7,1.2],{count});assert.equal(events.length,1);
 const e=events[0];assert.ok(Math.abs(e.baseline-.7)<1e-6);assert.ok(Math.abs(e.cycles[0].peakDelta-.2)<1e-6);
 // The remaining .8 is above .9 * .8, but the incremental .1 is below .2 * .8.
 assert.ok(.8>.9*.8);assert.ok(e.end>1.11&&e.end<1.15);assert.equal(opacityAt(e,1.2),0);
});

test('the neighbor maximum sustains a shifted peak while the visible shape stays at its birth x',()=>{
 const data=fixture((t,j)=>j===4?(t<.75?note(t):0):j===5?(t<.75?0:t<1.3?.9:.05):j===10?1:0);
 const events=at80(data,[.2,.7,1.2],{count});assert.equal(events.length,1);
 const e=events[0];assert.equal(opacityAt(e,1.1),1);assert.ok(e.end>1.51&&e.end<1.56);
 const initial=positionAt(e,e.born),later=positionAt(e,1.1);assert.equal(later.targetBar,5);
 assert.equal(later.x,initial.x);assert.ok(later.y<initial.y-.01);
 for(let i=3;i<e.motion.length;i+=5)assert.ok(e.motion[i]>=3&&e.motion[i]<=5);
 const remembered=positionAt(e,.9);for(const t of [1.2,.3,.8,.4])positionAt(e,t);assert.deepEqual(positionAt(e,.9),remembered);
});

test('a short beat window ignores strong attacks that occur elsewhere in the beat',()=>{
 const data=fixture((t,j)=>j===4?(t<.4?0:t<.46?(t-.4)/.06*.9:.9):0);
 assert.equal(at80(data,[.2,.7,1.2],{count,window:.06}).length,0);
 assert.ok(at80(data,[.2,.7,1.2],{count,window:.3}).length>0);
});


test('binding selects a higher neighboring local peak, choosing the taller side and stable ties',()=>{
 const choose=row=>nextBoundColumn(Float32Array.from(row),row.length,0,2);
 assert.equal(choose([0,.8,.1,.9,0]),3);
 assert.equal(choose([0,.9,.1,.8,0]),1);
 assert.equal(choose([0,.9,.1,.9,0]),1);
 assert.equal(choose([0,.2,.9,.8,0]),2);
 assert.equal(choose([0,.3,.4,.5,.9,0]),2); // The adjacent higher bar is still a slope, not a peak.
 assert.equal(choose([0,.9,.9,.2,0]),2);
});

test('one event rebinds monitoring without moving x and preserves pre-attack backgrounds',()=>{
 const data=fixture((t,j)=>j===4?(t<.5?note(t):0):j===5?(t>=.5&&t<.8?.9:0):
  j===6?(t>=.8&&t<1.1?.9:0):j===7?(t>=1.1&&t<1.4?.9:.05):0);
 const events=at80(data,[.2,.95,1.7],{count});assert.equal(events.length,1);
 const e=events[0];assert.deepEqual(e.bindings.map(b=>b.bar),[4,5,6,7]);assert.deepEqual(e.refreshes,[]);
 assert.equal(bindingAt(e,.6).bar,5);assert.equal(bindingAt(e,.9).bar,6);assert.equal(bindingAt(e,1.2).bar,7);
 assert.ok(Math.abs(bindingAt(e,1.2).baseline-.05)<1e-6);assert.equal(e.born,.2);
 for(let t=e.born;t<e.end;t+=.01)assert.equal(positionAt(e,t).x,positionAt(e,e.born).x);
 assert.equal(opacityAt(e,1.3),1);assert.ok(e.end<1.8);
 for(const binding of e.bindings.slice(1)){
  const before=positionAt(e,binding.time-.0001),after=positionAt(e,binding.time+.0001);
  assert.ok(Math.hypot(before.x-after.x,before.y-after.y)<.001);
 }
});

test('fade base durations are 180 ms at unit mass and remain independently configurable',()=>{
 const data=fixture((t,j)=>j===4?note(t):0);
 const e=at80(data,[.2,.7,1.2],{count})[0];
 assert.ok(Math.abs(opacityAt(e,.29)-.5)<1e-6);assert.equal(opacityAt(e,.39),1);
 assert.ok(Math.abs(opacityAt(e,1.04)-.5)<.0001);
 const adjusted=at80(data,[.2,.7,1.2],{count,fadeIn:.3,fadeOut:.4})[0];
 assert.ok(Math.abs(opacityAt(adjusted,.35)-.5)<1e-6);
 assert.ok(Math.abs(opacityAt(adjusted,1.15)-.5)<.0001);
});


test('50% is the default incremental decay threshold',()=>{
 const data=fixture((t,j)=>j===4?.7+(t<.18?0:t<.23?(t-.18)/.05*.2:t<.9?.2:t<1.3?.15:.08):0);
 const current=buildEvents(data,[.2,.7,1.2],{count,mass:1})[0],previous=buildEvents(data,[.2,.7,1.2],{count,decay:.8,mass:1})[0];
 assert.equal(opacityAt(current,1.2),1);assert.equal(opacityAt(previous,1.2),0);
 assert.ok(current.end>1.51&&current.end<1.55);
});

test('base envelope rises progressively slower, holds still without hover, and falls progressively faster',()=>{
 const e=at80(fixture((t,j)=>j===4?note(t):0),[.2,.7,1.2],{count})[0];
 const rise=[.2,.245,.29,.335,.38].map(t=>positionAt(e,t));
 const up=rise.slice(1).map((p,i)=>rise[i].y-p.y);
 assert.ok(up.every(v=>v>0));assert.ok(up[0]>up[1]&&up[1]>up[2]&&up[2]>up[3]);
 for(const t of [.5,.7,.9])assert.ok(Math.abs(positionAt(e,t).y-rise[4].y)<1e-9);
 const fall=[.95,.995,1.04,1.085,1.13].map(t=>positionAt(e,t));
 const down=fall.slice(1).map((p,i)=>p.y-fall[i].y);
 assert.ok(down.every(v=>v>0));assert.ok(down[0]<down[1]&&down[1]<down[2]&&down[2]<down[3]);
 assert.ok(Math.abs(fall[4].y-rise[0].y)<1e-7);
 assert.ok(rise.every(p=>Math.abs(p.x-rise[0].x)<1e-7));
});

test('without hover, peak changes and rebinding do not move the vertical resting position',()=>{
 const data=fixture((t,j)=>j===4?(t<.75?note(t):0):j===5?(t<.75?0:t<1.3?.9:.05):0);
 const e=at80(data,[.2,.7,1.2],{count})[0];
 const before=positionAt(e,.65),after=positionAt(e,1.1);
 assert.equal(bindingAt(e,1.1).bar,5);assert.equal(after.x,before.x);assert.equal(after.y,before.y);
 const remembered=positionAt(e,.85);for(const t of [1.4,.25,.6])positionAt(e,t);assert.deepEqual(positionAt(e,.85),remembered);
});

test('mass controls measured rising and falling acceleration while preserving excursion distance',()=>{
 const data=fixture((t,j)=>j===4?note(t):0),light=at80(data,[.2,.7,1.2],{count,mass:1})[0],heavy=at80(data,[.2,.7,1.2],{count,mass:8})[0];
 const acceleration=(event,start)=>{
  const dt=.01,a=positionAt(event,start).y,b=positionAt(event,start+dt).y,c=positionAt(event,start+2*dt).y;
  return(c-2*b+a)/(dt*dt);
 };
 const lightRise=acceleration(light,.22),heavyRise=acceleration(heavy,.22);
 const lightFall=acceleration(light,light.keys.at(-2).time+.01),heavyFall=acceleration(heavy,heavy.keys.at(-2).time+.01);
 assert.ok(lightRise>0&&heavyRise>0&&lightFall>0&&heavyFall>0);
 assert.ok(Math.abs(lightRise/heavyRise-8)<1e-6);assert.ok(Math.abs(lightFall/heavyFall-8)<1e-6);
 assert.ok(Math.abs(positionAt(light,.8).y-positionAt(heavy,.8).y)<1e-9);
 assert.ok(heavy.keys[1].time>light.keys[1].time);assert.ok(heavy.end>light.end);
});

test('default mass is the maximum 8 and heavy fade phases finish before the hold can end',()=>{
 const data=fixture((t,j)=>j===4?note(t):0),event=buildEvents(data,[.2,.45,.7,1.2],{count})[0];
 assert.equal(event.mass,8);assert.equal(event.vertical.mass,8);
 assert.ok(Math.abs(event.keys[1].time-event.born-.18*Math.sqrt(8))<1e-9);
 assert.ok(event.end>event.keys[1].time);
});

const hoveringEvents=()=>{
 const longDuration=10,longFrames=1001;
 const levels=Float32Array.from({length:longFrames*count},(_,i)=>[4,9].includes(i%count)?.8:0);
 return buildEvents({levels,frames:longFrames,frameStep:.01,duration:longDuration},
  Array.from({length:20},(_,i)=>i*.5),{count,height:800,mass:8});
};
test('geometry birth positions stretch vertically while preserving strength order',()=>{
 const ys=[0,.25,.5,.75,1].map(level=>birthHeight(level));
 assert.ok(Math.abs(ys[0]-.86)<1e-10);
 assert.ok(Math.abs(ys.at(-1)-.18)<1e-10);
 assert.ok(ys.every((y,i)=>i===0||y<ys[i-1]));
 assert.ok(ys[0]-ys.at(-1)>2*(.5-.21));
 for(const e of hoveringEvents())assert.equal(e.baseY,birthHeight(e.level));
});
test('position gamma separates low strengths and changes only vertical placement',()=>{
 const levels=[.01,.04,.09,.16],linear=levels.map(p=>birthHeight(p,1)),spread=levels.map(p=>birthHeight(p,.5));
 assert.ok(spread[0]-spread.at(-1)>1.9*(linear[0]-linear.at(-1)));
 assert.ok(spread.every((y,i)=>i===0||y<spread[i-1]));
 const e=hoveringEvents()[0],before=JSON.stringify(e);
 for(const t of [e.born,e.sustain.start,e.end-.05]){
  const a=positionAt(e,t,4,.5),b=positionAt(e,t,4,1);
  assert.equal(a.x,b.x);assert.equal(a.targetBar,b.targetBar);
  assert.ok(Math.abs(a.y-b.y-(birthHeight(e.level,.5)-birthHeight(e.level,1)))<1e-10);
 }
 assert.equal(JSON.stringify(e),before);
});
test('sustained shapes gradually become transparent without moving or losing seek determinism',()=>{
 const e=hoveringEvents()[0],start=e.sustain.start;
 const times=[start,start+.5,start+1,start+2,start+4];
 const alphas=times.map(t=>displayOpacityAt(e,t));
 assert.equal(alphas[0],1);
 assert.ok(alphas[0]>alphas[1]&&alphas[1]>alphas[2]&&alphas[2]>alphas[3]);
 assert.ok(Math.abs(alphas[3]-.25)<1e-10);
 assert.equal(alphas[4],.25);
 assert.ok(times.every(t=>opacityAt(e,t)===1)); // only display fades, not movement
 for(const t of [8,1,.1,7])displayOpacityAt(e,t);
 assert.deepEqual(times.map(t=>displayOpacityAt(e,t)),alphas);
 assert.equal(displayOpacityAt(e,e.end),0);
});
test('birth becomes clearly visible on the exact beat, independently of heavy rise inertia',()=>{
 for(const mass of [1,8]){
  const e=buildEvents(fixture((t,j)=>j===4?.8:0),[0,.5,1,1.5],{count,mass,fadeIn:.18})[0];
  assert.equal(displayOpacityAt(e,-.001),0);
  assert.equal(displayOpacityAt(e,0),.35);
  assert.ok(displayOpacityAt(e,.016)>.4);
  assert.equal(displayOpacityAt(e,.18),1);
  if(mass===8){assert.ok(opacityAt(e,.1)<.2);assert.ok(displayOpacityAt(e,.1)>.7)}
 }
});
test('appearance refresh preserves prior frames and releases fully at EOF',()=>{
 const data=fixture((t,j)=>j===4?(t<.3?note(t):t<.77?.05:t<.82?.05+(t-.77)/.05*.9:t<1?.95:.05):0);
 const e=at80(data,[.2,.7,.78,1.2],{count})[0];
 const before=JSON.stringify(e);
 for(const t of [.765,.2,1.5,.5,.78])assert.ok(displayOpacityAt(e,t)>=0&&displayOpacityAt(e,t)<=1);
 assert.equal(JSON.stringify(e),before);
 const final=hoveringEvents()[0];
 assert.equal(displayOpacityAt(final,final.end),0);
});
test('default hover is bounded to 2–4 px, has independent phases and keeps x fixed',()=>{
 const events=hoveringEvents();assert.equal(events.length,2);
 assert.notEqual(events[0].hover.phase,events[1].hover.phase);
 for(const e of events){
  assert.ok(e.hover.amplitude*800>=2&&e.hover.amplitude*800<=4);
  assert.ok(e.hover.periodBeats>=4&&e.hover.periodBeats<=8);
  const ys=[];
  for(let t=1;t<10;t+=.017){
   const p=positionAt(e,t);ys.push(p.y);
   assert.equal(p.x,positionAt(e,0).x);
   assert.ok(Math.abs(hoverOffset(e,t))*800<=4+1e-8);
   assert.equal(opacityAt(e,t),1);
  }
  assert.ok((Math.max(...ys)-Math.min(...ys))*800>2);
 }
});
test('hover joins the rise and EOF fall continuously and is stable after arbitrary seeks',()=>{
 const events=hoveringEvents(),repeat=hoveringEvents();
 assert.deepEqual(events,repeat);
 for(const e of events){
  assert.equal(hoverOffset(e,e.hover.start),0);
  for(const boundary of [e.hover.start,10,e.end]){
   const dt=1e-5,y0=positionAt(e,boundary-dt).y,y1=positionAt(e,boundary).y,y2=positionAt(e,boundary+dt).y;
   assert.ok(Math.abs(y2-y0)<1e-5);
   // The original accelerating fall ends at zero opacity with nonzero speed;
   // hover must not add a velocity jump at the visible joins.
   if(boundary!==e.end)assert.ok(Math.abs((y2-y1)/dt-(y1-y0)/dt)<1e-4);
   const h0=hoverOffset(e,boundary-dt),h1=hoverOffset(e,boundary),h2=hoverOffset(e,boundary+dt);
   assert.ok(Math.abs((h2-h1)/dt-(h1-h0)/dt)<1e-4);
  }
  assert.equal(hoverOffset(e,e.end),0);
  const remembered=positionAt(e,5.2),before=JSON.stringify(e);
  for(const t of [9,1,10.1,.2,7])positionAt(e,t);
  assert.deepEqual(positionAt(e,5.2),remembered);
  assert.equal(JSON.stringify(e),before);
 }
});
test('long beat gaps do not slow or stop sustained hover',()=>{
 const fast=hoveringEvents()[0];
 const levels=Float32Array.from({length:1001*count},(_,i)=>[4,9].includes(i%count)?.8:0);
 const slow=buildEvents({levels,frames:1001,frameStep:.01,duration:10},[0,5,9],{count,height:800,mass:8})[0];
 assert.ok(slow.hover.periodSeconds>=2&&slow.hover.periodSeconds<=4);
 const offsets=[];
 for(let t=1;t<5;t+=.017){
  offsets.push(hoverOffset(slow,t));
  assert.ok(Math.abs(hoverOffset(slow,t)-hoverOffset(fast,t))<1e-12);
 }
 assert.ok((Math.max(...offsets)-Math.min(...offsets))*800>4);
});
test('silence release joins current position and opacity and uses normal mass-scaled falling',()=>{
 const original=hoveringEvents(),before=JSON.stringify(original),start=3;
 const released=releaseEventsAt([...original,{...original[0],born:4}],start);
 assert.equal(released.length,original.length);
 for(let i=0;i<released.length;i++){
  const e=released[i],source=original[i],duration=source.vertical.fallDuration;
  assert.equal(e.end,start+duration);
  assert.equal(displayOpacityAt(e,start),displayOpacityAt(source,start));
  assert.deepEqual(positionAt(e,start,4,.5),positionAt(source,start,4,.5));
  const ys=[0,.25,.5,.75].map(u=>positionAt(e,start+duration*u,0).y);
  assert.ok(ys.every((y,j)=>j===0||y>ys[j-1]));
  assert.ok(ys[3]-ys[2]>ys[2]-ys[1]);
  assert.ok(displayOpacityAt(e,start+duration/2)>0);
  assert.ok(displayOpacityAt(e,start+duration/2)<displayOpacityAt(e,start));
  assert.equal(displayOpacityAt(e,e.end),0);
  const remembered=positionAt(e,start+.2,4);
  for(const t of [start+.4,start-.1,start+.1])positionAt(e,t,4);
  assert.deepEqual(positionAt(e,start+.2,4),remembered);
 }
 assert.equal(JSON.stringify(original),before);
 assert.equal(releaseEventsAt(original,original[0].end-.1)[0],original[0]); // do not restart an existing fall
 assert.equal(releaseEventsAt(original,0).length,0);
});
