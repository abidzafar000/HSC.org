/** Hamsun Phase 1 stock domain. Persistence commits a cloned state atomically. */
import { hasPermission, actionAllowed, filterModuleState, canAccessDocument } from './permissions.mjs';
import { createHash } from 'node:crypto';
const ROLES = ['superadmin', 'admin', 'warehouse', 'purchasing', 'branch', 'viewer'];
const isAdmin = user => ['admin','superadmin'].includes(user?.role);
// Comparisons tolerate floating-point noise, never a whole stored quantity step.
const EPS = 0.0000005;
const round = n => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
const clone = value => JSON.parse(JSON.stringify(value));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const need = (condition, message) => { if (!condition) fail(message); };
const text = (value, max = 300) => {
  need(value === undefined || value === null || ['string','number','boolean'].includes(typeof value), 'Text fields must contain a simple value.');
  return String(value ?? '').trim().slice(0, max);
};
const number = (value, name, min = 0, max = 1e9) => {
  need((typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '', `${name} must be a number.`);
  const result = Number(value);
  need(value !== '' && value !== null && value !== undefined && Number.isFinite(result) && result >= min && result <= max, `${name} must be between ${min} and ${max}.`);
  return result;
};
const now = () => new Date().toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const uid = prefix => `${prefix}_${globalThis.crypto.randomUUID()}`;
const canonicalStockUnit = value => ({pc:'pc',pcs:'pc',piece:'pc',pieces:'pc',box:'pc',boxes:'pc',litre:'L',liter:'L',litres:'L',liters:'L',l:'L',kilogram:'kg',kilograms:'kg',kg:'kg',gram:'g',grams:'g',g:'g',millilitre:'ml',milliliter:'ml',ml:'ml'}[String(value).toLowerCase()] ?? value);
const isCountedUnit = value => canonicalStockUnit(value)==='pc';

export function can(user, permission) {
  if (!user || !ROLES.includes(user.role)) return false;
  const roles = {
    masters: ['admin'],
    grn: ['admin', 'purchasing'],
    transfer: ['admin', 'warehouse'],
    return: ['admin', 'branch'],
    approve: ['admin'],
    dispatch: ['admin', 'warehouse', 'branch'],
    receive: ['admin', 'warehouse', 'branch'],
    costs: ['admin', 'warehouse', 'purchasing', 'viewer'],
    adjustment: ['admin', 'warehouse'],
    locations: [],
    demand: ['admin','branch'],
    demandReview: ['admin','warehouse'],
  };
  const modules={masters:['products','suppliers'],grn:['purchases'],transfer:['dispatches'],return:['returns'],approve:['approvals'],dispatch:['dispatches','returns'],receive:['dispatches','receipts','returns'],costs:['overview','products','purchases','stock','dispatches','returns','reports','adjustments'],adjustment:['adjustments'],locations:['locations'],demand:['demands'],demandReview:['demands']};
  if(user.role==='branch'&&permission==='dispatch')modules.dispatch=['returns'];
  if(user.role==='branch'&&permission==='receive')modules.receive=['dispatches'];
  const roleAllowed=user.role==='superadmin'?Object.hasOwn(roles,permission):(roles[permission]?.includes(user.role)??false);
  return roleAllowed&&(modules[permission]||[]).some(module=>hasPermission(user,module));
}

function audit(state, user, action, entity, detail = '') {
  state.audit.unshift({id:uid('AUD'),at:now(),userId:user.id,userName:user.name,role:user.role,action,entityId:entity?.id ?? '',reference:entity?.reference ?? entity?.sku ?? entity?.name ?? '',branchId:entity?.branchId ?? null,detail});
}

function product(state, id) {
  const p = state.products.find(item => item.id === id);
  need(p, 'Product does not exist.');
  return p;
}

/** A GRN can introduce a ready item without granting general product-master editing. */
function resolvePurchaseProducts(state,user,lines) {
  need(can(user,'grn'),'Your role cannot create purchase products.');
  need(Array.isArray(lines)&&lines.length>0&&lines.length<=100,'Add between 1 and 100 product lines.');
  const nameKey=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
  const names=new Map(state.products.map(item=>[nameKey(item.name),item]));
  const skus=new Set(state.products.map(item=>String(item.sku).toUpperCase()));
  let nextSku=1;
  return lines.map(line=>{
    need(isRecord(line),'Each product line must be an object with product, unit and quantity.');
    if(!Object.hasOwn(line,'newProduct'))return line;
    need(!line.productId,'Choose an existing product or enter a new product, not both.');
    const draft=line.newProduct;
    need(isRecord(draft)&&Object.keys(draft).every(key=>['name','category','baseUnit'].includes(key)),'New purchase products accept only name, category and stock unit.');
    need(typeof draft.name==='string'&&typeof draft.category==='string'&&typeof draft.baseUnit==='string','Enter the new product name, category and stock unit.');
    const name=draft.name.normalize('NFKC').replace(/\s+/g,' ').trim();
    const category=draft.category.normalize('NFKC').replace(/\s+/g,' ').trim();
    const baseUnit=canonicalStockUnit(draft.baseUnit.trim());
    need(name.length>0&&name.length<=160&&!/[\u0000-\u001f\u007f]/.test(name),'New product name must contain 1 to 160 characters.');
    need(category.length>0&&category.length<=60&&!/[\u0000-\u001f\u007f]/.test(category),'New product category must contain 1 to 60 characters.');
    need(['pc','kg','g','L','ml'].includes(baseUnit),'Choose pieces, kilograms, grams, litres or millilitres for the new stock unit.');
    need(canonicalStockUnit(line.unit)===baseUnit,'The new product line must use its selected stock unit.');
    const duplicate=names.get(nameKey(name));
    need(!duplicate,`“${name}” already exists or appears on another new line. Choose the existing product${duplicate?.setupPending||duplicate?.active===false?' after completing or activating its setup':''}.`);
    const rate=number(line.rate,'Rate',0.000001);
    let sku;
    do {sku=`ITEM-${String(nextSku++).padStart(4,'0')}`;}while(skus.has(sku));
    const item={id:uid('P'),sku,name,category,baseUnit,units:[{name:baseUnit,factor:1}],rate,reorderLevel:0,active:true};
    state.products.push(item);names.set(nameKey(name),item);skus.add(sku);
    audit(state,user,'product.create',item,'Created from a purchase GRN; stock posts through GRN approval.');
    const {newProduct,...resolved}=line;
    return {...resolved,productId:item.id,unit:baseUnit};
  });
}

function stock(state, locationId, productId) {
  let record = state.stock.find(s => s.locationId === locationId && s.productId === productId);
  if (!record) {
    record = {locationId,productId,qty:0,avgCost:0};
    state.stock.push(record);
  }
  return record;
}

function movement(state, doc, locationId, productId, qty, unitCost, kind, user) {
  state.ledger.push({id:uid('MOV'),at:now(),date:doc.date,documentId:doc.id,reference:doc.reference,branchId:doc.branchId ?? null,locationId,productId,qty:round(qty),unitCost:round(unitCost),value:round(qty*unitCost),kind,userId:user.id,userName:user.name});
}

function addStock(state, doc, locationId, line, qty, unitCost, kind, user) {
  const item = stock(state, locationId, line.productId);
  const combined = item.qty + qty;
  need(Number.isFinite(combined) && combined <= Number.MAX_SAFE_INTEGER, 'Stock balance exceeds the supported range.');
  need(combined >= -EPS, 'Posting would make stock negative.');
  item.avgCost = round(combined > EPS ? (item.qty*item.avgCost+qty*unitCost)/combined : 0);
  item.qty = round(Math.max(0, combined));
  movement(state, doc, locationId, line.productId, qty, unitCost, kind, user);
}

function removeStock(state, doc, locationId, line, qty, unitCost, kind, user) {
  const item = stock(state, locationId, line.productId);
  need(item.qty + EPS >= qty, `Insufficient ${product(state,line.productId).name} at ${locationId}. Available: ${item.qty}.`);
  item.qty = round(Math.max(0,item.qty-qty));
  if (item.qty < EPS) item.avgCost = 0;
  movement(state,doc,locationId,line.productId,-qty,unitCost,kind,user);
}

function assertBranch(state, id) {
  need(state.locations.some(l => l.id === id && l.type === 'branch'), 'Select one of the four branches.');
}

function assertDocumentScope(user, doc) {
  if (user.role === 'branch') {
    need(doc.type !== 'grn' && doc.branchId === user.branchId, 'This document belongs to another location.');
  }
}

function normalizeLines(state, type, lines, freight) {
  need(Array.isArray(lines) && lines.length > 0 && lines.length <= 100, 'Add between 1 and 100 product lines.');
  need(lines.every(isRecord), 'Each product line must be an object with product, unit and quantity.');
  const seen = new Set();
  const rows = lines.map(line => {
    const p = product(state,line.productId);
    need(p.active, `${p.name} is inactive.`);
    need(!seen.has(p.id), 'Each product can appear only once on a document.');
    seen.add(p.id);
    const unit = p.units.find(u => u.name === line.unit);
    need(unit, `Choose a valid unit for ${p.name}.`);
    const qty = number(line.qty,'Quantity',0.000001);
    const result = {productId:p.id,productSku:p.sku,productName:p.name,baseUnit:p.baseUnit,qty,unit:unit.name,baseQty:round(qty*unit.factor),factor:unit.factor};
    need(result.baseQty > 0, 'Converted quantity must be positive.');
    need(Number.isFinite(result.baseQty) && result.baseQty <= Number.MAX_SAFE_INTEGER, 'Converted quantity exceeds the supported range.');
    if (isCountedUnit(p.baseUnit)) need(Number.isInteger(result.baseQty),'Piece quantities must convert to whole pieces.');
    if (type === 'grn') {
      result.rate = number(line.rate,'Rate',0.000001);
      result.discount = number(line.discount ?? 0,'Discount',0,100);
      result.tax = number(line.tax ?? 0,'Tax',0,100);
      result.gross = round(qty*result.rate);
      result.net = round(result.gross*(1-result.discount/100));
      result.taxAmount = round(result.net*result.tax/100);
    }
    return result;
  });
  if (type === 'grn') {
    const net = rows.reduce((sum,l)=>sum+l.net,0);
    need(net > 0,'The discounted purchase value must be positive.');
    let allocated = 0, cumulativeNet = 0;
    rows.forEach((line,index) => {
      cumulativeNet += line.net;
      // Round cumulative shares so earlier rounding cannot make the last charge negative.
      const target = index === rows.length-1 ? round(freight) : Math.min(round(freight),round(freight*cumulativeNet/net));
      line.freight = round(Math.max(0,target-allocated));
      allocated = round(allocated+line.freight);
      line.cost = round(line.net+line.taxAmount+line.freight);
      line.unitCost = round(line.cost/line.baseQty);
    });
  }
  return rows;
}

function nextReference(state,type) {
  const prefix = {grn:'GRN',transfer:'GP',return:'RTN',adjustment:'ADJ',demand:'DM'}[type];
  const year = new Date().getUTCFullYear();
  state.sequence ??= {};
  state.sequence[type] = (state.sequence[type] ?? 0)+1;
  return `${prefix}-${year}-${String(state.sequence[type]).padStart(4,'0')}`;
}

function adjustmentLines(state,lines,locationId,stockAddition=false) {
  if (stockAddition) need(locationId==='WH','Manual stock additions can only go to Central Warehouse.');
  need(Array.isArray(lines) && lines.length>0 && lines.length<=100,'Add between 1 and 100 product lines.');
  need(lines.every(isRecord),'Each product line must be an object with product, unit and quantity.');
  const seen=new Set();
  return lines.map(line=>{
    const p=product(state,line.productId);
    need(p.active,`${p.name} is inactive.`);
    need(!seen.has(p.id),'Each product can appear only once on a document.');
    seen.add(p.id);
    const unit=p.units.find(u=>u.name===line.unit);
    need(unit,`Choose a valid unit for ${p.name}.`);
    const qty=stockAddition?number(line.qty,'Stock addition quantity',0.000001):number(line.qty,'Adjustment quantity',-1e9,1e9);
    const baseQty=round(qty*unit.factor);
    need(Math.abs(baseQty)>EPS,'Adjustment quantity cannot be zero.');
    need(Number.isFinite(baseQty) && Math.abs(baseQty)<=Number.MAX_SAFE_INTEGER,'Converted adjustment quantity exceeds the supported range.');
    const current=state.stock.find(s=>s.locationId===locationId&&s.productId===p.id)||{qty:0,avgCost:0};
    need(Number.isFinite(current.qty+baseQty) && current.qty+baseQty<=Number.MAX_SAFE_INTEGER,'Stock balance exceeds the supported range.');
    need(current.qty+baseQty>=-EPS,`Adjustment would make ${p.name} stock negative.`);
    if (isCountedUnit(p.baseUnit)) {
      if (stockAddition) need(Number.isInteger(baseQty),'Stock additions must use whole pieces.');
      need(Number.isInteger(round(current.qty+baseQty)),'The resulting piece balance must be a whole number.');
      need(Number.isInteger(baseQty)||current.countReviewRequired===true,'Piece adjustments must use whole pieces unless reconciling a flagged physical count.');
    }
    const rate=line.rate===undefined||line.rate===null||line.rate===''||((typeof line.rate==='number'||typeof line.rate==='string')&&Number(line.rate)===0)?null:number(line.rate,'Opening unit rate',0.000001);
    need(baseQty<0||current.avgCost>0||rate!==null,`Enter an opening rate for ${p.name}.`);
    const unitCost=stockAddition&&rate!==null?rate/unit.factor:baseQty<0?current.avgCost:current.avgCost>0?current.avgCost:rate===null?0:rate/unit.factor;
    return {productId:p.id,productSku:p.sku,productName:p.name,baseUnit:p.baseUnit,qty,unit:unit.name,baseQty,factor:unit.factor,rate,unitCost,cost:round(baseQty*unitCost)};
  });
}

function validateSourceReturn(state,doc) {
  if(doc.type!=='return'||!doc.sourceTransferId)return;
  const source=state.documents.find(row=>row.id===doc.sourceTransferId);
  need(source?.type==='transfer'&&source.branchId===doc.branchId&&['Completed','Discrepancy'].includes(source.status),'Select a received dispatch order belonging to this branch.');
  for(const line of doc.lines){
    const received=source.lines.find(row=>row.productId===line.productId);
    const quantity=round((received?.receivedQty||0)+(received?.recoveredQty||0));
    const reserved=state.documents.filter(row=>row.type==='return'&&row.sourceTransferId===source.id&&row.id!==doc.id&&!['Cancelled','Rejected'].includes(row.status)).reduce((sum,row)=>sum+row.lines.filter(item=>item.productId===line.productId).reduce((total,item)=>total+Math.max(0,item.baseQty-(item.returnedQty||0)),0),0);
    need(received&&quantity>0&&line.baseQty<=round(quantity-reserved)+EPS,'Return quantity exceeds the remaining received quantity for this dispatch order.');
  }
}

function documentValues(state,user,type,payload) {
  need(can(user,type),'Your role cannot create this type of document.');
  const stockAddition=type==='adjustment'&&payload.stockAddition===true;
  if (type==='adjustment') {
    if (stockAddition) need(payload.locationId==='WH','Manual stock additions can only go to Central Warehouse.');
    need(state.locations.some(l=>l.id===payload.locationId),'Select an existing stock location.');
    need(user.role!=='warehouse'||payload.locationId==='WH','Warehouse users can adjust only Central Warehouse.');
    need(text(payload.note||payload.reason,2000),'A stock adjustment reason is required.');
  } else if (type !== 'grn') {
    assertBranch(state,payload.branchId);
    if (user.role === 'branch') need(payload.branchId === user.branchId,'Returns must originate from your assigned branch.');
  } else {
    need(state.suppliers.some(s => s.id === payload.supplierId && s.active),'Select an active supplier.');
  }
  const date = payload.date || today();
  need(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date, 'Enter a valid document date.');
  const freight = type === 'grn' ? number(payload.freight ?? 0,'Freight') : 0;
  const values={date,branchId:type==='adjustment'?(payload.locationId==='WH'?null:payload.locationId):type==='grn'?null:payload.branchId,supplierId:type==='grn'?payload.supplierId:null,locationId:type==='adjustment'?payload.locationId:null,note:text(payload.note||payload.reason,2000),freight,lines:type==='adjustment'?adjustmentLines(state,payload.lines,payload.locationId,stockAddition):normalizeLines(state,type,payload.lines,freight),...(stockAddition?{stockAddition:true}:{})};
  values.total=round(values.lines.reduce((sum,l)=>sum+(l.cost??0),0));
  if(type==='return'&&payload.sourceTransferId){
    values.sourceTransferId=text(payload.sourceTransferId,100);
    validateSourceReturn(state,{...values,type,id:payload.id});
    values.sourceTransferReference=state.documents.find(row=>row.id===values.sourceTransferId).reference;
  }
  if (['transfer','return'].includes(type)) {
    const doc=values;
    const source = type === 'transfer' ? 'WH' : doc.branchId;
    for (const line of doc.lines) {
      const item = stock(state,source,line.productId);
      need(item.qty+EPS >= line.baseQty,`Insufficient ${product(state,line.productId).name} at source. Available: ${item.qty}.`);
    }
  }
  return values;
}

function createDocument(state,user,type,payload) {
  need(payload.id===undefined,'New documents cannot provide an existing document ID.');
  const values=documentValues(state,user,type,payload);
  const doc={id:uid(type.toUpperCase()),type,reference:nextReference(state,type),createdAt:now(),createdBy:user.id,createdByName:user.name,...values,status:payload.submit?'Pending approval':'Draft',history:[]};
  doc.history.push({at:now(),by:user.name,action:'Created',status:doc.status});
  state.documents.unshift(doc);
  audit(state,user,`${type}.create`,doc,`${doc.lines.length} product lines; ${doc.status}`);
  return doc;
}

function createStockAddition(state,user,payload) {
  need(can(user,'adjustment'),'Your role cannot add warehouse stock.');
  need(payload.locationId===undefined||payload.locationId==='WH','Manual stock additions can only go to Central Warehouse.');
  need(payload.postNow===undefined||typeof payload.postNow==='boolean','Choose whether to post the stock addition now.');
  if (payload.postNow===true) {
    need(user.role==='superadmin','Only Super Admin can post a stock addition immediately. Submit it for independent approval.');
    need(payload.override===true,'Confirm the Super Admin approval override to post stock now.');
  }
  const doc=createDocument(state,user,'adjustment',{...payload,locationId:'WH',stockAddition:true,submit:true});
  if (payload.postNow===true) transition(state,user,'document.approve',{id:doc.id,override:true,reason:doc.note});
  audit(state,user,'stock.add',doc,`${doc.lines.length} product lines; ${doc.status}`);
  return doc;
}

function saveLocation(state,user,payload) {
  need(user.role==='superadmin','Only Super Admin can configure warehouse and branches.');
  need(['WH','B1','B2','B3','B4'].includes(payload.id),'Select the central warehouse or one of the four branches.');
  const location=state.locations.find(l=>l.id===payload.id);
  need(location,'Location does not exist.');
  const name=text(payload.name,100);
  need(name,'Location name is required.');
  need(!state.locations.some(l=>l.id!==location.id&&l.name.toLowerCase()===name.toLowerCase()),'Location names must be unique.');
  const before={...location};
  Object.assign(location,{name,address:text(payload.address,500),contact:text(payload.contact,100),phone:text(payload.phone,60)});
  audit(state,user,'location.update',{...location,branchId:location.type==='branch'?location.id:null},`${before.name} → ${location.name}`);
  return location;
}

function saveProduct(state,user,payload) {
  need(can(user,'masters')&&hasPermission(user,'products'),'Only an administrator with product permission can change the product master.');
  const existing = payload.id ? product(state,payload.id) : null;
  const sku = text(payload.sku,40).toUpperCase();
  const name = text(payload.name,160);
  const category = text(payload.category,60);
  const suppliedUnit = text(payload.baseUnit,20);
  const locked = existing && (state.ledger.some(row=>row.productId===existing.id) || [...state.documents,...(state.demands||[])].some(doc=>doc.lines.some(line=>line.productId===existing.id)));
  const baseUnit = locked && suppliedUnit===existing.baseUnit ? suppliedUnit : canonicalStockUnit(suppliedUnit);
  need(sku && name && category && baseUnit,'SKU, name, category and base unit are required.');
  need(!state.products.some(p=>p.sku.toUpperCase()===sku && p.id!==existing?.id),'SKU must be unique.');
  need(Array.isArray(payload.units) && payload.units.length > 0 && payload.units.length <= 20,'Add at least one unit conversion.');
  need(payload.units.every(isRecord),'Each unit conversion must be an object with name and factor.');
  const units = payload.units.map(unit=>{
    const factor=number(unit.factor,'Unit factor',0.000001);
    const name=text(unit.name,40);
    return {name:!locked && name===suppliedUnit && factor===1 ? baseUnit : name,factor};
  });
  need(units.every(u=>u.name),'Unit names cannot be empty.');
  need(new Set(units.map(u=>u.name.toLowerCase())).size === units.length,'Unit names must be unique.');
  need(units.some(u=>u.name===baseUnit && Math.abs(u.factor-1)<EPS),'Include the base unit with factor 1.');
  if (locked) {
    need(existing.baseUnit===baseUnit && JSON.stringify(existing.units)===JSON.stringify(units),'Base unit and conversions are locked after stock movements or document use. Create a new SKU for another pack size.');
  }
  const blankRate=payload.rate===null||typeof payload.rate==='string'&&payload.rate.trim()==='';
  const rate=payload.rate===undefined?(existing?.rate??null):blankRate?null:number(payload.rate,'Reference rate',0);
  const record = {id:existing?.id ?? uid('P'),sku,name,category,baseUnit,units,rate,reorderLevel:number(payload.reorderLevel ?? 0,'Reorder level'),active:payload.active !== false};
  if (existing) { Object.assign(existing,record); delete existing.setupPending; } else state.products.push(record);
  audit(state,user,existing?'product.update':'product.create',record);
  return existing ?? record;
}

/** Save a product and its explicit warehouse count in the same application commit. */
function saveProductWithQuantity(state,user,payload) {
  const planned=clone(state);
  const saved=saveProduct(planned,user,payload);
  if(!can(user,'adjustment')) {
    const error=new Error('Your account needs stock adjustment permission to set warehouse quantity.');
    error.status=403;throw error;
  }
  const target=number(payload.warehouseQuantity,'Central Warehouse quantity');
  if(isCountedUnit(saved.baseUnit))need(Number.isInteger(target),'Warehouse piece quantity must be a whole number.');
  const current=planned.stock.find(row=>row.locationId==='WH'&&row.productId===saved.id);
  const before=current?.qty||0;
  if(payload.warehouseExpectedQuantity!==undefined&&Math.abs(number(payload.warehouseExpectedQuantity,'Previous warehouse quantity')-before)>EPS) {
    const error=new Error('Warehouse quantity changed while this product form was open. Close and reopen the product to review the current stock before saving a count.');
    error.status=409;throw error;
  }
  const delta=round(target-before);
  if(Math.abs(delta)>EPS) {
    need(saved.active,'Activate this product before setting its warehouse quantity.');
    const pending=planned.documents.find(doc=>doc.productQuantitySetup?.productId===saved.id&&['Draft','Pending approval','Approved'].includes(doc.status));
    if(pending) {
      need(Math.abs(pending.productQuantitySetup.fromQty-before)<=EPS,'Warehouse stock changed while the earlier quantity request was awaiting review. Resolve that request before entering another count.');
      need(pending.productQuantitySetup.targetQty===target,'A warehouse quantity request for this product is already awaiting review. Resolve it before requesting another count.');
    } else {
      let rate;
      if(payload.warehouseRate!==undefined&&payload.warehouseRate!==null&&payload.warehouseRate!=='')rate=number(payload.warehouseRate,'Warehouse stock rate',0.000001);
      if(delta>0&&!(current?.avgCost>0))need(rate!==undefined,'Enter a warehouse stock rate for the opening quantity.');
      const note=`Central Warehouse count entered in product setup: ${before} → ${target} ${saved.baseUnit}.`;
      const doc=createDocument(planned,user,'adjustment',{locationId:'WH',note,submit:true,lines:[{productId:saved.id,qty:delta,unit:saved.baseUnit,...(rate!==undefined?{rate}:{})}]});
      doc.productQuantitySetup={productId:saved.id,fromQty:before,targetQty:target};
      if(user.role==='superadmin')transition(planned,user,'document.approve',{id:doc.id,override:true,reason:note});
    }
  }
  Object.assign(state,planned);
  return state.products.find(item=>item.id===saved.id);
}

/** Importing item names creates a private catalogue draft, never inventory. */
function importProductNames(state,user,payload) {
  need(isAdmin(user)&&hasPermission(user,'products'),'Only an administrator with product permission can import item names.');
  need(isRecord(payload),'Send item names as an object.');
  need(Object.keys(payload).every(key=>['names','sourceLabel','importKey'].includes(key)),'Item-name imports accept only names, sourceLabel and importKey; monthly values are not allowed.');
  need(Array.isArray(payload.names)&&payload.names.length>0&&payload.names.length<=1000,'Import between 1 and 1000 item names.');
  const displayName=value=>{
    need(typeof value==='string','Every item name must be text.');
    const name=value.normalize('NFKC').replace(/\s+/g,' ').trim();
    need(name.length>0&&name.length<=160&&!/[\u0000-\u001f\u007f]/.test(name),'Each item name must contain 1 to 160 characters.');
    return name;
  };
  const nameKey=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
  const names=payload.names.map(displayName);
  const unique=new Map();
  for(const name of names)if(!unique.has(nameKey(name)))unique.set(nameKey(name),name);
  need(payload.sourceLabel===undefined||typeof payload.sourceLabel==='string','Source label must be text.');
  need(payload.importKey===undefined||typeof payload.importKey==='string','Import key must be text.');
  const sourceLabel=payload.sourceLabel===undefined?'Item names':payload.sourceLabel.trim();
  const importKey=payload.importKey?.trim();
  need(sourceLabel.length>0&&sourceLabel.length<=160,'Source label must contain 1 to 160 characters.');
  need(importKey===undefined||importKey.length>0&&importKey.length<=128,'Import key must contain 1 to 128 characters.');
  need(state.catalogueImports===undefined||Array.isArray(state.catalogueImports),'Catalogue import history is invalid.');
  const fingerprint=createHash('sha256').update('hsc-item-names-v1\0'+JSON.stringify([...unique.keys()].sort())).digest('hex');
  const history=state.catalogueImports||[];
  const sameKey=importKey&&history.find(record=>record.importKey===importKey);
  need(!sameKey||sameKey.fingerprint===fingerprint,'This import key already belongs to a different list of item names.');
  const previous=history.find(record=>record.fingerprint===fingerprint);
  const duplicatesSkipped=names.length-unique.size;
  if(previous)return {importId:previous.id,fingerprint,inputCount:names.length,uniqueCount:unique.size,created:0,matchedExisting:unique.size,duplicatesSkipped,repeated:true,noChanges:true};
  const existingNames=new Set(state.products.map(product=>nameKey(product.name)));
  const usedSkus=new Set(state.products.map(product=>String(product.sku).toUpperCase()));
  const planned=[];
  let sequence=0,matchedExisting=0;
  for(const [key,name] of unique){
    if(existingNames.has(key)){matchedExisting++;continue;}
    let sku;
    do{sku=`ITEM-${String(++sequence).padStart(4,'0')}`;}while(usedSkus.has(sku));
    usedSkus.add(sku);
    planned.push({id:uid('P'),sku,name,category:'',baseUnit:'',units:[],rate:null,reorderLevel:0,active:false,setupPending:true});
  }
  const record={id:uid('IMPORT'),at:now(),sourceLabel,fingerprint,...(importKey?{importKey}:{}),inputCount:names.length,uniqueCount:unique.size,duplicatesSkipped,matchedExisting,created:planned.length};
  state.products.push(...planned);
  state.catalogueImports=[...history,record];
  audit(state,user,'product.import',{id:record.id,name:sourceLabel},`Imported ${planned.length} item names as setup drafts; ${matchedExisting} existing and ${duplicatesSkipped} duplicate names skipped. No monthly values or stock were imported.`);
  return {importId:record.id,fingerprint,inputCount:names.length,uniqueCount:unique.size,created:planned.length,matchedExisting,duplicatesSkipped,repeated:false};
}

function saveSupplier(state,user,payload) {
  need(can(user,'masters')&&hasPermission(user,'suppliers'),'Only an administrator with supplier permission can change suppliers.');
  const existing = payload.id ? state.suppliers.find(s=>s.id===payload.id) : null;
  need(!payload.id || existing,'Supplier does not exist.');
  const name = text(payload.name,160);
  need(name,'Supplier name is required.');
  need(!state.suppliers.some(s=>s.name.toLowerCase()===name.toLowerCase() && s.id!==existing?.id),'A supplier with this name already exists.');
  const record = {id:existing?.id ?? uid('S'),name,contact:text(payload.contact,100),phone:text(payload.phone,60),email:text(payload.email,160),active:payload.active!==false};
  need(!record.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email),'Enter a valid supplier email.');
  if (existing) Object.assign(existing,record); else state.suppliers.push(record);
  audit(state,user,existing?'supplier.update':'supplier.create',record);
  return existing ?? record;
}

function demandValues(state,user,payload) {
  need(can(user,'demand'),'Your role cannot create branch demands.');
  const branchId=payload.branchId??user.branchId;
  assertBranch(state,branchId);
  if(user.role==='branch')need(branchId===user.branchId,'Demands must belong to your assigned branch.');
  need(payload.submit===undefined||typeof payload.submit==='boolean','Choose whether to submit the demand.');
  const date=payload.date||today();
  need(typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(`${date}T00:00:00Z`))&&new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date,'Enter a valid demand date.');
  return {branchId,date,note:text(payload.note,2000),lines:normalizeLines(state,'demand',payload.lines,0)};
}

function demandAction(state,user,action,payload) {
  state.demands??=[];
  const suffix=action.slice('demand.'.length);
  if(suffix==='create'){
    const values=demandValues(state,user,payload);
    const demand={id:uid('DEMAND'),type:'demand',reference:nextReference(state,'demand'),...values,status:payload.submit?'Pending approval':'Draft',createdAt:now(),createdBy:user.id,createdByName:user.name,history:[]};
    demand.history.push({at:demand.createdAt,by:user.name,action:'Created',status:demand.status});
    state.demands.unshift(demand);
    audit(state,user,action,demand,`${demand.lines.length} product lines; ${demand.status}`);
    return demand;
  }
  const demand=state.demands.find(row=>row.id===payload.id);
  need(demand,'Demand was not found.');
  if(user.role==='branch')need(demand.branchId===user.branchId,'This demand belongs to another location.');
  const reason=text(payload.reason||payload.note,2000);
  const writer=()=>{need(can(user,'demand'),'Your role cannot change branch demands.');need(demand.createdBy===user.id||isAdmin(user),'Only the creator or an administrator can change this demand.');};
  let result=demand;
  switch(suffix){
    case 'update':{
      writer();need(demand.status==='Draft','Only draft demands can be edited.');
      const values=demandValues(state,user,{...demand,...payload});
      need(values.branchId===demand.branchId,'A demand cannot be moved to another branch.');
      Object.assign(demand,values);
      if(payload.submit===true)demand.status='Pending approval';
      break;
    }
    case 'submit':
      writer();need(demand.status==='Draft','Only draft demands can be submitted.');
      demandValues(state,user,demand);demand.status='Pending approval';break;
    case 'approve':
      need(can(user,'demandReview'),'Only the central warehouse or an administrator can review demands.');
      need(demand.status==='Pending approval','Only pending demands can be approved.');
      if(demand.createdBy===user.id){
        need(user.role==='superadmin'&&payload.override===true,'Maker-checker rule: another reviewer must approve this demand.');
        need(reason,'A Super Admin override reason is required.');
        demand.approvalOverride={by:user.id,byName:user.name,at:now(),reason};
      }
      demand.status='Approved';demand.approvedBy=user.id;demand.approvedByName=user.name;demand.approvedAt=now();break;
    case 'reject':
      need(can(user,'demandReview'),'Only the central warehouse or an administrator can review demands.');
      need(demand.status==='Pending approval','Only pending demands can be rejected.');
      need(demand.createdBy!==user.id,'Maker-checker rule: another reviewer must review this demand.');
      need(reason,'A rejection reason is required.');demand.status='Rejected';break;
    case 'reopen':
      writer();need(demand.status==='Rejected','Only rejected demands can be reopened.');
      need(reason,'A reopening reason is required.');demand.status='Draft';
      delete demand.approvedAt;delete demand.approvedBy;delete demand.approvedByName;delete demand.approvalOverride;break;
    case 'cancel':
      need(['Draft','Pending approval','Approved'].includes(demand.status),'Only unconverted demands can be cancelled.');
      if(demand.status==='Approved')need(can(user,'demandReview'),'Only a central reviewer can cancel an approved demand.');else writer();
      need(reason,'A cancellation reason is required.');demand.status='Cancelled';break;
    case 'convert':{
      need(can(user,'demandReview')&&can(user,'transfer'),'You need demand review and dispatch permissions to prepare this gate pass.');
      const previous=state.documents.find(row=>row.id===demand.transferId);
      need(demand.status==='Approved'||demand.status==='Transfer created'&&previous?.status==='Cancelled','Approve this demand before creating a gate pass; an active linked gate pass cannot be created twice.');
      for(const line of demand.lines)need((state.stock.find(row=>row.locationId==='WH'&&row.productId===line.productId)?.qty||0)+EPS>=line.baseQty,`Insufficient ${product(state,line.productId).name} at Central Warehouse for this demand.`);
      const transfer=createDocument(state,user,'transfer',{branchId:demand.branchId,date:today(),note:`Branch demand ${demand.reference}${demand.note?`: ${demand.note}`:''}`,lines:demand.lines.map(line=>({productId:line.productId,qty:line.qty,unit:line.unit}))});
      transfer.demandId=demand.id;transfer.demandReference=demand.reference;
      demand.transferId=transfer.id;demand.transferReference=transfer.reference;
      demand.transferIds=[...(demand.transferIds||[]),transfer.id];
      demand.transferReferences=[...(demand.transferReferences||[]),transfer.reference];
      demand.status='Transfer created';result=transfer;break;
    }
    default:fail('Unsupported demand action.');
  }
  demand.updatedAt=now();demand.history.push({at:demand.updatedAt,by:user.name,action:suffix,status:demand.status,reason});
  audit(state,user,action,demand,reason||demand.status);
  return result;
}

function transition(state,user,action,payload) {
  const reference=text(payload.reference,100);
  const doc = state.documents.find(d=>d.id===payload.id || (reference && d.reference.toLowerCase()===reference.toLowerCase()));
  need(doc,'Document reference was not found.');
  assertDocumentScope(user,doc);
  need(canAccessDocument(user,doc,{review:['document.approve','document.reject','document.resolve'].includes(action),receive:action==='document.receive'}),'You do not have permission for this document action.');
  const reason = text(payload.reason || payload.note,2000);
  const suffix = action.slice('document.'.length);
  switch (suffix) {
    case 'update': {
      need(doc.status==='Draft','Only draft documents can be edited.');
      need(doc.createdBy===user.id||isAdmin(user),'Only the creator or an administrator can edit this draft.');
      need(payload.stockAddition===undefined||payload.stockAddition===(doc.stockAddition===true),'A document stock addition mode cannot be changed.');
      need(!doc.sourceTransferId||payload.sourceTransferId===undefined||payload.sourceTransferId===doc.sourceTransferId,'A return cannot change its source dispatch order.');
      const values=documentValues(state,user,doc.type,{...doc,...payload,stockAddition:doc.stockAddition===true});
      if(doc.demandId){
        const demand=state.demands?.find(row=>row.id===doc.demandId);
        need(demand&&values.branchId===demand.branchId&&values.lines.length===demand.lines.length&&values.lines.every(line=>demand.lines.some(requested=>requested.productId===line.productId&&Math.abs(requested.baseQty-line.baseQty)<EPS)),'A demand-linked gate pass must retain the approved branch and quantities.');
      }
      Object.assign(doc,values);
      break;
    }
    case 'reopen':
      need(doc.status==='Rejected','Only rejected documents can be reopened.');
      need(doc.createdBy===user.id||isAdmin(user),'Only the creator or an administrator can reopen this document.');
      need(can(user,doc.type),'Your role cannot reopen this document.');
      need(reason,'A reopening reason is required.');
      validateSourceReturn(state,doc);
      doc.status='Draft';
      break;
    case 'submit':
      need(doc.status==='Draft','Only drafts can be submitted.');
      need(doc.createdBy===user.id || isAdmin(user),'Only the creator or administrator can submit a draft.');
      need(can(user,doc.type),'Your role cannot submit this document.');
      validateSourceReturn(state,doc);
      doc.status='Pending approval';
      break;
    case 'approve':
      need(can(user,'approve'),'Only administrators can approve documents.');
      need(doc.status==='Pending approval','Only pending documents can be approved.');
      validateSourceReturn(state,doc);
      if(doc.productQuantitySetup) {
        const count=doc.productQuantitySetup;
        const balance=state.stock.find(row=>row.locationId==='WH'&&row.productId===count.productId)?.qty||0;
        need(doc.type==='adjustment'&&doc.locationId==='WH'&&doc.lines.length===1&&doc.lines[0].productId===count.productId&&Math.abs(doc.lines[0].baseQty-round(count.targetQty-count.fromQty))<=EPS,'The product quantity request no longer matches its recorded target. Cancel it and enter the correct count through Products.');
        need(Math.abs(balance-count.fromQty)<=EPS,'Warehouse stock changed after this quantity request. Cancel it and enter the current count through Products.');
      }
      if (doc.createdBy===user.id) {
        need(user.role==='superadmin'&&payload.override===true,'Maker-checker rule: another administrator must approve this document.');
        need(reason,'A Super Admin override reason is required.');
        doc.approvalOverride={by:user.id,byName:user.name,at:now(),reason};
      }
      doc.approvedBy=user.id;
      doc.approvedByName=user.name;
      doc.approvedAt=now();
      if (doc.type==='grn') {
        for (const line of doc.lines) addStock(state,doc,'WH',line,line.baseQty,line.unitCost,'Purchase receipt',user);
        doc.status='Completed';
        doc.postedAt=now();
      } else if (doc.type==='adjustment') {
        // Revalidate every quantity against the balances at approval, before posting.
        const planned=adjustmentLines(state,doc.lines,doc.locationId,doc.stockAddition===true);
        for (const line of planned) {
          const original=doc.lines.find(l=>l.productId===line.productId);
          original.unitCost=line.unitCost;
          original.cost=line.cost;
          if (line.baseQty>0) addStock(state,doc,doc.locationId,original,line.baseQty,line.unitCost,doc.stockAddition?'Manual stock addition':'Stock adjustment',user);
          else removeStock(state,doc,doc.locationId,original,-line.baseQty,line.unitCost,'Stock adjustment',user);
          const balance=stock(state,doc.locationId,line.productId);
          if (isCountedUnit(line.baseUnit)&&Number.isInteger(balance.qty)) delete balance.countReviewRequired;
        }
        doc.total=round(doc.lines.reduce((sum,l)=>sum+l.cost,0));
        doc.status='Completed';
        doc.postedAt=now();
      } else doc.status='Approved';
      break;
    case 'reject':
      need(can(user,'approve'),'Only administrators can reject documents.');
      need(doc.status==='Pending approval','Only pending documents can be rejected.');
      need(doc.createdBy!==user.id,'Maker-checker rule: another administrator must review this document.');
      need(reason,'A rejection reason is required.');
      doc.status='Rejected';
      break;
    case 'cancel':
      need(['Draft','Pending approval','Approved'].includes(doc.status),'Dispatched or posted documents cannot be cancelled.');
      need((doc.createdBy===user.id && doc.status!=='Approved') || isAdmin(user),'You cannot cancel this document.');
      need(user.role!=='viewer','Your role cannot cancel documents.');
      need(reason,'A cancellation reason is required.');
      doc.status='Cancelled';
      break;
    case 'dispatch': {
      need(['transfer','return'].includes(doc.type) && doc.status==='Approved','Only approved gate passes or returns can be dispatched.');
      need(isAdmin(user) || (doc.type==='transfer' && user.role==='warehouse') || (doc.type==='return' && user.role==='branch' && user.branchId===doc.branchId),'Your role cannot dispatch from this location.');
      validateSourceReturn(state,doc);
      const source = doc.type==='transfer'?'WH':doc.branchId;
      // Validate the entire movement before writing any lines.
      for (const line of doc.lines) need(stock(state,source,line.productId).qty+EPS>=line.baseQty,`Insufficient ${product(state,line.productId).name} for dispatch.`);
      for (const line of doc.lines) {
        line.unitCost=stock(state,source,line.productId).avgCost;
        line.cost=round(line.baseQty*line.unitCost);
        removeStock(state,doc,source,line,line.baseQty,line.unitCost,'Dispatch',user);
        movement(state,doc,'TRANSIT',line.productId,line.baseQty,line.unitCost,'In transit',user);
      }
      doc.total=round(doc.lines.reduce((sum,l)=>sum+l.cost,0));
      doc.dispatchedAt=now();
      doc.dispatchedBy=user.id;
      doc.vehicle=text(payload.vehicle,80);
      doc.driver=text(payload.driver,100);
      doc.status='In transit';
      break;
    }
    case 'receive': {
      need(['transfer','return'].includes(doc.type) && doc.status==='In transit','This document is not awaiting receipt.');
      need(isAdmin(user) || (doc.type==='transfer' && user.role==='branch' && user.branchId===doc.branchId) || (doc.type==='return' && user.role==='warehouse'),'Your role cannot receive at this location.');
      const to = doc.type==='transfer'?doc.branchId:'WH';
      const incoming = payload.lines;
      need(incoming===undefined || Array.isArray(incoming),'Receipt lines must be a list.');
      if (incoming) {
        need(incoming.every(isRecord),'Each receipt line must be an object with product and received quantities.');
        need(incoming.length===doc.lines.length && new Set(incoming.map(l=>l.productId)).size===incoming.length,'Confirm every receipt line exactly once.');
        need(incoming.every(l=>doc.lines.some(d=>d.productId===l.productId)),'Receipt includes a product absent from the gate pass.');
      }
      const receipt = doc.lines.map(line=> {
        const values=incoming?.find(l=>l.productId===line.productId);
        const receiptLimit=Math.max(1e9,line.baseQty);
        const good=number(values ? values.receivedQty : line.baseQty,'Good received quantity',0,receiptLimit);
        const damaged=number(values?.damagedQty ?? 0,'Damaged quantity',0,receiptLimit);
        need(good+damaged<=line.baseQty+EPS,'Good plus damaged quantity cannot exceed dispatched quantity.');
        if (isCountedUnit(product(state,line.productId).baseUnit)) need(Number.isInteger(good) && Number.isInteger(damaged),'Receipt quantities for pieces must be whole pieces.');
        return {line,good,damaged,short:round(Math.max(0,line.baseQty-good-damaged))};
      });
      for (const row of receipt) {
        const {line,good,damaged,short}=row;
        line.receivedQty=good;
        line.damagedQty=damaged;
        line.shortQty=short;
        line.unresolvedQty=round(damaged+short);
        if (good>0) {
          movement(state,doc,'TRANSIT',line.productId,-good,line.unitCost,'Receipt out of transit',user);
          addStock(state,doc,to,line,good,line.unitCost,'Transfer receipt',user);
        }
      }
      doc.receivedAt=now();
      doc.receivedBy=user.id;
      doc.receivedByName=user.name;
      doc.receiptNote=reason;
      doc.status=receipt.some(row=>row.damaged+row.short>EPS)?'Discrepancy':'Completed';
      break;
    }
    case 'resolve': {
      need(can(user,'approve'),'Only administrators can resolve discrepancies.');
      need(doc.status==='Discrepancy','Only discrepancy documents can be resolved.');
      need(reason,'A discrepancy resolution reason is required.');
      const mode=payload.resolutionMode??'loss';
      need(['loss','received','returned'].includes(mode),'Choose loss, received or returned for this discrepancy.');
      const destination=mode==='received'?(doc.type==='transfer'?doc.branchId:'WH'):(doc.type==='transfer'?'WH':doc.branchId);
      state.losses??=[];
      for (const line of doc.lines) {
        if (line.unresolvedQty>EPS) {
          movement(state,doc,'TRANSIT',line.productId,-line.unresolvedQty,line.unitCost,mode==='loss'?'Approved discrepancy loss':'Discrepancy recovery out of transit',user);
          if (mode==='loss') {
            state.losses.push({id:uid('LOSS'),at:now(),documentId:doc.id,reference:doc.reference,branchId:doc.branchId,productId:line.productId,qty:line.unresolvedQty,unitCost:line.unitCost,value:round(line.unresolvedQty*line.unitCost),reason,approvedBy:user.id});
            line.lossQty=line.unresolvedQty;
          } else {
            addStock(state,doc,destination,line,line.unresolvedQty,line.unitCost,mode==='received'?'Recovered receipt':'Discrepancy returned to source',user);
            line[mode==='received'?'recoveredQty':'returnedQty']=line.unresolvedQty;
          }
          line.unresolvedQty=0;
        }
      }
      doc.resolution=reason;
      doc.resolvedBy=user.id;
      doc.resolvedAt=now();
      doc.resolutionMode=mode;
      doc.status='Completed';
      break;
    }
    default: fail('Unsupported document action.');
  }
  doc.updatedAt=now();
  doc.history.push({at:doc.updatedAt,by:user.name,action:suffix,status:doc.status,reason});
  audit(state,user,action,doc,suffix==='approve'&&doc.approvalOverride?`Super Admin approval override: ${reason}`:suffix==='resolve'?`${doc.resolutionMode}: ${reason}`:reason || doc.status);
  return doc;
}

/** Run against a private clone, then commit only if no error is thrown. */
export function execute(state,user,action,payload={}) {
  need(user && ROLES.includes(user.role),'A valid signed-in role is required.');
  need(user.id && user.name,'User identity is incomplete.');
  if (user.role==='branch') assertBranch(state,user.branchId);
  need(user.role!=='viewer','The viewer role is read only.');
  need(actionAllowed(user,action,payload,state),'You do not have permission for this action.');
  if(Array.isArray(payload.lines)&&payload.lines.some(line=>isRecord(line)&&Object.hasOwn(line,'newProduct'))) {
    const reference=text(payload.reference,100).toLowerCase();
    const doc=action==='document.update'?state.documents.find(row=>row.id===payload.id||reference&&row.reference.toLowerCase()===reference):null;
    need(action==='grn.create'||action==='document.update'&&doc?.type==='grn','New products can only be created within a purchase GRN.');
    // Validate the complete GRN on a plan so a bad line cannot leave an orphan master.
    const planned=clone(state);
    const lines=resolvePurchaseProducts(planned,user,payload.lines);
    const result=execute(planned,user,action,{...payload,lines});
    Object.assign(state,planned);
    return result;
  }
  if (action==='product.save') return payload.warehouseQuantity===undefined?saveProduct(state,user,payload):saveProductWithQuantity(state,user,payload);
  if (action==='product.import') return importProductNames(state,user,payload);
  if (action==='supplier.save') return saveSupplier(state,user,payload);
  if (action==='location.save') return saveLocation(state,user,payload);
  if (action==='stock.add') return createStockAddition(state,user,payload);
  if (action.startsWith('demand.'))return demandAction(state,user,action,payload);
  if (['grn.create','transfer.create','return.create','adjustment.create'].includes(action)) return createDocument(state,user,action.split('.')[0],payload);
  if (action.startsWith('document.')) return transition(state,user,action,payload);
  fail('Unsupported action.');
}

/** Remove inaccessible rows and monetary fields before serializing any response. */
export function scopedState(state,user) {
  need(user && ROLES.includes(user.role),'A valid signed-in role is required.');
  const result=clone(state);
  result.demands??=[];
  if (user.role!=='branch') return filterModuleState(result,user);
  assertBranch(state,user.branchId);
  result.documents=result.documents.filter(d=>d.branchId===user.branchId&&(d.type==='return'||d.type==='transfer'&&['In transit','Discrepancy','Completed'].includes(d.status)));
  result.demands=result.demands.filter(d=>d.branchId===user.branchId);
  result.stock=result.stock.filter(s=>s.locationId===user.branchId);
  result.suppliers=[];
  result.locations=result.locations.filter(l=>l.id===user.branchId || l.id==='WH');
  result.audit=result.audit.filter(a=>a.branchId===user.branchId);
  result.ledger=result.ledger.filter(l=>l.locationId===user.branchId);
  result.losses=result.losses.filter(l=>l.branchId===user.branchId);
  const costs=['rate','discount','tax','gross','net','taxAmount','cost','total','freight','unitCost','avgCost','value'];
  function redact(object) {
    if (!object || typeof object!=='object') return;
    if (Array.isArray(object)) { object.forEach(redact); return; }
    for (const key of Object.keys(object)) {
      if (costs.includes(key)) delete object[key]; else redact(object[key]);
    }
  }
  redact(result);
  return filterModuleState(result,user);
}

export function seedState() {
  const state={version:2,sequence:{grn:1006,transfer:2023,return:104},products:[],suppliers:[
    {id:'S1',name:'Pure Dairy Co.',contact:'Ahmed Raza',phone:'+92 300 123 4567',email:'orders@puredairy.example',active:true},
    {id:'S2',name:'Punjab General Traders',contact:'Sana Malik',phone:'+92 321 456 7890',email:'sales@punjabtraders.example',active:true},
    {id:'S3',name:'Eco Pack Supplies',contact:'Usman Ali',phone:'+92 333 222 8100',email:'hello@ecopack.example',active:true},
    {id:'S4',name:'Fresh Brew Distributors',contact:'Hassan Khan',phone:'+92 301 555 0182',email:'supply@freshbrew.example',active:true},
  ],locations:[{id:'WH',name:'Central Warehouse',type:'warehouse'},{id:'B1',name:'Gulberg',type:'branch'},{id:'B2',name:'DHA',type:'branch'},{id:'B3',name:'Johar Town',type:'branch'},{id:'B4',name:'Model Town',type:'branch'}],stock:[],documents:[],demands:[],ledger:[],audit:[],losses:[]};
  const rows=[
    ['P1','DAI-001','Milk · 250 ml','Dairy','pc',[['pc',1],['Packet',1],['Carton (24)',24]],240,1920,65],
    ['P2','DAI-002','Milk · 500 ml','Dairy','pc',[['pc',1],['Packet',1],['Carton (12)',12]],120,720,127.5],
    ['P3','DAI-003','Milk · 1 litre','Dairy','pc',[['pc',1],['Packet',1],['Carton (12)',12]],100,720,250],
    ['P4','DAI-004','Dairy cream · 200 ml','Dairy','pc',[['pc',1],['Pack',1],['Carton (24)',24]],50,240,190],
    ['P5','DRY-001','Refined white sugar','Dry goods','kg',[['kg',1],['Bag (50 kg)',50]],200,1250,145],
    ['P6','DRY-002','Premium wheat flour','Dry goods','kg',[['kg',1],['Bag (20 kg)',20]],100,620,125],
    ['P7','BEV-001','House blend coffee beans','Beverages','kg',[['kg',1],['Bag (1 kg)',1],['Box (6 kg)',6]],40,26,3600],
    ['P8','BEV-002','Black tea leaves','Beverages','kg',[['kg',1],['Pack (500 g)',0.5],['Carton (10 kg)',10]],25,120,1850],
    ['P9','PKG-001','Paper cups · 12 oz','Packaging','pc',[['pc',1],['Sleeve (50)',50],['Carton (1000)',1000]],2000,8500,18],
    ['P10','PKG-002','Cup lids · 12 oz','Packaging','pc',[['pc',1],['Sleeve (100)',100],['Carton (1000)',1000]],2000,7500,8],
    ['P11','CLN-001','Dishwashing liquid','Cleaning','L',[['L',1],['Can (5 L)',5],['Carton (20 L)',20]],30,24,310],
    ['P12','CLN-002','Food-safe sanitizer','Cleaning','L',[['L',1],['Can (5 L)',5]],20,85,420],
    ['P13','DRY-003','Chocolate sauce','Dry goods','kg',[['kg',1],['Bottle (2 kg)',2],['Case (12 kg)',12]],30,144,820],
    ['P14','PKG-003','Kraft takeaway bags','Packaging','pc',[['pc',1],['Pack (100)',100],['Carton (500)',500]],1000,4500,26],
  ];
  const system={id:'system',name:'Opening balances',role:'admin'};
  for (const [id,sku,name,category,baseUnit,units,reorderLevel,qty,cost] of rows) {
    state.products.push({id,sku,name,category,baseUnit,units:units.map(([name,factor])=>({name,factor})),reorderLevel,active:true});
    for (const [locationId,multiplier] of [['WH',1],['B1',0.08],['B2',0.06],['B3',0.07],['B4',0.05]]) {
      const amount=baseUnit==='pc'?Math.floor(qty*multiplier):round(qty*multiplier);
      state.stock.push({locationId,productId:id,qty:amount,avgCost:cost});
      movement(state,{id:'OPEN',date:'2026-10-01',reference:'OPEN-2026',branchId:locationId==='WH'?null:locationId},locationId,id,amount,cost,'Opening balance',system);
    }
  }
  const purchasing={id:'purchasing',name:'Ayesha Malik',role:'purchasing'};
  const warehouse={id:'warehouse',name:'Hamza Khan',role:'warehouse'};
  const admin={id:'admin',name:'Abid Zafar',role:'admin'};
  const branch={id:'branch1',name:'Gulberg Manager',role:'branch',branchId:'B1'};
  const grn=createDocument(state,purchasing,'grn',{supplierId:'S1',date:'2026-10-27',note:'Morning dairy delivery · invoice PD-7821',freight:1800,submit:true,lines:[{productId:'P3',qty:20,unit:'Carton (12)',rate:2880,discount:3,tax:0},{productId:'P1',qty:15,unit:'Carton (24)',rate:1500,discount:2,tax:0}]});
  const completed=createDocument(state,purchasing,'grn',{supplierId:'S2',date:'2026-10-26',note:'Weekly dry goods replenishment',freight:1500,submit:true,lines:[{productId:'P5',qty:5,unit:'Bag (50 kg)',rate:7250,discount:2,tax:0},{productId:'P6',qty:5,unit:'Bag (20 kg)',rate:2500,discount:0,tax:0}]});
  transition(state,admin,'document.approve',{id:completed.id});
  const transit=createDocument(state,warehouse,'transfer',{branchId:'B2',date:'2026-10-28',note:'Scheduled morning replenishment',submit:true,lines:[{productId:'P3',qty:10,unit:'Carton (12)'},{productId:'P9',qty:2,unit:'Carton (1000)'}]});
  transition(state,admin,'document.approve',{id:transit.id});
  transition(state,warehouse,'document.dispatch',{id:transit.id,vehicle:'LEA-4821',driver:'Imran'});
  const discrepancy=createDocument(state,warehouse,'transfer',{branchId:'B1',date:'2026-10-27',note:'Gulberg daily dispatch',submit:true,lines:[{productId:'P2',qty:10,unit:'Carton (12)'},{productId:'P10',qty:1,unit:'Carton (1000)'}]});
  transition(state,admin,'document.approve',{id:discrepancy.id});
  transition(state,warehouse,'document.dispatch',{id:discrepancy.id});
  transition(state,branch,'document.receive',{id:discrepancy.id,reason:'Four milk packets damaged in transit; lids received in full.',lines:[{productId:'P2',receivedQty:116,damagedQty:4},{productId:'P10',receivedQty:1000,damagedQty:0}]});
  createDocument(state,warehouse,'transfer',{branchId:'B3',date:'2026-10-28',note:'Afternoon dispatch request',submit:true,lines:[{productId:'P5',qty:2,unit:'Bag (50 kg)'},{productId:'P14',qty:2,unit:'Carton (500)'}]});
  createDocument(state,branch,'return',{branchId:'B1',date:'2026-10-28',note:'Unopened excess dairy stock; return to warehouse.',submit:true,lines:[{productId:'P1',qty:12,unit:'Packet'}]});
  // Seed times are visibly sample records; all new actions get current timestamps.
  return state;
}
