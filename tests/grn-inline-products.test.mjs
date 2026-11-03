import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../lib/bootstrap.mjs';
import {execute} from '../lib/engine.mjs';

const owner={id:'owner',name:'Owner',role:'superadmin'};
const buyer={id:'buyer',name:'Buyer',role:'purchasing',permissions:['purchases']};
const reviewer={id:'reviewer',name:'Reviewer',role:'admin'};
const fresh=()=>{const state=emptyState();state.suppliers.push({id:'S1',name:'Test supplier',active:true});return state;};
const inline=(name='New sealed packets',baseUnit='pc')=>({productId:'',newProduct:{name,category:'Food',baseUnit},unit:baseUnit,qty:10,rate:20,discount:0,tax:0});
const grn=lines=>({supplierId:'S1',lines});
const unchanged=(state,run,pattern)=>{const before=structuredClone(state);assert.throws(run,pattern);assert.deepEqual(state,before);};
const balance=(state,id)=>state.stock.find(row=>row.productId===id&&row.locationId==='WH');

test('a buyer creates a ready product through a GRN without general master access or opening stock',()=>{
  const state=fresh();
  const doc=execute(state,buyer,'grn.create',grn([inline()]));
  assert.equal(state.products.length,1);const item=state.products[0];
  assert.equal(item.name,'New sealed packets');assert.equal(item.category,'Food');assert.equal(item.active,true);
  assert.equal(item.baseUnit,'pc');assert.deepEqual(item.units,[{name:'pc',factor:1}]);
  assert.equal(item.rate,20);assert.equal(item.reorderLevel,0);assert.equal(item.sku,'ITEM-0001');
  assert.equal(doc.status,'Draft');assert.equal(doc.lines[0].productId,item.id);assert.equal(doc.lines[0].newProduct,undefined);
  assert.deepEqual(state.stock,[]);assert.deepEqual(state.ledger,[]);
  assert.ok(state.audit.some(row=>row.action==='product.create'&&row.userId===buyer.id&&row.entityId===item.id));
  unchanged(state,()=>execute(state,buyer,'product.save',{...item,name:'Unauthorized rename'}),/permission/);
});

test('GRN approval posts inline products once with landed cost and later receipts keep weighted average',()=>{
  const state=fresh();
  const doc=execute(state,buyer,'grn.create',{...grn([{...inline(),discount:10,tax:5}]),freight:11,submit:true});
  const id=doc.lines[0].productId;
  assert.equal(balance(state,id),undefined);assert.equal(doc.total,200);
  execute(state,reviewer,'document.approve',{id:doc.id});
  assert.equal(doc.status,'Completed');assert.equal(balance(state,id).qty,10);assert.equal(balance(state,id).avgCost,20);
  assert.equal(state.ledger.length,1);
  unchanged(state,()=>execute(state,reviewer,'document.approve',{id:doc.id}),/Only pending/);
  const second=execute(state,buyer,'grn.create',{...grn([{productId:id,qty:10,unit:'pc',rate:40}]),submit:true});
  execute(state,reviewer,'document.approve',{id:second.id});
  assert.equal(state.products.length,1);assert.equal(balance(state,id).qty,20);assert.equal(balance(state,id).avgCost,30);
});

test('normalized existing and same-request duplicate names roll back the whole GRN',()=>{
  const state=fresh();execute(state,buyer,'grn.create',grn([inline('Coffee beans')]));
  unchanged(state,()=>execute(state,buyer,'grn.create',grn([inline('New valid item'),inline('  ＣＯＦＦＥＥ   beans  ')])),/already exists/);
  unchanged(state,()=>execute(state,buyer,'grn.create',grn([inline('Unlisted food'),inline(' UNLISTED  FOOD ')])),/already exists/);
  state.products.push({id:'pending',sku:'ITEM-0002',name:'Pending sugar',setupPending:true,active:false,baseUnit:'',units:[]});
  unchanged(state,()=>execute(state,buyer,'grn.create',grn([inline('Pending sugar')])),/completing or activating/);
});

test('invalid metadata, quantities, rates, supplier and later lines leave no new masters or audit rows',()=>{
  const attempts=[
    {lines:[{...inline(),newProduct:{name:'',category:'Food',baseUnit:'pc'}}]},
    {lines:[{...inline(),newProduct:{name:'Valid name',category:'',baseUnit:'pc'}}]},
    {lines:[{...inline(),newProduct:{name:'Valid name',category:'Food',baseUnit:'carton'}}]},
    {lines:[{...inline(),newProduct:{name:'Valid name',category:'Food',baseUnit:'pc',warehouseQuantity:5}}]},
    {lines:[{...inline(),qty:1.5}]},{lines:[{...inline(),qty:0}]},{lines:[{...inline(),rate:0}]},
    {lines:[{...inline(),rate:'bad'}]},{lines:[{...inline(),unit:'kg'}]},
    {lines:[inline(),{productId:'missing',qty:1,unit:'pc',rate:20}]},
    {lines:[inline()],freight:-1},{lines:[inline()],supplierId:'missing'},
  ];
  for(const payload of attempts){const state=fresh();unchanged(state,()=>execute(state,buyer,'grn.create',{supplierId:'S1',...payload}));}
});

test('generated product codes skip collisions and liquid/weight products retain their own unit',()=>{
  const state=fresh();state.products.push({id:'reserved',sku:'ITEM-0001',name:'Reserved draft',active:false});
  const doc=execute(state,buyer,'grn.create',grn([{...inline('Liquid stock','liters'),qty:1.25},{...inline('Vegetables','kg'),qty:2.5}]));
  const liquid=state.products.find(row=>row.id===doc.lines[0].productId),vegetables=state.products.find(row=>row.id===doc.lines[1].productId);
  assert.equal(liquid.sku,'ITEM-0002');assert.equal(vegetables.sku,'ITEM-0003');
  assert.equal(liquid.baseUnit,'L');assert.equal(doc.lines[0].unit,'L');assert.equal(doc.lines[0].baseQty,1.25);
  assert.equal(vegetables.baseUnit,'kg');assert.equal(doc.lines[1].baseQty,2.5);
});

test('draft edits create new items atomically and subsequent saves reuse the linked product',()=>{
  const state=fresh();const original=execute(state,buyer,'grn.create',grn([inline('First item')]));
  const existingLine=structuredClone(original.lines[0]);
  unchanged(state,()=>execute(state,buyer,'document.update',{id:original.id,lines:[existingLine,{...inline('Second item'),qty:0}]}));
  const updated=execute(state,buyer,'document.update',{id:original.id,lines:[existingLine,inline('Second item')]});
  assert.equal(state.products.length,2);assert.equal(state.documents.length,1);assert.equal(updated.lines.length,2);
  assert.equal(updated.lines[1].newProduct,undefined);assert.deepEqual(state.stock,[]);
  execute(state,buyer,'document.update',{id:updated.id,lines:updated.lines.map(row=>({...row,qty:12}))});
  assert.equal(state.products.length,2);assert.equal(state.documents[0].lines[1].qty,12);
  execute(state,buyer,'document.submit',{id:updated.id});
  unchanged(state,()=>execute(state,buyer,'document.update',{id:updated.id,lines:[inline('Late item')]}),/Only draft/);
});

test('inline creation respects GRN permissions and cannot be smuggled into other document types',()=>{
  const state=fresh();
  for(const user of [{id:'w',name:'Warehouse',role:'warehouse'},{...buyer,permissions:[]},{id:'b',name:'Branch',role:'branch',branchId:'B1'}])
    unchanged(state,()=>execute(state,user,'grn.create',grn([inline()])),/permission/);
  for(const [action,payload] of [['transfer.create',{branchId:'B1'}],['adjustment.create',{locationId:'WH',note:'Count'}],['demand.create',{branchId:'B1'}]])
    unchanged(state,()=>execute(state,owner,action,{...payload,lines:[inline()]}),/only be created within a purchase GRN/);
  const draft=execute(state,buyer,'grn.create',grn([inline()]));
  unchanged(state,()=>execute(state,{...buyer,id:'another-buyer'},'document.update',{id:draft.id,lines:[inline('Another item')]}),/Only the creator/);
  unchanged(state,()=>execute(state,buyer,'grn.create',grn([{...inline('Overwrite attempt'),productId:draft.lines[0].productId}])),/not both/);
});
