"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Check, ClipboardList, FileText, Plus, RotateCcw, ShieldCheck, Truck, X } from "lucide-react";
import { hasPermission } from "../lib/permissions.mjs";

type R = Record<string, any>;
type Props = {
  user:R; demands:R[]; products:R[]; locations:R[]; documents:R[];
  busy:boolean; search:string; filter:string; locationId:string;
  act:(action:string,payload:R,message?:string)=>Promise<boolean>;
  onOpenTransfer:(id:string)=>void;
};
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Karachi",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const number=(value:any)=>new Intl.NumberFormat("en-PK",{maximumFractionDigits:6}).format(Number(value||0));
const unit=(value:any)=>/^(pc|pcs|piece|pieces)$/i.test(String(value))?"pcs":String(value||"");
const displayDate=(value:any)=>value?new Date(value).toLocaleDateString("en-GB",{timeZone:"Asia/Karachi",day:"2-digit",month:"short",year:"numeric"}):"—";
const preferredUnit=(product:R)=>product.units?.find((value:R)=>value.name===product.baseUnit)?.name||product.units?.[0]?.name||"";
function Field({label,children,wide=false}:{label:string;children:ReactNode;wide?:boolean}){return <label className={`field ${wide?"wide":""}`}><span>{label}</span>{children}</label>;}
function Status({value}:{value:string}){return <span className={`badge status-${value.toLowerCase().replaceAll(" ","-")}`}><i/>{value}</span>;}

export default function DemandPanel({user,demands,products,locations,documents,busy,search,filter,locationId,act,onOpenTransfer}:Props){
  const [editor,setEditor]=useState<R|null>(null),[selectedId,setSelectedId]=useState<string|null>(null),[reason,setReason]=useState("");
  const dialogRef=useRef<HTMLElement>(null);
  const branch=user.role==="branch",admin=["superadmin","admin"].includes(user.role),reviewer=admin||user.role==="warehouse";
  const canCreate=branch||admin,canConvert=reviewer&&hasPermission(user,"dispatches");
  const activeProducts=products.filter(product=>product.active);
  const rows=demands.filter(demand=>(!branch||demand.branchId===user.branchId)&&(locationId==="All"||locationId==="WH"||demand.branchId===locationId)&&(filter==="All"||demand.status===filter)&&JSON.stringify(demand).toLowerCase().includes(search.toLowerCase()));
  const selected=demands.find(demand=>demand.id===selectedId);
  const branchName=(id:string)=>locations.find(location=>location.id===id)?.name||id;
  const product=(id:string)=>products.find(product=>product.id===id);
  const close=()=>{setEditor(null);setSelectedId(null);setReason("");};
  useEffect(()=>{
    if(!editor&&!selectedId)return;
    const previous=document.activeElement as HTMLElement|null;
    const originalOverflow=document.body.style.overflow;document.body.style.overflow="hidden";
    const focusable=()=>Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')||[]);
    const timer=setTimeout(()=>focusable()[0]?.focus(),0);
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){setEditor(null);setSelectedId(null);setReason("");}
      if(event.key!=="Tab")return;
      const elements=focusable(),first=elements[0],last=elements[elements.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown",keydown);
    return()=>{clearTimeout(timer);document.body.style.overflow=originalOverflow;document.removeEventListener("keydown",keydown);previous?.focus();};
  },[!!editor,selectedId]);
  function edit(demand?:R){
    const first=activeProducts[0];
    setSelectedId(null);setReason("");
    setEditor(demand?{...demand,lines:demand.lines.map((line:R)=>({productId:line.productId,qty:line.qty,unit:line.unit}))}:{date:today(),branchId:branch?user.branchId:locations.some(location=>location.id===locationId&&location.type==="branch")?locationId:locations.find(location=>location.type==="branch")?.id||"",note:"",lines:first?[{productId:first.id,qty:1,unit:preferredUnit(first)}]:[]});
  }
  function changeLine(index:number,key:string,value:any){
    if(!editor)return;
    const lines=editor.lines.map((line:R,i:number)=>i===index?{...line,[key]:value,...(key==="productId"?{unit:preferredUnit(product(value)||{})}:{})}:line);
    setEditor({...editor,lines});
  }
  async function save(event:FormEvent){
    event.preventDefault();if(!editor)return;
    const submit=(event.nativeEvent as SubmitEvent).submitter?.getAttribute("value")==="submit";
    const payload={id:editor.id,branchId:editor.branchId,date:editor.date,note:editor.note,lines:editor.lines,...(!editor.id?{submit}:{})};
    if(await act(editor.id?"demand.update":"demand.create",payload,submit?"Demand submitted to Central Warehouse":"Demand draft saved"))close();
  }
  async function transition(action:string,override=false){
    if(selected&&await act(`demand.${action}`,{id:selected.id,reason,override},action==="convert"?"Gate pass draft created for this demand":"Demand updated"))setReason("");
  }
  const own=selected&&canCreate&&(selected.createdBy===user.id||admin);
  const linkedDocument=selected?.transferId&&documents.find(document=>document.id===selected.transferId);
  const linkedCancelled=linkedDocument?.status==="Cancelled";
  const pending=demands.filter(demand=>demand.status==="Pending approval"&&(!branch||demand.branchId===user.branchId)).length;
  return <>
    <div className="demand-intro">
      <span className="demand-emblem"><ClipboardList size={26}/></span>
      <div><strong>{branch?"Tell the warehouse what your branch needs":"Branch requests, ready for review"}</strong><p>{branch?"Choose items and quantities, then submit your demand. Track its approval and linked dispatch here.":"Review each branch’s requested quantities. Approved demands become gate-pass drafts for the normal dispatch workflow."}</p></div>
      {canCreate&&<button className="button primary" disabled={busy||!activeProducts.length} onClick={()=>edit()}><Plus size={16}/>New demand</button>}
    </div>
    {!activeProducts.length&&canCreate&&<div className="info-banner"><FileText size={20}/><p>No active items are available yet. Your central team must add products before a demand can be submitted.</p></div>}
    <section className="card demand-register"><div className="card-heading compact"><div><h2>{branch?"Your branch demands":"Demand register"} <span className="inline-count">{rows.length}</span></h2><p>{pending?`${pending} awaiting review`:"Requests stay linked to their branch and dispatch."}</p></div><span className="pill">Quantities only</span></div>
      {rows.length?<div className="table-scroll"><table><thead><tr><th>Demand reference</th><th>Date</th>{!branch&&<th>Branch</th>}<th>Items</th><th>Status</th><th/></tr></thead><tbody>{[...rows].sort((a,b)=>String(b.createdAt||b.date).localeCompare(String(a.createdAt||a.date))).map(demand=><tr key={demand.id}><td><button className="text-button demand-reference" onClick={()=>{setSelectedId(demand.id);setReason("");}}><ClipboardList size={15}/>{demand.reference}</button></td><td>{displayDate(demand.date)}</td>{!branch&&<td>{branchName(demand.branchId)}</td>}<td>{demand.lines.length} products</td><td><Status value={demand.status}/></td><td><button className="text-button" onClick={()=>{setSelectedId(demand.id);setReason("");}} aria-label={`View demand ${demand.reference}`}>View<ArrowRight size={14}/></button></td></tr>)}</tbody></table></div>:<div className="empty"><ClipboardList size={32}/><h3>No demands to display</h3><p>{branch?"Your submitted requests and drafts will appear here.":"Branch requests will appear here for warehouse review."}</p></div>}
    </section>

    {editor&&<div className="modal-backdrop" onClick={()=>!busy&&close()}><section ref={dialogRef} className="modal large-modal" role="dialog" aria-modal="true" aria-label={editor.id?"Edit branch demand":"New branch demand"} onClick={event=>event.stopPropagation()}><header className="modal-header"><div><span className="eyebrow">BRANCH DEMAND</span><h2>{editor.id?"Edit demand draft":"What does your branch need?"}</h2></div><button className="icon-button" type="button" aria-label="Close demand form" onClick={close}><X size={20}/></button></header><form onSubmit={save}><div className="modal-body"><div className="form-grid"><Field label="Requesting branch"><select required disabled={branch} value={editor.branchId} onChange={event=>setEditor({...editor,branchId:event.target.value})}>{locations.filter(location=>location.type==="branch").map(location=><option value={location.id} key={location.id}>{location.name}</option>)}</select></Field><Field label="Request date"><input required type="date" max={today()} value={editor.date} onChange={event=>setEditor({...editor,date:event.target.value})}/></Field></div><div className="form-section-title"><h3>Requested items</h3><span className="small muted">Use each item’s own unit</span></div><div className="document-lines">{editor.lines.map((line:R,index:number)=>{const item=product(line.productId),factor=item?.units.find((value:R)=>value.name===line.unit)?.factor||1;return <div className="line-editor demand-line-editor" key={index}><span className="line-number">{index+1}</span><div className="line-fields"><Field label="Product"><select required value={line.productId} onChange={event=>changeLine(index,"productId",event.target.value)}>{item&&!item.active&&<option value={item.id}>{item.name} · Inactive</option>}{activeProducts.filter(candidate=>candidate.id===line.productId||!editor.lines.some((other:R)=>other.productId===candidate.id)).map(candidate=><option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.sku}</option>)}</select></Field><Field label="Quantity"><input required type="number" min="0.000001" step="any" value={line.qty} onChange={event=>changeLine(index,"qty",event.target.value)}/></Field><Field label="Unit"><select required value={line.unit} onChange={event=>changeLine(index,"unit",event.target.value)}>{item?.units.map((value:R)=><option value={value.name} key={value.name}>{unit(value.name)}</option>)}</select></Field><div className="line-conversion">{number(line.qty)} {unit(line.unit)} = <b>{number(Number(line.qty)*factor)} {unit(item?.baseUnit)}</b></div></div><button type="button" className="icon-button remove-line" aria-label={`Remove requested item ${index+1}`} disabled={editor.lines.length===1} onClick={()=>setEditor({...editor,lines:editor.lines.filter((_:R,i:number)=>i!==index)})}><X size={15}/></button></div>;})}</div><button type="button" className="button dashed full" disabled={editor.lines.length>=100||!activeProducts.some(item=>!editor.lines.some((line:R)=>line.productId===item.id))} onClick={()=>{const item=activeProducts.find(candidate=>!editor.lines.some((line:R)=>line.productId===candidate.id));if(item)setEditor({...editor,lines:[...editor.lines,{productId:item.id,qty:1,unit:preferredUnit(item)}]});}}><Plus size={16}/>Add requested item</button><div className="bottom-fields"><Field label="Notes for the warehouse"><textarea rows={3} maxLength={1000} value={editor.note} onChange={event=>setEditor({...editor,note:event.target.value})} placeholder="Add delivery instructions or explain the requirement…"/></Field></div></div><footer className="modal-footer"><span className="small muted">No stock moves until an approved gate pass is dispatched.</span><button className="button secondary" type="button" onClick={close}>Cancel</button><button className="button secondary" type="submit" value="draft" disabled={busy}>Save draft</button>{!editor.id&&<button className="button primary" type="submit" value="submit" disabled={busy}>Submit demand<ArrowRight size={15}/></button>}</footer></form></section></div>}

    {selected&&!editor&&<div className="modal-backdrop" onClick={()=>!busy&&close()}><section ref={dialogRef} className="modal large-modal demand-detail" role="dialog" aria-modal="true" aria-label={`Demand ${selected.reference}`} onClick={event=>event.stopPropagation()}><header className="modal-header"><div><span className="eyebrow">BRANCH DEMAND</span><h2>{selected.reference}</h2></div><button className="icon-button" aria-label="Close demand" onClick={close}><X size={20}/></button></header><div className="modal-body"><div className="detail-status-row"><Status value={selected.status}/><span className="small muted">{displayDate(selected.date)}</span></div><div className="document-meta demand-meta"><div><small>REQUESTING BRANCH</small><strong>{branchName(selected.branchId)}</strong></div><div><small>REQUESTED BY</small><strong>{selected.createdByName||selected.createdBy}</strong></div><div><small>ITEMS</small><strong>{selected.lines.length} products</strong></div></div><div className="table-scroll"><table><thead><tr><th>Requested item</th><th className="numeric">Quantity</th><th className="numeric">Stock quantity</th></tr></thead><tbody>{selected.lines.map((line:R)=><tr key={line.productId}><td><strong>{line.productName||product(line.productId)?.name}</strong><small className="block muted">{line.productSku||product(line.productId)?.sku}</small></td><td className="numeric">{number(line.qty)} {unit(line.unit)}</td><td className="numeric">{number(line.baseQty)} {unit(line.baseUnit)}</td></tr>)}</tbody></table></div>{selected.note&&<div className="note-block"><small>REQUEST NOTES</small><p>{selected.note}</p></div>}{selected.status==="Transfer created"&&<div className="info-banner"><Truck size={21}/><div><strong>{linkedDocument?`Linked gate pass: ${selected.transferReference||linkedDocument.reference}`:"The warehouse is preparing your dispatch"}</strong><p>{linkedCancelled?"The linked gate pass was cancelled. The warehouse can create a replacement.":"The demand and dispatch remain linked for a clear delivery record."}</p></div>{linkedDocument&&hasPermission(user,"dispatches")&&<button className="button secondary" onClick={()=>{onOpenTransfer(linkedDocument.id);close();}}>Open gate pass<ArrowRight size={14}/></button>}</div>}
      {!["Cancelled","Transfer created"].includes(selected.status)&&<Field label="Action note / reason"><textarea rows={2} value={reason} onChange={event=>setReason(event.target.value)} placeholder="A reason is required for rejection, cancellation or reopening."/></Field>}
      <div className="action-buttons demand-actions">
        {selected.status==="Draft"&&own&&<><button className="button secondary" disabled={busy} onClick={()=>edit(selected)}>Edit draft</button><button className="button primary" disabled={busy} onClick={()=>transition("submit")}>Submit demand<ArrowRight size={15}/></button></>}
        {selected.status==="Pending approval"&&reviewer&&selected.createdBy!==user.id&&<><button className="button danger" disabled={busy||!reason.trim()} onClick={()=>transition("reject")}>Reject demand</button><button className="button primary" disabled={busy} onClick={()=>transition("approve")}>Approve demand<Check size={15}/></button></>}
        {selected.status==="Pending approval"&&reviewer&&selected.createdBy===user.id&&(user.role==="superadmin"?<button className="button primary" disabled={busy||!reason.trim()} onClick={()=>transition("approve",true)}>Approve as Super Admin<ShieldCheck size={15}/></button>:<p className="small muted">Another reviewer must approve your demand.</p>)}
        {(selected.status==="Approved"||selected.status==="Transfer created"&&linkedCancelled)&&canConvert&&<button className="button primary" disabled={busy} onClick={()=>transition("convert")}><Truck size={16}/>{linkedCancelled?"Create replacement gate pass":"Create gate pass draft"}</button>}
        {selected.status==="Rejected"&&own&&<button className="button secondary" disabled={busy||!reason.trim()} onClick={()=>transition("reopen")}><RotateCcw size={15}/>Reopen as draft</button>}
        {(["Draft","Pending approval"].includes(selected.status)&&own||selected.status==="Approved"&&reviewer)&&<button className="button danger" disabled={busy||!reason.trim()} onClick={()=>transition("cancel")}>Cancel demand</button>}
      </div>
      {!!selected.history?.length&&<div className="detail-audit demand-history"><div className="form-section-title"><h3>Demand history</h3></div>{selected.history.map((entry:R,index:number)=><div key={index}><i/><div><strong>{entry.action} · {entry.status}</strong><small>{entry.by} · {displayDate(entry.at)}</small>{(entry.reason||entry.note)&&<p>{entry.reason||entry.note}</p>}</div></div>)}</div>}
    </div></section></div>}
  </>;
}
