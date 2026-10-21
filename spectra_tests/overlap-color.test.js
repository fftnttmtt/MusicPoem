import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {shapeForInstrument,shapeMetrics,traceInstrumentShape,paintEmotionShape} from '../spectra_web/emotion-shape.js';
import {overlapKey,overlapColorAt,paintOverlapShapes,actorBounds} from '../spectra_web/overlap-color.js';
let createCanvas;try{({createCanvas}=createRequire(import.meta.url)('@napi-rs/canvas'))}catch{}
const row=rgb=>({status:'ok',start_seconds:0,end_seconds:10,rgb});
const combo=(stems,rgb)=>({key:overlapKey(stems),stems,segments:[row(rgb)]});
const actor=(id,x,y,rgb,kind='square')=>({id,x,y,radius:80/Math.sqrt(Math.PI),alpha:1,rgb,form:{...shapeForInstrument(id,5,5),kind,outline_enabled:false}});
const rgbAt=(ctx,x,y)=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3);
function blank(w=240,h=220){const canvas=createCanvas(w,h),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);return{canvas,ctx}}

test('overlap identities are canonical and invalid rows never fabricate mixed colors',()=>{
 assert.equal(overlapKey(['vocals','drums']),'drums+vocals');
 assert.equal(overlapColorAt({segments:[{...row([1,2,3]),status:'pending'}]},2),null);
 assert.equal(overlapColorAt(combo(['drums','vocals'],[1,2,3]),2).join(','),'1,2,3');
 assert.equal(overlapColorAt(combo(['drums','vocals'],[1,2,3]),11),null);
});
test('actual Canvas separates exact pair/triple regions, preserves single colors and excludes outsider holes',{skip:!createCanvas},()=>{
 const {ctx}=blank(),actors=[actor('drums',90,80,[255,0,0]),actor('vocals',130,80,[0,0,255]),actor('bass',110,120,[128,0,128])];
 const combinations=[combo(['drums','vocals'],[0,255,0]),combo(['drums','bass'],[255,0,255]),combo(['vocals','bass'],[0,255,255]),combo(['drums','vocals','bass'],[255,255,0])];
 paintOverlapShapes(ctx,actors,{combinations},1,240,220);
 assert.deepEqual(rgbAt(ctx,60,60),[255,0,0]);assert.deepEqual(rgbAt(ctx,160,60),[0,0,255]);
 assert.deepEqual(rgbAt(ctx,110,60),[0,255,0]);assert.deepEqual(rgbAt(ctx,80,100),[255,0,255]);
 assert.deepEqual(rgbAt(ctx,140,100),[0,255,255]);assert.deepEqual(rgbAt(ctx,110,100),[255,255,0]);
 assert.deepEqual(rgbAt(ctx,110,150),[128,0,128]);assert.deepEqual(rgbAt(ctx,210,200),[255,255,255]);
 // Missing triple predictions must not paint the triple with any pair's color.
 const c=blank().ctx;paintOverlapShapes(c,actors,{combinations:combinations.slice(0,3)},1,240,220);
 assert.deepEqual(rgbAt(c,110,100),[128,0,128]);
});
test('lower instrument outlines remain visible above later fills and mixed fills',{skip:!createCanvas},()=>{
 const {ctx}=blank(),a=actor('drums',90,80,[255,0,0]),b=actor('vocals',130,80,[0,0,255]);a.form.outline_enabled=true;a.form.outline_width=6;
 paintOverlapShapes(ctx,[a,b],{combinations:[combo(['drums','vocals'],[0,255,0])]},1,240,220);
 assert.deepEqual(rgbAt(ctx,127,70),[0,0,0]);
 const normal=blank().ctx;for(const item of [a,b])paintEmotionShape(normal,item.form,item.x,item.y,item.radius,item.alpha,item.rgb);
 assert.deepEqual(rgbAt(normal,127,70),[0,0,255]);
});
test('all six actual rotated contours receive exactly their subset color at interior pixels',{skip:!createCanvas},()=>{
 const stems=['bass','drums','other','vocals','guitar','piano'],{ctx}=blank(),probe=createCanvas(240,220).getContext('2d');
 const actors=stems.map((id,i)=>({id,x:95+(i%3)*18,y:75+Math.floor(i/3)*30,radius:43,alpha:1,rgb:[20+i*25,20,20],form:{...shapeForInstrument(id,5,5),outline_enabled:false,rotation_offset_degrees:i*23}}));
 const combinations=[],colors=new Map();
 for(let mask=1;mask<64;mask++){
  const ids=stems.filter((_,i)=>mask&(1<<i));if(ids.length<2)continue;
  const rgb=[mask*3,230-mask*2,60+mask];combinations.push(combo(ids,rgb));colors.set(overlapKey(ids),rgb);
 }
 paintOverlapShapes(ctx,actors,{combinations},1,240,220);
 function inside(a,x,y){probe.save();probe.translate(a.x,a.y);probe.rotate(a.form.rotation_offset_degrees*Math.PI/180);traceInstrumentShape(probe,a.form.kind,shapeMetrics(a.radius,a.form.kind,a.form.aspect));probe.restore();return probe.isPointInPath(x,y)}
 let checked=0,triple=0;
 for(let y=12;y<205;y+=6)for(let x=12;x<230;x+=6){
  const members=actors.filter(a=>inside(a,x+.5,y+.5));
  if(actors.some(a=>[[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([sx,sy])=>inside(a,sx+.5,sy+.5)!==members.includes(a))))continue;
  const expected=members.length>1?colors.get(overlapKey(members.map(a=>a.id))):members[0]?.rgb||[255,255,255];
  const actual=rgbAt(ctx,x,y);assert.ok(actual.every((v,i)=>Math.abs(v-expected[i])<=1),JSON.stringify({x,y,members:members.map(a=>a.id),actual,expected}));
  checked++;if(members.length>=3)triple++;
 }
 assert.ok(checked>300);assert.ok(triple>20);
 for(const a of actors){const bounds=actorBounds(a);assert.ok(bounds.right>bounds.left&&bounds.bottom>bounds.top)}
});
