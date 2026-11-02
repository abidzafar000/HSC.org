import test from 'node:test';
import assert from 'node:assert/strict';
import {seedState,execute} from '../lib/engine.mjs';

const purchaser={id:'edge-purchase',name:'Purchasing',role:'purchasing'};
const checker={id:'edge-checker',name:'Checker',role:'admin'};
const warehouse={id:'edge-warehouse',name:'Warehouse',role:'warehouse'};
const branch={id:'edge-branch',name:'Branch',role:'branch',branchId:'B1'};
const owner={id:'edge-owner',name:'Owner',role:'superadmin'};
const approve=(state,doc)=>execute(state,checker,'document.approve',{id:doc.id});

test('a converted dispatch above the input-unit limit remains fully receivable',()=>{
  for(const explicit of [false,true]) {
    const state=seedState();
    const line={productId:'P1',unit:'Carton (24)',qty:100_000_000};
    const purchase=execute(state,purchaser,'grn.create',{supplierId:'S1',submit:true,lines:[{...line,rate:1500}]});
    approve(state,purchase);
    const doc=execute(state,warehouse,'transfer.create',{branchId:'B1',submit:true,lines:[line]});
    approve(state,doc);
    execute(state,warehouse,'document.dispatch',{id:doc.id});
    const destination=state.stock.find(row=>row.productId==='P1'&&row.locationId==='B1');
    const before=destination.qty;
    assert.equal(doc.lines[0].baseQty,2_400_000_000);
    execute(state,branch,'document.receive',{id:doc.id,...(explicit?{lines:[{productId:'P1',receivedQty:2_400_000_000,damagedQty:0}]}:{})});
    assert.equal(doc.status,'Completed');
    assert.equal(destination.qty,before+2_400_000_000);
    assert.equal(state.ledger.filter(row=>row.documentId===doc.id&&row.locationId==='TRANSIT').reduce((sum,row)=>sum+row.qty,0),0);
  }
});

test('unit conversions reject unsafe quantities before a document or adjustment can be saved',()=>{
  const state=seedState();
  const product=execute(state,owner,'product.save',{sku:'EDGE-COUNT',name:'Large bundle',category:'Packaging',baseUnit:'pc',units:[{name:'pc',factor:1},{name:'Bundle',factor:1_000_000_000}]});
  const lines=[{productId:product.id,unit:'Bundle',qty:1_000_000_000,rate:1}];
  const before=state.documents.length;
  assert.throws(()=>execute(state,purchaser,'grn.create',{supplierId:'S1',lines}),/supported range/);
  assert.throws(()=>execute(state,owner,'adjustment.create',{locationId:'WH',note:'Oversized count',lines}),/supported range/);
  assert.equal(state.documents.length,before);
});

test('the smallest supported quantity cannot dispatch from an empty source',()=>{
  const state=seedState();
  state.stock.find(row=>row.productId==='P5'&&row.locationId==='WH').qty=0;
  assert.throws(()=>execute(state,warehouse,'transfer.create',{branchId:'B1',lines:[{productId:'P5',qty:0.000001,unit:'kg'}]}),/Insufficient/);
});

test('a smallest-step short receipt stays discrepant until its transit balance is resolved',()=>{
  const state=seedState();
  const doc=execute(state,warehouse,'transfer.create',{branchId:'B1',submit:true,lines:[{productId:'P5',qty:0.000001,unit:'kg'}]});
  approve(state,doc);
  execute(state,warehouse,'document.dispatch',{id:doc.id});
  execute(state,branch,'document.receive',{id:doc.id,lines:[{productId:'P5',receivedQty:0,damagedQty:0}]});
  assert.equal(doc.status,'Discrepancy');
  assert.equal(doc.lines[0].unresolvedQty,0.000001);
  execute(state,checker,'document.resolve',{id:doc.id,reason:'Smallest measured shortage approved.'});
  assert.equal(doc.status,'Completed');
  assert.equal(doc.lines[0].unresolvedQty,0);
  assert.equal(state.losses.find(row=>row.documentId===doc.id).qty,0.000001);
  assert.equal(state.ledger.filter(row=>row.documentId===doc.id&&row.locationId==='TRANSIT').reduce((sum,row)=>sum+row.qty,0),0);
});

test('a smallest-step opening adjustment retains its positive balance and unit cost',()=>{
  const state=seedState();
  const product=execute(state,owner,'product.save',{sku:'EDGE-WEIGHED',name:'Measured ingredient',category:'Dry goods',baseUnit:'kg',units:[{name:'kg',factor:1}]});
  const doc=execute(state,owner,'adjustment.create',{locationId:'WH',note:'Measured opening balance',submit:true,lines:[{productId:product.id,qty:0.000001,unit:'kg',rate:100}]});
  approve(state,doc);
  const stock=state.stock.find(row=>row.productId===product.id&&row.locationId==='WH');
  assert.equal(stock.qty,0.000001);
  assert.equal(stock.avgCost,100);
});

test('malformed product, adjustment and unit entries fail with clear validation errors',()=>{
  for(const entry of [null,[],true,1,'bad']) {
    const state=seedState();
    assert.throws(()=>execute(state,purchaser,'grn.create',{supplierId:'S1',lines:[entry]}),/Each product line must be an object/);
    assert.throws(()=>execute(state,warehouse,'transfer.create',{branchId:'B1',lines:[entry]}),/Each product line must be an object/);
    assert.throws(()=>execute(state,owner,'adjustment.create',{locationId:'WH',note:'Count correction',lines:[entry]}),/Each product line must be an object/);
    assert.throws(()=>execute(state,owner,'product.save',{sku:'BAD-ENTRY',name:'Malformed units',category:'General',baseUnit:'pc',units:[entry]}),/Each unit conversion must be an object/);
  }
});

test('malformed receipt entries fail before any stock or transit movement changes',()=>{
  for(const entry of [null,[],true,1,'bad']) {
    const state=seedState();
    const doc=state.documents.find(row=>row.type==='transfer'&&row.status==='In transit');
    const before={stock:structuredClone(state.stock),ledger:structuredClone(state.ledger)};
    assert.throws(()=>execute(state,{...branch,branchId:doc.branchId},'document.receive',{id:doc.id,lines:doc.lines.map(()=>entry)}),/Each receipt line must be an object/);
    assert.deepEqual(state.stock,before.stock);
    assert.deepEqual(state.ledger,before.ledger);
    assert.equal(doc.status,'In transit');
  }
});

test('accumulated stock cannot overflow the supported quantity range',()=>{
  const state=seedState();
  const stock=state.stock.find(row=>row.productId==='P1'&&row.locationId==='WH');
  stock.qty=Number.MAX_SAFE_INTEGER;
  assert.throws(()=>execute(state,owner,'adjustment.create',{locationId:'WH',note:'Unsupported excess count',lines:[{productId:'P1',qty:1,unit:'pc'}]}),/Stock balance exceeds the supported range/);
  const purchase=execute(state,purchaser,'grn.create',{supplierId:'S1',submit:true,lines:[{productId:'P1',qty:1,unit:'pc',rate:65}]});
  assert.throws(()=>approve(state,purchase),/Stock balance exceeds the supported range/);
  assert.equal(stock.qty,Number.MAX_SAFE_INTEGER);
});

test('structured values cannot bypass text and number validation or throw conversion errors',()=>{
  const state=seedState(),value={toString:null,valueOf:null};
  assert.throws(()=>execute(state,purchaser,'grn.create',{supplierId:'S1',lines:[{productId:'P1',qty:value,unit:'pc',rate:65}]}),/Quantity must be a number/);
  assert.throws(()=>execute(state,owner,'adjustment.create',{locationId:'WH',note:'Malformed opening rate',lines:[{productId:'P1',qty:1,unit:'pc',rate:value}]}),/Opening unit rate must be a number/);
  assert.throws(()=>execute(state,owner,'supplier.save',{name:value}),/Text fields must contain a simple value/);
  assert.throws(()=>execute(state,owner,'document.receive',{reference:value}),/Text fields must contain a simple value/);
});
