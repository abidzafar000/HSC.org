import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../lib/bootstrap.mjs';
import {execute,scopedState} from '../lib/engine.mjs';
import {actionAllowed} from '../lib/permissions.mjs';

const owner={id:'owner',name:'Owner',role:'superadmin'};
const administrator={id:'admin-two',name:'Administrator',role:'admin'};
const branch={id:'branch',name:'Branch',role:'branch',branchId:'B1'};
const create=(state,fields={})=>execute(state,owner,'product.save',{sku:'EXISTING',name:'Existing item',category:'Food',baseUnit:'pc',units:[{name:'pc',factor:1}],...fields});
const monthlyCollections=['stock','documents','ledger','losses','demands','suppliers','locations','sequence'];

test('name-only import deduplicates the workbook and existing catalogue without posting monthly records',()=>{
  const state=emptyState();create(state,{sku:'item-0001',name:'  Existing item  '});
  const before=structuredClone(state);
  const result=execute(state,administrator,'product.import',{names:['  COFFEE\n BEANS  ','coffee beans','ＥＸＩＳＴＩＮＧ item','New item'],sourceLabel:'Inventory food item names',importKey:'inventory-names-1'});
  assert.equal(result.created,2);assert.equal(result.matchedExisting,1);assert.equal(result.duplicatesSkipped,1);assert.equal(result.uniqueCount,3);
  assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(state.products.slice(1).map(item=>item.name),['COFFEE BEANS','New item']);
  assert.deepEqual(state.products.slice(1).map(item=>item.sku),['ITEM-0002','ITEM-0003']);
  for(const item of state.products.slice(1)){
    assert.equal(item.active,false);assert.equal(item.setupPending,true);
    assert.equal(item.category,'');assert.equal(item.baseUnit,'');assert.deepEqual(item.units,[]);assert.equal(item.rate,null);
    assert.ok(!Object.hasOwn(item,'opening'));assert.ok(!Object.hasOwn(item,'sourceSheet'));
  }
  for(const key of monthlyCollections)assert.deepEqual(state[key],before[key],key);
  assert.deepEqual(state.products[0],before.products[0]);
  assert.equal(state.catalogueImports.length,1);assert.equal(state.audit.length,before.audit.length+1);assert.equal(state.audit[0].action,'product.import');
});

test('repeated name lists are idempotent across ordering, spacing and case; reused keys reject different names',()=>{
  const state=emptyState();
  const first=execute(state,owner,'product.import',{names:['Tea','Milk'],importKey:'same-batch'});
  const before=structuredClone(state);
  const replay=execute(state,owner,'product.import',{names:[' milk ','TEA','tea'],sourceLabel:'Other label',importKey:'same-batch'});
  assert.equal(replay.repeated,true);assert.equal(replay.created,0);assert.equal(replay.fingerprint,first.fingerprint);assert.equal(replay.noChanges,true);
  assert.deepEqual(state,before);
  assert.throws(()=>execute(state,owner,'product.import',{names:['Sugar'],importKey:'same-batch'}),/different list/);
  assert.deepEqual(state,before);
  const another=execute(state,owner,'product.import',{names:['Tea','Sugar']});
  assert.equal(another.created,1);assert.equal(another.matchedExisting,1);assert.equal(state.products.length,3);
});

test('name imports reject monthly fields and malformed names before any state or audit change',()=>{
  const invalid=[
    {names:['Tea'],opening:0},{names:['Tea'],rate:12},{names:['Tea'],unit:'kg'},{names:['Tea'],category:'Food'},{names:['Tea'],month:'October'},
    {names:[]},{names:['Tea',' ']},{names:['Tea',3]},{names:['Tea',null]},{names:['Tea','bad\0name']},
    {names:['x'.repeat(161)]},{names:Array(1001).fill('Tea')},{names:['Tea'],sourceLabel:0},{names:['Tea'],sourceLabel:''},
    {names:['Tea'],importKey:{}},{names:['Tea'],importKey:''},{names:['Tea'],importKey:'x'.repeat(129)},
  ];
  for(const payload of invalid){const state=emptyState(),before=structuredClone(state);assert.throws(()=>execute(state,owner,'product.import',payload));assert.deepEqual(state,before);}
});

test('imports require both an administrator role and the products module',()=>{
  for(const role of ['branch','warehouse','purchasing','viewer']){
    const user={id:role,name:role,role,branchId:role==='branch'?'B1':null};
    const state=emptyState(),before=structuredClone(state);
    assert.equal(actionAllowed(user,'product.import',{names:['Tea']},state),false);
    assert.throws(()=>execute(state,user,'product.import',{names:['Tea']}),/permission|read only/);
    assert.deepEqual(state,before);
  }
  const limited={...administrator,permissions:['suppliers']};
  assert.equal(actionAllowed(limited,'product.import',{},emptyState()),false);
  assert.throws(()=>execute(emptyState(),limited,'product.import',{names:['Tea']}),/permission/);
});

test('unconfigured imports stay private and cannot enter orders; valid setup preserves their identity',()=>{
  const state=emptyState();execute(state,owner,'product.import',{names:['Tea'],sourceLabel:'Private source name'});
  const item=state.products[0],before=structuredClone(state);
  for(const user of [branch,{id:'wh',name:'Warehouse',role:'warehouse'},{id:'view',name:'Viewer',role:'viewer'}, {...administrator,permissions:['stock','audit']}]){
    const response=scopedState(state,user);
    assert.deepEqual(response.products,[]);
    assert.ok(!Object.hasOwn(response,'catalogueImports'));
    assert.ok(response.audit.every(entry=>entry.action!=='product.import'));
  }
  assert.equal(scopedState(state,administrator).products.length,1);
  assert.equal(scopedState(state,owner).catalogueImports.length,1);
  assert.throws(()=>execute(state,branch,'demand.create',{branchId:'B1',lines:[{productId:item.id,qty:1,unit:'pc'}]}),/inactive/);
  assert.deepEqual(state,before);
  assert.throws(()=>execute(state,owner,'product.save',{...item,active:true}),/required/);
  assert.deepEqual(state,before);
  const configured=execute(state,owner,'product.save',{...item,category:'Beverages',baseUnit:'kg',units:[{name:'kg',factor:1}],active:true});
  assert.equal(configured.id,item.id);assert.equal(configured.sku,item.sku);assert.equal(configured.active,true);assert.ok(!Object.hasOwn(configured,'setupPending'));
  assert.equal(scopedState(state,branch).products.length,1);
  for(const key of ['stock','documents','ledger'])assert.deepEqual(state[key],[]);
});
