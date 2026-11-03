import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../lib/bootstrap.mjs';
import {execute} from '../lib/engine.mjs';

const owner={id:'audit-owner',name:'Audit owner',role:'superadmin'};
const buyer={id:'audit-buyer',name:'Audit buyer',role:'purchasing'};
const checker={id:'audit-checker',name:'Audit checker',role:'admin'};
const round=value=>Math.round((value+Number.EPSILON)*1e6)/1e6;

test('freight rounding never gives a negative last share or negative landed inventory cost',()=>{
  for(const rates of [[26,26,26,22],Array(100).fill(0.000001)]) {
    const state=emptyState();state.suppliers.push({id:'S1',name:'Audit supplier',active:true});
    const lines=rates.map((rate,i)=>{
      const item=execute(state,owner,'product.save',{sku:`AUDIT-${i}`,name:`Audit item ${i}`,category:'Audit',baseUnit:'pc',units:[{name:'pc',factor:1}]});
      return {productId:item.id,qty:1,unit:'pc',rate};
    });
    const freight=rates.length===4?0.000002:0.00005;
    const doc=execute(state,buyer,'grn.create',{supplierId:'S1',freight,submit:true,lines});
    assert.equal(round(doc.lines.reduce((sum,line)=>sum+line.freight,0)),freight);
    assert.ok(doc.lines.every(line=>line.freight>=0&&line.cost>0&&line.unitCost>0));
    assert.equal(round(doc.total),round(rates.reduce((sum,rate)=>sum+rate,0)+freight));
    execute(state,checker,'document.approve',{id:doc.id});
    assert.equal(state.stock.length,rates.length);
    assert.ok(state.stock.every(row=>row.qty===1&&row.avgCost>0));
    assert.equal(round(state.ledger.reduce((sum,row)=>sum+row.value,0)),doc.total);
  }
});

test('stock returned to a branch during discrepancy resolution remains eligible for a dispatch-linked return',()=>{
  const state=emptyState(),branch={id:'audit-branch',name:'Audit branch',role:'branch',branchId:'B1'},warehouse={id:'audit-warehouse',name:'Audit warehouse',role:'warehouse'};
  const item=execute(state,owner,'product.save',{sku:'AUDIT-RET',name:'Return packets',category:'Food',baseUnit:'pc',units:[{name:'pc',factor:1}],warehouseQuantity:20,warehouseRate:10});
  const source=execute(state,warehouse,'transfer.create',{branchId:'B1',submit:true,lines:[{productId:item.id,qty:10,unit:'pc'}]});
  execute(state,checker,'document.approve',{id:source.id});
  execute(state,warehouse,'document.dispatch',{id:source.id});
  execute(state,branch,'document.receive',{id:source.id});
  const returned=execute(state,branch,'return.create',{branchId:'B1',sourceTransferId:source.id,submit:true,note:'Return received stock',lines:[{productId:item.id,qty:10,unit:'pc'}]});
  execute(state,checker,'document.approve',{id:returned.id});
  execute(state,branch,'document.dispatch',{id:returned.id});
  execute(state,warehouse,'document.receive',{id:returned.id,lines:[{productId:item.id,receivedQty:6,damagedQty:0}]});
  execute(state,checker,'document.resolve',{id:returned.id,resolutionMode:'returned',reason:'Four packets located and returned intact to the branch.'});
  assert.equal(state.stock.find(row=>row.locationId==='B1'&&row.productId===item.id).qty,4);
  assert.equal(returned.lines[0].returnedQty,4);
  const retry=execute(state,branch,'return.create',{branchId:'B1',sourceTransferId:source.id,submit:true,note:'Return the restored packets',lines:[{productId:item.id,qty:4,unit:'pc'}]});
  const before=structuredClone(state);
  assert.throws(()=>execute(state,branch,'return.create',{branchId:'B1',sourceTransferId:source.id,note:'Excess reservation',lines:[{productId:item.id,qty:1,unit:'pc'}]}),/remaining received quantity/);
  assert.deepEqual(state,before);
  execute(state,checker,'document.approve',{id:retry.id});
  execute(state,branch,'document.dispatch',{id:retry.id});
  execute(state,warehouse,'document.receive',{id:retry.id});
  assert.equal(state.stock.find(row=>row.locationId==='B1'&&row.productId===item.id).qty,0);
  assert.equal(state.stock.find(row=>row.locationId==='WH'&&row.productId===item.id).qty,20);
  assert.equal(state.ledger.filter(row=>row.locationId==='TRANSIT').reduce((sum,row)=>sum+row.qty,0),0);
});
