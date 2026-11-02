import test from 'node:test';
import assert from 'node:assert/strict';
import {seedState,execute,scopedState,can} from '../lib/engine.mjs';

const owner={id:'admin',name:'Owner',role:'superadmin'};
const admin={id:'checker',name:'Checker',role:'admin'};
const warehouse={id:'warehouse',name:'Warehouse',role:'warehouse'};
const purchaser={id:'purchasing',name:'Purchasing',role:'purchasing'};
const branch={id:'branch1',name:'Branch One',role:'branch',branchId:'B1'};
const balance=(s,locationId,productId)=>s.stock.find(r=>r.locationId===locationId&&r.productId===productId);
const close=(a,b)=>assert.ok(Math.abs(a-b)<0.0001,`${a} != ${b}`);
const approve=(s,d)=>execute(s,admin,'document.approve',{id:d.id});
const grn=(s,user=owner)=>execute(s,user,'grn.create',{supplierId:'S1',submit:true,lines:[{productId:'P1',qty:2,unit:'Packet',rate:65}]});
const denied=(state,attempt)=>{const before=structuredClone(state);assert.throws(attempt,/You do not have permission for this action\./);assert.deepEqual(state,before);};

test('Super Admin has all operational rights and unscoped records',()=>{
  const s=seedState();
  for(const permission of ['masters','grn','transfer','return','approve','dispatch','receive','costs','adjustment','locations'])assert.equal(can(owner,permission),true,permission);
  assert.equal(can(owner,'invented-permission'),false);
  assert.equal(scopedState(s,owner).locations.length,5);
  assert.ok(scopedState(s,owner).stock.every(row=>'avgCost' in row));
  assert.equal(can(admin,'locations'),false);
});

test('Super Admin own approval requires an explicit reasoned override and posts once',()=>{
  const s=seedState(),doc=grn(s);
  const before=balance(s,'WH','P1').qty;
  assert.throws(()=>execute(s,owner,'document.approve',{id:doc.id}),/Maker-checker/);
  assert.throws(()=>execute(s,owner,'document.approve',{id:doc.id,override:true}),/override reason/);
  execute(s,owner,'document.approve',{id:doc.id,override:true,reason:'Owner checked supplier invoice and physical packets.'});
  assert.equal(doc.status,'Completed');
  assert.equal(doc.approvalOverride.by,owner.id);
  assert.match(doc.approvalOverride.reason,/physical packets/);
  assert.equal(balance(s,'WH','P1').qty,before+2);
  assert.match(s.audit[0].detail,/Super Admin approval override/);
  assert.throws(()=>execute(s,owner,'document.approve',{id:doc.id,override:true,reason:'Repeat'}),/Only pending/);
  const normal=grn(s,admin);
  assert.throws(()=>execute(s,admin,'document.approve',{id:normal.id,override:true,reason:'Attempt'}),/Maker-checker/);
});

test('draft editing recalculates its lines without changing reference or creator',()=>{
  const s=seedState();
  const doc=execute(s,purchaser,'grn.create',{supplierId:'S1',lines:[{productId:'P1',qty:1,unit:'Packet',rate:65}]});
  const identity={id:doc.id,reference:doc.reference,createdAt:doc.createdAt,createdBy:doc.createdBy};
  execute(s,purchaser,'document.update',{id:doc.id,supplierId:'S2',freight:100,note:'Corrected quantities',lines:[{productId:'P1',qty:2,unit:'Carton (24)',rate:1200,discount:10,tax:5}]});
  assert.deepEqual(Object.fromEntries(Object.keys(identity).map(k=>[k,doc[k]])),identity);
  assert.equal(doc.lines[0].baseQty,48);
  close(doc.total,2368);
  assert.equal(doc.status,'Draft');
  assert.equal(s.audit[0].action,'document.update');
  assert.throws(()=>execute(s,{...purchaser,id:'unrelated'},'document.update',{id:doc.id,note:'Attempt'}),/creator/);
  execute(s,purchaser,'document.submit',{id:doc.id});
  assert.throws(()=>execute(s,purchaser,'document.update',{id:doc.id,note:'Locked'}),/Only draft/);
});

test('rejected documents reopen with a reason and branch drafts retain scope',()=>{
  const s=seedState();
  const doc=execute(s,branch,'return.create',{branchId:'B1',submit:true,note:'Excess sealed packets',lines:[{productId:'P1',qty:2,unit:'Packet'}]});
  execute(s,admin,'document.reject',{id:doc.id,reason:'Correct the count.'});
  assert.throws(()=>execute(s,branch,'document.reopen',{id:doc.id}),/reopening reason/);
  execute(s,branch,'document.reopen',{id:doc.id,reason:'Physical count rechecked.'});
  assert.equal(doc.status,'Draft');
  execute(s,branch,'document.update',{id:doc.id,lines:[{productId:'P1',qty:3,unit:'Packet'}]});
  assert.equal(doc.lines[0].baseQty,3);
  assert.throws(()=>execute(s,branch,'document.update',{id:doc.id,branchId:'B2'}),/assigned branch/);
  denied(s,()=>execute(s,{...branch,id:'branch2',branchId:'B2'},'document.update',{id:doc.id}));
});

test('only Super Admin can configure the existing central warehouse and four branches',()=>{
  const s=seedState(),ids=s.locations.map(l=>l.id);
  denied(s,()=>execute(s,admin,'location.save',{id:'B1',name:'Renamed'}));
  execute(s,owner,'location.save',{id:'B1',name:'Gulberg Main',address:'Main Road',contact:'Branch Manager',phone:'03001234567',type:'warehouse'});
  const location=s.locations.find(l=>l.id==='B1');
  assert.equal(location.type,'branch');
  assert.equal(location.name,'Gulberg Main');
  assert.equal(location.address,'Main Road');
  assert.deepEqual(s.locations.map(l=>l.id),ids);
  assert.equal(s.audit[0].action,'location.update');
  assert.throws(()=>execute(s,owner,'location.save',{id:'B5',name:'Fifth'}),/four branches/);
  assert.throws(()=>execute(s,owner,'location.save',{id:'B1',name:'DHA'}),/unique/);
});

test('stock adjustment is scoped to warehouse for warehouse users and to all locations for administrators',()=>{
  const s=seedState(),payload={locationId:'WH',note:'Count correction',lines:[{productId:'P1',qty:2,unit:'pc'}]};
  denied(s,()=>execute(s,branch,'adjustment.create',payload));
  assert.throws(()=>execute(s,warehouse,'adjustment.create',{...payload,locationId:'B1'}),/only Central Warehouse/);
  assert.throws(()=>execute(s,owner,'adjustment.create',{...payload,note:''}),/reason/);
  const doc=execute(s,warehouse,'adjustment.create',{...payload,submit:true});
  assert.equal(doc.type,'adjustment');
  assert.match(doc.reference,/^ADJ-/);
  assert.equal(doc.locationId,'WH');
  denied(s,()=>execute(s,warehouse,'document.approve',{id:doc.id}));
  approve(s,doc);
  assert.equal(doc.status,'Completed');
  const branchAdjustment=execute(s,owner,'adjustment.create',{...payload,locationId:'B1'});
  assert.equal(branchAdjustment.branchId,'B1');
});

test('approved signed adjustments conserve their value and cannot post again',()=>{
  const s=seedState();
  const beforeA=structuredClone(balance(s,'WH','P1')),beforeB=structuredClone(balance(s,'WH','P5'));
  const doc=execute(s,warehouse,'adjustment.create',{locationId:'WH',note:'Stock count variance',submit:true,lines:[{productId:'P1',qty:3,unit:'pc',rate:999},{productId:'P5',qty:-2.5,unit:'kg'}]});
  assert.equal(balance(s,'WH','P1').qty,beforeA.qty);
  approve(s,doc);
  close(balance(s,'WH','P1').qty,beforeA.qty+3);
  close(balance(s,'WH','P1').avgCost,beforeA.avgCost);
  close(balance(s,'WH','P5').qty,beforeB.qty-2.5);
  close(doc.total,3*beforeA.avgCost-2.5*beforeB.avgCost);
  const movements=s.ledger.filter(l=>l.documentId===doc.id);
  assert.equal(movements.length,2);
  assert.ok(movements.every(l=>l.kind==='Stock adjustment'));
  close(movements.reduce((v,l)=>v+l.value,0),doc.total);
  assert.throws(()=>approve(s,doc),/Only pending/);
  denied(s,()=>execute(s,owner,'document.dispatch',{id:doc.id}));
});

test('zero optional rate uses the existing average cost, while a new opening still requires a rate',()=>{
  const s=seedState();
  const doc=execute(s,owner,'adjustment.create',{locationId:'WH',note:'Browser form default optional opening rate',lines:[{productId:'P1',qty:1,unit:'pc',rate:0}]});
  assert.ok(doc.lines[0].unitCost>0);
  assert.equal(doc.lines[0].rate,null);
});

test('opening adjustments require a rate and calculate it per selected purchase unit',()=>{
  const s=seedState();
  const p=execute(s,owner,'product.save',{sku:'OPEN-001',name:'Empty carton boxes',category:'Packaging',baseUnit:'pc',units:[{name:'pc',factor:1},{name:'Bundle (10)',factor:10}]});
  const payload={locationId:'WH',note:'Approved opening balance',submit:true,lines:[{productId:p.id,qty:2,unit:'Bundle (10)'}]};
  assert.throws(()=>execute(s,owner,'adjustment.create',payload),/opening rate/);
  payload.lines[0].rate=150;
  const doc=execute(s,owner,'adjustment.create',payload);
  approve(s,doc);
  close(balance(s,'WH',p.id).qty,20);
  close(balance(s,'WH',p.id).avgCost,15);
  close(doc.total,300);
});

test('all adjustment quantities revalidate before any line posts',()=>{
  const s=seedState();
  const doc=execute(s,warehouse,'adjustment.create',{locationId:'WH',note:'Damaged inventory count',submit:true,lines:[{productId:'P1',qty:2,unit:'pc'},{productId:'P5',qty:-50,unit:'kg'}]});
  const before=balance(s,'WH','P1').qty;
  balance(s,'WH','P5').qty=10;
  const ledgerCount=s.ledger.length;
  assert.throws(()=>approve(s,doc),/negative/);
  assert.equal(balance(s,'WH','P1').qty,before);
  assert.equal(s.ledger.length,ledgerCount);
});

test('a flagged legacy fractional piece balance can be corrected to a whole physical count',()=>{
  const s=seedState(),item=balance(s,'B1','P1');
  item.qty=153.6;item.countReviewRequired=true;
  const beforeCost=item.avgCost;
  const doc=execute(s,owner,'adjustment.create',{locationId:'B1',note:'Physical packet count is 153.',submit:true,lines:[{productId:'P1',qty:-0.6,unit:'pc'}]});
  approve(s,doc);
  assert.equal(item.qty,153);
  assert.equal(item.countReviewRequired,undefined);
  assert.equal(item.avgCost,beforeCost);
  const branchView=scopedState(s,branch);
  const visible=branchView.documents.find(d=>d.id===doc.id);
  assert.equal(visible,undefined);
  assert.deepEqual(branchView.audit,[]);
  assert.deepEqual(branchView.ledger,[]);
  assert.equal(branchView.stock.find(row=>row.locationId==='B1'&&row.productId==='P1').qty,153);
  assert.doesNotMatch(JSON.stringify(branchView),/"(?:avgCost|unitCost|total|value|rate)":/);
  assert.throws(()=>execute(s,owner,'adjustment.create',{locationId:'B1',note:'Bad half piece',lines:[{productId:'P1',qty:0.5,unit:'pc'}]}),/whole number/);
});

test('discrepancy resolution supports receipt recovery and return to source without recognizing a loss',()=>{
  for(const mode of ['received','returned']) {
    const s=seedState(),doc=s.documents.find(d=>d.status==='Discrepancy');
    const line=doc.lines.find(l=>l.unresolvedQty>0),source=balance(s,'WH',line.productId),dest=balance(s,'B1',line.productId);
    const before={source:source.qty,dest:dest.qty,losses:s.losses.length,qty:line.unresolvedQty};
    execute(s,owner,'document.resolve',{id:doc.id,resolutionMode:mode,reason:'Rechecked and recovered intact packets.'});
    assert.equal(doc.status,'Completed');
    assert.equal(doc.resolutionMode,mode);
    assert.equal(s.losses.length,before.losses);
    assert.equal(line.unresolvedQty,0);
    close(source.qty,before.source+(mode==='returned'?before.qty:0));
    close(dest.qty,before.dest+(mode==='received'?before.qty:0));
    close(line[mode==='received'?'recoveredQty':'returnedQty'],before.qty);
    close(s.ledger.filter(l=>l.documentId===doc.id&&l.locationId==='TRANSIT').reduce((v,l)=>v+l.qty,0),0);
    assert.throws(()=>execute(s,owner,'document.resolve',{id:doc.id,resolutionMode:mode,reason:'Again'}),/Only discrepancy/);
  }
});

test('returned branch stock discrepancies recover at the correct source branch',()=>{
  const s=seedState();
  const doc=execute(s,branch,'return.create',{branchId:'B1',note:'Excess stock',submit:true,lines:[{productId:'P1',qty:4,unit:'Packet'}]});
  approve(s,doc);
  execute(s,branch,'document.dispatch',{id:doc.id});
  const dispatched=balance(s,'B1','P1').qty;
  execute(s,warehouse,'document.receive',{id:doc.id,lines:[{productId:'P1',receivedQty:2,damagedQty:1}]});
  denied(s,()=>execute(s,branch,'document.resolve',{id:doc.id,resolutionMode:'returned',reason:'Attempt'}));
  execute(s,admin,'document.resolve',{id:doc.id,resolutionMode:'returned',reason:'Two packets located and returned to the branch.'});
  close(balance(s,'B1','P1').qty,dispatched+2);
  assert.equal(doc.lines[0].returnedQty,2);
});
