/** Location preferences filter an already authorized response; they never grant access. */
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
