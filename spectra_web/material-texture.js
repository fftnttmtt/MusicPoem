// Procedural paint on paper. Stable seeds and object-local coordinates: no frame noise.
export const MATERIAL_DEFAULTS={texture_enabled:true,texture_paper_strength:.3,texture_pigment_strength:.35,texture_edge_strength:.25};
const SOFTNESS={vocals:1.15,other:1.2,drums:.7,piano:.8,guitar:1,bass:1};
const cache=new Map();let canvasFactory=null;
export function setTextureCanvasFactory(factory){canvasFactory=factory;cache.clear()}
export function materialParameters(values={}){
 const p=Object.fromEntries(Object.entries(MATERIAL_DEFAULTS).map(([k,v])=>[k,values[k]??v]));
 if(typeof p.texture_enabled!=='boolean')throw Error('肌理须为开关。');
 for(const key of Object.keys(p).filter(k=>k.endsWith('_strength')))if(!Number.isFinite(p[key])||p[key]<0||p[key]>1)throw Error('肌理强度须在 0–1 内。');
 return p;
}
export function materialSeed(text){let n=2166136261;for(const ch of text)n=Math.imul(n^ch.charCodeAt(0),16777619);return n>>>0}
function random(seed){let n=seed;return()=>{n+=0x6D2B79F5;let t=Math.imul(n^n>>>15,1|n);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296}}
function makeCanvas(size){
 const c=canvasFactory?canvasFactory(size,size):typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(size,size):typeof document!=='undefined'?document.createElement('canvas'):null;
 if(c){c.width=size;c.height=size}return c;
}
export function textureTile(kind,identity='paper'){
 const key=kind+':'+identity;if(cache.has(key))return cache.get(key);
 const size=kind==='pigment'?384:256,c=makeCanvas(size),ctx=c?.getContext('2d');
 if(!ctx?.createImageData||!ctx?.putImageData)return null;
 const image=ctx.createImageData(size,size);if(!image?.data)return null;
 const rng=random(materialSeed(key)),grid=8,field=Array.from({length:grid*grid},()=>rng()*2-1);
 const fade=t=>t*t*(3-2*t),at=(x,y)=>field[(y%grid)*grid+x%grid];
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  let value;
  if(kind==='pigment'){
   const gx=x/size*grid,gy=y/size*grid,ix=Math.floor(gx),iy=Math.floor(gy),u=fade(gx-ix),v=fade(gy-iy);
   const a=at(ix,iy)*(1-u)+at(ix+1,iy)*u,b=at(ix,iy+1)*(1-u)+at(ix+1,iy+1)*u;
   value=(a*(1-v)+b*v)*.8+(rng()*2-1)*.12;
  }else value=(rng()*2-1)*.75+Math.sin(x*.13+y*.37)*.1+Math.sin(x*.03-y*.6)*.08;
  const i=(y*size+x)*4,shade=value<0?0:255;
  image.data[i]=image.data[i+1]=image.data[i+2]=shade;image.data[i+3]=Math.round(Math.abs(value)*180);
 }
 ctx.putImageData(image,0,0);cache.set(key,c);return c;
}
function layer(ctx,tile,bounds,strength,scale=1,offset=0){
 if(!tile||strength<=0)return;
 const pattern=ctx.createPattern(tile,'repeat');if(!pattern)return;
 ctx.save();ctx.globalAlpha*=strength;ctx.globalCompositeOperation='soft-light';
 ctx.translate(offset,-offset*.47);ctx.scale(scale,scale);ctx.fillStyle=pattern;
 ctx.fillRect((bounds.left-offset)/scale,(bounds.top+offset*.47)/scale,(bounds.right-bounds.left)/scale,(bounds.bottom-bounds.top)/scale);ctx.restore();
}
export function paintPaperTexture(ctx,width,height,parameters={},viewportScale=1){
 const p=materialParameters(parameters);if(!p.texture_enabled||p.texture_paper_strength===0)return;
 const bounds={left:0,top:0,right:width,bottom:height},s=Math.max(.1,viewportScale);
 layer(ctx,textureTile('grain'),bounds,p.texture_paper_strength*.75,s);
 layer(ctx,textureTile('pigment','paper'),bounds,p.texture_paper_strength*.22,s*2);
}
// Caller clips and translates to a shape; the pattern is fixed in its own coordinate system.
export function paintPigmentTexture(ctx,bounds,stem,parameters={},viewportScale=1){
 const p=materialParameters(parameters);if(!p.texture_enabled)return;
 const s=Math.max(.1,viewportScale),soft=SOFTNESS[stem]??1;
 layer(ctx,textureTile('pigment',stem),bounds,p.texture_pigment_strength*.9*soft,s,materialSeed(stem||'shape')%127);
 layer(ctx,textureTile('grain',stem),bounds,p.texture_paper_strength*.45,s);
}
// Very light, deterministic broken paint/ink marks, clipped inside the mathematical contour.
export function paintEdgeTexture(ctx,kind,m,stem,parameters={},viewportScale=1,trace){
 const p=materialParameters(parameters);if(!p.texture_enabled||p.texture_edge_strength===0||!ctx.createPattern)return;
 const s=Math.max(.1,viewportScale),tile=textureTile('grain','edge-'+stem);if(!tile)return;
 const pattern=ctx.createPattern(tile,'repeat');if(!pattern)return;
 ctx.save();ctx.globalAlpha*=p.texture_edge_strength*.65;ctx.strokeStyle=pattern;
 ctx.lineWidth=Math.min(m.inradius*.15,2*s);ctx.lineJoin='round';
 trace(ctx,kind,m,ctx.lineWidth*.35);ctx.stroke();ctx.restore();
}
export function paintInkTexture(ctx,stem,parameters={}){
 const p=materialParameters(parameters);if(!p.texture_enabled||p.texture_edge_strength===0||!ctx.createPattern)return;
 const tile=textureTile('grain','ink-'+stem);if(!tile)return;
 const pattern=ctx.createPattern(tile,'repeat');if(!pattern)return;
 ctx.save();ctx.globalAlpha*=p.texture_edge_strength*.5;ctx.strokeStyle=pattern;ctx.stroke();ctx.restore();
}
