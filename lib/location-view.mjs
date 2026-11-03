/** Location preferences filter an already authorized response; they never grant access. */
import {hasPermission} from './permissions.mjs';
export function availableLocations(user,locations) {
  return (locations||[]).filter(location=>user?.role!=='branch'||location.id===user.branchId);
}

export function normalizeLocationSelection(candidate,user,locations) {
  if(user?.role==='branch')return user.branchId;
  return candidate==='All'||availableLocations(user,locations).some(location=>location.id===candidate)?candidate:'All';
}

export function documentMatchesLocation(document,locationId) {
  if(locationId==='All')return true;
  if(locationId==='WH')return document.type==='grn'||['transfer','return'].includes(document.type)||document.locationId==='WH';
  return document.locationId===locationId||document.branchId===locationId;
}

export function auditMatchesLocation(entry,locationId,documents) {
  if(locationId==='All')return true;
  if(entry.branchId===locationId)return true;
  const document=(documents||[]).find(row=>row.id===entry.entityId||row.id===entry.documentId||(entry.reference&&row.reference===entry.reference));
  if(document)return documentMatchesLocation(document,locationId);
  return locationId==='WH'&&!entry.branchId;
}

export function locationView(data,locationId) {
  return {
    stock:(data.stock||[]).filter(row=>locationId==='All'||row.locationId===locationId),
    documents:(data.documents||[]).filter(row=>documentMatchesLocation(row,locationId)),
    ledger:(data.ledger||[]).filter(row=>locationId==='All'||row.locationId===locationId),
    audit:(data.audit||[]).filter(row=>auditMatchesLocation(row,locationId,data.documents)),
  };
}

/** Show ready warehouse items before their first receipt, without posting any stock. */
export function warehouseStockRows(data,user,locationId) {
  const rows=(data.stock||[]).filter(row=>locationId==='All'||row.locationId===locationId);
  const warehouseVisible=availableLocations(user,data.locations||[]).some(location=>location.id==='WH');
  if(user?.role==='branch'||!hasPermission(user,'stock')||!warehouseVisible||!['All','WH'].includes(locationId))return rows;
  const present=new Set(rows.filter(row=>row.locationId==='WH').map(row=>row.productId));
  const additions=[];
  for(const item of data.products||[]) {
    const configured=item.active===true&&item.setupPending!==true&&typeof item.category==='string'&&item.category.trim()&&typeof item.baseUnit==='string'&&item.baseUnit.trim()&&Array.isArray(item.units)&&item.units.some(unit=>unit.name===item.baseUnit&&Number(unit.factor)===1);
    if(!configured||!item.id||present.has(item.id))continue;
    additions.push({locationId:'WH',productId:item.id,qty:0,avgCost:0,unstocked:true});
    present.add(item.id);
  }
  return [...rows,...additions];
}
