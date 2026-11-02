/** Versioned data repair for milk packets previously measured as loose litres. */
export const UNIT_SCHEMA_VERSION = 2;
const milkPacks = [
  {id:'P1',sku:'DAI-001',piecesPerLitre:4,pack:'Packet',carton:'Carton (24)',count:24},
  {id:'P2',sku:'DAI-002',piecesPerLitre:2,pack:'Packet',carton:'Carton (12)',count:12},
  {id:'P3',sku:'DAI-003',piecesPerLitre:1,pack:'Packet',carton:'Carton (12)',count:12},
  {id:'P4',sku:'DAI-004',piecesPerLitre:5,pack:'Pack',carton:'Carton (24)',count:24},
];
const quantityKeys = ['baseQty','receivedQty','damagedQty','shortQty','unresolvedQty','lossQty'];
const round = value => Math.round((value + Number.EPSILON)*1e6)/1e6;
const snapshot = (record,keys) => Object.fromEntries(keys.filter(key=>record[key]!==undefined).map(key=>[key,structuredClone(record[key])]));

/** Mutate a private state clone and return whether it needs an atomic save. */
export function upgradeState(state) {
  if ((state.version ?? 1) >= UNIT_SCHEMA_VERSION) return false;
  const changed = [];
  for (const spec of milkPacks) {
    const product = state.products.find(row=>row.id===spec.id && row.sku===spec.sku && row.baseUnit==='L');
    if (!product) continue;
    const scale = spec.piecesPerLitre;
    product.legacyMeasurement ??= snapshot(product,['baseUnit','units','reorderLevel']);
    product.baseUnit = 'pc';
    product.units = [{name:'pc',factor:1},{name:spec.pack,factor:1},{name:spec.carton,factor:spec.count}];
    product.reorderLevel = round(product.reorderLevel*scale);
    for (const stock of state.stock.filter(row=>row.productId===spec.id)) {
      stock.legacyMeasurement ??= {baseUnit:'L',...snapshot(stock,['qty','avgCost'])};
      stock.qty = round(stock.qty*scale);
      // Do not round inverse costs: existing inventory values must remain exact.
      stock.avgCost /= scale;
      if (!Number.isInteger(stock.qty)) stock.countReviewRequired = true;
    }
    for (const ledger of state.ledger.filter(row=>row.productId===spec.id)) {
      ledger.legacyMeasurement ??= {baseUnit:'L',...snapshot(ledger,['qty','unitCost'])};
      ledger.qty = round(ledger.qty*scale);
      ledger.unitCost /= scale;
      ledger.baseUnit = 'pc';
    }
    for (const loss of (state.losses ?? []).filter(row=>row.productId===spec.id)) {
      loss.legacyMeasurement ??= {baseUnit:'L',...snapshot(loss,['qty','unitCost'])};
      loss.qty = round(loss.qty*scale);
      loss.unitCost /= scale;
      loss.baseUnit = 'pc';
    }
    for (const doc of state.documents) {
      for (const line of doc.lines.filter(row=>row.productId===spec.id)) {
        line.legacyMeasurement ??= snapshot(line,['baseUnit','qty','unit','factor','rate','unitCost',...quantityKeys]);
        line.legacyMeasurement.baseUnit ??= 'L';
        for (const key of quantityKeys) if (typeof line[key]==='number') line[key] = round(line[key]*scale);
        if (typeof line.factor==='number') line.factor = round(line.factor*scale);
        if (typeof line.unitCost==='number') line.unitCost /= scale;
        if (line.unit==='L') {
          line.unit = 'pc';
          line.qty = round(line.qty*scale);
          if (typeof line.rate==='number') line.rate /= scale;
          line.factor = 1;
        }
        line.baseUnit = 'pc';
      }
    }
    changed.push(product.sku);
  }
  state.version = UNIT_SCHEMA_VERSION;
  state.audit ??= [];
  state.audit.unshift({id:`AUD_${crypto.randomUUID()}`,at:new Date().toISOString(),userId:'system',userName:'System',role:'admin',action:'system.item-units-upgrade',entityId:'item-units-v2',reference:'ITEM-UNITS-V2',branchId:null,detail:`Item-specific stock units applied. Packaged milk/cream counted as pieces: ${changed.join(', ') || 'no legacy milk items found'}. Existing quantities and unit costs converted together; document values retained.`});
  return true;
}
