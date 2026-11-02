import test from 'node:test';
import assert from 'node:assert/strict';
import {can,execute,scopedState,seedState} from '../lib/engine.mjs';
import {upgradeState} from '../lib/unit-upgrade.mjs';

const branch={id:'branch1',name:'Branch one',role:'branch',branchId:'B1'};
const second={id:'branch2',name:'Branch two',role:'branch',branchId:'B2'};
const admin={id:'checker',name:'Administrator',role:'admin'};
const owner={id:'owner',name:'Owner',role:'superadmin'};
const warehouse={id:'warehouse',name:'Warehouse',role:'warehouse'};
const lines=[{productId:'P1',qty:12,unit:'Packet'}];
const request=(state,payload={})=>execute(state,branch,'demand.create',{branchId:'B1',lines,...payload});
const review=(state,demand)=>execute(state,warehouse,'demand.approve',{id:demand.id});
const amounts=state=>JSON.stringify({stock:state.stock,ledger:state.ledger});

test('a branch can request unavailable stock without moving inventory; draft edit and submit is atomic',()=>{
  const state=seedState(),before=amounts(state);
  const demand=request(state,{lines:[{productId:'P1',qty:99999,unit:'Packet'}]});
  assert.equal(demand.status,'Draft');assert.match(demand.reference,/^DM-\d{4}-0001$/);
  execute(state,branch,'demand.update',{id:demand.id,lines,note:'Weekly replenishment',submit:true});
  assert.equal(demand.status,'Pending approval');assert.equal(demand.lines[0].baseQty,12);
  assert.equal(demand.note,'Weekly replenishment');assert.equal(amounts(state),before);
  assert.throws(()=>execute(state,branch,'demand.update',{id:demand.id,lines}),/Only draft/);
  assert.ok(state.audit.some(entry=>entry.action==='demand.update'&&entry.entityId===demand.id));
});

test('demand quantities, units, calendar dates and branch scope are validated before a request is saved',()=>{
  for(const payload of [
    {lines:[{productId:'P1',qty:0,unit:'Packet'}]},
    {lines:[{productId:'P1',qty:0.5,unit:'Packet'}]},
    {lines:[{productId:'P1',qty:1,unit:'L'}]},
    {lines:[...lines,...lines]},
    {lines:[{productId:'P1',qty:{value:1},unit:'Packet'}]},
    {date:'2026-02-30'},
    {branchId:'B2'},
    {submit:'true'},
  ]){
    const state=seedState(),before=JSON.stringify(state);
    assert.throws(()=>request(state,payload));assert.equal(JSON.stringify(state),before);
  }
});

test('demand reviews require central authority and Super Admin self-review requires a recorded override',()=>{
  const state=seedState(),demand=request(state,{submit:true});
  assert.throws(()=>execute(state,branch,'demand.approve',{id:demand.id}),/central warehouse|permission/);
  assert.throws(()=>execute(state,{...warehouse,permissions:['dispatches']},'demand.approve',{id:demand.id}),/permission/);
  review(state,demand);assert.equal(demand.status,'Approved');assert.equal(demand.approvedBy,warehouse.id);
  const own=execute(state,owner,'demand.create',{branchId:'B1',lines,submit:true});
  assert.throws(()=>execute(state,owner,'demand.approve',{id:own.id}),/Maker-checker/);
  assert.throws(()=>execute(state,owner,'demand.approve',{id:own.id,override:true}),/reason/);
  execute(state,owner,'demand.approve',{id:own.id,override:true,reason:'Owner reviewed branch replenishment'});
  assert.equal(own.approvalOverride.reason,'Owner reviewed branch replenishment');
});

test('rejected demands reopen with a reason; converted and cancelled requests cannot be silently changed',()=>{
  const state=seedState(),demand=request(state,{submit:true});
  assert.throws(()=>execute(state,warehouse,'demand.reject',{id:demand.id}),/reason/);
  execute(state,warehouse,'demand.reject',{id:demand.id,reason:'Please check requested quantity'});
  assert.equal(demand.status,'Rejected');
  assert.throws(()=>execute(state,branch,'demand.reopen',{id:demand.id}),/reason/);
  execute(state,branch,'demand.reopen',{id:demand.id,reason:'Quantity confirmed'});
  execute(state,branch,'demand.submit',{id:demand.id});review(state,demand);
  assert.throws(()=>execute(state,branch,'demand.cancel',{id:demand.id,reason:'Changed plan'}),/central reviewer/);
  execute(state,warehouse,'demand.cancel',{id:demand.id,reason:'No longer required'});
  assert.equal(demand.status,'Cancelled');assert.throws(()=>execute(state,branch,'demand.submit',{id:demand.id}),/Only draft/);
});

test('approved demand conversion creates one linked draft and stock moves only through the existing approved dispatch',()=>{
  const state=seedState(),before=amounts(state),demand=request(state,{submit:true});review(state,demand);
  const transfer=execute(state,warehouse,'demand.convert',{id:demand.id});
  assert.equal(transfer.status,'Draft');assert.equal(transfer.demandId,demand.id);
  assert.equal(demand.transferId,transfer.id);assert.equal(demand.transferReference,transfer.reference);
  assert.equal(demand.status,'Transfer created');assert.equal(amounts(state),before);
  assert.throws(()=>execute(state,warehouse,'demand.convert',{id:demand.id}),/cannot be created twice/);
  assert.ok(!scopedState(state,branch).documents.some(row=>row.id===transfer.id));
  execute(state,warehouse,'document.submit',{id:transfer.id});
  execute(state,admin,'document.approve',{id:transfer.id});
  execute(state,warehouse,'document.dispatch',{id:transfer.id});
  assert.ok(scopedState(state,branch).documents.some(row=>row.id===transfer.id));
  assert.notEqual(amounts(state),before);
});

test('demand conversion cannot reserve missing stock, bypass dispatch grants, or replace approved quantities',()=>{
  const state=seedState(),demand=request(state,{submit:true});review(state,demand);
  assert.throws(()=>execute(state,{...warehouse,permissions:['demands']},'demand.convert',{id:demand.id}),/permission/);
  const transfer=execute(state,warehouse,'demand.convert',{id:demand.id});
  assert.throws(()=>execute(state,warehouse,'document.update',{id:transfer.id,lines:[{productId:'P1',qty:13,unit:'Packet'}]}),/approved branch and quantities/);
  assert.throws(()=>execute(state,warehouse,'document.update',{id:transfer.id,branchId:'B2'}),/approved branch and quantities/);
  const large=request(state,{submit:true,lines:[{productId:'P1',qty:99999,unit:'Packet'}]});review(state,large);
  const before=JSON.stringify(state);
  assert.throws(()=>execute(state,warehouse,'demand.convert',{id:large.id}),/Insufficient/);
  assert.equal(JSON.stringify(state),before);
});

test('a cancelled gate pass can be replaced once while preserving demand and transfer links',()=>{
  const state=seedState(),demand=request(state,{submit:true});review(state,demand);
  const first=execute(state,warehouse,'demand.convert',{id:demand.id});
  execute(state,warehouse,'document.cancel',{id:first.id,reason:'Wrong vehicle; prepare again'});
  const second=execute(state,warehouse,'demand.convert',{id:demand.id});
  assert.notEqual(first.id,second.id);assert.deepEqual(demand.transferIds,[first.id,second.id]);
  assert.equal(first.demandId,demand.id);assert.equal(second.demandId,demand.id);
  assert.throws(()=>execute(state,warehouse,'demand.convert',{id:demand.id}),/cannot be created twice/);
});

test('demand item snapshots keep conversions locked while product names may be maintained',()=>{
  const state=seedState();
  const product=execute(state,owner,'product.save',{sku:'DEMAND-NEW',name:'New branch item',category:'Packaging',baseUnit:'pc',units:[{name:'pc',factor:1}]});
  const demand=request(state,{lines:[{productId:product.id,qty:3,unit:'pc'}]});
  assert.throws(()=>execute(state,owner,'product.save',{...product,units:[...product.units,{name:'Box',factor:10}]}),/locked/);
  execute(state,owner,'product.save',{...product,name:'Renamed branch item'});
  assert.equal(demand.lines[0].productName,'New branch item');assert.equal(demand.lines[0].baseQty,3);
});

test('branch response contains only its own issued dispatches, returns and demands with no monetary fields',()=>{
  const state=seedState(),own=request(state,{submit:true});
  execute(state,second,'demand.create',{branchId:'B2',lines,submit:true});
  assert.throws(()=>execute(state,second,'demand.cancel',{id:own.id,reason:'Unauthorized'}),/another location/);
  const scoped=scopedState(state,branch);
  assert.deepEqual(scoped.demands.map(row=>row.id),[own.id]);
  assert.ok(scoped.documents.every(row=>row.branchId==='B1'&&(row.type==='return'||['In transit','Discrepancy','Completed'].includes(row.status))));
  assert.deepEqual(scoped.audit,[]);assert.deepEqual(scoped.ledger,[]);assert.deepEqual(scoped.suppliers,[]);
  assert.ok(!JSON.stringify(scoped).includes('unitCost'));
  const restricted={...branch,permissions:['dispatches']},limited=scopedState(state,restricted);
  assert.deepEqual(limited.demands,[]);assert.deepEqual(limited.stock,[]);assert.ok(limited.documents.every(row=>row.type==='transfer'));
  assert.throws(()=>execute(state,restricted,'demand.create',{branchId:'B1',lines}),/permission/);
  assert.equal(can({...branch,permissions:['dispatches']},'dispatch'),false);
  assert.equal(can({...branch,permissions:['returns']},'receive'),false);
});

function receivedDispatch(state){
  const transfer=execute(state,warehouse,'transfer.create',{branchId:'B1',submit:true,lines:[{productId:'P1',qty:1,unit:'Carton (24)'}]});
  execute(state,admin,'document.approve',{id:transfer.id});execute(state,warehouse,'document.dispatch',{id:transfer.id});
  execute(state,branch,'document.receive',{id:transfer.id,lines:[{productId:'P1',receivedQty:20,damagedQty:4}]});
  return transfer;
}
const linkedReturn=(state,source,qty,payload={})=>execute(state,branch,'return.create',{branchId:'B1',sourceTransferId:source.id,lines:[{productId:'P1',qty,unit:'Packet'}],...payload});

test('dispatch-linked returns use actual received pieces and prevent concurrent over-return reservations',()=>{
  const state=seedState(),source=receivedDispatch(state),before=amounts(state);
  const first=linkedReturn(state,source,12);
  assert.equal(first.sourceTransferId,source.id);assert.equal(first.sourceTransferReference,source.reference);
  assert.equal(amounts(state),before);
  assert.throws(()=>linkedReturn(state,source,9),/remaining received quantity/);
  const reserved=structuredClone(state);
  assert.throws(()=>linkedReturn(state,source,9,{id:first.id}),/New documents cannot provide/);
  assert.deepEqual(state,reserved);
  const second=linkedReturn(state,source,8);assert.equal(second.lines[0].baseQty,8);
  assert.throws(()=>execute(state,branch,'document.update',{id:first.id,lines:[{productId:'P1',qty:13,unit:'Packet'}]}),/remaining received quantity/);
  assert.throws(()=>execute(state,branch,'document.update',{id:first.id,sourceTransferId:''}),/cannot change its source/);
  execute(state,branch,'document.cancel',{id:second.id,reason:'Consolidate returns'});
  execute(state,branch,'document.update',{id:first.id,lines:[{productId:'P1',qty:20,unit:'Packet'}]});
  assert.equal(first.lines[0].baseQty,20);
});

test('a dispatch return cannot use another branch, unreceived units, or add items absent from that dispatch',()=>{
  const state=seedState(),source=receivedDispatch(state);
  assert.throws(()=>execute(state,second,'return.create',{branchId:'B2',sourceTransferId:source.id,lines}),/belonging to this branch/);
  assert.throws(()=>linkedReturn(state,source,1,{lines:[{productId:'P1',qty:1,unit:'Carton (24)'}]}),/remaining received quantity/);
  assert.throws(()=>linkedReturn(state,source,1,{lines:[{productId:'P2',qty:1,unit:'Packet'}]}),/remaining received quantity/);
  const pending=state.documents.find(row=>row.type==='transfer'&&row.status==='Pending approval');
  assert.throws(()=>execute(state,branch,'return.create',{branchId:pending.branchId,sourceTransferId:pending.id,lines}),/assigned branch|belonging/);
});

test('source return allowance is checked when rejected requests reopen and approved requests dispatch',()=>{
  const state=seedState(),source=receivedDispatch(state);
  const first=linkedReturn(state,source,12,{submit:true});
  execute(state,admin,'document.reject',{id:first.id,reason:'Wrong return date'});
  const other=linkedReturn(state,source,12);
  assert.throws(()=>execute(state,branch,'document.reopen',{id:first.id,reason:'Date corrected'}),/remaining received quantity/);
  execute(state,branch,'document.cancel',{id:other.id,reason:'Use original return'});
  execute(state,branch,'document.reopen',{id:first.id,reason:'Date corrected'});
  execute(state,branch,'document.submit',{id:first.id});execute(state,admin,'document.approve',{id:first.id});
  // Simulate an imported legacy reservation that did not pass current creation checks.
  state.documents.push({...structuredClone(first),id:'legacy-return',status:'Draft'});
  const before=amounts(state);
  assert.throws(()=>execute(state,branch,'document.dispatch',{id:first.id}),/remaining received quantity/);
  assert.equal(amounts(state),before);
});

test('adding the demand collection upgrades old workspaces once without changing existing records',()=>{
  const state=seedState();delete state.demands;const before=structuredClone(state);
  assert.equal(upgradeState(state),true);assert.deepEqual(state,{...before,demands:[]});
  assert.equal(upgradeState(state),false);
});
