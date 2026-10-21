import {clamp,lerp,smoothstep,randomGenerator} from './core.js?v=stems-r33';
import {beatIndexAt} from './beat-events.js?v=stems-r33';
export const EPIC_OUTLINE_GAP=3;
// VEO motifs: body and surrounding lines retain their separate emotion colors.
export const MOTIFS=[
  {name:'快乐',shape:'circle',body:'#ffff00',lines:'#ff9900',double:true},
  {name:'希望',shape:'circle',body:'#ffffff',lines:'#ffff00',double:false},
  {name:'兴趣',shape:'circle',body:'#ff9900',lines:'#ffff00',double:false},
  {name:'愤怒',shape:'down',body:'#ff0000',lines:'#000000',double:true},
  {name:'悲伤',shape:'down',body:'#0000ff',lines:'#800080',double:true},
  {name:'恐惧',shape:'down',body:'#000000',lines:'#800080',double:true},
  {name:'厌恶',shape:'down',body:'#008000',lines:'#804000',double:true},
  {name:'惊讶',shape:'up',body:'#ffff00',lines:'#0000ff',double:true}
];
const COLORS=[[62,84,115],[116,65,87],[48,91,80],[119,95,54],[79,65,110],[48,85,106],[121,87,67],[74,96,118]];
export function demoScene(seed,segment){
  const random=randomGenerator((seed+Math.imul(segment+1,0x9e3779b9))>>>0);
  return{motif:MOTIFS[Math.floor(random()*MOTIFS.length)],background:COLORS[Math.floor(random()*COLORS.length)]};
}
export function backgroundAt(seed,beats,duration,time){
  const index=Math.max(0,beatIndexAt(beats,time)),segment=Math.floor(index/16),current=demoScene(seed,segment);
  if(!segment)return current.background;
  const start=beats[segment*16],end=beats[(segment+1)*16]??duration;
  const mix=smoothstep(clamp((time-start)/Math.min(.8,Math.max(.1,(end-start)*.15)),0,1));
  return current.background.map((v,i)=>Math.round(lerp(demoScene(seed,segment-1).background[i],v,mix)));
}
function trianglePath(ctx,shape,r){
  const first=shape==='down'?Math.PI/2:-Math.PI/2;
  for(let i=0;i<3;i++){const angle=first+i*Math.PI*2/3,x=Math.cos(angle)*r,y=Math.sin(angle)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}
  ctx.closePath();
}
function bodyPath(ctx,shape,r){
  ctx.beginPath();
  if(shape==='circle')ctx.arc(0,0,r,0,Math.PI*2);
  else trianglePath(ctx,shape,r);
}
export function paintMotif(ctx,motif,x,y,r,alpha){
  if(alpha<=.001)return;
  ctx.save();ctx.translate(x,y);ctx.globalAlpha=alpha;
  ctx.lineCap='butt';ctx.lineJoin='miter';ctx.miterLimit=3;
  bodyPath(ctx,motif.shape,r);ctx.fillStyle=motif.body;ctx.fill();
  ctx.strokeStyle=motif.lines;ctx.lineWidth=4.8;
  if(motif.double&&motif.shape==='up'){
    // Explicit hollow bands: no shared stroke path or miter join. A radial
    // width of 2*w gives a perpendicular band thickness of w on a triangle.
    const width=4.8,step=2*(width+EPIC_OUTLINE_GAP);
    ctx.fillStyle=motif.lines;
    for(const center of [r,r+step]){
      ctx.beginPath();trianglePath(ctx,motif.shape,center+width);
      trianglePath(ctx,motif.shape,Math.max(.1,center-width));
      ctx.fill('evenodd');
    }
    ctx.restore();return;
  }
  // A single/doubled line becomes one/two complete, nested outlines.
  // An equilateral triangle's inradius is half its circumradius. Double
  // the radial increment to match the circle's perpendicular edge spacing,
  // and retain at least 3 px of clear space with the thick 4.8 px strokes.
  const outlineStep=motif.shape==='circle'?r*.26:2*Math.max(r*.26,ctx.lineWidth+3);
  for(let layer=0;layer<(motif.double?2:1);layer++){
    bodyPath(ctx,motif.shape,r+layer*outlineStep);ctx.closePath();ctx.stroke();
  }
  ctx.restore();
}
