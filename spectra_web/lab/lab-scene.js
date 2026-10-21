import {labBackgroundAt} from './lab-model.js?v=r56';
import {stemStatesAt} from '../stem-player.js?v=lab-r56';
import {orderActorsForPainting,paintEmotionShape} from '../emotion-shape.js?v=r56';
import {paintPaperTexture} from '../material-texture.js?v=r56';
import {paintOverlapShapes} from '../overlap-color.js?v=r56';

// The preview and offline export use exactly the same time-indexed scene.
export function paintLabScene(ctx,bundle,time,visualTime,options,width,height,painters={}){
 const paper=painters.paintPaper??paintPaperTexture,shape=painters.paintShape??paintEmotionShape,overlap=painters.paintOverlap??paintOverlapShapes;
 const background=labBackgroundAt(bundle,time),geometry=options.geometry||{};
 ctx.fillStyle='rgb('+background.rgb.join(',')+')';ctx.fillRect(0,0,width,height);paper(ctx,width,height,geometry,height/540);
 if(!bundle)return{background,actors:[],mixed:false,overlapReport:null};
 const prediction=options.solo?{...bundle,stems:bundle.stems.filter(t=>t.id===options.stem)}:bundle;
 const actors=orderActorsForPainting((painters.actorStates??stemStatesAt)(prediction,time,visualTime,{size:options.size??1,sizeMultiplier:9,motionFraction:1,beatCentroid:true,beatVolume:true,pitchMode:options.pitchMode||'beat_summary',parametricShape:true,geometry,fadeOut:.18,mass:8,breath:1},width,height));
 if(options.guides){
  ctx.strokeStyle='#ffffff33';ctx.fillStyle='#ffffffbb';
  for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(width*i/4,15);ctx.lineTo(width*i/4,height-15);ctx.moveTo(15,height*i/4);ctx.lineTo(width-15,height*i/4);ctx.stroke()}
  ctx.fillText('A P5 → P95（各轨独立）',12,height-10);ctx.fillText('MIDI P95 ↑（鼓：质心）',12,18);
 }
 const mixed=!!(bundle.overlap?.enabled&&options.overlap),overlapReport=mixed?overlap(ctx,actors,bundle.overlap,time,width,height,height/540):null;
 for(const a of actors){
  if(!mixed)shape(ctx,a.form,a.x,a.y,a.radius,a.alpha,a.rgb,height/540);
  if(options.guides){ctx.fillStyle='#fff';ctx.shadowColor='#000';ctx.shadowBlur=3;
   ctx.fillText(a.label,Math.max(4,Math.min(width-80,a.x+a.radius+7)),a.y);
   ctx.fillText('A '+a.arousal.toFixed(2),Math.max(4,Math.min(width-80,a.x+a.radius+7)),a.y+13);ctx.shadowBlur=0;
  }
 }
 return{background,actors,mixed,overlapReport};
}
