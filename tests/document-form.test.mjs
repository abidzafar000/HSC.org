import test from 'node:test';
import assert from 'node:assert/strict';
import {availableLineProducts, canAddDocumentLine, dispatchReturnAllowances, documentPrerequisite, newProductNameIssue} from '../lib/document-form.mjs';

const products = [{id:'A',active:true},{id:'B',active:true},{id:'C',active:false}];

test('document editor offers active products once and stops when all are used', () => {
  assert.deepEqual(availableLineProducts(products,[{productId:'A'}]).map(product=>product.id),['B']);
  assert.deepEqual(availableLineProducts(products,[{productId:'A'},{productId:'B'}]),[]);
  assert.deepEqual(availableLineProducts([],[]),[]);
  assert.deepEqual(availableLineProducts(products,[{productId:'A'},{productId:'B'}],'A').map(product=>product.id),['A']);
});

test('document creation reports missing master data before opening an unusable form', () => {
  assert.match(documentPrerequisite('transfer',[],[]),/product/);
  assert.match(documentPrerequisite('grn',[{id:'A',active:false}],[]),/supplier/);
  assert.match(documentPrerequisite('grn',products,[{active:false}]),/supplier/);
  assert.equal(documentPrerequisite('grn',products,[{active:true}]),'');
  assert.equal(documentPrerequisite('grn',[],[{active:true}]),'');
  assert.equal(documentPrerequisite('transfer',products,[]),'');
});

test('GRNs can append new items with an empty or exhausted catalogue, within the document limit', () => {
  assert.equal(canAddDocumentLine('grn',[],[]),true);
  assert.equal(canAddDocumentLine('grn',products,[{productId:'A'},{productId:'B'}]),true);
  assert.equal(canAddDocumentLine('transfer',products,[{productId:'A'},{productId:'B'}]),false);
  assert.equal(canAddDocumentLine('grn',[],Array.from({length:100},()=>({newProduct:{name:'Item'}}))),false);
});

test('new GRN items flag normalized catalogue and line duplicates, including pending setup', () => {
  const catalogue=[{id:'A',name:' Coffee  Beans ',active:true},{id:'B',name:'Milk',active:false}];
  assert.match(newProductNameIssue(catalogue,[{newProduct:{name:'ＣＯＦＦＥＥ beans'}}],0),/already exists/);
  assert.match(newProductNameIssue(catalogue,[{newProduct:{name:' milk '}}],0),/Complete or activate/);
  const lines=[{newProduct:{name:'Fresh  cream'}},{newProduct:{name:' fresh cream '}}];
  assert.match(newProductNameIssue(catalogue,lines,0),/another line/);
  assert.match(newProductNameIssue(catalogue,lines,1),/another line/);
  assert.equal(newProductNameIssue(catalogue,[{newProduct:{name:'Green tea'}}],0),'');
  assert.equal(newProductNameIssue(catalogue,[{productId:'A'}],0),'');
});

test('linked-return choices use received dispatch items, branch balance and net prior reservations', () => {
  const source={id:'T1',type:'transfer',status:'Discrepancy',branchId:'B1',lines:[{productId:'A',receivedQty:8,recoveredQty:2},{productId:'B',receivedQty:0,damagedQty:2},{productId:'C',receivedQty:2}]};
  const returns=[
    {id:'R1',type:'return',sourceTransferId:'T1',status:'Completed',lines:[{productId:'A',baseQty:7,returnedQty:3}]},
    {id:'R2',type:'return',sourceTransferId:'T1',status:'Cancelled',lines:[{productId:'A',baseQty:90}]},
    {id:'R3',type:'return',sourceTransferId:'T1',status:'Rejected',lines:[{productId:'A',baseQty:90}]},
    {id:'R4',type:'return',sourceTransferId:'OTHER',status:'Draft',lines:[{productId:'A',baseQty:90}]},
  ];
  const stock=[{locationId:'B1',productId:'A',qty:9},{locationId:'B1',productId:'B',qty:20},{locationId:'B1',productId:'C',qty:0},{locationId:'WH',productId:'C',qty:40}];
  const before=structuredClone({source,returns,stock});
  const choices=dispatchReturnAllowances(source,returns,stock);
  assert.deepEqual([...choices],[['A',6]]);
  assert.deepEqual(availableLineProducts([{id:'A',active:true},{id:'B',active:true},{id:'C',active:true}].filter(item=>choices.has(item.id)),[]).map(item=>item.id),['A']);
  assert.deepEqual({source,returns,stock},before);
});

test('editing a linked return excludes its own reservation and caps quantities at actual branch stock', () => {
  const source={id:'T1',type:'transfer',status:'Completed',branchId:'B1',lines:[{productId:'A',receivedQty:10}]};
  const returns=[{id:'EDIT',type:'return',sourceTransferId:'T1',status:'Draft',lines:[{productId:'A',baseQty:7}]}];
  const stock=[{locationId:'B1',productId:'A',qty:6}];
  assert.equal(dispatchReturnAllowances(source,returns,stock).get('A'),3);
  assert.equal(dispatchReturnAllowances(source,returns,stock,'EDIT').get('A'),6);
  assert.equal(dispatchReturnAllowances({...source,status:'In transit'},returns,stock).size,0);
  assert.equal(dispatchReturnAllowances(undefined,returns,stock).size,0);
});
