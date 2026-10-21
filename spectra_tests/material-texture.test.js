import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {materialParameters,MATERIAL_DEFAULTS,textureTile,setTextureCanvasFactory,paintPaperTexture} from '../spectra_web/material-texture.js?v=r56';
import {shapeForInstrument,shapeMetrics,outlineBands,paintEmotionShape,GEOMETRY_DEFAULTS} from '../spectra_web/emotion-shape.js';
import {paintOverlapShapes} from '../spectra_web/overlap-color.js';
const {createCanvas}=createRequire(import.meta.url)('@napi-rs/canvas');
setTextureCanvasFactory(createCanvas);
const pixel=(ctx,x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
function image(w=480,h=300){const c=createCanvas(w,h),ctx=c.getContext('2d');return{c,ctx}}
function draw(x=160,parameters={}){const {c,ctx}=image();ctx.fillStyle='#ddd1b4';ctx.fillRect(0,0,480,300);paintEmotionShape(ctx,shapeForInstrument('piano',6,5,{outline_piano_enabled:false,...parameters}),x,150,95,1,[202,82,52]);return{c,ctx}}

test('material settings are bounded, shared with geometry, seeded and cached without frame randomness',()=>{
 assert.deepEqual(materialParameters({}),MATERIAL_DEFAULTS);
 for(const [k,v] of Object.entries(MATERIAL_DEFAULTS))assert.equal(GEOMETRY_DEFAULTS[k],v);
 for(const key of ['texture_paper_strength','texture_pigment_strength','texture_edge_strength'])for(const v of [-.1,1.1,NaN,true])assert.throws(()=>materialParameters({[key]:v}));
 assert.throws(()=>materialParameters({texture_enabled:1}));
 const tile=textureTile('pigment','piano');assert.equal(tile,textureTile('pigment','piano'));assert.notEqual(tile,textureTile('pigment','drums'));
 const before=tile.getContext('2d').getImageData(0,0,384,384).data;
 setTextureCanvasFactory(createCanvas);assert.deepEqual(textureTile('pigment','piano').getContext('2d').getImageData(0,0,384,384).data,before);
});
test('paint visibly varies without changing musical hue into another fill, and zero/off restore exact flat color',()=>{
 const textured=draw(),off=draw(160,{texture_enabled:false}),zero=draw(160,{texture_paper_strength:0,texture_pigment_strength:0,texture_edge_strength:0});
 assert.deepEqual(pixel(off.ctx,160,150),[202,82,52,255]);assert.deepEqual(zero.c.toBuffer('image/png'),off.c.toBuffer('image/png'));
 const values=new Set();let means=[0,0,0],n=0;
 for(let y=90;y<210;y+=2)for(let x=100;x<220;x+=2){const p=pixel(textured.ctx,x,y);values.add(p.join(','));for(let i=0;i<3;i++)means[i]+=p[i];n++}
 assert.ok(values.size>50,'paint must be visible, not a no-op');
 for(const [i,v] of [202,82,52].entries())assert.ok(Math.abs(means[i]/n-v)<9,'keep mean predicted color');
 assert.deepEqual(pixel(textured.ctx,20,20),pixel(off.ctx,20,20),'clip material inside silhouette');
});
test('material is attached to the instrument, not screen coordinates or playback-frame random state',()=>{
 const a=draw(160),b=draw(300);draw(90,{texture_pigment_strength:1});const again=draw(160);
 assert.deepEqual(a.c.toBuffer('image/png'),again.c.toBuffer('image/png'));
 for(let y=100;y<200;y+=7)for(let x=-40;x<40;x+=7)assert.deepEqual(pixel(a.ctx,160+x,y),pixel(b.ctx,300+x,y));
});
test('static paper keeps the song background, changes it gently, and can be disabled',()=>{
 const {c,ctx}=image();ctx.fillStyle='rgb(130,160,170)';ctx.fillRect(0,0,480,300);const initial=c.toBuffer('image/png');
 paintPaperTexture(ctx,480,300,{texture_enabled:false});assert.deepEqual(c.toBuffer('image/png'),initial);
 paintPaperTexture(ctx,480,300);assert.notDeepEqual(c.toBuffer('image/png'),initial);
 for(let y=20;y<300;y+=31)for(let x=20;x<480;x+=31)assert.ok(pixel(ctx,x,y).slice(0,3).every((v,i)=>Math.abs(v-[130,160,170][i])<35));
});
test('drum double border has outer thick / inner thin bands and positive clear space at tiny and normal sizes',()=>{
 for(const radius of [.5,2,10,80,180])for(const scale of [.5,1,2]){
  const shape=shapeForInstrument('drums',5,9),m=shapeMetrics(radius,shape.kind),bands=outlineBands(shape,m,scale);
  assert.equal(bands.length,2);const [outer,inner]=bands;
  assert.ok(outer.width>inner.width&&inner.width>0);
  const gap=inner.inset-inner.width/2-(outer.inset+outer.width/2);assert.ok(gap>0);
  assert.ok(inner.inset+inner.width/2<m.inradius);assert.ok(Number.isFinite(gap));
 }
 const shape=shapeForInstrument('drums',5,6),m=shapeMetrics(100,'diamond'),[outer,inner]=outlineBands(shape,m);
 assert.ok(Math.abs(inner.inset-inner.width/2-outer.width-6)<1e-10);assert.equal(inner.width,outer.width*.35);
 const {ctx}=image(),r=100,center=[200,150];paintEmotionShape(ctx,{...shape,texture_enabled:false},...center,r,1,[220,110,70]);
 // Probe normal to the upper-right edge, away from vertices.
 const d=m.halfDiagonal,probe=inset=>pixel(ctx,Math.round(center[0]+d/2-inset/Math.sqrt(2)),Math.round(center[1]-d/2+inset/Math.sqrt(2)));
 assert.deepEqual(probe(outer.inset).slice(0,3),[0,0,0]);
 assert.deepEqual(probe(outer.width+3).slice(0,3),[220,110,70]);
 assert.deepEqual(probe(inner.inset).slice(0,3),[0,0,0]);
});
test('mixed regions retain actual predicted mixed color under stable material, with drum double borders painted last',()=>{
 const {ctx}=image(),shape=id=>shapeForInstrument(id,5,5),actors=[
  {id:'drums',x:180,y:150,radius:90,alpha:1,rgb:[200,70,50],form:shape('drums')},
  {id:'vocals',x:235,y:150,radius:95,alpha:1,rgb:[60,90,200],form:shape('vocals')}];
 const mixed=[40,170,105];paintOverlapShapes(ctx,actors,{combinations:[{stems:['drums','vocals'],segments:[{status:'ok',start_seconds:0,end_seconds:10,rgb:mixed}]}]},2,480,300);
 for(const [i,v] of pixel(ctx,210,150).slice(0,3).entries())assert.ok(Math.abs(v-mixed[i])<15,'mix prediction remains the base color');
 const {ctx:flat}=image();for(const a of actors)a.form.texture_enabled=false;
 paintOverlapShapes(flat,actors,{combinations:[{stems:['drums','vocals'],segments:[{status:'ok',start_seconds:0,end_seconds:10,rgb:mixed}]}]},2,480,300);
 assert.deepEqual(pixel(flat,210,150).slice(0,3),mixed);
});
