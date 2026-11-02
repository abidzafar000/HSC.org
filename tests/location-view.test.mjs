import test from 'node:test';
import assert from 'node:assert/strict';
import {availableLocations,normalizeLocationSelection,documentMatchesLocation,locationView} from '../lib/location-view.mjs';

const locations=[{id:'WH',type:'warehouse'},{id:'B1',type:'branch'},{id:'B2',type:'branch'}];
const owner={id:'owner',role:'superadmin',branchId:null};
const branch={id:'branch1',role:'branch',branchId:'B1'};
const documents=[
  {id:'G',reference:'GRN-1',type:'grn',branchId:null},
  {id:'T1',reference:'GP-1',type:'transfer',branchId:'B1'},
  {id:'T2',reference:'GP-2',type:'transfer',branchId:'B2'},
  {id:'R',reference:'RTN-1',type:'return',branchId:'B1'},
  {id:'A1',reference:'ADJ-1',type:'adjustment',locationId:'B1',branchId:'B1'},
  {id:'AW',reference:'ADJ-WH',type:'adjustment',locationId:'WH',branchId:null},
];

test('Super Admin changes viewing location without changing account authority',()=>{
  const before=structuredClone(owner);
  assert.equal(normalizeLocationSelection('B2',owner,locations),'B2');
  assert.equal(normalizeLocationSelection('WH',owner,locations),'WH');
  assert.equal(normalizeLocationSelection('All',owner,locations),'All');
  assert.deepEqual(owner,before);
});

test('assigned branch remains the only option even with a stale or tampered preference',()=>{
  assert.deepEqual(availableLocations(branch,locations).map(row=>row.id),['B1']);
  for(const selected of ['All','B2','WH','unknown',null])assert.equal(normalizeLocationSelection(selected,branch,locations),'B1');
  assert.equal(normalizeLocationSelection('B1',{...branch,branchId:'B2'},locations),'B2');
  assert.equal(normalizeLocationSelection('deleted-location',owner,locations),'All');
});

test('warehouse view includes both endpoints of transfers and returns but excludes branch adjustments',()=>{
  assert.deepEqual(documents.filter(row=>documentMatchesLocation(row,'WH')).map(row=>row.id),['G','T1','T2','R','AW']);
  assert.deepEqual(documents.filter(row=>documentMatchesLocation(row,'B1')).map(row=>row.id),['T1','R','A1']);
  assert.deepEqual(documents.filter(row=>documentMatchesLocation(row,'B2')).map(row=>row.id),['T2']);
});

test('branch metrics, physical ledger, audit and registers share a consistent view',()=>{
  const data={documents,stock:[{locationId:'WH',qty:100,avgCost:2},{locationId:'B1',qty:10,avgCost:2},{locationId:'B2',qty:20,avgCost:2}],ledger:[{id:'LW',locationId:'WH'},{id:'L1',locationId:'B1'},{id:'LT',locationId:'TRANSIT',branchId:'B1'}],audit:[{id:'master',branchId:null,reference:'SKU-1'},{id:'transfer',branchId:'B1',reference:'GP-1'},{id:'linked',branchId:null,entityId:'A1'},{id:'other',branchId:'B2',reference:'GP-2'}]};
  const before=structuredClone(data);
  const view=locationView(data,'B1');
  assert.equal(view.stock.reduce((sum,row)=>sum+row.qty*row.avgCost,0),20);
  assert.deepEqual(view.ledger.map(row=>row.id),['L1']);
  assert.deepEqual(view.audit.map(row=>row.id),['transfer','linked']);
  assert.deepEqual(view.documents.map(row=>row.id),['T1','R','A1']);
  assert.deepEqual(data,before);
  assert.equal(locationView(data,'All').stock.length,3);
});
