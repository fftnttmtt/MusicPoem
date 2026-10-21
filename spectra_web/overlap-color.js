import {visibleOverlapAreas} from './overlap-coverage.js?v=r56';
import {paintPigmentTexture} from './material-texture.js?v=r56';
import {shapeMetrics,traceInstrumentShape,paintEmotionShape} from './emotion-shape.js?v=r56';
import {intervalAt,predictedBackground} from './prediction.js?v=stems-r33';
const STEMS=['bass','drums','other','vocals','guitar','piano'];
export const overlapKey=ids=>[...ids].sort((a,b)=>STEMS.indexOf(a)-STEMS.indexOf(b)).join('+');
export function overlapColorAt(combination,time){
 const row=intervalAt(combination?.segments||[],time);
 if(row?.status!=='ok'||!Array.isArray(row.rgb))return null;
 return predictedBackground(combination,time);
}
function metricsFor(actor){return shapeMetrics(actor.radius,actor.form.kind,actor.form.aspect)}
export function actorBounds(actor){
 const m=metricsFor(actor),kind=actor.form.kind;
 const points=kind==='circle'?[[-m.radius,-m.radius],[m.radius,m.radius]]:
  kind==='semicircle'?[[-m.radius,m.centerY],[m.radius,m.centerY+m.radius]]:
  kind==='diamond'?[[-m.halfDiagonal,-m.halfDiagonal],[m.halfDiagonal,m.halfDiagonal]]:
  kind==='triangle_up'?[[-m.width/2,-2*m.height/3],[m.width/2,m.height/3]]:
  [[-(m.width??m.side)/2,-(m.height??m.side)/2],[(m.width??m.side)/2,(m.height??m.side)/2]];
 const theta=(actor.form.rotation_offset_degrees??0)*Math.PI/180,c=Math.cos(theta),s=Math.sin(theta);
 const corners=[points[0],[points[0][0],points[1][1]],points[1],[points[1][0],points[0][1]]].map(([x,y])=>[actor.x+x*c-y*s,actor.y+x*s+y*c]);
 return{left:Math.min(...corners.map(p=>p[0])),right:Math.max(...corners.map(p=>p[0])),top:Math.min(...corners.map(p=>p[1])),bottom:Math.max(...corners.map(p=>p[1]))};
}
function intersect(a,b){const r={left:Math.max(a.left,b.left),right:Math.min(a.right,b.right),top:Math.max(a.top,b.top),bottom:Math.min(a.bottom,b.bottom)};return r.right>r.left&&r.bottom>r.top?r:null}
function appendActor(ctx,actor,begin=true){
 ctx.save();ctx.translate(actor.x,actor.y);ctx.rotate((actor.form.rotation_offset_degrees??0)*Math.PI/180);
 // Canvas paths retain transformed coordinates after restoring transform state.
 traceInstrumentShape(ctx,actor.form.kind,metricsFor(actor),0,begin);ctx.restore();
}
export function paintOverlapShapes(ctx,actors,overlap,time,width,height,viewportScale=1){
 const active=actors.filter(a=>a.form&&a.radius>0&&a.alpha>0),bounds=new Map(active.map(a=>[a.id,actorBounds(a)]));
 for(const a of active)paintEmotionShape(ctx,a.form,a.x,a.y,a.radius,a.alpha,a.rgb,viewportScale,'fill');
 let painted=0,missing=0;
 const visible=visibleOverlapAreas(active,width,height),byKey=new Map((overlap?.combinations||[]).map(c=>[c.key??overlapKey(c.stems),c]));
 for(const region of visible){
  const combination=byKey.get(region.key);if(!combination){missing++;continue}
  const members=active.filter(a=>combination.stems.includes(a.id));if(members.length!==combination.stems.length)continue;
  let box={left:0,top:0,right:width,bottom:height};for(const a of members){box=intersect(box,bounds.get(a.id));if(!box)break}if(!box)continue;
  const rgb=overlapColorAt(combination,time);if(!rgb){missing++;continue}
  ctx.save();
  for(const a of members){appendActor(ctx,a);ctx.clip()}
  // Subtract non-member silhouettes: a 3-way region cannot receive a pair color.
  for(const a of active.filter(a=>!combination.stems.includes(a.id)&&intersect(box,bounds.get(a.id)))){
   ctx.beginPath();ctx.rect(0,0,width,height);appendActor(ctx,a,false);ctx.clip('evenodd');
  }
  ctx.globalAlpha=Math.min(...members.map(a=>a.alpha));ctx.fillStyle='rgb('+rgb.join(',')+')';
  ctx.fillRect(box.left,box.top,box.right-box.left,box.bottom-box.top);
  // Same material as the top participating instrument, over the predicted mix color.
  const anchor=members.at(-1);
  if(anchor.form.texture_enabled){ctx.translate(anchor.x,anchor.y);ctx.rotate((anchor.form.rotation_offset_degrees??0)*Math.PI/180);
   const extent=anchor.radius*4;
   paintPigmentTexture(ctx,{left:-extent,top:-extent,right:extent,bottom:extent},anchor.id,anchor.form,viewportScale);
  }
  ctx.restore();painted++;
 }
 // Every enabled outline is above every color region, independent of layer rank.
 for(const a of active)paintEmotionShape(ctx,a.form,a.x,a.y,a.radius,a.alpha,a.rgb,viewportScale,'outline');
 return{painted,missing};
}
