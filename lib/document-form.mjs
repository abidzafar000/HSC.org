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
