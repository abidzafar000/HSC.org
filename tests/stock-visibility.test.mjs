import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../lib/bootstrap.mjs';
import {execute} from '../lib/engine.mjs';
import {warehouseStockRows} from '../lib/location-view.mjs';

const owner={id:'owner',name:'Owner',role:'superadmin'};
const ready=(id,extra={})=>({id,name:id,sku:id,active:true,category:'Food',baseUnit:'pc',units:[{name:'pc',factor:1}],...extra});
const locations=[{id:'WH',type:'warehouse'},{id:'B1',type:'branch'}];

test('completing and activating an imported product shows zero stock without posting inventory',()=>{
  const state=emptyState();
  execute(state,owner,'product.import',{names:['Warehouse visibility item']});
  const item=state.products[0];
  assert.deepEqual(warehouseStockRows(state,owner,'WH'),[]);
  const fields={...item,category:'Food',baseUnit:'pc',units:[{name:'pc',factor:1}],active:false};
  execute(state,owner,'product.save',fields);
  assert.deepEqual(warehouseStockRows(state,owner,'WH'),[]);
  execute(state,owner,'product.save',{...fields,active:true});
  const before=structuredClone(state);
  const shown=warehouseStockRows(state,owner,'WH');
  assert.deepEqual(shown,[{locationId:'WH',productId:item.id,qty:0,avgCost:0,unstocked:true}]);
  assert.deepEqual(state,before);
  assert.deepEqual(state.stock,[]);assert.deepEqual(state.documents,[]);assert.deepEqual(state.ledger,[]);
});

test('a first stock receipt replaces the display-only zero row without duplication or costing changes',()=>{
  const state=emptyState();
  const item=execute(state,owner,'product.save',{sku:'ZERO-1',name:'Zero stock item',category:'Food',baseUnit:'kg',units:[{name:'kg',factor:1}],rate:999});
  assert.equal(warehouseStockRows(state,owner,'WH')[0].avgCost,0);
  execute(state,owner,'stock.add',{locationId:'WH',postNow:true,override:true,note:'Actual opening balance',lines:[{productId:item.id,qty:5,unit:'kg',rate:20}]});
  const before=structuredClone(state),shown=warehouseStockRows(state,owner,'WH');
  assert.equal(shown.length,1);assert.equal(shown[0].qty,5);assert.equal(shown[0].avgCost,20);assert.equal(shown[0].unstocked,undefined);
  assert.deepEqual(state,before);
});

test('only active fully configured products get warehouse placeholders; historical stock remains visible',()=>{
  const data={locations,products:[ready('ready'),ready('inactive',{active:false}),ready('pending',{setupPending:true}),ready('no-category',{category:''}),ready('no-unit',{baseUnit:''}),ready('no-conversion',{units:[]}),ready('bad-conversion',{units:[{name:'pc',factor:12}]}),ready('ready')],stock:[{locationId:'WH',productId:'inactive',qty:3,avgCost:9}]};
  const before=structuredClone(data),shown=warehouseStockRows(data,owner,'WH');
  assert.deepEqual(shown.map(row=>row.productId),['inactive','ready']);
  assert.equal(shown[0].qty,3);assert.equal(shown[0].avgCost,9);
  assert.deepEqual(data,before);
});

test('All locations adds only a central zero row and a selected branch never gains synthetic stock',()=>{
  const data={locations,products:[ready('new')],stock:[{locationId:'B1',productId:'new',qty:2,avgCost:5}]};
  assert.deepEqual(warehouseStockRows(data,owner,'All').map(row=>[row.locationId,row.qty]),[['B1',2],['WH',0]]);
  assert.deepEqual(warehouseStockRows(data,owner,'B1'),data.stock);
  assert.equal(warehouseStockRows(data,owner,'WH').length,1);
});

test('branch scope and missing warehouse or stock permission prevent synthesized warehouse balances',()=>{
  const data={locations,products:[ready('new')],stock:[]};
  for(const user of [{id:'b',role:'branch',branchId:'B1'},{id:'a',role:'admin',permissions:['products']},{id:'v',role:'viewer',permissions:['reports']},null]){
    assert.deepEqual(warehouseStockRows(data,user,'All'),[]);
    assert.deepEqual(warehouseStockRows(data,user,'WH'),[]);
  }
  assert.deepEqual(warehouseStockRows({...data,locations:[locations[1]]},owner,'WH'),[]);
  assert.deepEqual(warehouseStockRows(data,{id:'a',role:'admin',active:false},'WH'),[]);
});
