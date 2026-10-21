import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TAGS,TAG_HUES,scoreRows,rowAt,timeLabel,stageEnabled,changedParameters,windowBounds,selectedRange} from '../spectra_web/lab/lab-model.js';

test('lab uses the exact nine tags, weights and original timeline boundaries',()=>{
 assert.equal(TAGS.length,9);assert.ok(!TAGS.includes('funny'));assert.equal(TAG_HUES.energetic,10);
 const weighted=scoreRows({happy:.5,love:.25},2);
 assert.equal(weighted.find(r=>r.tag==='happy').weight,.8);
 assert.equal(weighted.find(r=>r.tag==='love').weight,.2);
 assert.equal(weighted.find(r=>r.tag==='calm').score,null);
 assert.equal(rowAt([{start:0,end:2},{start:2,end:9},{start:9,end:12}],2),1);
 assert.equal(rowAt([{start_seconds:0},{start_seconds:2}],1.999),0);
 assert.equal(timeLabel(59.9996),'01:00.000');
 assert.deepEqual(windowBounds({prediction_start_seconds:2,prediction_end_seconds:8},12),[1.4,8.6]);
});
test('model stages require saved parameters and explicit ready dependencies',()=>{
 const m={stages:{meter:{status:'ready'},separation:{status:'ready'},features:{status:'stale'},emotion:{status:'partial'}}};
 assert.equal(stageEnabled('features',m,false,false),true);
 assert.equal(stageEnabled('emotion',m,false,false),false);
 assert.equal(stageEnabled('mapping',m,false,false),true);
 assert.equal(stageEnabled('meter',m,false,true),false);
 assert.equal(stageEnabled('meter',m,true,false),false);
 assert.deepEqual(changedParameters({hue_gamma:2,saturation_range:[.2,1]},{hue_gamma:1,saturation_range:[.2,1]}),{hue_gamma:1});
 assert.deepEqual(selectedRange('1','3',3),{bar_start:1,bar_end:3});
 for(const range of [[0,1],[1,4],[2,1],[1.5,2]])assert.throws(()=>selectedRange(...range,3));
});
test('workbench HTML and JS IDs match, with independent target/context audition',()=>{
 const html=readFileSync(new URL('../spectra_web/lab/index.html',import.meta.url),'utf8');
 const js=readFileSync(new URL('../spectra_web/lab/lab.js',import.meta.url),'utf8');
 const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
 for(const [,id] of js.matchAll(/\$\('([^']+)'\)/g))if(!id.endsWith('-'))assert.ok(ids.has(id),'missing DOM ID '+id);
 assert.match(js,/kind=target/);assert.match(js,/kind=context/);
 assert.match(js,/playbackTime\(state,performance.now\(\)\)/);
 assert.match(js,/dataset.logicalHeight\?\?=/);
 assert.match(html,/不自动加载模型/);
});
