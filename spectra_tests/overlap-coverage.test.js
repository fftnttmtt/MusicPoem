import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {visibleOverlapAreas,scanOverlapCoverage,coverageMatches,coverageProfile} from '../spectra_web/overlap-coverage.js';
const actor=(id,x,y,r=10,kind='square')=>({id,x,y,radius:r,alpha:1,form:{kind,aspect:1,rotation_offset_degrees:0}});
const key=actors=>visibleOverlapAreas(actors,100,100).map(r=>r.key);
test('actual contours exclude circle pairs whose bounding boxes intersect but whose shapes do not',()=>{
 assert.deepEqual(key([actor('bass',30,30,20,'circle'),actor('drums',65,65,20,'circle')]),[]);
 assert.deepEqual(key([actor('bass',30,30,20,'circle'),actor('drums',50,30,20,'circle')]),['bass+drums']);
 assert.deepEqual(key([actor('bass',-30,30,10),actor('drums',-30,30,10)]),[]);
});
test('exact region sets exclude pairs fully covered by a third instrument and retain visible triple colors',()=>{
 const a=actor('bass',50,50),b=actor('drums',50,50),c=actor('vocals',50,50,40,'circle');
 assert.deepEqual(key([a,b,c]),['bass+drums+vocals']);
 c.x=90;const keys=key([a,b,c]);assert.ok(keys.includes('bass+drums'));assert.ok(keys.includes('bass+drums+vocals'));
});
test('rotation and viewport clipping use the real silhouette and finite subpixel regions',()=>{
 const a=actor('guitar',50,50,12,'triangle_up'),b=actor('drums',50,50,12,'diamond');a.form.rotation_offset_degrees=60;
 const areas=visibleOverlapAreas([a,b],100,100);assert.equal(areas.length,1);assert.equal(areas[0].key,'drums+guitar');assert.ok(areas[0].area>0&&Number.isFinite(areas[0].area));
 b.alpha=0;assert.deepEqual(key([a,b]),[]);
});
test('the trajectory scanner catches overlaps inside a bar and requests only that combination and bar',async()=>{
 const bundle={scene_revision:'test',audio:{duration_seconds:1},beats:[0,.5],bars:[{start_seconds:0,end_seconds:.5},{start_seconds:.5,end_seconds:1}],stems:[{motion:{times:[0,.25,.5,1]}}]};
 const coverage=await scanOverlapCoverage(bundle,{size:1},100,56.25,{yieldEvery:Infinity,actorStates:(p,t)=>{
  const u=Math.min(t,.5);return[actor('bass',10+160*u,25,5),actor('drums',90-160*u,25,5)]}});
 assert.deepEqual(coverage.requirements,{'bass+drums':[1]});assert.equal(coverage.required_count,1);assert.equal(coverage.theoretical_count,114);assert.ok(coverage.sampling.samples>60);
 const scene={size:1};assert.equal(coverageMatches(coverage,bundle,scene,100,56.25),true);
 for(const change of [{size:1.1},{pitchMode:'continuous'},{solo:true,stem:'bass'},{geometry:{foote_motion_enabled:false}},{geometry:{rotation_enabled:false}}])assert.equal(coverageMatches(coverage,bundle,change,100,56.25),false);
 assert.equal(coverageMatches(coverage,{...bundle,scene_revision:'changed'},scene,100,56.25),false);
 assert.equal(coverageMatches(coverage,bundle,scene,200,112.5),false);
 assert.equal(coverageMatches({...coverage,profile:{...coverage.profile,revision:1}},bundle,scene,100,56.25),false);
});
test('real mapped six-stem motion produces fewer required jobs than the exhaustive baseline',async()=>{
 const bundle=JSON.parse(readFileSync(new URL('./fixtures/lab-r37.json',import.meta.url),'utf8'));
 const coverage=await scanOverlapCoverage(bundle,{size:1,geometry:{rotation_enabled:true,foote_motion_enabled:true}},960,540,{yieldEvery:Infinity});
 assert.ok(coverage.required_count>0);assert.ok(coverage.required_count<57*bundle.bars.length);
 for(const rows of Object.values(coverage.requirements))assert.ok(rows.every(i=>i>=1&&i<=bundle.bars.length));
});
