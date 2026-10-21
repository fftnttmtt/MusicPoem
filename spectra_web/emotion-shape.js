import {MATERIAL_DEFAULTS,materialParameters,paintPigmentTexture,paintEdgeTexture,paintInkTexture} from './material-texture.js?v=r56';
import {clamp,smoothstep} from './core.js?v=stems-r33';
import {intervalAt} from './prediction.js?v=stems-r33';

export const OUTLINE_MULTIPLIERS={bass:1,drums:1.2,other:1,vocals:1,guitar:.6,piano:1};
export const GEOMETRY_DEFAULTS={outline_arousal_scale:1.5,outline_enabled:true,rotation_enabled:true,foote_motion_enabled:true,...MATERIAL_DEFAULTS,drums_outline_gap:6,drums_inner_ratio:.35,
 outline_bass_enabled:false,outline_drums_enabled:true,outline_other_enabled:false,
 outline_vocals_enabled:false,outline_guitar_enabled:true,outline_piano_enabled:true,
 ...Object.fromEntries(Object.entries(OUTLINE_MULTIPLIERS).map(([s,v])=>['outline_'+s+'_multiplier',v]))};
export const DRAW_ORDER=['bass','guitar','piano','other','drums','vocals'];
export const ROTATION_DIRECTIONS={bass:-1,guitar:-1,drums:1,piano:1,other:1,vocals:0};
export function orderActorsForPainting(actors){return [...actors].sort((a,b)=>DRAW_ORDER.indexOf(a.id)-DRAW_ORDER.indexOf(b.id))}
export const SHAPE_LABELS={rectangle:'横矩形',diamond:'菱形',semicircle:'半圆',circle:'圆',triangle_up:'上三角',square:'正方形'};
export const INSTRUMENT_SHAPES={
 bass:{kind:'rectangle',aspect:3},drums:{kind:'diamond',rotation_degrees:45},
 other:{kind:'semicircle'},vocals:{kind:'circle'},guitar:{kind:'triangle_up',aspect:.8},piano:{kind:'square'}
};
export function geometryParameters(values={}){
 const p=Object.fromEntries(Object.entries(GEOMETRY_DEFAULTS).map(([k,v])=>[k,values[k]??v]));
 if(!Number.isFinite(p.outline_arousal_scale))throw Error('描边系数必须为有限数值。');
 for(const key of Object.keys(GEOMETRY_DEFAULTS).filter(k=>k.endsWith('_enabled')))if(typeof p[key]!=='boolean')throw Error('描边与旋转须为开关。');
 if(p.outline_arousal_scale<.01||p.outline_arousal_scale>10)throw Error('描边系数须在 0.01–10 内。');
 for(const stem of Object.keys(OUTLINE_MULTIPLIERS)){const v=p['outline_'+stem+'_multiplier'];if(!Number.isFinite(v)||v<0||v>10)throw Error('各乐器描边倍率须在 0–10 内。')}
 materialParameters(p);
 if(!Number.isFinite(p.drums_outline_gap)||p.drums_outline_gap<.5||p.drums_outline_gap>30||!Number.isFinite(p.drums_inner_ratio)||p.drums_inner_ratio<.1||p.drums_inner_ratio>.8)throw Error('鼓声双线净间距须在 0.5–30，内外线宽比须在 0.1–0.8 内。');
 return p;
}
const referenceCache=new WeakMap();
export function trackEmotionReference(track){
 const rows=track.segments||[];
 if(referenceCache.has(rows))return referenceCache.get(rows);
 const valid=rows.filter(r=>r.status==='ok'&&Number.isFinite(r.valence)&&Number.isFinite(r.arousal));
 const stored=track.shape_reference;
 const storedValid=stored?.method==='arithmetic_mean_of_valid_bar_predictions'&&stored.valid_segments===valid.length&&stored.total_segments===rows.length;
 // Use the exported thresholds exactly to avoid cross-runtime rounding at the boundary.
 const mean=key=>!valid.length?null:storedValid&&Number.isFinite(stored[key+'_mean'])?stored[key+'_mean']:valid.every(r=>r[key]===valid[0][key])?valid[0][key]:valid.reduce((sum,r)=>sum+r[key],0)/valid.length;
 const reference={valence_mean:mean('valence'),arousal_mean:mean('arousal'),valid_segments:valid.length,
  total_segments:rows.length,complete:rows.every(r=>(r.prediction_status??r.status)==='silent'||(r.status==='ok'&&Number.isFinite(r.valence)&&Number.isFinite(r.arousal))),
  method:'arithmetic_mean_of_valid_bar_predictions',equality:'high'};
 referenceCache.set(rows,reference);return reference;
}
const rotationCache=new WeakMap();
export function rotationReference(track){
 const rows=track.segments||[];if(rotationCache.has(rows))return rotationCache.get(rows);
 const valid=rows.filter(r=>r.status==='ok'&&Number.isFinite(r.valence)&&Number.isFinite(r.arousal));
 const values=valid.map(r=>r.valence).sort((a,b)=>a-b),stored=track.rotation_reference;
 const percentile=q=>{if(!values.length)return null;const x=(values.length-1)*q,i=Math.floor(x);return values[i]+(values[Math.min(i+1,values.length-1)]-values[i])*(x-i)};
 const storedValid=stored?.method==='percentile_linear'&&stored.valid_segments===valid.length&&stored.total_segments===rows.length&&Number.isFinite(stored.valence_low)&&Number.isFinite(stored.valence_high)&&stored.valence_high>=stored.valence_low;
 const low=storedValid?stored.valence_low:percentile(.1),high=storedValid?stored.valence_high:percentile(.9);
 const reference={method:'percentile_linear',percentiles:[10,90],valence_low:low,valence_high:high,
  valid_segments:valid.length,total_segments:rows.length,complete:trackEmotionReference(track).complete,
  constant:!values.length||high-low<=1e-9};
 rotationCache.set(rows,reference);return reference;
}
export function valenceRotation(stem,valence,reference,enabled=true){
 if(!enabled||!ROTATION_DIRECTIONS[stem]||!Number.isFinite(valence)||!reference||reference.constant||!Number.isFinite(reference.valence_low)||!Number.isFinite(reference.valence_high)||reference.valence_high-reference.valence_low<=1e-9)return 0;
 const u=clamp((valence-reference.valence_low)/(reference.valence_high-reference.valence_low),0,1);
 // Canvas positive angles are clockwise. Rising valence approaches upright.
 const angle=-ROTATION_DIRECTIONS[stem]*180*(1-u);return angle===0?0:angle;
}
export function shapeForInstrument(stem,valence,arousal,parameters={}){
 const p=geometryParameters(parameters),identity=INSTRUMENT_SHAPES[stem];
 if(!identity||!Number.isFinite(valence)||!Number.isFinite(arousal))return null;
 return{...identity,...materialParameters(p),drums_outline_gap:p.drums_outline_gap,drums_inner_ratio:p.drums_inner_ratio,stem,valence,arousal,outline_enabled:p.outline_enabled&&p['outline_'+stem+'_enabled'],outline_multiplier:p['outline_'+stem+'_multiplier'],rotation_offset_degrees:0,outline_width:p.outline_arousal_scale*p['outline_'+stem+'_multiplier']*clamp(arousal,1,9)};
}
export function emotionShapeAt(track,time,parameters={}){
 const row=intervalAt(track.segments,time);
 if(row?.status!=='ok')return null;
 const p=geometryParameters(parameters),reference=rotationReference(track),target=shapeForInstrument(track.id,row.valence,row.arousal,p);
 if(target){target.rotation_reference=reference;target.rotation_offset_degrees=valenceRotation(track.id,row.valence,reference,p.rotation_enabled)}
 if(!target)return null;
 const previous=track.segments[track.segments.indexOf(row)-1];
 if(previous?.status!=='ok'||!Number.isFinite(previous.arousal)||!Number.isFinite(previous.valence)||Math.abs(previous.end_seconds-row.start_seconds)>1e-5)return{...target,target};
 const u=smoothstep(clamp((time-row.start_seconds)/(row.end_seconds-row.start_seconds),0,1));
 const arousal=previous.arousal+(row.arousal-previous.arousal)*u;
 const previousAngle=valenceRotation(track.id,previous.valence,reference,p.rotation_enabled);
 return{...target,arousal,outline_width:p.outline_arousal_scale*target.outline_multiplier*clamp(arousal,1,9),
  rotation_offset_degrees:previousAngle+(target.rotation_offset_degrees-previousAngle)*u,target};
}
export function shapeMetrics(radius,kind,aspect){
 const area=Math.PI*radius*radius;
 if(kind==='circle')return{area,inradius:radius,radius};
 if(kind==='semicircle'){
  const outerRadius=radius*Math.sqrt(2);
  return{area,inradius:outerRadius/2,radius:outerRadius,centerY:-4*outerRadius/(3*Math.PI)};
 }
 if(kind==='square'||kind==='diamond'){
  const side=Math.sqrt(area);
  return{area,inradius:side/2,side,halfDiagonal:side/Math.sqrt(2)};
 }
 if(kind==='rectangle'){
  const ratio=aspect??3,width=Math.sqrt(area*ratio),height=Math.sqrt(area/ratio);
  return{area,width,height,inradius:Math.min(width,height)/2};
 }
 if(kind==='triangle_up'){
  const ratio=aspect??.8,height=Math.sqrt(2*area/ratio),width=height*ratio;
  const inradius=2*area/(width+2*Math.hypot(height,width/2));
  return{area,width,height,inradius,incenterY:height/3-inradius,
   points:[[0,-2*height/3],[width/2,height/3],[-width/2,height/3]]};
 }
 throw Error('未知的乐器几何形态。');
}
export function traceInstrumentShape(ctx,kind,m,inset=0,begin=true){
 if(begin)ctx.beginPath();
 if(kind==='circle'){ctx.moveTo(m.radius-inset,0);ctx.arc(0,0,m.radius-inset,0,2*Math.PI)}
 else if(kind==='semicircle'){
  const r=m.radius-inset,angle=Math.asin(inset/r);
  ctx.moveTo(r*Math.cos(angle),m.centerY+r*Math.sin(angle));ctx.arc(0,m.centerY,r,angle,Math.PI-angle);
 }
 else if(kind==='square'||kind==='rectangle'){
  const width=(m.width??m.side)-2*inset,height=(m.height??m.side)-2*inset;
  ctx.rect(-width/2,-height/2,width,height);
 }
 else{
  const points=kind==='diamond'?[[0,-m.halfDiagonal],[m.halfDiagonal,0],[0,m.halfDiagonal],[-m.halfDiagonal,0]]:m.points;
  const scale=1-inset/m.inradius,cy=m.incenterY??0;
  points.forEach(([x,y],i)=>{const px=x*scale,py=cy+(y-cy)*scale;i?ctx.lineTo(px,py):ctx.moveTo(px,py)});
 }
 ctx.closePath();
}
export function outlineBands(shape,metrics,viewportScale=1){
 const requested=Math.min(shape.outline_width*viewportScale,metrics.inradius);
 if(!(requested>0))return [];
 if(shape.stem!=='drums')return [{width:requested,inset:requested/2}];
 const ratio=shape.drums_inner_ratio??.35;
 const gap=Math.min((shape.drums_outline_gap??6)*viewportScale,metrics.inradius*.12);
 const outer=Math.min(requested,(metrics.inradius*.85-gap)/(1+ratio)),inner=outer*ratio;
 return [{width:outer,inset:outer/2},{width:inner,inset:outer+gap+inner/2}];
}
export function paintEmotionShape(ctx,shape,x,y,radius,alpha,rgb,viewportScale=1,pass='all'){
 if(!shape||alpha<=0||radius<=0)return;
 const m=shapeMetrics(radius,shape.kind,shape.aspect),bands=outlineBands(shape,m,viewportScale);
 ctx.save();ctx.translate(x,y);ctx.rotate((shape.rotation_offset_degrees??0)*Math.PI/180);ctx.globalAlpha=alpha;
 ctx.fillStyle='rgb('+rgb.join(',')+')';ctx.strokeStyle='#000000';ctx.lineJoin='miter';ctx.miterLimit=4;ctx.setLineDash([]);
 traceInstrumentShape(ctx,shape.kind,m);if(pass!=='outline'){
  ctx.fill();
  if(shape.texture_enabled){ctx.save();ctx.clip();
   const extent=radius*4;
   paintPigmentTexture(ctx,{left:-extent,top:-extent,right:extent,bottom:extent},shape.stem,shape,viewportScale);
   paintEdgeTexture(ctx,shape.kind,m,shape.stem,shape,viewportScale,traceInstrumentShape);ctx.restore();
  }
 }
 // Separate inset contours keep a genuine colored gap, including at the diamond corners.
 if(pass!=='fill'&&shape.outline_enabled!==false&&bands.length){
  traceInstrumentShape(ctx,shape.kind,m);ctx.clip();
  for(const band of bands){ctx.lineWidth=band.width;traceInstrumentShape(ctx,shape.kind,m,band.inset);ctx.stroke();if(shape.texture_enabled)paintInkTexture(ctx,shape.stem,shape)}
 }
 ctx.restore();
}
