import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {midiNote,frameIndex,diagnosticFrame,diagnosticSummary,diagnosticAt,drawPitchDiagnostics} from '../spectra_web/pitch-diagnostics.js';
let createCanvas;try{({createCanvas}=createRequire(import.meta.url)('@napi-rs/canvas'))}catch{}
function data(){
 const row=(a,b,m,from=m)=>({start_seconds:a,end_seconds:b,status:m===null?'unvoiced':'ok',midi:m,from_midi:from,target_midi:m??from,from_normalized:.5,target_normalized:.5,confidence:.95,confidence_median:.95});
 return{raw:{times:[0,.02,.04,.06,.08,.1],f0_hz:[440,880,660,440,null,440],voiced_flag:[true,true,true,false,false,true],voiced_probability:[.95,.95,.2,.95,.1,.95],rms:[.1,.1,.1,.1,.1,0]},
 pitch:{method:'pyin',confidence_threshold:.6,gate_dbfs:-55,midi_p5:68,midi_p95:70,continuous_tau_seconds:.06,
  rows:[row(0,.05,69),row(.05,.12,null,69)],continuous:[row(0,.02,69),row(.02,.04,81,69),row(.04,.12,null,70)]}};
}
test('diagnostics preserve absolute MIDI/note names and distinguish each rejection reason',()=>{
 const {raw,pitch}=data();assert.equal(midiNote(69),'A4');assert.equal(midiNote(60),'C4');assert.equal(midiNote(null),'—');
 assert.equal(frameIndex(raw.times,-.01),-1);assert.equal(frameIndex(raw.times,.039),1);
 assert.equal(diagnosticFrame(raw,pitch,0).midi,69);assert.equal(diagnosticFrame(raw,pitch,1).midi,81);
 assert.deepEqual(raw.times.map((_,i)=>diagnosticFrame(raw,pitch,i).reason),['accepted','accepted','low_probability','unvoiced','no_f0','quiet']);
 assert.equal(diagnosticFrame(raw,pitch,4).midi,null);
 const at=diagnosticAt(raw,pitch,.021);assert.equal(at.frame.hz,880);assert.equal(at.frame.note,'A5');
});
test('octave candidates are flagged as observations, excluded data cannot create jumps and summaries retain clipping counts',()=>{
 const {raw,pitch}=data(),summary=diagnosticSummary(raw,pitch);
 assert.equal(summary.counts.accepted,2);assert.equal(summary.counts.low_probability,1);assert.equal(summary.octaves.length,1);
 assert.equal(summary.octaves[0].time,.02);assert.equal(summary.clipped,1);assert.equal(summary.span,2);
 assert.equal(diagnosticSummary(raw,pitch),summary);
 assert.equal(diagnosticSummary(raw,{...pitch,confidence_threshold:.99}).counts.accepted,0);
});
test('actual Canvas diagnostic renders finite axes, all layers and both preview modes without mutating data',{skip:!createCanvas},()=>{
 const {raw,pitch}=data(),before=JSON.stringify({raw,pitch}),canvas=createCanvas(900,430),ctx=canvas.getContext('2d');
 for(const mode of ['beat_summary','continuous']){
  const bounds=drawPitchDiagnostics(ctx,900,430,{raw,pitch,beats:[0,.05,.1],time:.03,start:0,end:.12,mode});
  assert.ok(bounds.midiLow<69&&bounds.midiHigh>81);
  assert.equal(bounds.left,68);assert.equal(bounds.right,888);
  const rgba=ctx.getImageData(0,0,900,430).data;assert.ok(rgba.some((v,i)=>i%4===3&&v>0));
 }
 drawPitchDiagnostics(ctx,900,430,{raw,pitch,start:0,end:.12,layers:{raw:false,accepted:false,beat:false,position:false}});
 drawPitchDiagnostics(ctx,900,430,{raw:null,pitch:null});assert.equal(JSON.stringify({raw,pitch}),before);
});

test('Melodia confidence is not a pYIN probability; values above one stay visible and filter independently',async()=>{
 const {pitchConfidenceLabel}=await import('../spectra_web/pitch-diagnostics.js');
 const {raw,pitch}=data();pitch.method='melodia';pitch.confidence_threshold=1.5;raw.method='melodia';raw.voiced_probability[0]=2.4;
 assert.equal(pitchConfidenceLabel(pitch,raw),'Melodia 显著度置信值');
 assert.equal(diagnosticFrame(raw,pitch,0).accepted,true);
 assert.equal(diagnosticFrame(raw,pitch,1).reason,'low_probability');
 if(createCanvas){const canvas=createCanvas(900,430);assert.doesNotThrow(()=>drawPitchDiagnostics(canvas.getContext('2d'),900,430,{raw,pitch,start:0,end:.12}))}
});
