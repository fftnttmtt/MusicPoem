import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EMOTION_GROUPS,apportionMotifs,assignEventMotifs,preparePrediction,predictedBackground,intervalAt} from '../spectra_web/prediction.js';
import {transitionColor} from '../spectra_web/color-transition.js';

const fixture=()=>({schema:'spectra-prediction-v1',prediction_unit:'bar',audio:{duration_seconds:8,sha256:'correct'},beats:[0,.5,1,2,3,4,5,6,7],
 bars:[{id:1,start_seconds:0,end_seconds:4},{id:2,start_seconds:4,end_seconds:8}],
 segments:[{segment:1,status:'ok',start_seconds:0,end_seconds:4,rgb:[255,0,0],hex:'#ff0000',tag_scores:{happy:.5,love:.25,funny:1}},
 {segment:2,status:'ok',start_seconds:4,end_seconds:8,rgb:[0,0,255],hex:'#0000ff',tag_scores:{sad:1}}]});

test('all seven emotion geometries exactly match the requested bodies and outlines',()=>{
 assert.deepEqual(EMOTION_GROUPS.map(g=>[g.tags,g.shape,g.body,g.lines,g.double]),[
  [['calm','nature'],'circle','#008000','#0000ff',false],
  [['romantic','love'],'circle','#ff0000','#ffc0cb',false],
  [['dream'],'circle','#ffffff','#ffff00',false],
  [['sad'],'down','#0000ff','#808080',false],
  [['epic'],'up','#ffff00','#0000ff',true],
  [['happy'],'circle','#ffff00','#ff9900',true],
  [['energetic'],'circle','#ff9900','#ffff00',false]
 ]);
});
test('the user example always gives two happy and one love, in seeded random positions',()=>{
 const orders=new Set();
 for(let seed=1;seed<=100;seed++){
  const result=apportionMotifs({happy:.5,love:.25},3,seed).map(m=>m.id);
  assert.equal(result.filter(t=>t==='happy').length,2);assert.equal(result.filter(t=>t==='love').length,1);
  orders.add(result.join(','));
 }
 assert.equal(orders.size,3);
 const amplified=apportionMotifs({happy:.5,love:.25},5,7).map(m=>m.id);
 assert.equal(amplified.filter(t=>t==='happy').length,4);
 assert.equal(amplified.filter(t=>t==='love').length,1);
});
test('apportionment preserves total and nearest quotas, groups identical motifs and ignores funny',()=>{
 for(let n=1;n<=100;n++){
  const shapes=apportionMotifs({happy:.5,love:.25,sad:.17,dream:.08,funny:1},n,77);
  assert.equal(shapes.length,n);
  const total=.5**2+.25**2+.17**2+.08**2;
  for(const [id,p] of [['happy',.5],['love',.25],['sad',.17],['dream',.08]])assert.ok(Math.abs(shapes.filter(m=>m.id===id).length-n*p**2/total)<1.00001);
 }
 assert.deepEqual(apportionMotifs({calm:.5,nature:.5,happy:1},2,1).map(m=>m.id).sort(),['calm','happy']);
 // Square each original tag, then combine identical motifs: .5²+.5² versus 1².
 assert.deepEqual(apportionMotifs({calm:.5,nature:.5,happy:1},3,1).map(m=>m.id).sort(),['calm','happy','happy']);
 assert.equal(apportionMotifs({funny:1},5,1).length,0);
 assert.equal(apportionMotifs({energetic:.001},3,1).length,3); // no .3 cutoff
 assert.equal(apportionMotifs({happy:0,sad:NaN},5,1).length,0);
});
test('bar ownership uses birth time, is stable on seek/replay and does not mutate motion',()=>{
 const p=preparePrediction(fixture(),8,'correct');
 const events=[0,1,2,4,5].map((born,i)=>({id:i+1,born,end:8,motion:Float32Array.of(0,1),keys:[{time:born,value:0}]}));
 const before=events.map(e=>({born:e.born,motion:Array.from(e.motion),keys:e.keys}));
 assignEventMotifs(events,p,4);const first=events.map(e=>[e.motif.id,e.predictionBar]);
 assert.equal(first.slice(0,3).filter(([t])=>t==='happy').length,2);
 assert.ok(first.slice(3).every(([t,b])=>t==='sad'&&b===2));
 assignEventMotifs(events,p,4);assert.deepEqual(events.map(e=>[e.motif.id,e.predictionBar]),first);
 assert.deepEqual(events.map(e=>({born:e.born,motion:Array.from(e.motion),keys:e.keys})),before);
 assert.equal(intervalAt(p.bars,4).id,2);assert.equal(intervalAt(p.bars,8).id,2);
});
test('beat predictions and forced target splits pool by target overlap, not extended model context',()=>{
 const f=fixture();f.prediction_unit='beat';f.segments=[
  {...f.segments[0],end_seconds:1,tag_scores:{happy:1},prediction_start_seconds:0,prediction_end_seconds:6},
  {...f.segments[0],start_seconds:1,end_seconds:4,tag_scores:{love:1},prediction_start_seconds:0,prediction_end_seconds:6},f.segments[1]];
 const p=preparePrediction(f,8);
 assert.equal(p.bars[0].tag_scores.happy,.25);assert.equal(p.bars[0].tag_scores.love,.75);
 assert.equal(p.bars[1].tag_scores.sad,1);assert.equal(p.bars[1].tag_scores.love,0);
});
test('invalid, mismatched or incomplete imports fail explicitly; missing predictions stay missing',()=>{
 assert.throws(()=>preparePrediction(fixture(),9),/时长/);
 assert.throws(()=>preparePrediction(fixture(),8,'wrong'),/另一份/);
 assert.throws(()=>preparePrediction({segments:[]},8),/SPECTRA/);
 const f=fixture();f.beats=[1,1];assert.throws(()=>preparePrediction(f,8),/节拍/);
 const bad=fixture();bad.segments[1].status='prediction_error';bad.segments[1].tag_scores={};
 const p=preparePrediction(bad,8);const events=[{id:1,born:4,motif:{id:'old'}}];assignEventMotifs(events,p,1);
 assert.equal(events[0].motif,undefined);assert.deepEqual(predictedBackground(p,4),[0,0,0]);
});

test('real Python default mapper matches JS colors at boundaries and Foote fades, including errors',()=>{
 const {bundle,times,expected}=JSON.parse(readFileSync(new URL('./fixtures/default-prediction.json',import.meta.url),'utf8')),p=preparePrediction(bundle,8);
 times.forEach((t,i)=>assert.deepEqual(predictedBackground(p,t),expected[i]));
 for(const row of p.segments)assert.ok(!('funny' in row.tag_scores));
 for(const event of p.transition.runs[0].events){
  assert.equal(event.start_seconds,event.boundary_seconds);
  assert.deepEqual(predictedBackground(p,event.start_seconds-1e-6),p.segments[event.from_index].rgb);
  assert.deepEqual(predictedBackground(p,event.end_seconds),p.segments[event.to_index].rgb);
 }
 assert.equal(p.defaults.hue_gamma,2);assert.equal(p.defaults.saturation_k,0);assert.equal(p.defaults.max_transition_fraction,.15);
});

test('existing exports are upgraded without re-predicting and never show the next color before its boundary',()=>{
 const legacy=JSON.parse(readFileSync(new URL('./fixtures/legacy-prediction.json',import.meta.url),'utf8')).bundle;
 const original=JSON.stringify(legacy),p=preparePrediction(legacy,8);
 assert.equal(JSON.stringify(legacy),original);
 assert.equal(p.transition.mode,'boundary_start');
 const fresh=preparePrediction(JSON.parse(readFileSync(new URL('./fixtures/default-prediction.json',import.meta.url),'utf8')).bundle,8);
 for(let t=0;t<8;t+=.005)assert.deepEqual(predictedBackground(p,t),predictedBackground(fresh,t));
});
