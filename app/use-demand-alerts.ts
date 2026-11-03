"use client";

import {useEffect,useRef,useState} from "react";
import {canReceiveDemandAlerts,safeSeenDemandAlerts,mergeSeenDemandAlerts,unseenDemandAlerts} from "../lib/demand-alerts.mjs";

export type DemandAlert = {
  eventKey:string; demandId:string; reference:string; branchId:string;
  branchName:string; createdByName?:string; itemCount:number; submittedAt:string;
};

/** Poll only the small, permission-scoped inbox; never overwrite an open form. */
export default function useDemandAlerts(user:Record<string,any>|null,onSessionExpired:()=>void,sessionKey:number){
  const [alerts,setAlerts]=useState<DemandAlert[]>([]);
  const inbox=useRef<DemandAlert[]>([]),seen=useRef<string[]>([]),storageKey=useRef("");
  const expired=useRef(onSessionExpired);
  useEffect(()=>{expired.current=onSessionExpired;},[onSessionExpired]);
  const allowed=canReceiveDemandAlerts(user),identity=allowed?String(user?.id):"";

  useEffect(()=>{
    setAlerts([]);inbox.current=[];seen.current=[];storageKey.current="";
    if(!identity)return;
    const key=`hamsun-demand-alerts:${identity}`;storageKey.current=key;
    const expireSession=expired.current;
    try{seen.current=safeSeenDemandAlerts(JSON.parse(localStorage.getItem(key)||"[]"));}catch{}
    let stopped=false,inFlight=false,timer:ReturnType<typeof setTimeout>|undefined;
    const controller=new AbortController();
    const update=()=>setAlerts(unseenDemandAlerts(inbox.current,seen.current));
    const poll=async()=>{
      if(stopped||inFlight)return;
      clearTimeout(timer);
      if(document.visibilityState==="hidden"){timer=setTimeout(poll,30000);return;}
      inFlight=true;
      try{
        const response=await fetch("/api/demand-alerts",{cache:"no-store",signal:controller.signal});
        if(stopped)return;
        if(response.status===401){stopped=true;setAlerts([]);expireSession();return;}
        if(response.status===403){stopped=true;inbox.current=[];setAlerts([]);return;}
        if(!response.ok)return;
        const data=await response.json();
        if(stopped)return;
        if(Array.isArray(data.alerts)){inbox.current=data.alerts;update();}
      }catch{/* A later poll or reconnect retries temporary network failures. */}
      finally{inFlight=false;if(!stopped)timer=setTimeout(poll,10000);}
    };
    const resume=()=>{if(!stopped&&document.visibilityState!=="hidden")void poll();};
    const sync=(event:StorageEvent)=>{
      if(event.key!==key)return;
      let saved:string[]=[];try{saved=safeSeenDemandAlerts(localStorage.getItem(key)||"[]");}catch{}
      seen.current=mergeSeenDemandAlerts(seen.current,saved,event.newValue);
      if(seen.current.some(value=>!saved.includes(value)))try{localStorage.setItem(key,JSON.stringify(seen.current));}catch{}
      update();
    };
    window.addEventListener("storage",sync);window.addEventListener("focus",resume);window.addEventListener("online",resume);document.addEventListener("visibilitychange",resume);
    void poll();
    return()=>{stopped=true;controller.abort();clearTimeout(timer);window.removeEventListener("storage",sync);window.removeEventListener("focus",resume);window.removeEventListener("online",resume);document.removeEventListener("visibilitychange",resume);};
  },[identity,sessionKey]);

  function acknowledge(keys:string[]){
    if(!storageKey.current)return;
    let saved:string[]=[];try{saved=safeSeenDemandAlerts(JSON.parse(localStorage.getItem(storageKey.current)||"[]"));}catch{}
    seen.current=mergeSeenDemandAlerts(saved,seen.current,keys);
    try{localStorage.setItem(storageKey.current,JSON.stringify(seen.current));}catch{}
    setAlerts(unseenDemandAlerts(inbox.current,seen.current));
  }
  return {alerts:allowed?alerts:[],dismiss:(key:string)=>acknowledge([key]),dismissAll:()=>acknowledge(alerts.map(alert=>alert.eventKey))};
}
