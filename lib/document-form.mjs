/** Keep the editor aligned with the server's active, unique product-line rules. */
export function availableLineProducts(products, lines = [], currentProductId) {
  const selected = new Set(lines.map(line => line.productId));
  return (products || []).filter(product => product.active && (!selected.has(product.id) || product.id === currentProductId));
}

export function documentPrerequisite(type, products, suppliers) {
  if (type === 'grn' && !(suppliers || []).some(supplier => supplier.active)) return 'Add or activate a supplier before creating a purchase GRN.';
  if (type !== 'grn' && !(products || []).some(product => product.active)) return 'Add or activate a product before creating a document.';
  return '';
}

export function canAddDocumentLine(type, products, lines = []) {
  return lines.length < 100 && (type === 'grn' || availableLineProducts(products, lines).length > 0);
}

/** Remaining received stock for a return linked to one dispatch, in stock units. */
export function dispatchReturnAllowances(source, documents = [], stock = [], excludedReturnId) {
  const quantities = new Map();
  if (!source || source.type !== 'transfer' || !['Completed', 'Discrepancy'].includes(source.status)) return quantities;
  const returns = documents.filter(document => document.type === 'return' && document.sourceTransferId === source.id && document.id !== excludedReturnId && !['Cancelled', 'Rejected'].includes(document.status));
  for (const line of source.lines || []) {
    const received = (line.receivedQty || 0) + (line.recoveredQty || 0);
    const reserved = returns.reduce((sum, document) => sum + document.lines.filter(item => item.productId === line.productId).reduce((total, item) => total + Math.max(0, item.baseQty - (item.returnedQty || 0)), 0), 0);
    const available = stock.find(row => row.locationId === source.branchId && row.productId === line.productId)?.qty || 0;
    const quantity = Math.round((Math.max(0, Math.min(available, received - reserved)) + Number.EPSILON) * 1e6) / 1e6;
    if (quantity > 0) quantities.set(line.productId, quantity);
  }
  return quantities;
}

const productNameKey = name => String(name || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');

/** The server also checks hidden catalogue entries and concurrent saves. */
export function newProductNameIssue(products, lines, index) {
  const key = productNameKey(lines[index]?.newProduct?.name);
  if (!key) return '';
  const existing = (products || []).find(product => productNameKey(product.name) === key);
  if (existing) return existing.active
    ? 'This item already exists. Choose it from the product list.'
    : 'This item already exists. Complete or activate its product setup before using it.';
  if (lines.some((line, other) => other !== index && line.newProduct && productNameKey(line.newProduct.name) === key)) return 'This new item is already entered on another line.';
  return '';
}
