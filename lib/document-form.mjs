/** Keep the editor aligned with the server's active, unique product-line rules. */
export function availableLineProducts(products, lines = [], currentProductId) {
  const selected = new Set(lines.map(line => line.productId));
  return (products || []).filter(product => product.active && (!selected.has(product.id) || product.id === currentProductId));
}

export function documentPrerequisite(type, products, suppliers) {
  if (!(products || []).some(product => product.active)) return 'Add or activate a product before creating a document.';
  if (type === 'grn' && !(suppliers || []).some(supplier => supplier.active)) return 'Add or activate a supplier before creating a purchase GRN.';
  return '';
}
