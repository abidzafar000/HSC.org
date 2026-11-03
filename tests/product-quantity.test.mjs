import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../lib/bootstrap.mjs';
import {execute} from '../lib/engine.mjs';

const owner={id:'owner',name:'Owner',role:'superadmin'};
const admin={id:'admin-two',name:'Administrator',role:'admin'};
const other={id:'reviewer',name:'Reviewer',role:'admin'};
const base={sku:'COUNT-1',name:'Product count test',category:'Food',baseUnit:'pc',units:[{name:'pc',factor:1}],active:true,rate:20};
const quantity=(state,id)=>state.stock.find(row=>row.locationId==='WH'&&row.productId===id)?.qty||0;

test('a product setup quantity posts once into Central Warehouse with an audited opening cost',()=>{
  const state=emptyState();
  const item=execute(state,owner,'product.save',{...base,warehouseQuantity:100,warehouseRate:20});
  assert.equal(quantity(state,item.id),100);assert.equal(state.stock[0].avgCost,20);
  assert.equal(state.documents.length,1);assert.equal(state.documents[0].status,'Completed');
  assert.deepEqual(state.documents[0].productQuantitySetup,{productId:item.id,fromQty:0,targetQty:100});
  assert.ok(state.documents[0].approvalOverride.reason.includes('100 pc'));
  assert.ok(state.audit.some(entry=>entry.action==='document.approve'));
  assert.ok(!Object.hasOwn(item,'warehouseQuantity'));
  const ledger=structuredClone(state.ledger);
  execute(state,owner,'product.save',{...item,warehouseQuantity:100,warehouseRate:20});
  assert.equal(quantity(state,item.id),100);assert.equal(state.documents.length,1);assert.deepEqual(state.ledger,ledger);
});

test('product quantity is an absolute count and later increases or decreases do not double stock',()=>{
  const state=emptyState();let item=execute(state,owner,'product.save',{...base,warehouseQuantity:100,warehouseRate:20});
  item=execute(state,owner,'product.save',{...item,warehouseQuantity:120});assert.equal(quantity(state,item.id),120);
  assert.equal(state.documents[0].lines[0].baseQty,20);
  item=execute(state,owner,'product.save',{...item,warehouseQuantity:80});assert.equal(quantity(state,item.id),80);
  assert.equal(state.documents[0].lines[0].baseQty,-40);
  assert.equal(state.stock[0].avgCost,20);
  execute(state,owner,'product.save',{...item,name:'Renamed without stock change',rate:500});assert.equal(quantity(state,item.id),80);
  assert.equal(state.documents.length,3);
});

test('invalid quantity, missing opening cost and missing stock permission roll back the complete product save',()=>{
  for(const fields of [{warehouseQuantity:1},{warehouseQuantity:1.5,warehouseRate:20},{warehouseQuantity:-1},{warehouseQuantity:'bad'},{warehouseQuantity:100,warehouseRate:0},{warehouseQuantity:1,warehouseRate:20,active:false}]){
    const state=emptyState(),before=structuredClone(state);
    assert.throws(()=>execute(state,owner,'product.save',{...base,...fields}));assert.deepEqual(state,before);
  }
  const state=emptyState(),before=structuredClone(state);
  assert.throws(()=>execute(state,{...admin,permissions:['products']},'product.save',{...base,warehouseQuantity:100,warehouseRate:20}),error=>error.status===403);
  assert.deepEqual(state,before);
});

test('ordinary administrators queue one quantity request and another reviewer posts it once',()=>{
  const state=emptyState();let item=execute(state,admin,'product.save',{...base,warehouseQuantity:100,warehouseRate:20});
  assert.equal(quantity(state,item.id),0);assert.equal(state.documents.length,1);const id=state.documents[0].id;
  assert.equal(state.documents[0].status,'Pending approval');
  item=execute(state,admin,'product.save',{...item,warehouseQuantity:100,warehouseRate:20});assert.equal(state.documents.length,1);
  const before=structuredClone(state);
  assert.throws(()=>execute(state,admin,'document.approve',{id}),/another administrator/);assert.deepEqual(state,before);
  execute(state,other,'document.approve',{id});assert.equal(quantity(state,item.id),100);
  assert.throws(()=>execute(state,other,'document.approve',{id}),/Only pending/);
  assert.equal(quantity(state,item.id),100);
});

test('a queued absolute count cannot approve after a real warehouse movement changes its basis',()=>{
  const state=emptyState();const item=execute(state,admin,'product.save',{...base,warehouseQuantity:100,warehouseRate:20});
  const pending=state.documents[0];
  execute(state,owner,'stock.add',{locationId:'WH',postNow:true,override:true,note:'Independent stock receipt',lines:[{productId:item.id,qty:10,unit:'pc',rate:20}]});
  const before=structuredClone(state);
  assert.throws(()=>execute(state,other,'document.approve',{id:pending.id}),/stock changed/);assert.deepEqual(state,before);assert.equal(quantity(state,item.id),10);
  assert.throws(()=>execute(state,admin,'product.save',{...item,warehouseQuantity:100,warehouseRate:20}),/earlier quantity request/);assert.deepEqual(state,before);
});

test('a form opened before another receipt cannot overwrite that new warehouse count',()=>{
  const state=emptyState();let item=execute(state,owner,'product.save',{...base,warehouseQuantity:100,warehouseRate:20});
  item=execute(state,owner,'product.save',{...item,warehouseQuantity:110,warehouseExpectedQuantity:100});
  const before=structuredClone(state);
  assert.throws(()=>execute(state,owner,'product.save',{...item,name:'Stale edit',warehouseQuantity:120,warehouseExpectedQuantity:100}),error=>error.status===409);
  assert.deepEqual(state,before);assert.equal(quantity(state,item.id),110);
});
