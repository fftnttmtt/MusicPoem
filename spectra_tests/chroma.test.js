import test from 'node:test';
import assert from 'node:assert/strict';
import {chromaBarCount,sampleChromaSpectrum,createChromaPlot,paintChromaBars,findSpectrumPeaks} from '../spectra_web/chroma.js';

test('bars match the uploaded CHROMA reference sampling and rectangles',()=>{
  const bytes=Uint8Array.from({length:1024},(_,i)=>(i*71+19)%256);
  for(const [width,height] of [[320,640],[375,812],[800,720],[1206,1088],[1920,1080]]){
    const n=Math.min(100,Math.max(24,Math.floor(width*.78/7))),gap=width<500?2:4;
    const bw=Math.max(1,(width*.78-(n-1)*gap)/n),left=width*.11;
    const plot=createChromaPlot(width,height),levels=sampleChromaSpectrum(bytes,n),rectangles=[];
    const ctx=new Proxy({}, {get:(o,k)=>k in o?o[k]:(...a)=>{if(k==='fillRect')rectangles.push(a);assert.ok(a.filter(v=>typeof v==='number').every(Number.isFinite))},set:(o,k,v)=>{o[k]=v;return true}});
    paintChromaBars(ctx,plot,levels,[91,111,135]);
    assert.equal(plot.count,n);assert.equal(rectangles.length,n);
    for(let i=0;i<n;i++){
      const value=bytes[Math.floor(i*300/n)]/255,h=Math.max(2,value*height*.58);
      const expected=[left+i*(bw+gap),height*.5-h/2,bw,h];
      rectangles[i].forEach((v,k)=>assert.ok(Math.abs(v-expected[k])<.00003));
      assert.ok(Math.abs(plot.x(i)-(expected[0]+bw/2))<1e-8);
      assert.ok(Math.abs(plot.top(levels[i])-rectangles[i][1])<1e-8);
    }
  }
});
const width=1206,height=800,count=chromaBarCount(width);
function input(peaks){
  const bytes=new Uint8Array(1024);
  for(let i=0;i<count;i++){
    let value=0;
    for(const [bar,level] of peaks)value=Math.max(value,level*Math.exp(-(((i-bar)/2.3)**2)));
    bytes[Math.floor(i*300/count)]=Math.round(value*255);
  }return bytes;
}
const update=(t,bytes,opts={})=>t.update(bytes,1/60,{width,height,rmsDb:-20,...opts});
const run=(t,bytes,frames=120,opts={})=>{for(let i=0;i<frames;i++)update(t,bytes,opts)};

test('peak detection handles plateaus, boundary peaks, weak peaks and silence',()=>{
  assert.deepEqual(findSpectrumPeaks([.8,.3,.7,.7,.7,.0001,.001]),[
    {bar:0,level:.8},{bar:3,level:.7},{bar:6,level:.001}
  ]);
  assert.deepEqual(findSpectrumPeaks([0,0,0]),[]);
  assert.deepEqual(findSpectrumPeaks([.4,.4,.4,.4]),[{bar:1.5,level:.4}]);
});

