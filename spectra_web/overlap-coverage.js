import {shapeMetrics} from './emotion-shape.js?v=r56';
import {stemStatesAt,STEM_IDS} from './stem-player.js?v=lab-r56';

const EPS=1e-8;
export const COVERAGE_REVISION=3;
export function signedArea(p){let a=0;for(let i=0;i<p.length;i++){const q=p[(i+1)%p.length];a+=p[i][0]*q[1]-q[0]*p[i][1]}return a/2}
export function actorPolygon(a){
 const m=shapeMetrics(a.radius,a.form.kind,a.form.aspect),kind=a.form.kind;let p=[];
 if(kind==='circle')for(let i=0;i<96;i++){const t=i*2*Math.PI/96;p.push([m.radius*Math.cos(t),m.radius*Math.sin(t)])}
 else if(kind==='semicircle')for(let i=0;i<=48;i++){const t=i*Math.PI/48;p.push([m.radius*Math.cos(t),m.centerY+m.radius*Math.sin(t)])}
 else if(kind==='diamond')p=[[0,-m.halfDiagonal],[m.halfDiagonal,0],[0,m.halfDiagonal],[-m.halfDiagonal,0]];
 else if(kind==='triangle_up')p=m.points;
 else {const w=(m.width??m.side)/2,h=(m.height??m.side)/2;p=[[-w,-h],[w,-h],[w,h],[-w,h]]}
 const t=(a.form.rotation_offset_degrees??0)*Math.PI/180,c=Math.cos(t),s=Math.sin(t);
 p=p.map(([x,y])=>[a.x+x*c-y*s,a.y+x*s+y*c]);if(signedArea(p)<0)p.reverse();return p;
}
export function intersectConvex(subject,clip){
 let p=subject;
 for(let i=0;i<clip.length&&p.length;i++){
  const a=clip[i],b=clip[(i+1)%clip.length],cross=v=>(b[0]-a[0])*(v[1]-a[1])-(b[1]-a[1])*(v[0]-a[0]);
  const out=[];let prev=p.at(-1),dp=cross(prev);
  for(const next of p){const dn=cross(next),inside=dn>=-EPS,wasInside=dp>=-EPS;
   if(inside!==wasInside){const u=dp/(dp-dn);out.push([prev[0]+(next[0]-prev[0])*u,prev[1]+(next[1]-prev[1])*u])}
   if(inside)out.push(next);prev=next;dp=dn;
  }p=out;
 }return p;
}
const bounds=p=>({l:Math.min(...p.map(v=>v[0])),r:Math.max(...p.map(v=>v[0])),t:Math.min(...p.map(v=>v[1])),b:Math.max(...p.map(v=>v[1]))});
const touch=(a,b)=>a&&b&&Math.min(a.r,b.r)>Math.max(a.l,b.l)&&Math.min(a.b,b.b)>Math.max(a.t,b.t);
// Intersections for every subset, then Möbius inversion: remove regions occupied
// by any extra instrument. A fully covered pair is not a visible pair-colored area.
export function visibleOverlapAreas(actors,width,height){
 const p=new Array(64),boxes=new Array(64),areas=new Float64Array(64),present=new Map(),actorBoxes=new Map();
 for(const a of actors)if(a.form&&a.radius>0&&a.alpha>0){const bit=1<<STEM_IDS.indexOf(a.id);if(bit>0){const poly=actorPolygon(a);present.set(bit,poly);actorBoxes.set(bit,bounds(poly))}}
 p[0]=[[0,0],[width,0],[width,height],[0,height]];boxes[0]=bounds(p[0]);areas[0]=width*height;
 for(let mask=1;mask<64;mask++){
  const bit=1<<Math.floor(Math.log2(mask)),rest=mask^bit,poly=present.get(bit);
  if(!poly||!p[rest]?.length)continue;
  const box=actorBoxes.get(bit);if(!touch(boxes[rest],box))continue;
  const clipped=intersectConvex(p[rest],poly);if(clipped.length<3)continue;
  const area=Math.abs(signedArea(clipped));if(area<EPS)continue;p[mask]=clipped;boxes[mask]=bounds(clipped);areas[mask]=area;
 }
 for(let bit=1;bit<64;bit<<=1)for(let mask=0;mask<64;mask++)if(!(mask&bit))areas[mask]-=areas[mask|bit];
 const result=[];for(let mask=1;mask<64;mask++)if((mask&(mask-1))&&areas[mask]>.1)result.push({key:STEM_IDS.filter((_,i)=>mask&(1<<i)).join('+'),area:areas[mask]});
 return result;
}
export function coverageProfile(scene,width,height){
 return{revision:COVERAGE_REVISION,width,height,size:scene.size??1,pitch_mode:scene.pitchMode||'beat_summary',
  solo:!!scene.solo,stem:scene.solo?scene.stem:'bass',foote_motion_enabled:scene.geometry?.foote_motion_enabled??true,
  rotation_enabled:scene.geometry?.rotation_enabled??true};
}
export const coverageKey=p=>JSON.stringify(p);
export function coverageMatches(coverage,bundle,scene,width,height){return !!coverage&&coverage.scene_revision===bundle.scene_revision&&coverageKey(coverage.profile)===coverageKey(coverageProfile(scene,width,height))}

export async function scanOverlapCoverage(bundle,scene,width,height,{onProgress,signal,yieldEvery=32,actorStates=stemStatesAt}={}){
 const duration=bundle.audio.duration_seconds,times=new Set([0,duration]);
 // Cover both video grids, original acoustic samples, beats and exact bar sides.
 for(let i=0;i/60<duration+.55;i++)times.add(i/60);
 for(const t of bundle.beats||[])times.add(t);
 for(const b of bundle.bars){times.add(b.start_seconds);times.add(Math.max(b.start_seconds,b.end_seconds-1e-7))}
 for(const track of bundle.stems)for(const t of track.motion.times)times.add(t);
 const ordered=[...times].sort((a,b)=>a-b),required=new Map();let barIndex=0;
 const prediction=scene.solo?{...bundle,stems:bundle.stems.filter(t=>t.id===scene.stem)}:bundle;
 for(let i=0;i<ordered.length;i++){
  if(signal?.aborted)throw new DOMException('交叠筛选已取消。','AbortError');
  const vt=ordered[i],time=Math.min(duration,vt);
  while(barIndex+1<bundle.bars.length&&time>=bundle.bars[barIndex].end_seconds)barIndex++;
  const actors=actorStates(prediction,time,vt,{size:scene.size??1,sizeMultiplier:9,motionFraction:1,beatCentroid:true,beatVolume:true,pitchMode:scene.pitchMode||'beat_summary',parametricShape:true,geometry:scene.geometry,fadeOut:.18,mass:8,breath:1},width,height);
  if(actors.length>=2)for(const region of visibleOverlapAreas(actors,width,height)){
   if(!required.has(region.key))required.set(region.key,new Set());required.get(region.key).add(barIndex+1);
  }
  if(i%yieldEvery===0){onProgress?.((i+1)/ordered.length);await new Promise(r=>setTimeout(r,0))}
 }
 const requirements=Object.fromEntries([...required].sort(([a],[b])=>a.localeCompare(b)).map(([key,rows])=>[key,[...rows].sort((a,b)=>a-b)]));
 const count=Object.values(requirements).reduce((n,a)=>n+a.length,0);
 return{revision:COVERAGE_REVISION,scene_revision:bundle.scene_revision,profile:coverageProfile(scene,width,height),requirements,
  sampling:{fps:60,samples:ordered.length,acoustic_knots:true,bar_boundaries:true,circle_sides:96,minimum_area:.1},
  required_count:count,theoretical_count:57*bundle.bars.length};
}
