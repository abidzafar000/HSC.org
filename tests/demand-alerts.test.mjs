import test from 'node:test';
import assert from 'node:assert/strict';
import {canReceiveDemandAlerts,pendingDemandAlerts,safeSeenDemandAlerts,mergeSeenDemandAlerts,unseenDemandAlerts} from '../lib/demand-alerts.mjs';
import {emptyState} from '../lib/bootstrap.mjs';
import {execute} from '../lib/engine.mjs';

const owner={id:'owner',name:'Owner',role:'superadmin'};
const branch={id:'branch',name:'Branch requester',role:'branch',branchId:'B1'};
const reviewer={id:'reviewer',name:'Reviewer',role:'admin'};
const makeDemand=(overrides={})=>({id:'D1',reference:'DM-2026-0001',branchId:'B1',createdBy:'branch',createdByName:'Branch requester',status:'Pending approval',createdAt:'2026-11-03T09:00:00.000Z',lines:[{productId:'P1'}],history:[{at:'2026-11-03T09:00:00.000Z',action:'Created',status:'Pending approval'}],...overrides});

test('only assigned central reviewers receive demand alerts',()=>{
  for(const role of ['superadmin','admin','warehouse'])assert.equal(canReceiveDemandAlerts({...owner,role}),true);
  for(const role of ['branch','purchasing','viewer','unknown'])assert.equal(canReceiveDemandAlerts({...owner,role}),false);
  assert.equal(canReceiveDemandAlerts({...reviewer,permissions:[]}),false);
  assert.equal(canReceiveDemandAlerts({...reviewer,permissions:['demands']}),true);
  assert.equal(canReceiveDemandAlerts({...owner,active:false}),false);
  assert.equal(canReceiveDemandAlerts({...owner,id:''}),false);
  assert.equal(canReceiveDemandAlerts(null),false);
  assert.deepEqual(pendingDemandAlerts([makeDemand()],branch),[]);
});

test('pending submissions alert independently of selected location, without draft, own or closed requests',()=>{
  const requests=[makeDemand(),makeDemand({id:'D2',branchId:'B2'}),...['Draft','Approved','Rejected','Cancelled','Transfer created'].map((status,i)=>makeDemand({id:`closed-${i}`,status})),makeDemand({id:'own',createdBy:owner.id})];
  const alerts=pendingDemandAlerts(requests,owner);
  assert.deepEqual(alerts.map(alert=>alert.demandId),['D1','D2']);
  assert.equal(alerts[0].itemCount,1);assert.equal(alerts[0].createdByName,'Branch requester');
  assert.equal(alerts[0].submittedAt,'2026-11-03T09:00:00.000Z');
  assert.equal(alerts[0].id,alerts[0].eventKey);
  assert.deepEqual(pendingDemandAlerts([null,{},makeDemand({branchId:''})],owner),[]);
});

test('refreshes, history ordering and draft edits do not create another submission event',()=>{
  const history=[{at:'2026-11-03T08:00:00.000Z',action:'Created',status:'Draft'},{at:'2026-11-03T08:30:00.000Z',action:'update',status:'Draft'},{at:'2026-11-03T09:00:00.000Z',action:'submit',status:'Pending approval'}];
  const first=pendingDemandAlerts([makeDemand({history})],owner);
  const later=pendingDemandAlerts([makeDemand({history:[...history].reverse(),updatedAt:'2026-11-03T10:00:00.000Z',note:'Changed presentation'})],owner);
  assert.equal(first[0].eventKey,later[0].eventKey);
  assert.deepEqual(unseenDemandAlerts(later,[first[0].eventKey]),[]);
  assert.equal(pendingDemandAlerts([makeDemand(),makeDemand()],owner).length,1);
});

test('the real demand lifecycle creates a fresh alert only when a rejected demand is resubmitted',()=>{
  const state=emptyState();const item=execute(state,owner,'product.save',{name:'Rice bags',sku:'RICE',category:'Food',baseUnit:'pc',units:[{name:'pc',factor:1}],active:true});
  const demand=execute(state,branch,'demand.create',{branchId:'B1',lines:[{productId:item.id,qty:2,unit:'pc'}]});
  assert.deepEqual(pendingDemandAlerts(state.demands,owner),[]);
  execute(state,branch,'demand.update',{id:demand.id,note:'Needed today',submit:true});
  const first=pendingDemandAlerts(state.demands,owner)[0];assert.ok(first);
  execute(state,reviewer,'demand.reject',{id:demand.id,reason:'Review quantity'});
  execute(state,branch,'demand.reopen',{id:demand.id,reason:'Corrected request'});
  assert.deepEqual(pendingDemandAlerts(state.demands,owner),[]);
  execute(state,branch,'demand.submit',{id:demand.id});
  const second=pendingDemandAlerts(state.demands,owner)[0];
  assert.equal(second.demandId,first.demandId);assert.notEqual(second.eventKey,first.eventKey);
  assert.equal(unseenDemandAlerts([second],[first.eventKey]).length,1);
  execute(state,reviewer,'demand.approve',{id:demand.id});
  assert.deepEqual(pendingDemandAlerts(state.demands,owner),[]);
});

test('same-time resubmissions are distinct and old pending records remain stable',()=>{
  const created={at:'2026-11-03T09:00:00.000Z',action:'Created',status:'Pending approval'};
  const first=pendingDemandAlerts([makeDemand({history:[created]})],owner)[0];
  const second=pendingDemandAlerts([makeDemand({history:[created,{...created,action:'submit'}]})],owner)[0];
  assert.notEqual(first.eventKey,second.eventKey);
  const legacy=pendingDemandAlerts([makeDemand({history:undefined})],owner)[0];
  assert.equal(legacy.eventKey,pendingDemandAlerts([makeDemand({history:undefined})],owner)[0].eventKey);
});

test('acknowledgements tolerate invalid storage, deduplicate and keep a bounded recent history',()=>{
  assert.deepEqual(safeSeenDemandAlerts('bad JSON'),[]);
  assert.deepEqual(safeSeenDemandAlerts('{}'),[]);
  assert.deepEqual(safeSeenDemandAlerts(JSON.stringify(['old','new','new',null,3,''])),['old','new']);
  assert.deepEqual(safeSeenDemandAlerts(['one','two','three'],2),['two','three']);
  assert.deepEqual(safeSeenDemandAlerts(['x'.repeat(501)]),[]);
  const alert=pendingDemandAlerts([makeDemand()],owner)[0];
  assert.equal(unseenDemandAlerts([alert],null).length,1);
  assert.deepEqual(unseenDemandAlerts([alert],JSON.stringify([alert.eventKey])),[]);
});

test('stale cross-tab storage updates retain current acknowledgements and converge regardless of order',()=>{
  const first='D1:submission:1:2026-11-03T09:00:00.000Z';
  const second='D2:submission:1:2026-11-03T10:00:00.000Z';
  const local=[first,second],staleIncoming=JSON.stringify([first]);
  assert.deepEqual(mergeSeenDemandAlerts(local,staleIncoming),local);
  assert.deepEqual(mergeSeenDemandAlerts(staleIncoming,[second]),mergeSeenDemandAlerts([second],staleIncoming));
  assert.deepEqual(mergeSeenDemandAlerts(['legacy-b',second],['legacy-a',first]),['legacy-a','legacy-b',first,second]);
  assert.deepEqual(mergeSeenDemandAlerts(mergeSeenDemandAlerts([first],[second]),[first]),local);
});

test('acknowledgement merging rejects invalid storage and keeps the same 500 newest events in every tab',()=>{
  const keys=Array.from({length:505},(_,i)=>`D${i}:submission:1:${new Date(Date.UTC(2026,10,3,0,i)).toISOString()}`);
  const merged=mergeSeenDemandAlerts([...keys].reverse(),null,'broken JSON',{},['',5,'x'.repeat(501)]);
  assert.deepEqual(merged,keys.slice(5));
  assert.deepEqual(mergeSeenDemandAlerts(keys.slice(0,250),keys.slice(250)),merged);
  assert.deepEqual(mergeSeenDemandAlerts(),[]);
  assert.deepEqual(mergeSeenDemandAlerts(['b','a'],JSON.stringify(['a','c']),false),['a','b','c']);
});
