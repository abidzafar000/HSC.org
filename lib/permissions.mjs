/** Module grants only narrow a role's authority; they never widen its role or branch scope. */
export const PERMISSION_DEFINITIONS = [
  {key:'overview',label:'Overview'},
  {key:'products',label:'Products'},
  {key:'suppliers',label:'Suppliers'},
  {key:'purchases',label:'Purchase GRNs'},
  {key:'stock',label:'Warehouse stock'},
  {key:'dispatches',label:'Dispatch orders'},
  {key:'receipts',label:'Branch receipts'},
  {key:'returns',label:'Branch returns'},
  {key:'adjustments',label:'Stock adjustments'},
  {key:'demands',label:'Branch demands'},
  {key:'approvals',label:'Approvals'},
  {key:'reports',label:'Reports'},
  {key:'audit',label:'Audit trail'},
  {key:'users',label:'Access & roles'},
  {key:'locations',label:'Locations & settings'},
  {key:'security',label:'Security'},
];
const all=PERMISSION_DEFINITIONS.map(permission=>permission.key);
const roleGrants={
  superadmin:all,
  admin:all.filter(key=>!['users','locations'].includes(key)),
  warehouse:['overview','products','stock','dispatches','receipts','returns','adjustments','demands','reports','audit','security'],
  purchasing:['overview','products','suppliers','purchases','stock','reports','audit','security'],
  branch:['dispatches','returns','demands','security'],
  viewer:all.filter(key=>!['users','locations','approvals'].includes(key)),
};
export function rolePermissions(role){return [...(roleGrants[role]||[])];}
export function defaultPermissions(role){return role==='branch'?['dispatches','returns','demands']:rolePermissions(role);}
export function permissionOptions(role){return PERMISSION_DEFINITIONS.filter(permission=>rolePermissions(role).includes(permission.key));}
export function normalizePermissions(role,supplied){
  if(role==='superadmin')return rolePermissions(role);
  if(supplied===undefined||supplied===null)return defaultPermissions(role);
  let selected=supplied;
  if(typeof selected==='string'){try{selected=JSON.parse(selected);}catch{return [];}}
  if(!Array.isArray(selected))return [];
  const permitted=rolePermissions(role);
  return permitted.filter(key=>selected.includes(key));
}
export function hasPermission(user,key){
  return !!user&&user.active!==false&&user.active!==0&&normalizePermissions(user.role,user.permissions).includes(key);
}
export function accessiblePages(user){return PERMISSION_DEFINITIONS.filter(permission=>hasPermission(user,permission.key)).map(permission=>permission.label);}

function documentPermission(document){return ({grn:'purchases',transfer:'dispatches',return:'returns',adjustment:'adjustments'})[document?.type];}
export function canAccessDocument(user,document,{review=false,receive=false}={}){
  if(!document)return false;
  if(user?.role==='branch'&&(document.branchId!==user.branchId||!['transfer','return'].includes(document.type)||document.type==='transfer'&&!['In transit','Discrepancy','Completed'].includes(document.status)))return false;
  if(review)return hasPermission(user,'approvals');
  if(document.type==='transfer'&&receive)return hasPermission(user,'dispatches')||hasPermission(user,'receipts');
  return hasPermission(user,documentPermission(document));
}
export function actionAllowed(user,action,payload,state){
  if(action==='user.save'||action==='workspace.clear-sample-data')return user?.role==='superadmin';
  const modules={'product.save':'products','supplier.save':'suppliers','location.save':'locations','stock.add':'adjustments','grn.create':'purchases','transfer.create':'dispatches','return.create':'returns','adjustment.create':'adjustments'};
  const central=['superadmin','admin','warehouse'];
  const creators={grn:['superadmin','admin','purchasing'],transfer:central,return:['superadmin','admin','branch'],adjustment:central};
  if(Object.hasOwn(modules,action)){
    const roles=action==='location.save'?['superadmin']:['product.save','supplier.save'].includes(action)?['superadmin','admin']:action==='stock.add'?central:creators[action.split('.')[0]];
    return roles.includes(user?.role)&&hasPermission(user,modules[action]);
  }
  if(action.startsWith('demand.')){
    const roles=action==='demand.cancel'?['superadmin','admin','warehouse','branch']:['demand.approve','demand.reject','demand.convert'].includes(action)?central:['superadmin','admin','branch'];
    return roles.includes(user?.role)&&hasPermission(user,'demands')&&(action!=='demand.convert'||hasPermission(user,'dispatches'));
  }
  if(action.startsWith('document.')){
    const reference=typeof payload.reference==='string'?payload.reference.trim().slice(0,100).toLowerCase():'';
    const document=(state.documents||[]).find(row=>row.id===payload.id||reference&&row.reference?.toLowerCase()===reference);
    const review=['document.approve','document.reject','document.resolve'].includes(action);
    if(user?.role==='viewer')return false;
    if(review&&!['superadmin','admin'].includes(user?.role))return false;
    if(!document)return ['purchases','dispatches','receipts','returns','adjustments','approvals'].some(key=>hasPermission(user,key));
    let roles=creators[document.type]||[];
    if(review)roles=['superadmin','admin'];
    else if(action==='document.dispatch')roles=document.type==='transfer'?central:document.type==='return'?creators.return:[];
    else if(action==='document.receive')roles=document.type==='transfer'?creators.return:document.type==='return'?central:[];
    return roles.includes(user?.role)&&canAccessDocument(user,document,{review,receive:action==='document.receive'});
  }
  return false;
}

/** Applied after branch/cost redaction, including every response after a mutation. */
export function filterModuleState(state,user){
  const result={...state};
  const permitted=key=>hasPermission(user,key);
  const documents=(state.documents||[]).filter(document=>permitted('reports')||canAccessDocument(user,document)||document.type==='transfer'&&permitted('receipts')||permitted('approvals')&&['Pending approval','Discrepancy'].includes(document.status));
  result.documents=documents;
  result.demands=permitted('demands')?(state.demands||[]).filter(demand=>user?.role!=='branch'||demand.branchId===user.branchId):[];
  result.suppliers=permitted('suppliers')||permitted('purchases')||permitted('reports')?(state.suppliers||[]):[];
  result.stock=['stock','reports','returns','adjustments'].some(permitted)?(state.stock||[]):[];
  result.ledger=permitted('stock')||permitted('reports')?(state.ledger||[]):[];
  result.audit=permitted('audit')?(state.audit||[]):[];
  result.losses=permitted('reports')||permitted('approvals')?(state.losses||[]):[];
  const catalogue=['products','purchases','stock','returns','adjustments','demands','reports'].some(permitted);
  const referenced=new Set(documents.flatMap(document=>(document.lines||[]).map(line=>line.productId)));
  result.products=catalogue?(state.products||[]):(state.products||[]).filter(product=>referenced.has(product.id));
  if(user?.role==='branch'){
    result.stock=result.stock.filter(row=>row.locationId===user.branchId);
    result.locations=(state.locations||[]).filter(location=>location.id===user.branchId||location.id==='WH');
  }
  if(!accessiblePages(user).length)result.locations=[];
  if(user?.role!=='superadmin'){delete result.sequence;delete result.lastAccessMutation;}
  return result;
}
