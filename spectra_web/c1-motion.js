import {clamp} from './core.js?v=stems-r33';

export const MOTION_SMOOTH_SECONDS=.06;
export function easedProgress(u){
 // Symmetry avoids cancellation/overshoot near the upper endpoint.
 if(u>.5){const q=1-u;return 1-q*q*q*(10+q*(-15+6*q))}
 return u*u*u*(10+u*(-15+6*u));
}
export const easedRate=u=>30*u*u*(1-u)*(1-u);
const lowerBound=(times,t)=>{let l=0,h=times.length;while(l<h){const m=(l+h)>>1;if(times[m]<t)l=m+1;else h=m}return l};
function integral(age,window){if(age<=0)return 0;if(age>=window)return 1;const u=age/window;return u-Math.sin(2*Math.PI*u)/(2*Math.PI)}
function kernel(age,window){return age<=0||age>=window?0:(1-Math.cos(2*Math.PI*age/window))/window}

// Exact convolution of a held source with a compact causal Hann kernel.
// Both value and velocity remain continuous, even across a source jump.
export function sampleHeldCurve(data,time,window=MOTION_SMOOTH_SECONDS){
 const {times,values}=data,baseline=data.baseline??values[0];
 let value=baseline*(1-integral(time-times[0],window)),velocity=-baseline*kernel(time-times[0],window);
 for(let i=Math.max(0,lowerBound(times,time-window)-1);i<times.length&&times[i]<time;i++){
  const end=times[i+1]??Infinity;
  value+=values[i]*(integral(time-times[i],window)-integral(time-end,window));
  velocity+=values[i]*(kernel(time-times[i],window)-kernel(time-end,window));
 }
 return {value,velocity};
}

// Carry the current velocity into a finite stop instead of freezing a moving
// coordinate. Shorten the stop near an edge so it remains inside the viewport.
export function brakeMotion(position,velocity,elapsed,seconds=.12){
 if(elapsed<=0)return{value:position,velocity};
 if(Math.abs(velocity)<1e-12)return{value:position,velocity:0};
 const space=velocity>0?1-position:position;
 const duration=Math.min(seconds,Math.max(0,2*space/Math.abs(velocity)));
 if(!duration)return{value:position,velocity:0};
 const u=clamp(elapsed/duration,0,1),distance=duration*(u-u*u*u+.5*u*u*u*u);
 return{value:clamp(position+velocity*distance,0,1),velocity:u===1?0:velocity*(1-u*u*(3-2*u))};
}

// Monotone Hermite slopes for legacy realtime centroid position. Reversals
// have zero tangent; the curve stays bounded without a hard clipping corner.
export function positionSlopes(times,values){
 const slopes=values.map(()=>0);
 for(let i=1;i<values.length-1;i++){
  const a=times[i]-times[i-1],b=times[i+1]-times[i],left=(values[i]-values[i-1])/a,right=(values[i+1]-values[i])/b;
  if(left*right>0){const w1=2*b+a,w2=b+2*a;slopes[i]=(w1+w2)/(w1/left+w2/right)}
 }
 return slopes;
}
export function samplePositionCurve(times,values,slopes,time){
 if(time<=times[0])return{value:values[0],velocity:0};
 if(time>=times.at(-1))return{value:values.at(-1),velocity:0};
 const i=Math.max(0,lowerBound(times,time)-1),d=times[i+1]-times[i],u=(time-times[i])/d;
 const a=values[i],b=values[i+1],m=slopes[i],n=slopes[i+1];
 return{value:(2*u*u*u-3*u*u+1)*a+(u*u*u-2*u*u+u)*d*m+(-2*u*u*u+3*u*u)*b+(u*u*u-u*u)*d*n,
  velocity:((6*u*u-6*u)*a+(-6*u*u+6*u)*b)/d+(3*u*u-4*u+1)*m+(3*u*u-2*u)*n};
}
