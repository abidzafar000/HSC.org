import test from 'node:test';
import assert from 'node:assert/strict';
import {seedState,execute} from '../lib/engine.mjs';

const owner={id:'owner',name:'Owner',role:'superadmin'};
const checker={id:'checker',name:'Checker',role:'admin'};
const warehouse={id:'warehouse',name:'Warehouse',role:'warehouse'};
const branch={id:'branch1',name:'Branch One',role:'branch',branchId:'B1'};
const payload={locationId:'WH',note:'Physical stock received without a purchase invoice.',lines:[{productId:'P1',qty:2,unit:'Carton (24)',rate:2400}]};
const balance=(state,location='WH',productId='P1')=>state.stock.find(row=>row.locationId===location&&row.productId===productId);
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.000001,`${actual} != ${expected}`);

test('Super Admin posts manual stock once at incoming unit cost with an audited reason',()=>{
  const state=seedState();
  const before=structuredClone(balance(state)),branchBefore=structuredClone(balance(state,'B1'));
  const doc=execute(state,owner,'stock.add',{...payload,postNow:true,override:true});
  assert.equal(doc.type,'adjustment');
  assert.equal(doc.stockAddition,true);
  assert.equal(doc.locationId,'WH');
  assert.equal(doc.branchId,null);
  assert.equal(doc.status,'Completed');
  assert.equal(doc.lines[0].baseQty,48);
  assert.equal(doc.lines[0].unitCost,100);
  assert.equal(doc.total,4800);
  assert.equal(balance(state).qty,before.qty+48);
  close(balance(state).avgCost,(before.qty*before.avgCost+4800)/(before.qty+48));
  assert.deepEqual(balance(state,'B1'),branchBefore);
  assert.equal(doc.approvalOverride.by,owner.id);
  assert.equal(doc.approvalOverride.reason,payload.note);
  assert.equal(state.ledger.filter(row=>row.documentId===doc.id).length,1);
  assert.equal(state.ledger.find(row=>row.documentId===doc.id).kind,'Manual stock addition');
  assert.equal(state.audit[0].action,'stock.add');
  assert.ok(state.audit.some(row=>row.entityId===doc.id&&/approval override/.test(row.detail)));
  assert.throws(()=>execute(state,owner,'document.approve',{id:doc.id,override:true,reason:'Repeat'}),/Only pending/);
  assert.equal(balance(state).qty,before.qty+48);
});

test('warehouse additions wait for independent approval and ordinary administrators cannot self-post',()=>{
  const state=seedState(),before=balance(state).qty;
  const doc=execute(state,warehouse,'stock.add',payload);
  assert.equal(doc.status,'Pending approval');
  assert.equal(balance(state).qty,before);
  assert.throws(()=>execute(state,warehouse,'document.approve',{id:doc.id}),/Only administrators/);
  execute(state,checker,'document.approve',{id:doc.id});
  assert.equal(balance(state).qty,before+48);
  assert.equal(doc.status,'Completed');
  for (const user of [warehouse,checker]) {
    const count=state.documents.length;
    assert.throws(()=>execute(state,user,'stock.add',{...payload,postNow:true,override:true}),/Only Super Admin/);
    assert.equal(state.documents.length,count);
  }
  const adminDoc=execute(state,checker,'stock.add',payload);
  assert.throws(()=>execute(state,checker,'document.approve',{id:adminDoc.id,override:true,reason:'Attempt'}),/Maker-checker/);
});

test('manual stock additions require WH, positive quantities, valid units and an explicit owner override',()=>{
  for (const change of [
    {locationId:'B1'},
    {note:''},
    {postNow:true},
    {postNow:'true'},
    {lines:[{productId:'P1',qty:-1,unit:'pc'}]},
    {lines:[{productId:'P1',qty:0,unit:'pc'}]},
    {lines:[{productId:'P1',qty:0.5,unit:'pc'}]},
    {lines:[{productId:'P1',qty:1,unit:'not-a-unit'}]},
  ]) {
    const state=seedState(),before=structuredClone(state);
    assert.throws(()=>execute(state,owner,'stock.add',{...payload,...change}));
    assert.deepEqual(state,before);
  }
  for (const role of ['branch','purchasing','viewer']) {
    const state=seedState(),before=structuredClone(state);
    assert.throws(()=>execute(state,{...branch,role},'stock.add',payload),/cannot add|read only/);
    assert.deepEqual(state,before);
  }
});

test('optional incoming rate falls back to the current average and new openings require a rate',()=>{
  const state=seedState(),before=structuredClone(balance(state));
  const fallback=execute(state,owner,'stock.add',{note:'Existing cost used.',postNow:true,override:true,lines:[{productId:'P1',qty:1,unit:'Packet',rate:0}]});
  assert.equal(fallback.lines[0].rate,null);
  assert.equal(balance(state).avgCost,before.avgCost);
  const product=execute(state,owner,'product.save',{sku:'MANUAL-OPEN',name:'New packets',category:'Packaging',baseUnit:'pc',units:[{name:'pc',factor:1},{name:'Bundle (10)',factor:10}]});
  const opening={note:'Opening physical inventory.',postNow:true,override:true,lines:[{productId:product.id,qty:2,unit:'Bundle (10)'}]};
  assert.throws(()=>execute(state,owner,'stock.add',opening),/opening rate/);
  const doc=execute(state,owner,'stock.add',{...opening,lines:[{...opening.lines[0],rate:150}]});
  assert.equal(doc.total,300);
  assert.equal(balance(state,'WH',product.id).qty,20);
  assert.equal(balance(state,'WH',product.id).avgCost,15);
});

test('reopened additions retain WH-only positive rules and incoming rates through editing and approval',()=>{
  const state=seedState(),doc=execute(state,warehouse,'stock.add',payload);
  execute(state,checker,'document.reject',{id:doc.id,reason:'Correct the carton count.'});
  execute(state,warehouse,'document.reopen',{id:doc.id,reason:'Count verified.'});
  for (const change of [{stockAddition:false},{locationId:'B1'},{lines:[{productId:'P1',qty:-1,unit:'pc'}]}]) {
    const before=structuredClone(doc);
    assert.throws(()=>execute(state,warehouse,'document.update',{id:doc.id,...change}));
    assert.deepEqual(doc,before);
  }
  execute(state,warehouse,'document.update',{id:doc.id,stockAddition:true,lines:[{productId:'P1',qty:1,unit:'Carton (24)',rate:1200}]});
  assert.equal(doc.stockAddition,true);
  assert.equal(doc.lines[0].unitCost,50);
  const before=structuredClone(balance(state));
  execute(state,warehouse,'document.submit',{id:doc.id});
  execute(state,checker,'document.approve',{id:doc.id});
  assert.equal(doc.lines[0].unitCost,50);
  assert.equal(balance(state).qty,before.qty+24);
  close(balance(state).avgCost,(before.qty*before.avgCost+1200)/(before.qty+24));
});

test('addition approval revalidates all lines before posting any stock',()=>{
  const state=seedState();
  const doc=execute(state,warehouse,'stock.add',{...payload,lines:[payload.lines[0],{productId:'P5',qty:1,unit:'kg'}]});
  state.products.find(row=>row.id==='P5').active=false;
  const before=structuredClone(state.stock),ledgerCount=state.ledger.length;
  assert.throws(()=>execute(state,checker,'document.approve',{id:doc.id}),/inactive/);
  assert.deepEqual(state.stock,before);
  assert.equal(state.ledger.length,ledgerCount);
});

test('manual additions cannot use fractional pieces to reconcile a flagged legacy balance',()=>{
  const state=seedState();
  Object.assign(balance(state),{qty:153.6,countReviewRequired:true});
  const addition={note:'Physical packet delivery.',postNow:true,override:true,lines:[{productId:'P1',qty:0.4,unit:'pc'}]};
  const before=structuredClone(state);
  assert.throws(()=>execute(state,owner,'stock.add',addition),/whole pieces/);
  assert.deepEqual(state,before);
  const correction=execute(state,warehouse,'adjustment.create',{locationId:'WH',note:'Physical packet count is 154.',submit:true,lines:addition.lines});
  execute(state,checker,'document.approve',{id:correction.id});
  assert.equal(balance(state).qty,154);
  assert.equal(balance(state).countReviewRequired,undefined);
});
