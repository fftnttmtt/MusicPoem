import {clamp,smoothstep} from './core.js?v=stems-r33';
import {easedProgress,easedRate} from './c1-motion.js?v=r56';
const cache=new WeakMap();
export function prepareFooteCurve(curve){
 if(!curve||typeof curve!=='object')return null;
 if(cache.has(curve))return cache.get(curve);
 const times=curve.times,values=curve.values;
 if(!Array.isArray(times)||!Array.isArray(values)||times.length<2||times.length!==values.length||times.some((t,i)=>!Number.isFinite(t)||t<0||(i&&t<=times[i-1]))||values.some(v=>!Number.isFinite(v)||v<0)){cache.set(curve,null);return null}
 const area=[0];for(let i=1;i<times.length;i++)area.push(area[i-1]+(times[i]-times[i-1])*(values[i-1]+values[i])/2);
 const out={times,values,area};cache.set(curve,out);return out;
}
function indexAt(times,time){let lo=0,hi=times.length;while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<=time)lo=mid+1;else hi=mid}return Math.max(0,lo-1)}
export function footeLevelAt(curve,time){
 const c=prepareFooteCurve(curve);if(!c)return null;const i=indexAt(c.times,time),j=Math.min(i+1,c.times.length-1),u=i===j?0:clamp((time-c.times[i])/(c.times[j]-c.times[i]),0,1);
 return c.values[i]+(c.values[j]-c.values[i])*u;
}
function primitive(c,time){
 if(time<=c.times[0])return(time-c.times[0])*c.values[0];
 const i=indexAt(c.times,time),d=time-c.times[i];if(i===c.times.length-1)return c.area[i]+c.values[i]*d;
 return c.area[i]+c.values[i]*d+(c.values[i+1]-c.values[i])*d*d/(2*(c.times[i+1]-c.times[i]));
}
export function footeIntegral(curve,start,end){const c=prepareFooteCurve(curve);return c?Math.max(0,primitive(c,end)-primitive(c,start)):null}
export function footeProgress(curve,start,end,time){
 const linear=clamp((time-start)/Math.max(end-start,1e-12),0,1),total=footeIntegral(curve,start,end);
 // A zero-change interval still joins both original anchors using legacy easing.
 return total===null||total<=1e-12?smoothstep(linear):easedProgress(clamp(footeIntegral(curve,start,Math.max(start,Math.min(end,time)))/total,0,1));
}
export function footeProgressRate(curve,start,end,time){
 if(time<=start||time>=end||end<=start)return 0;
 const total=footeIntegral(curve,start,end),linear=(time-start)/(end-start);
 if(total===null||total<=1e-12)return 6*linear*(1-linear)/(end-start);
 const u=clamp(footeIntegral(curve,start,time)/total,0,1);
 return easedRate(u)*footeLevelAt(curve,time)/total;
}
export function footeResponse(curve,start,end,tau,mean){
 const area=footeIntegral(curve,start,end);return area===null||!Number.isFinite(mean)||mean<=1e-12?1-Math.exp(-Math.max(0,end-start)/tau):1-Math.exp(-area/(mean*tau));
}
