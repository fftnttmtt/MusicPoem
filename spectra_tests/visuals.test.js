import test from 'node:test';
import assert from 'node:assert/strict';
import {paintMotif} from '../spectra_web/visuals.js';

function record(shape,r,double=true){
 let path=[];const strokes=[],fills=[];
 const ctx={save(){},restore(){},translate(){},beginPath(){path=[]},closePath(){},
  moveTo(x,y){path.push([[x,y]])},lineTo(x,y){path.at(-1).push([x,y])},arc(x,y,r){path.push({radius:r})},
  fill(rule){fills.push({path,rule,color:this.fillStyle})},stroke(){strokes.push({path,width:this.lineWidth})}};
 paintMotif(ctx,{shape,double,body:'#ffff00',lines:'#0000ff'},0,0,r,1);
 return{strokes,fills};
}
const distanceToSide=(a,b,p)=>Math.abs((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]))/Math.hypot(b[0]-a[0],b[1]-a[1]);
test('epic uses two separate hollow blue bands with exactly 3 CSS px clear space',()=>{
 for(const size of [.55,1.5,1.6])for(const pulse of [1,1.05]){
  const radius=68*size/2.6*pulse,{strokes,fills}=record('up',radius);
  assert.equal(strokes.length,0);assert.equal(fills.length,3);
  assert.equal(fills[0].color,'#ffff00');
  const bands=fills.slice(1);assert.ok(bands.every(b=>b.color==='#0000ff'&&b.rule==='evenodd'&&b.path.length===2));
  for(let i=0;i<3;i++){
   const a=bands[0].path[0][i],b=bands[0].path[0][(i+1)%3],outerInner=bands[1].path[1][i];
   assert.ok(Math.abs(distanceToSide(a,b,outerInner)-3)<1e-10);
   for(const band of bands)assert.ok(Math.abs(distanceToSide(band.path[0][i],band.path[0][(i+1)%3],band.path[1][i])-4.8)<1e-10);
   assert.ok(Math.abs(Math.hypot(...fills[0].path[0][i])-radius)<1e-10);
  }
 }
});
test('downward double triangle strokes retain visible perpendicular gaps at minimum size',()=>{
 for(const size of [.55,1.5,1.6]){
  const radius=68*size/2.6,{strokes,fills}=record('down',radius);
  assert.equal(strokes.length,2);assert.ok(strokes.every(s=>s.width===4.8));
  assert.equal(fills.length,1);assert.deepEqual(fills[0].path,strokes[0].path);
  for(let i=0;i<3;i++)assert.ok(distanceToSide(strokes[0].path[0][i],strokes[0].path[0][(i+1)%3],strokes[1].path[0][i])-4.8>=3-1e-10);
 }
});
test('single triangles and double circles retain their previous outline layout',()=>{
 for(const shape of ['up','down'])assert.equal(record(shape,40,false).strokes.length,1);
 const {strokes}=record('circle',40);
 assert.equal(strokes[0].path[0].radius,40);
 assert.equal(strokes[1].path[0].radius,50.4);
});
