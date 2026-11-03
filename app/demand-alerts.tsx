"use client";

import { ArrowRight, BellRing, X } from "lucide-react";
import "./demand-alerts.css";

export type BranchDemandAlert = {
  eventKey:string;
  demandId:string;
  reference:string;
  branchName:string;
  createdByName?:string;
  itemCount:number;
  submittedAt:string;
};

type Props = {
  alerts:BranchDemandAlert[];
  onOpen:(alert:BranchDemandAlert)=>void;
  onDismiss:(eventKey:string)=>void;
  onDismissAll:()=>void;
};

function submittedTime(value:string){
  const time=new Date(value);
  return Number.isNaN(time.getTime()) ? "" : time.toLocaleString("en-GB",{
    timeZone:"Asia/Karachi",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"
  });
}

export default function DemandAlerts({alerts,onOpen,onDismiss,onDismissAll}:Props){
  if(!alerts.length)return null;
  const latest=alerts[0],visible=alerts.slice(0,3),remaining=alerts.length-visible.length;
  return <section className="demand-alerts" role="region" aria-label="Branch demand notifications">
    <p className="demand-alert-announcement" role="status" aria-live="polite" aria-atomic="true">
      {alerts.length===1?"A new branch demand is waiting.":`${alerts.length} new branch demands are waiting.`} Latest: {latest.reference} from {latest.branchName}.
    </p>
    <header className="demand-alerts-heading">
      <span className="demand-alerts-bell"><BellRing size={17} aria-hidden="true"/></span>
      <div><h2>New branch demand</h2><p>Ready for warehouse review</p></div>
      {alerts.length>1&&<span className="demand-alerts-count">{alerts.length} new</span>}
    </header>
    <ul className="demand-alerts-list">
      {visible.map(alert=>{
        const time=submittedTime(alert.submittedAt);
        return <li key={alert.eventKey} className="demand-alert-item">
          <div className="demand-alert-item-heading"><strong>{alert.branchName}</strong><button type="button" className="demand-alert-dismiss" aria-label={`Dismiss demand ${alert.reference}`} onClick={()=>onDismiss(alert.eventKey)}><X size={15} aria-hidden="true"/></button></div>
          <div className="demand-alert-meta"><span className="demand-alert-reference">{alert.reference}</span><span>{alert.itemCount} {alert.itemCount===1?"item":"items"}</span></div>
          {alert.createdByName&&<p className="demand-alert-requester">Requested by {alert.createdByName}</p>}
          <div className="demand-alert-item-footer">{time?<time dateTime={alert.submittedAt}>{time}</time>:<span/>}<button type="button" className="demand-alert-open" onClick={()=>onOpen(alert)}>View demand<ArrowRight size={13} aria-hidden="true"/></button></div>
        </li>;
      })}
    </ul>
    {alerts.length>1&&<footer className="demand-alerts-footer"><span>{remaining>0?`+${remaining} more waiting`:`${alerts.length} demands waiting`}</span><button type="button" onClick={onDismissAll}>Dismiss all</button></footer>}
  </section>;
}
