import test from 'node:test';
import assert from 'node:assert/strict';
import {accessiblePages,actionAllowed,canAccessDocument,defaultPermissions,filterModuleState,hasPermission,normalizePermissions,rolePermissions} from '../lib/permissions.mjs';

const branch={id:'branch-1',role:'branch',branchId:'B1',active:true};
const transfer={id:'T1',reference:'GP-TEST-1',type:'transfer',branchId:'B1',status:'In transit',lines:[{productId:'P1'}]};

test('branch defaults expose exactly dispatch orders, returns and demands, with deliberate empty grants supported',()=>{
  assert.deepEqual(defaultPermissions('branch'),['dispatches','returns','demands']);
  assert.deepEqual(accessiblePages(branch),['Dispatch orders','Branch returns','Branch demands']);
  assert.deepEqual(accessiblePages({...branch,permissions:['dispatches']}),['Dispatch orders']);
  assert.deepEqual(accessiblePages({...branch,permissions:[]}),[]);
  assert.deepEqual(accessiblePages({...branch,active:false}),[]);
});

test('stored grants cannot widen a role or treat invalid data as default access',()=>{
  assert.deepEqual(normalizePermissions('branch',['users','approvals','stock','returns','returns']),['returns']);
  assert.deepEqual(normalizePermissions('branch','["returns"]'),['returns']);
  for(const malformed of ['bad JSON','null','{}',true,{}])assert.deepEqual(normalizePermissions('branch',malformed),[]);
  assert.deepEqual(normalizePermissions('unknown',null),[]);
  assert.deepEqual(normalizePermissions('superadmin',[]),rolePermissions('superadmin'));
  assert.equal(hasPermission({...branch,permissions:['users']},'users'),false);
});

test('document grants keep branch dispatches scoped and hide undispatched warehouse work',()=>{
  assert.equal(canAccessDocument(branch,transfer),true);
  assert.equal(canAccessDocument(branch,{...transfer,branchId:'B2'}),false);
  for(const status of ['Draft','Pending approval','Approved','Rejected','Cancelled'])assert.equal(canAccessDocument(branch,{...transfer,status}),false);
  assert.equal(canAccessDocument(branch,{...transfer,type:'grn'}),false);
  assert.equal(canAccessDocument(branch,{...transfer,type:'adjustment'}),false);
  assert.equal(canAccessDocument(branch,{...transfer,type:'return',status:'Draft'}),true);
});

test('reference-based receipt cannot bypass revoked dispatch permissions or branch ownership',()=>{
  const state={documents:[transfer]};
  const request={reference:' gp-test-1 '};
  assert.equal(actionAllowed({...branch,permissions:['returns']},'document.receive',request,state),false);
  assert.equal(actionAllowed({...branch,branchId:'B2'},'document.receive',request,state),false);
  assert.equal(actionAllowed(branch,'document.receive',request,state),true);
  assert.equal(actionAllowed(branch,'document.dispatch',request,state),false);
  assert.equal(actionAllowed({role:'viewer',permissions:['returns']},'return.create',{},state),false);
  assert.equal(actionAllowed({role:'viewer',permissions:['dispatches']},'document.cancel',request,state),false);
});

test('review-only access and demand conversion require the relevant assigned modules',()=>{
  const reviewer={role:'admin',permissions:['approvals']};
  assert.equal(actionAllowed(reviewer,'document.approve',{id:transfer.id},{documents:[transfer]}),true);
  assert.equal(actionAllowed(reviewer,'document.dispatch',{id:transfer.id},{documents:[transfer]}),false);
  assert.equal(actionAllowed({role:'warehouse',permissions:['demands']},'demand.approve',{},{}),true);
  assert.equal(actionAllowed({role:'warehouse',permissions:['demands']},'demand.convert',{},{}),false);
  assert.equal(actionAllowed({role:'warehouse',permissions:['demands','dispatches']},'demand.convert',{},{}),true);
  assert.equal(actionAllowed(branch,'demand.approve',{},{}),false);
});

test('module response filtering retains return form support and removes unrelated records and hidden counters',()=>{
  const data={products:[{id:'P1'},{id:'P2'}],suppliers:[{id:'S1'}],documents:[transfer,{...transfer,id:'T2',branchId:'B2'},{id:'R',type:'return',branchId:'B1',status:'Draft',lines:[]}],stock:[{productId:'P1',locationId:'B1',qty:3},{productId:'P1',locationId:'WH',qty:100}],demands:[{id:'D1',branchId:'B1'},{id:'D2',branchId:'B2'}],ledger:[{}],audit:[{}],losses:[{}],locations:[{id:'WH'},{id:'B1'},{id:'B2'}],sequence:{grn:70},lastAccessMutation:'private-marker'};
  const filtered=filterModuleState(data,branch);
  assert.deepEqual(filtered.documents.map(row=>row.id),['T1','R']);
  assert.deepEqual(filtered.stock,[{productId:'P1',locationId:'B1',qty:3}]);
  assert.equal(filtered.products.length,2,'Returns and demands need product/unit choices');
  assert.deepEqual(filtered.demands.map(row=>row.id),['D1']);
  for(const key of ['suppliers','audit','ledger','losses'])assert.deepEqual(filtered[key],[]);
  assert.equal(filtered.sequence,undefined);assert.equal(filtered.lastAccessMutation,undefined);
  const dispatchOnly=filterModuleState(data,{...branch,permissions:['dispatches']});
  assert.deepEqual(dispatchOnly.products,[{id:'P1'}]);assert.deepEqual(dispatchOnly.stock,[]);assert.deepEqual(dispatchOnly.demands,[]);
  const noAccess=filterModuleState(data,{...branch,permissions:[]});
  for(const key of ['products','suppliers','documents','stock','demands','ledger','audit','losses','locations'])assert.deepEqual(noAccess[key],[]);
  assert.equal(data.stock.length,2,'Filtering must not mutate persisted records');
});

test('approvals-only reviewers receive supplier names for visible GRNs without the supplier catalogue or contacts',()=>{
  const suppliers=[
    {id:'S1',name:'Referenced supplier',contact:'Private contact',phone:'Private phone',email:'private@example.test',active:true},
    {id:'S2',name:'Unrelated supplier',contact:'Hidden contact',active:true},
  ];
  const state={
    suppliers,
    documents:[
      {id:'G1',type:'grn',status:'Pending approval',supplierId:'S1',lines:[{productId:'P1'}]},
      {id:'G2',type:'grn',status:'Draft',supplierId:'S2',lines:[{productId:'P2'}]},
      {...transfer,lines:[{productId:'P1'}]},
    ],
    products:[{id:'P1'},{id:'P2'}],stock:[],demands:[],ledger:[],audit:[],losses:[],locations:[],
  };
  const reviewer=filterModuleState(state,{id:'reviewer',role:'admin',permissions:['approvals']});
  assert.deepEqual(reviewer.documents.map(document=>document.id),['G1']);
  assert.deepEqual(reviewer.suppliers,[{id:'S1',name:'Referenced supplier'}]);
  assert.deepEqual(filterModuleState(state,branch).suppliers,[],'Branch users receive no supplier names or contacts');
  assert.deepEqual(filterModuleState(state,{role:'purchasing',permissions:['purchases']}).suppliers,suppliers,'Explicit purchasing access retains its supplier form support');
  assert.equal(suppliers[0].contact,'Private contact','The minimal projection must not mutate the stored supplier');
});
