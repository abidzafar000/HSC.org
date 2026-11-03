import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../lib/bootstrap.mjs';
import {execute,scopedState} from '../lib/engine.mjs';

const owner={id:'owner',name:'Owner',role:'superadmin'};
const branch={id:'branch',name:'Branch',role:'branch',branchId:'B1'};
const fields={sku:'RATE-001',name:'Reference-rate item',category:'Food',baseUnit:'kg',units:[{name:'kg',factor:1},{name:'Bag (25 kg)',factor:25}]};
const create=(state,extra={})=>execute(state,owner,'product.save',{...fields,...extra});
const save=(state,item,extra={})=>execute(state,owner,'product.save',{...structuredClone(item),...extra});

test('a zero-opening catalogue retains an explicit zero rate separately from an unknown rate',()=>{
  const state=emptyState();
  const unknown=create(state);
  const free=create(state,{sku:'RATE-002',name:'Zero-rate item',rate:0});
  assert.equal(unknown.rate,null);
  assert.equal(free.rate,0);
  assert.deepEqual(state.stock,[]);
  assert.deepEqual(state.documents,[]);
  assert.deepEqual(state.ledger,[]);
});

test('reference rates normalize numeric input, survive omitted edits, and can be cleared deliberately',()=>{
  const state=emptyState(),item=create(state,{rate:'125.50'});
  assert.equal(item.rate,125.5);
  const {rate,...withoutRate}=structuredClone(item);
  execute(state,owner,'product.save',{...withoutRate,name:'Renamed item'});
  assert.equal(item.rate,125.5);
  for(const empty of [null,'','  ']){
    save(state,item,{rate:empty});assert.equal(item.rate,null);
    save(state,item,{rate:0});assert.equal(item.rate,0);
  }
  const {rate:zero,...omitZero}=structuredClone(item);
  execute(state,owner,'product.save',omitZero);
  assert.equal(item.rate,0);
});

test('invalid reference rates fail before changing master data or audit history',()=>{
  for(const rate of [-1,NaN,Infinity,'not a price',true,false,{},[],1000000001]){
    const state=emptyState(),before=structuredClone(state);
    assert.throws(()=>create(state,{rate}),/Reference rate/);
    assert.deepEqual(state,before);
  }
});

test('a product reference rate never posts stock or replaces actual incoming cost',()=>{
  const state=emptyState(),item=create(state,{rate:1200});
  execute(state,owner,'stock.add',{locationId:'WH',postNow:true,override:true,note:'Opening actual cost',lines:[{productId:item.id,qty:2,unit:'kg',rate:10}]});
  const stock=structuredClone(state.stock),ledger=structuredClone(state.ledger);
  assert.equal(stock[0].qty,2);assert.equal(stock[0].avgCost,10);
  save(state,item,{rate:1500});
  assert.equal(item.rate,1500);
  assert.deepEqual(state.stock,stock);
  assert.deepEqual(state.ledger,ledger);
  const zero=create(state,{sku:'RATE-002',name:'Zero-rate item',rate:0});
  const before=structuredClone(state);
  assert.throws(()=>execute(state,owner,'stock.add',{locationId:'WH',postNow:true,override:true,note:'Unknown opening cost',lines:[{productId:zero.id,qty:1,unit:'kg',rate:0}]}),/opening rate/);
  assert.deepEqual(state,before);
});

test('branch catalogue responses remove every reference rate, including zero and null',()=>{
  const state=emptyState();
  create(state,{rate:125});create(state,{sku:'RATE-002',name:'Zero-rate item',rate:0});create(state,{sku:'RATE-003',name:'Unknown-rate item'});
  const restricted=scopedState(state,branch),full=scopedState(state,owner);
  assert.equal(restricted.products.length,3);
  assert.ok(restricted.products.every(item=>!Object.hasOwn(item,'rate')));
  assert.deepEqual(full.products.map(item=>item.rate),[125,0,null]);
  assert.deepEqual(state.products.map(item=>item.rate),[125,0,null]);
});
