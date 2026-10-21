/* Half-open segment intervals: seeking to a boundary selects the next segment. */
function findColorSegment(rows, seconds, ended) {
  let low=0, high=rows.length;
  while(low<high){ const mid=(low+high)>>1; if(rows[mid].start_seconds<=seconds)low=mid+1;else high=mid; }
  const row=rows[low-1];
  if(row && seconds<row.end_seconds)return row;
  const last=rows[rows.length-1];
  if(ended && last && Math.abs(seconds-last.end_seconds)<0.03)return last;
  return null;
}
function upperBound(values,t){
  let lo=0,hi=values.length;
  while(lo<hi){const m=(lo+hi)>>1;if(values[m]<=t)lo=m+1;else hi=m;}
  return lo;
}
function speedIntegral(curve,t){
  const {grid,rate,area}=curve;
  if(grid.length===1)return 0;
  t=Math.max(grid[0],Math.min(grid[grid.length-1],t));
  const j=Math.max(0,Math.min(grid.length-2,upperBound(grid,t)-1)),d=t-grid[j];
  const slope=(rate[j+1]-rate[j])/(grid[j+1]-grid[j]);
  return area[j]+rate[j]*d+.5*slope*d*d;
}
function labToColor(lab){
  const [L,a,b]=lab;
  const l=(L+.3963377774*a+.2158037573*b)**3;
  const m=(L-.1055613458*a-.0638541728*b)**3;
  const s=(L-.0894841775*a-1.291485548*b)**3;
  const linear=[4.0767416621*l-3.3077115913*m+.2309699292*s,
    -1.2684380046*l+2.6097574011*m-.3413193965*s,
    -.0041960863*l-.7034186147*m+1.707614701*s];
  const rgb=linear.map(v=>{v=Math.max(0,Math.min(1,v));return Math.round(255*(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055));});
  const [r,g,blue]=rgb.map(v=>v/255),max=Math.max(r,g,blue),min=Math.min(r,g,blue),d=max-min;
  let h=0;
  if(d){if(max===r)h=((g-blue)/d)%6;else if(max===g)h=(blue-r)/d+2;else h=(r-g)/d+4;h=(h*60+360)%360;}
  return {rgb,hex:'#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join(''),hue_degrees:h,saturation:max?d/max:0,value:max};
}
function startAlignedTransition(curve){
  if(!curve||curve.mode!=='boundary_hold')return curve;
  const fraction=curve.max_segment_fraction??.15;
  return {...curve,mode:'boundary_start',anchor:'transition_start_at_original_segment_start',
    duration_cap_basis:'receiving_segment_start_interval',
    duration_formula:'receiving_interval*(1-expm1(strength*novelty)/expm1(strength)); capped by configured fraction of receiving interval',
    timing:'start exactly at original next segment start; never show next color before boundary',
    runs:curve.runs.map(run=>({...run,events:run.events.map(event=>{
      const interval=event.receiving_duration_seconds,oldInterval=event.anchor_interval_seconds;
      const ratio=oldInterval>0?event.requested_duration_seconds/oldInterval:0;
      const requested=interval*Math.max(0,Math.min(1,ratio)),cap=interval*fraction,duration=Math.min(requested,cap);
      return {...event,start_seconds:event.boundary_seconds,end_seconds:event.boundary_seconds+duration,
        duration_seconds:duration,requested_duration_seconds:requested,duration_cap_seconds:cap,
        duration_capped:requested>cap+1e-9,anchor_time_error_seconds:null,transition_start_error_seconds:0};
    })}))};
}
function transitionColor(curve,t){
  if(!curve||!curve.enabled)return null;
  const runs=curve.runs;
  const i=upperBound(runs.map(r=>r.start),t)-1;
  if(i<0||t>runs[i].end)return null;
  const run=runs[i],times=run.times,labs=run.labs;
  const anchorIndex=upperBound(times,t)-1;
  if(curve.mode!=='boundary_start'&&anchorIndex>=0&&times[anchorIndex]===t)return labToColor(labs[anchorIndex]);
  if(curve.mode==='boundary_hold'||curve.mode==='boundary_start'){
    const events=run.events,j=upperBound(events.map(e=>e.start_seconds),t)-1;
    if(j<0)return labToColor(labs[0]);
    const event=events[j];
    let u=event.duration_seconds<=0?1:Math.max(0,Math.min(1,(t-event.start_seconds)/event.duration_seconds));
    u=u*u*(3-2*u);
    return labToColor(labs[event.from_index].map((v,k)=>v*(1-u)+labs[event.to_index][k]*u));
  }
  if(times.length===1||t<=times[0])return labToColor(labs[0]);
  if(t>=times[times.length-1])return labToColor(labs[labs.length-1]);
  const j=upperBound(times,t)-1;
  let u=Math.max(0,Math.min(1,(speedIntegral(curve,t)-run.anchor_area[j])/(run.anchor_area[j+1]-run.anchor_area[j])));
  u=u*u*(3-2*u);
  return labToColor(labs[j].map((v,k)=>v*(1-u)+labs[j+1][k]*u));
}

export {findColorSegment,transitionColor,startAlignedTransition};
