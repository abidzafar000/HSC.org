import test from 'node:test';
import assert from 'node:assert/strict';
import {seedState,execute,scopedState} from '../lib/engine.mjs';

const admin={id:'admin',name:'Administrator',role:'admin'};
const checker={id:'admin2',name:'Second Administrator',role:'admin'};
const purchasing={id:'purchase-test',name:'Purchasing',role:'purchasing'};
const warehouse={id:'warehouse-test',name:'Warehouse',role:'warehouse'};
const branch={id:'branch-test',name:'Gulberg',role:'branch',branchId:'B1'};
const balance=(s,locationId,productId)=>s.stock.find(r=>r.locationId===locationId&&r.productId===productId);
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.0001,`${actual} != ${expected}`);
const approve=(s,doc)=>execute(s,admin,'document.approve',{id:doc.id});
const transfer=(s,lines=[{productId:'P3',qty:1,unit:'Carton (12)'}])=>execute(s,warehouse,'transfer.create',{branchId:'B1',submit:true,lines});

test('seed has one central warehouse, four branches and distinct milk variants',()=>{
  const s=seedState();
  assert.equal(s.locations.filter(l=>l.type==='warehouse').length,1);
  assert.equal(s.locations.filter(l=>l.type==='branch').length,4);
  assert.equal(s.products.filter(p=>p.name.startsWith('Milk')).length,3);
  assert.equal(s.products.find(p=>p.id==='P1').baseUnit,'pc');
  assert.equal(s.products.find(p=>p.id==='P1').units.find(u=>u.name==='Packet').factor,1);
  assert.equal(s.products.find(p=>p.id==='P2').units.find(u=>u.name==='Carton (12)').factor,12);
  assert.ok(s.stock.filter(row=>s.products.find(p=>p.id===row.productId).baseUnit==='pc').every(row=>Number.isInteger(row.qty)));
});

test('GRN nets discount, adds percentage tax and apportions freight into weighted average',()=>{
  const s=seedState();
  const before=structuredClone(balance(s,'WH','P3'));
  const doc=execute(s,purchasing,'grn.create',{supplierId:'S1',submit:true,freight:300,lines:[{productId:'P3',qty:2,unit:'Carton (12)',rate:2400,discount:10,tax:5},{productId:'P1',qty:1,unit:'Carton (24)',rate:1200,discount:0,tax:0}]});
  const milk=doc.lines[0];
  close(milk.baseQty,24);
  close(milk.net,4320);
  close(milk.taxAmount,216);
  close(milk.freight,300*4320/5520);
  close(doc.total,4320+216+1200+300);
  approve(s,doc);
  assert.equal(doc.status,'Completed');
  close(balance(s,'WH','P3').qty,before.qty+24);
  close(balance(s,'WH','P3').avgCost,(before.qty*before.avgCost+milk.cost)/(before.qty+24));
  assert.throws(()=>approve(s,doc),/Only pending/);
});

test('maker-checker blocks even administrator self approval',()=>{
  const s=seedState();
  const doc=execute(s,admin,'grn.create',{supplierId:'S1',submit:true,lines:[{productId:'P1',qty:1,unit:'Packet',rate:65}]});
  assert.throws(()=>approve(s,doc),/Maker-checker/);
  execute(s,checker,'document.approve',{id:doc.id});
  assert.equal(doc.status,'Completed');
});

test('dispatch captures warehouse cost, receipt posts only good units, explicit loss reconciles transit',()=>{
  const s=seedState();
  const source=structuredClone(balance(s,'WH','P3'));
  const destination=structuredClone(balance(s,'B1','P3'));
  const doc=transfer(s);
  approve(s,doc);
  execute(s,warehouse,'document.dispatch',{id:doc.id});
  close(balance(s,'WH','P3').qty,source.qty-12);
  close(doc.lines[0].unitCost,source.avgCost);
  assert.throws(()=>execute(s,warehouse,'document.dispatch',{id:doc.id}),/Only approved/);
  execute(s,branch,'document.receive',{id:doc.id,note:'One damaged and one missing.',lines:[{productId:'P3',receivedQty:10,damagedQty:1}]});
  assert.equal(doc.status,'Discrepancy');
  close(balance(s,'B1','P3').qty,destination.qty+10);
  close(doc.lines[0].shortQty,1);
  close(doc.lines[0].unresolvedQty,2);
  assert.throws(()=>execute(s,branch,'document.resolve',{id:doc.id,reason:'loss'}),/Only administrators/);
  execute(s,admin,'document.resolve',{id:doc.id,reason:'Damage verified and shortage approved.'});
  assert.equal(doc.status,'Completed');
  close(s.losses.find(l=>l.documentId===doc.id).qty,2);
  close(s.ledger.filter(l=>l.documentId===doc.id&&l.locationId==='TRANSIT').reduce((a,l)=>a+l.qty,0),0);
});

test('return removes branch stock then warehouse receiver posts at frozen dispatch cost',()=>{
  const s=seedState();
  const source=structuredClone(balance(s,'B1','P1'));
  const destination=structuredClone(balance(s,'WH','P1'));
  const doc=execute(s,branch,'return.create',{branchId:'B1',submit:true,lines:[{productId:'P1',qty:4,unit:'Packet'}]});
  approve(s,doc);
  execute(s,branch,'document.dispatch',{id:doc.id});
  close(balance(s,'B1','P1').qty,source.qty-4);
  execute(s,warehouse,'document.receive',{id:doc.id});
  assert.equal(doc.status,'Completed');
  close(balance(s,'WH','P1').qty,destination.qty+4);
});

test('branch scope hides other locations, purchase documents and every monetary field',()=>{
  const s=seedState();
  const view=scopedState(s,branch);
  assert.ok(view.stock.every(r=>r.locationId==='B1'));
  assert.ok(view.documents.every(d=>d.type!=='grn'&&d.branchId==='B1'));
  assert.equal(view.suppliers.length,0);
  assert.doesNotMatch(JSON.stringify(view),/"(?:avgCost|unitCost|rate|total|value|freight|cost)":/);
  const other=s.documents.find(d=>d.branchId==='B2');
  assert.throws(()=>execute(s,branch,'document.receive',{id:other.id}),/another location/);
  assert.throws(()=>execute(s,branch,'return.create',{branchId:'B2',lines:[{productId:'P1',qty:1,unit:'Packet'}]}),/assigned branch/);
});

test('permissions and validation reject bad quantity, wrong units and duplicate product lines',()=>{
  const s=seedState();
  assert.throws(()=>execute(s,{id:'v',name:'Viewer',role:'viewer'},'transfer.create',{}),/read only/);
  assert.throws(()=>execute(s,branch,'grn.create',{}),/role cannot create/);
  assert.throws(()=>transfer(s,[{productId:'P3',qty:-1,unit:'Packet'}]),/Quantity/);
  assert.throws(()=>transfer(s,[{productId:'P3',qty:1,unit:'Box of anything'}]),/valid unit/);
  assert.throws(()=>transfer(s,[{productId:'P3',qty:1,unit:'Packet'},{productId:'P3',qty:1,unit:'L'}]),/only once/);
  assert.throws(()=>transfer(s,[{productId:'P3',qty:999999,unit:'Packet'}]),/Insufficient/);
});

test('receipt validates all lines before any posting and prevents over receipt or repeat receipt',()=>{
  const s=seedState();
  const doc=transfer(s,[{productId:'P3',qty:1,unit:'Packet'},{productId:'P1',qty:1,unit:'Packet'}]);
  approve(s,doc);
  execute(s,warehouse,'document.dispatch',{id:doc.id});
  const before=structuredClone(s.stock);
  assert.throws(()=>execute(s,branch,'document.receive',{id:doc.id,lines:[{productId:'P3',receivedQty:1,damagedQty:0},{productId:'P1',receivedQty:2,damagedQty:0}]}),/cannot exceed/);
  assert.deepEqual(s.stock,before);
  assert.equal(doc.status,'In transit');
  execute(s,branch,'document.receive',{id:doc.id});
  assert.throws(()=>execute(s,branch,'document.receive',{id:doc.id}),/not awaiting receipt/);
});

test('approved and posted master conversion definitions remain immutable',()=>{
  const s=seedState();
  const p=structuredClone(s.products[0]);
  p.units[1].factor=0.5;
  assert.throws(()=>execute(s,admin,'product.save',p),/locked after stock/);
  const doc=s.documents.find(d=>d.status==='Completed');
  assert.throws(()=>execute(s,admin,'document.cancel',{id:doc.id,reason:'changed mind'}),/cannot be cancelled/);
});

test('audit includes actor, document reference and status transition',()=>{
  const s=seedState();
  const doc=transfer(s);
  approve(s,doc);
  const event=s.audit[0];
  assert.equal(event.userId,admin.id);
  assert.equal(event.reference,doc.reference);
  assert.equal(event.action,'document.approve');
  assert.equal(doc.history.at(-1).status,'Approved');
});

test('unposted document use locks conversion definitions and snapshots product identity',()=>{
  const s=seedState();
  const p=execute(s,admin,'product.save',{sku:'NEW-001',name:'Test product',category:'Dry goods',baseUnit:'kg',units:[{name:'kg',factor:1},{name:'Bag',factor:10}],reorderLevel:5});
  const doc=execute(s,purchasing,'grn.create',{supplierId:'S2',lines:[{productId:p.id,qty:2,unit:'Bag',rate:1500}]});
  assert.equal(doc.lines[0].baseUnit,'kg');
  assert.equal(doc.lines[0].productSku,'NEW-001');
  assert.equal(doc.lines[0].productName,'Test product');
  const modified=structuredClone(p);
  modified.units[1].factor=20;
  assert.throws(()=>execute(s,admin,'product.save',modified),/document use/);
  execute(s,admin,'product.save',{...p,name:'Updated display name'});
  assert.equal(doc.lines[0].productName,'Test product');
});

test('receipts retain dispatch costs even when subsequent purchases change warehouse average',()=>{
  const s=seedState();
  const doc=transfer(s);
  approve(s,doc);
  execute(s,warehouse,'document.dispatch',{id:doc.id});
  const dispatchedCost=doc.lines[0].unitCost;
  const branchBefore=structuredClone(balance(s,'B1','P3'));
  const grn=execute(s,purchasing,'grn.create',{supplierId:'S1',submit:true,lines:[{productId:'P3',qty:500,unit:'Packet',rate:400}]});
  approve(s,grn);
  assert.notEqual(balance(s,'WH','P3').avgCost,dispatchedCost);
  execute(s,branch,'document.receive',{id:doc.id});
  close(balance(s,'B1','P3').avgCost,(branchBefore.qty*branchBefore.avgCost+12*dispatchedCost)/(branchBefore.qty+12));
});

test('cancelled approvals cannot dispatch; later source shortages stop the entire dispatch',()=>{
  const s=seedState();
  const cancelled=transfer(s);
  approve(s,cancelled);
  execute(s,admin,'document.cancel',{id:cancelled.id,reason:'Schedule changed'});
  assert.throws(()=>execute(s,warehouse,'document.dispatch',{id:cancelled.id}),/Only approved/);
  const doc=transfer(s,[{productId:'P3',qty:1,unit:'Packet'},{productId:'P1',qty:1,unit:'Packet'}]);
  approve(s,doc);
  balance(s,'WH','P1').qty=0;
  const before=structuredClone(s.stock);
  const ledgerCount=s.ledger.length;
  assert.throws(()=>execute(s,warehouse,'document.dispatch',{id:doc.id}),/Insufficient/);
  assert.deepEqual(s.stock,before);
  assert.equal(s.ledger.length,ledgerCount);
});

test('bad calendar dates and fractional pieces are rejected before stock posting',()=>{
  const s=seedState();
  assert.throws(()=>execute(s,purchasing,'grn.create',{supplierId:'S1',date:'2026-02-31',lines:[{productId:'P3',qty:1,unit:'Packet',rate:200}]}),/valid document date/);
  assert.throws(()=>transfer(s,[{productId:'P9',qty:0.5,unit:'pc'}]),/whole pieces/);
  const doc=transfer(s,[{productId:'P9',qty:5,unit:'pc'}]);
  approve(s,doc);
  execute(s,warehouse,'document.dispatch',{id:doc.id});
  assert.throws(()=>execute(s,branch,'document.receive',{id:doc.id,lines:[{productId:'P9',receivedQty:4.5,damagedQty:0.5}]}),/whole pieces/);
});

test('seed branch maker ids match the login accounts',()=>{
  const s=seedState();
  const pendingReturn=s.documents.find(d=>d.type==='return'&&d.status==='Pending approval');
  assert.equal(pendingReturn.createdBy,'branch1');
  execute(s,{...branch,id:'branch1'},'document.cancel',{id:pendingReturn.id,reason:'Return no longer required.'});
  assert.equal(pendingReturn.status,'Cancelled');
});
