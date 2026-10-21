import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GEOMETRY_DEFAULTS,INSTRUMENT_SHAPES,OUTLINE_MULTIPLIERS,geometryParameters,trackEmotionReference,rotationReference,shapeForInstrument,emotionShapeAt,shapeMetrics,traceInstrumentShape,paintEmotionShape} from '../spectra_web/emotion-shape.js';
import {actorPolygon,visibleOverlapAreas} from '../spectra_web/overlap-coverage.js';
import {actorBounds} from '../spectra_web/overlap-color.js';

function contour(kind,metrics,inset=0){
 const points=[],ctx={beginPath(){},closePath(){},moveTo(x,y){points.push([x,y])},lineTo(x,y){points.push([x,y])},
  rect(x,y,w,h){points.push([x,y],[x+w,y],[x+w,y+h],[x,y+h])},
  arc(x,y,r,a,b){for(let i=0;i<=4096;i++){const theta=a+(b-a)*i/4096;points.push([x+r*Math.cos(theta),y+r*Math.sin(theta)])}}};
 traceInstrumentShape(ctx,kind,metrics,inset);return points;
}
function polygonProperties(points){
 let twiceArea=0,cx=0,cy=0;
 points.forEach(([x,y],i)=>{const[nx,ny]=points[(i+1)%points.length],cross=x*ny-y*nx;twiceArea+=cross;cx+=(x+nx)*cross;cy+=(y+ny)*cross});
 return{area:Math.abs(twiceArea/2),cx:cx/(3*twiceArea),cy:cy/(3*twiceArea)};
}

test('high-valence other has its curved arc below the straight edge, low valence flips it upward',()=>{
 const track={id:'other',segments:[{status:'ok',start_seconds:0,end_seconds:1,valence:9,arousal:5},
  {status:'ok',start_seconds:1,end_seconds:2,valence:1,arousal:5}]};
 const m=shapeMetrics(40,'semicircle'),points=contour('semicircle',m);
 for(const [time,down] of [[.5,true],[2-1e-8,false]]){
  const shape=emotionShapeAt(track,time),theta=shape.rotation_offset_degrees*Math.PI/180;
  const y=([x,y])=>x*Math.sin(theta)+y*Math.cos(theta),edge=y(points[0]),pole=y([0,m.centerY+m.radius]);
  assert.equal(pole>edge,down);assert.equal(pole>0,down);
 }
 assert.equal(emotionShapeAt(track,1.5,{rotation_enabled:false}).rotation_offset_degrees,0);
 assert.ok(m.centerY<0&&m.centerY+m.radius>0);
});
test('flipped semicircle paint, overlap polygon and bounds describe the same silhouette',()=>{
 for(const angle of [0,40,90,180,-120]){
  const actor={id:'other',x:50,y:50,radius:20,alpha:1,form:{kind:'semicircle',rotation_offset_degrees:angle}};
  const box=actorBounds(actor);
  for(const [x,y] of actorPolygon(actor))assert.ok(x>=box.left-1e-8&&x<=box.right+1e-8&&y>=box.top-1e-8&&y<=box.bottom+1e-8);
 }
 const actors=[{id:'other',x:50,y:50,radius:20,alpha:1,form:{kind:'semicircle'}},
  {id:'vocals',x:50,y:65,radius:1,alpha:1,form:{kind:'circle'}}];
 assert.ok(visibleOverlapAreas(actors,100,100).some(r=>r.key==='other+vocals'&&r.area>2));
});

test('six instrument identities stay fixed across all emotion quadrants and retain arousal outlines',()=>{
 const kinds={bass:'rectangle',drums:'diamond',other:'semicircle',vocals:'circle',guitar:'triangle_up',piano:'square'};
 for(const [stem,kind] of Object.entries(kinds))for(const v of [1,5,9])for(const a of [1,5,9]){
  const s=shapeForInstrument(stem,v,a);assert.equal(s.kind,kind);assert.equal(s.outline_width,1.5*OUTLINE_MULTIPLIERS[stem]*a);assert.equal(s.outline_enabled,['drums','piano','guitar'].includes(stem));
 }
 assert.equal(INSTRUMENT_SHAPES.bass.aspect,3);assert.equal(INSTRUMENT_SHAPES.guitar.aspect,.8);
 assert.equal(INSTRUMENT_SHAPES.drums.rotation_degrees,45);
 assert.equal(shapeForInstrument('vocals',5,6,{outline_arousal_scale:2}).outline_width,12);
 assert.equal(shapeForInstrument('unknown',5,5),null);assert.equal(shapeForInstrument('vocals',NaN,5),null);
 for(const p of [{outline_arousal_scale:0},{outline_arousal_scale:NaN},{outline_arousal_scale:11}])assert.throws(()=>geometryParameters(p));
 assert.deepEqual(geometryParameters({}),GEOMETRY_DEFAULTS);
});
test('diagnostic means continue to exclude missing, silent and malformed rows without controlling shape',()=>{
 const r=trackEmotionReference({segments:[{status:'ok',valence:7,arousal:7},{status:'ok',valence:3,arousal:3},
  {status:'silent',valence:100,arousal:100},{status:'pending'},{status:'ok',valence:NaN,arousal:4}]});
 assert.equal(r.valence_mean,5);assert.equal(r.arousal_mean,5);assert.equal(r.valid_segments,2);assert.equal(r.complete,false);
 assert.equal(trackEmotionReference({segments:[{status:'silent'}]}).valence_mean,null);
});
test('all six actual contours have equal RMS-driven area and area centroid at the mapped position',()=>{
 for(const identity of Object.values(INSTRUMENT_SHAPES)){
  const m=shapeMetrics(40,identity.kind,identity.aspect),points=contour(identity.kind,m),p=polygonProperties(points);
  assert.ok(Math.abs(p.area/(Math.PI*1600)-1)<.00001,identity.kind+' area');
  assert.ok(Math.abs(p.cx)<.001&&Math.abs(p.cy)<.001,identity.kind+' center');
  if(identity.kind==='rectangle')assert.ok(Math.abs(m.width/m.height-3)<1e-12);
  if(identity.kind==='triangle_up'){
   assert.equal(points.length,3);assert.ok(points[0][1]<0);assert.ok(Math.abs(m.width/m.height-.8)<1e-12);
  }
  if(identity.kind==='diamond')assert.equal(points.length,4);
  if(identity.kind==='semicircle'){
   assert.ok(Math.abs(points[0][1]-points.at(-1)[1])<1e-10);
   assert.ok(Math.max(...points.map(p=>p[1]))>0);assert.ok(points[0][1]<0);
  }
 }
});
test('black borders scale with arousal and stay clipped inside all six silhouettes, including tiny shapes',()=>{
 for(const identity of Object.values(INSTRUMENT_SHAPES))for(const radius of [1,40]){
  const calls=[],ctx=new Proxy({},{get:(o,k)=>k in o?o[k]:(...args)=>calls.push([k,...args]),set:(o,k,v)=>(o[k]=v,true)});
  paintEmotionShape(ctx,{...identity,outline_width:9},100,200,radius,.8,[20,40,60],.75);
  assert.equal(calls.filter(c=>c[0]==='fill').length,1);assert.equal(calls.filter(c=>c[0]==='stroke').length,1);
  assert.equal(calls.filter(c=>c[0]==='clip').length,1);
  assert.equal(ctx.strokeStyle,'#000000');assert.equal(ctx.fillStyle,'rgb(20,40,60)');
  const m=shapeMetrics(radius,identity.kind,identity.aspect);assert.equal(ctx.lineWidth,Math.min(6.75,m.inradius));
  for(const c of calls.filter(c=>['translate','moveTo','lineTo','arc','rect'].includes(c[0])))assert.ok(c.slice(1).every(v=>Number.isFinite(v)));
  const inner=polygonProperties(contour(identity.kind,m,ctx.lineWidth/2));assert.ok(inner.area>0&&inner.area<m.area);
 }
});
test('identity remains fixed across bars while border smoothly interpolates over full bar with deterministic seeks',()=>{
 for(const [stem,identity] of Object.entries(INSTRUMENT_SHAPES)){
  const track={id:stem,segments:[{status:'ok',start_seconds:0,end_seconds:2,valence:3,arousal:1},
   {status:'ok',start_seconds:2,end_seconds:6,valence:7,arousal:9},
   {status:'ok',start_seconds:6,end_seconds:9,valence:3,arousal:3}]};
  for(const t of [0,1.999,2,4,6,8])assert.equal(emotionShapeAt(track,t).kind,identity.kind);
  assert.equal(emotionShapeAt(track,2).outline_width,1.5*OUTLINE_MULTIPLIERS[stem]);assert.equal(emotionShapeAt(track,4).outline_width,1.5*OUTLINE_MULTIPLIERS[stem]*5);
  assert.equal(emotionShapeAt(track,6).outline_width,1.5*OUTLINE_MULTIPLIERS[stem]*9);
  const expected=emotionShapeAt(track,4);for(const t of [8,0,6.2])emotionShapeAt(track,t);
  assert.deepEqual(emotionShapeAt(track,4),expected);
 }
});
test('Python export and live renderer agree on fixed identities, geometry rows and retained diagnostic means',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
 assert.equal(fixture.geometry.default_size_percent,100);assert.deepEqual(fixture.geometry.instrument_shapes,INSTRUMENT_SHAPES);
 for(const track of fixture.stems){
  assert.deepEqual(trackEmotionReference(track),track.shape_reference);assert.deepEqual(rotationReference(track),track.rotation_reference);assert.deepEqual(track.shape_identity,INSTRUMENT_SHAPES[track.id]);
  for(const row of track.segments)assert.equal(emotionShapeAt(track,row.start_seconds)?.kind??null,row.geometry_kind);
 }
});

test('rotation uses independent valid-bar P10/P90 endpoints, clamps outliers and respects per-stem directions',async()=>{
 const {rotationReference,valenceRotation}=await import('../spectra_web/emotion-shape.js');
 const track={segments:[1,3,5,7,9].map(v=>({status:'ok',valence:v,arousal:5}))};
 track.segments.push({status:'silent',valence:100,arousal:5},{status:'pending'});
 const r=rotationReference(track);assert.ok(Math.abs(r.valence_low-1.8)<1e-10);assert.ok(Math.abs(r.valence_high-8.2)<1e-10);
 assert.equal(r.complete,false);assert.equal(r.valid_segments,5);
 for(const stem of ['drums','piano','other']){
  assert.equal(valenceRotation(stem,1,r),-180);assert.equal(valenceRotation(stem,9,r),0);
  assert.ok(Math.abs(valenceRotation(stem,5,r)+90)<1e-10);
 }
 for(const stem of ['bass','guitar']){
  assert.equal(valenceRotation(stem,1,r),180);assert.equal(valenceRotation(stem,9,r),0);
  assert.ok(Math.abs(valenceRotation(stem,5,r)-90)<1e-10);
 }
 assert.equal(valenceRotation('vocals',1,r),0);assert.equal(valenceRotation('guitar',1,r,false),0);
 const flat=rotationReference({segments:[{status:'ok',valence:6,arousal:5}]});
 assert.equal(flat.constant,true);assert.equal(valenceRotation('guitar',1,flat),0);
 const shifted=rotationReference({segments:[{status:'ok',valence:6,arousal:5},{status:'ok',valence:8,arousal:5}]});
 assert.notEqual(shifted.valence_low,r.valence_low);
});
test('rotation is continuous from the current boundary over its entire bar and toggles restore upright pose',()=>{
 const track={id:'guitar',segments:[{status:'ok',start_seconds:0,end_seconds:2,valence:1,arousal:3},
  {status:'ok',start_seconds:2,end_seconds:6,valence:9,arousal:7}]};
 assert.equal(emotionShapeAt(track,1.999).rotation_offset_degrees,180);
 assert.equal(emotionShapeAt(track,2).rotation_offset_degrees,180);
 assert.equal(emotionShapeAt(track,4).rotation_offset_degrees,90);
 assert.ok(emotionShapeAt(track,5.99).rotation_offset_degrees<.01);
 const remembered=emotionShapeAt(track,4);emotionShapeAt(track,.1);assert.deepEqual(emotionShapeAt(track,4),remembered);
 assert.equal(emotionShapeAt(track,4,{rotation_enabled:false}).rotation_offset_degrees,0);
 assert.equal(emotionShapeAt(track,4,{outline_enabled:false}).outline_enabled,false);
 assert.throws(()=>geometryParameters({outline_enabled:1}),/开关/);assert.throws(()=>geometryParameters({rotation_enabled:'true'}),/开关/);
});
test('renderer rotates around the mapped centroid and outline-off skips both stroke and clipping',()=>{
 const calls=[],ctx=new Proxy({},{get:(o,k)=>k in o?o[k]:(...args)=>calls.push([k,...args]),set:(o,k,v)=>(o[k]=v,true)});
 paintEmotionShape(ctx,{kind:'semicircle',outline_width:8,outline_enabled:false,rotation_offset_degrees:90},120,80,40,1,[10,20,30]);
 assert.deepEqual(calls.find(c=>c[0]==='translate'),['translate',120,80]);
 assert.deepEqual(calls.find(c=>c[0]==='rotate'),['rotate',Math.PI/2]);
 assert.equal(calls.filter(c=>c[0]==='fill').length,1);assert.equal(calls.filter(c=>c[0]==='stroke').length,0);assert.equal(calls.filter(c=>c[0]==='clip').length,0);
});
test('painting order enforces requested occlusion without mutating data or voice order',async()=>{
 const {DRAW_ORDER,orderActorsForPainting}=await import('../spectra_web/emotion-shape.js');
 const input=['vocals','drums','other','piano','bass','guitar'].map(id=>({id})),before=input.map(a=>a.id);
 assert.deepEqual(orderActorsForPainting(input).map(a=>a.id),['bass','guitar','piano','other','drums','vocals']);
 assert.deepEqual(input.map(a=>a.id),before);assert.equal(DRAW_ORDER.at(-1),'vocals');
});


test('exported outline and rotation switches are honored when no live override is supplied',async()=>{
 const {stemStatesAt}=await import('../spectra_web/stem-player.js');
 const p=JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
 p.geometry.parameters={...p.geometry.parameters,outline_enabled:false,rotation_enabled:false};
 const actors=stemStatesAt(p,4,4,{parametricShape:true},960,540);
 assert.ok(actors.length>0);assert.ok(actors.every(a=>a.form.outline_enabled===false&&a.form.rotation_offset_degrees===0));
});

test('per-instrument border switches compose with master and restore selection without changing silhouettes',()=>{
 for(const stem of Object.keys(INSTRUMENT_SHAPES)){
  const key='outline_'+stem+'_enabled',original=shapeForInstrument(stem,5,6);
  assert.equal(shapeForInstrument(stem,5,6,{[key]:true}).outline_enabled,true);
  assert.equal(shapeForInstrument(stem,5,6,{[key]:false}).outline_enabled,false);
  const muted=shapeForInstrument(stem,5,6,{[key]:true,outline_enabled:false});
  assert.equal(muted.outline_enabled,false);assert.equal(muted.kind,original.kind);
  assert.equal(muted.outline_width,original.outline_width);
  assert.throws(()=>geometryParameters({[key]:1}),/开关/);
 }
});
test('mapped border settings and coefficients agree with Python export',()=>{
 const p=JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
 assert.deepEqual(p.geometry.outline_multipliers,OUTLINE_MULTIPLIERS);
 for(const stem of Object.keys(INSTRUMENT_SHAPES)){
  assert.equal(p.geometry.outline_instruments[stem],p.geometry.parameters['outline_'+stem+'_enabled']);
  assert.equal(p.geometry.parameters['outline_'+stem+'_enabled'],GEOMETRY_DEFAULTS['outline_'+stem+'_enabled']);
 }
});

test('independent outline multipliers affect only the selected stem and accept zero safely',()=>{
 const normal=shapeForInstrument('drums',5,6),custom=shapeForInstrument('drums',5,6,{outline_drums_multiplier:2.4});
 assert.equal(custom.outline_width,normal.outline_width*2);assert.equal(custom.kind,normal.kind);
 assert.deepEqual(shapeForInstrument('guitar',5,6,{outline_drums_multiplier:2.4}),shapeForInstrument('guitar',5,6));
 for(const stem of Object.keys(OUTLINE_MULTIPLIERS))for(const value of [-1,10.1,NaN,Infinity,true,'1'])assert.throws(()=>geometryParameters({['outline_'+stem+'_multiplier']:value}),/倍率/);
 const calls=[],ctx=new Proxy({},{get:(o,k)=>o[k]??((...args)=>calls.push([k,...args])),set:(o,k,v)=>(o[k]=v,true)});
 paintEmotionShape(ctx,shapeForInstrument('drums',5,6,{outline_drums_multiplier:0}),10,10,30,1,[100,120,140]);
 assert.equal(calls.filter(c=>c[0]==='fill').length,1);assert.equal(calls.filter(c=>c[0]==='stroke').length,0);
});
