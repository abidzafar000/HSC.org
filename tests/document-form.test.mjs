import test from 'node:test';
import assert from 'node:assert/strict';
import {availableLineProducts, documentPrerequisite} from '../lib/document-form.mjs';

const products = [{id:'A',active:true},{id:'B',active:true},{id:'C',active:false}];

test('document editor offers active products once and stops when all are used', () => {
  assert.deepEqual(availableLineProducts(products,[{productId:'A'}]).map(product=>product.id),['B']);
  assert.deepEqual(availableLineProducts(products,[{productId:'A'},{productId:'B'}]),[]);
  assert.deepEqual(availableLineProducts([],[]),[]);
  assert.deepEqual(availableLineProducts(products,[{productId:'A'},{productId:'B'}],'A').map(product=>product.id),['A']);
});

test('document creation reports missing master data before opening an unusable form', () => {
  assert.match(documentPrerequisite('transfer',[],[]),/product/);
  assert.match(documentPrerequisite('grn',[{id:'A',active:false}],[]),/product/);
  assert.match(documentPrerequisite('grn',products,[{active:false}]),/supplier/);
  assert.equal(documentPrerequisite('grn',products,[{active:true}]),'');
  assert.equal(documentPrerequisite('transfer',products,[]),'');
});
