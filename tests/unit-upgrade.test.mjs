import test from 'node:test';
import assert from 'node:assert/strict';
import {upgradeState} from '../lib/unit-upgrade.mjs';
import {seedState,execute,scopedState} from '../lib/engine.mjs';

const admin={id:'admin',name:'Administrator',role:'admin'};
const purchaser={id:'purchasing',name:'Purchasing',role:'purchasing'};
const warehouse={id:'warehouse',name:'Warehouse',role:'warehouse'};
const branch={id:'branch1',name:'Gulberg',role:'branch',branchId:'B1'};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);
const quantityKeys=['baseQty','receivedQty','damagedQty','shortQty','unresolvedQty','lossQty'];
const definitions=[['P1','DAI-001',4,'Packet',24],['P2','DAI-002',2,'Packet',12],['P3','DAI-003',1,'Packet',12],['P4','DAI-004',5,'Pack',24]];

function legacyState() {
  const state={version:1,products:[],stock:[],documents:[],ledger:[],losses:[],audit:[],locations:[{id:'WH',type:'warehouse'},{id:'B1',type:'branch'}],suppliers:[]};
  for (const [id,sku,scale,pack,count] of definitions) {
    state.products.push({id,sku,name:id,category:'Dairy',baseUnit:'L',active:true,reorderLevel:10,units:[{name:'L',factor:1},{name:pack,factor:1/scale},{name:`Carton (${count})`,factor:count/scale}]});
    state.stock.push({locationId:'WH',productId:id,qty:12.25,avgCost:255.123456});
    state.stock.push({locationId:'B1',productId:id,qty:0.03,avgCost:260});
    state.ledger.push({id:`MOV-${id}`,productId:id,locationId:'WH',qty:12.25,unitCost:255.123456,value:3125.262336});
  }
  const line=(id,values={})=>({productId:id,baseUnit:'L',qty:2,unit:'L',factor:1,baseQty:2,rate:250,unitCost:250,cost:500,gross:500,net:500,tax:0,taxAmount:0,freight:0,...values});
  state.documents=[
    {id:'PENDING',reference:'GP-PENDING',type:'transfer',branchId:'B1',status:'Pending approval',total:500,lines:[line('P1',{qty:2,unit:'Carton (24)',factor:6,baseQty:12,rate:1500,unitCost:250,cost:3000,gross:3000,net:3000})]},
    {id:'TRANSIT',reference:'GP-TRANSIT',type:'transfer',branchId:'B1',status:'In transit',total:380,lines:[line('P4',{qty:2,unit:'Pack',factor:0.2,baseQty:0.4,rate:190,unitCost:950,cost:380,gross:380,net:380})]},
    {id:'DIFFERENCE',reference:'GP-DIFFERENCE',type:'transfer',branchId:'B1',status:'Discrepancy',total:1530,lines:[line('P2',{qty:1,unit:'Carton (12)',factor:6,baseQty:6,rate:1530,unitCost:255,cost:1530,gross:1530,net:1530,receivedQty:5,damagedQty:0.5,shortQty:0.5,unresolvedQty:1})]},
    {id:'DONE',reference:'GP-DONE',type:'transfer',branchId:'B1',status:'Completed',total:500,lines:[line('P3',{receivedQty:1,damagedQty:0.5,shortQty:0.5,unresolvedQty:0,lossQty:1})]},
    {id:'VOLUME',reference:'GRN-VOLUME',type:'grn',status:'Draft',total:650,lines:[line('P1',{qty:2.5,baseQty:2.5,rate:260,unitCost:260,cost:650,gross:650,net:650})]},
  ];
  state.losses.push({id:'LOSS',productId:'P3',branchId:'B1',documentId:'DONE',qty:1,unitCost:250,value:250});
  state.products.push({id:'LOOSE',sku:'LQ-1',baseUnit:'L',units:[{name:'L',factor:1}],reorderLevel:5},{id:'VEG',sku:'VEG-1',baseUnit:'kg',units:[{name:'kg',factor:1}],reorderLevel:10});
  state.stock.push({locationId:'WH',productId:'LOOSE',qty:20.5,avgCost:100},{locationId:'WH',productId:'VEG',qty:25.75,avgCost:80});
  return state;
}

test('legacy quantity repair preserves inventory and document values across every workflow state',()=>{
  const state=legacyState();
  const before=structuredClone(state);
  assert.equal(upgradeState(state),true);
  assert.equal(state.version,2);
  for (const [id,,scale,,count] of definitions) {
    const product=state.products.find(p=>p.id===id);
    assert.equal(product.baseUnit,'pc');
    assert.equal(product.units.find(u=>u.name.startsWith('Carton')).factor,count);
    assert.ok(product.units.some(u=>u.name==='pc'&&u.factor===1));
    assert.equal(product.reorderLevel,10*scale);
    for (const stock of state.stock.filter(row=>row.productId===id)) {
      const original=before.stock.find(row=>row.productId===id&&row.locationId===stock.locationId);
      near(stock.qty,original.qty*scale);
      near(stock.qty*stock.avgCost,original.qty*original.avgCost);
      assert.deepEqual(stock.legacyMeasurement,{baseUnit:'L',qty:original.qty,avgCost:original.avgCost});
      assert.equal(Boolean(stock.countReviewRequired),!Number.isInteger(stock.qty));
    }
    const movement=state.ledger.find(row=>row.productId===id);
    const oldMovement=before.ledger.find(row=>row.productId===id);
    near(movement.qty,oldMovement.qty*scale);
    near(movement.qty*movement.unitCost,oldMovement.qty*oldMovement.unitCost);
    assert.equal(movement.value,oldMovement.value);
  }
  for (const doc of state.documents) {
    const oldDoc=before.documents.find(row=>row.id===doc.id);
    assert.equal(doc.total,oldDoc.total);
    assert.equal(doc.status,oldDoc.status);
    doc.lines.forEach((line,index)=>{
      const original=oldDoc.lines[index];
      const scale=definitions.find(([id])=>id===line.productId)[2];
      assert.equal(line.baseUnit,'pc');
      assert.equal(line.cost,original.cost);
      for (const key of quantityKeys) if(original[key]!==undefined)near(line[key],original[key]*scale);
      near(line.unitCost*line.baseQty,original.unitCost*original.baseQty);
      near(line.qty*line.rate,original.qty*original.rate);
      if(original.unit==='L')assert.equal(line.unit,'pc'); else assert.equal(line.unit,original.unit);
      assert.equal(line.legacyMeasurement.unit,original.unit);
      assert.equal(line.legacyMeasurement.baseQty,original.baseQty);
    });
  }
  const loss=state.losses[0];
  assert.equal(loss.value,before.losses[0].value);
  near(loss.qty*loss.unitCost,before.losses[0].qty*before.losses[0].unitCost);
  for (const id of ['LOOSE','VEG'])assert.deepEqual(state.stock.find(row=>row.productId===id),before.stock.find(row=>row.productId===id));
  assert.equal(state.audit.filter(row=>row.action==='system.item-units-upgrade').length,1);
  const upgraded=structuredClone(state);
  assert.equal(upgradeState(state),false);
  assert.deepEqual(state,upgraded);
});

test('upgraded pending, in-transit and discrepancy documents retain usable workflow quantities',()=>{
  const state=legacyState();
  upgradeState(state);
  for(const doc of state.documents)doc.history=[];
  execute(state,admin,'document.approve',{id:'PENDING'});
  // Two cartons of 24 milk packets now dispatch and receive as 48 pieces.
  execute(state,warehouse,'document.dispatch',{id:'PENDING'});
  execute(state,branch,'document.receive',{id:'PENDING',lines:[{productId:'P1',receivedQty:48,damagedQty:0}]});
  assert.equal(state.documents.find(doc=>doc.id==='PENDING').status,'Completed');
  execute(state,branch,'document.receive',{id:'TRANSIT',lines:[{productId:'P4',receivedQty:2,damagedQty:0}]});
  assert.equal(state.documents.find(doc=>doc.id==='TRANSIT').status,'Completed');
  execute(state,admin,'document.resolve',{id:'DIFFERENCE',reason:'Verified short and damaged packets.'});
  assert.equal(state.losses.find(loss=>loss.documentId==='DIFFERENCE').qty,2);
});

test('migration guards known milk SKU identities and preserves branch cost redaction in legacy traces',()=>{
  const state=legacyState();
  state.products.find(p=>p.id==='P1').sku='CUSTOM-CHANGED';
  upgradeState(state);
  assert.equal(state.products.find(p=>p.id==='P1').baseUnit,'L');
  const scoped=scopedState(state,branch);
  assert.doesNotMatch(JSON.stringify(scoped),/"(?:avgCost|unitCost|rate|total|value|freight|cost)":/);
});

test('piece, loose-liquid and vegetable masters each post and receive in their own unit',()=>{
  const state=seedState();
  const records=[
    {sku:'NEW-BOX',name:'Takeaway box',category:'Packaging',baseUnit:'pieces',units:[{name:'pieces',factor:1}],qty:4,expected:'pc'},
    {sku:'NEW-LIQ',name:'Loose juice',category:'Beverages',baseUnit:'L',units:[{name:'L',factor:1}],qty:2.5,expected:'L'},
    {sku:'NEW-VEG',name:'Tomatoes',category:'Vegetables',baseUnit:'kg',units:[{name:'kg',factor:1}],qty:3.25,expected:'kg'},
  ];
  for(const values of records){
    const p=execute(state,admin,'product.save',values);
    assert.equal(p.baseUnit,values.expected);
    const doc=execute(state,purchaser,'grn.create',{supplierId:'S1',submit:true,lines:[{productId:p.id,qty:values.qty,unit:p.units[0].name,rate:100}]});
    execute(state,admin,'document.approve',{id:doc.id});
    near(state.stock.find(row=>row.locationId==='WH'&&row.productId===p.id).qty,values.qty);
    const transfer=execute(state,warehouse,'transfer.create',{branchId:'B1',submit:true,lines:[{productId:p.id,qty:values.qty,unit:p.units[0].name}]});
    execute(state,admin,'document.approve',{id:transfer.id});
    execute(state,warehouse,'document.dispatch',{id:transfer.id});
    execute(state,branch,'document.receive',{id:transfer.id});
    near(state.stock.find(row=>row.locationId==='B1'&&row.productId===p.id).qty,values.qty);
  }
  for(const alias of ['pc','pcs','piece','pieces','box','boxes']){
    const p=execute(state,admin,'product.save',{sku:`ALIAS-${alias}`,name:alias,category:'Packaging',baseUnit:alias,units:[{name:alias,factor:1}]});
    assert.equal(p.baseUnit,'pc');
    assert.throws(()=>execute(state,purchaser,'grn.create',{supplierId:'S1',lines:[{productId:p.id,qty:0.5,unit:'pc',rate:100}]}),/whole pieces/);
  }
  const milk=execute(state,purchaser,'grn.create',{supplierId:'S1',submit:true,lines:[{productId:'P1',qty:4,unit:'Packet',rate:65}]});
  assert.equal(milk.lines[0].baseQty,4);
  assert.equal(milk.lines[0].baseUnit,'pc');
});
