import test from 'node:test';
import assert from 'node:assert/strict';
import {availableLineProducts, canAddDocumentLine, documentPrerequisite, newProductNameIssue} from '../lib/document-form.mjs';

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
