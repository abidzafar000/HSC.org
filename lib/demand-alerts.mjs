import {hasPermission} from './permissions.mjs';

/** Demand alerts are for central reviewers with the assigned demands area. */
export function canReceiveDemandAlerts(user) {
  return typeof user?.id==='string'&&user.id.trim()!==''&&['superadmin','admin','warehouse'].includes(user.role)&&hasPermission(user,'demands');
}

const timestamp=value=>typeof value==='string'&&value.length<=80&&Number.isFinite(Date.parse(value))?value:'';
const shortText=(value,max)=>typeof value==='string'?value.slice(0,max):'';

/** Identify the submission, not the record's latest edit or the current poll. */
export function pendingDemandAlerts(demands,user) {
  if(!canReceiveDemandAlerts(user)||!Array.isArray(demands))return [];
  const alerts=new Map();
  for(const demand of demands) {
    if(!demand||typeof demand.id!=='string'||!demand.id||typeof demand.branchId!=='string'||!demand.branchId||demand.status!=='Pending approval'||demand.createdBy===user.id)continue;
    const submissions=(Array.isArray(demand.history)?demand.history:[]).filter(entry=>entry&&entry.status==='Pending approval'&&['Created','submit','update'].includes(entry.action));
    const submittedAt=submissions.map(entry=>timestamp(entry.at)).filter(Boolean).sort().at(-1)||timestamp(demand.createdAt);
    // The count also distinguishes two genuine submissions in the same millisecond.
    const eventKey=`${demand.id}:submission:${submissions.length}:${submittedAt||'legacy'}`;
    alerts.set(eventKey,{id:eventKey,eventKey,demandId:demand.id,reference:shortText(demand.reference,100),branchId:demand.branchId,createdByName:shortText(demand.createdByName,100),itemCount:Array.isArray(demand.lines)?demand.lines.length:0,submittedAt});
  }
  return [...alerts.values()].sort((a,b)=>b.submittedAt.localeCompare(a.submittedAt)||a.demandId.localeCompare(b.demandId));
}

function seenDemandKeys(value) {
  let entries=value;
  if(typeof entries==='string')try{entries=JSON.parse(entries);}catch{return [];}
  if(!Array.isArray(entries))return [];
  return entries.filter(key=>typeof key==='string'&&key.length>0&&key.length<=500);
}

/** Keep browser acknowledgement data small and tolerate unavailable/old storage. */
export function safeSeenDemandAlerts(value,max=500) {
  const limit=Number.isInteger(max)&&max>0?Math.min(max,1000):500;
  return [...new Set(seenDemandKeys(value))].slice(-limit);
}

/** Concurrent tabs converge on the same bounded union instead of overwriting acks. */
export function mergeSeenDemandAlerts(...values) {
  const submittedTime=key=>{
    const suffix=key.match(/:submission:\d+:(.+)$/)?.[1];
    const parsed=suffix?Date.parse(suffix):NaN;
    return Number.isFinite(parsed)?parsed:Number.NEGATIVE_INFINITY;
  };
  return [...new Set(values.flatMap(seenDemandKeys))].sort((a,b)=>{
    const left=submittedTime(a),right=submittedTime(b);
    return left!==right?(left<right?-1:1):(a<b?-1:a>b?1:0);
  }).slice(-500);
}

export function unseenDemandAlerts(alerts,seen) {
  const acknowledged=new Set(safeSeenDemandAlerts(seen));
  return (Array.isArray(alerts)?alerts:[]).filter(alert=>alert&&typeof alert.eventKey==='string'&&!acknowledged.has(alert.eventKey));
}
