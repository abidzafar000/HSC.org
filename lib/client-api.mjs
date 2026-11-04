/** JSON requests never retry a mutation: a lost response may follow a committed save. */
export async function requestJson(path, body, fetchImpl = globalThis.fetch) {
  const writing = body !== undefined;
  const options = {
    method: writing ? 'POST' : 'GET',
    headers: writing ? { 'Content-Type': 'application/json' } : {},
    body: writing ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  };
  const interrupted = status => Object.assign(new Error(writing
    ? 'The connection was interrupted. Your save could not be confirmed. Check the saved record before trying again.'
    : 'The connection was interrupted. Please try loading the page again.'), {
    status, networkError: true, ...(writing ? { saveUnconfirmed: true } : {}),
  });
  let response;
  try { response = await fetchImpl(path, options); }
  catch { throw interrupted(0); }
  let data;
  try { data = await response.json(); }
  catch { throw interrupted(response.status); }
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : 'Unable to complete this request.';
    if (/^(fetch failed|failed to fetch)$/i.test(message.trim())) throw interrupted(response.status);
    throw Object.assign(new Error(message), { status: response.status });
  }
  return data;
}

const EPS = 0.0000005;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => ['string', 'number', 'boolean'].includes(typeof value) ? String(value).trim().slice(0, max) : '';
const numeric = (value, min = 0, max = 1e9) => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= min && result <= max ? result : null;
};
const near = (a, b) => typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= EPS;
const round = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const canonicalUnit = value => ({
  pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc', box: 'pc', boxes: 'pc',
  litre: 'L', liter: 'L', litres: 'L', liters: 'L', l: 'L',
  kilogram: 'kg', kilograms: 'kg', kg: 'kg', gram: 'g', grams: 'g', g: 'g',
  millilitre: 'ml', milliliter: 'ml', ml: 'ml',
}[value.toLowerCase()] ?? value);

/**
 * Confirm only the requested, fully configured product in a fresh server state.
 * This is deliberately conservative: false means keep the form for review, never retry a POST.
 */
export function productSaveConfirmed(state, payload, user) {
  if (!record(state) || !record(payload) || !payload.id || !Array.isArray(state.products)) return false;
  const product = state.products.find(item => item.id === payload.id);
  if (!record(product) || Object.hasOwn(product, 'setupPending')) return false;
  const sku = text(payload.sku, 40).toUpperCase();
  const name = text(payload.name, 160);
  const category = text(payload.category, 60);
  const suppliedUnit = text(payload.baseUnit, 20);
  if (!sku || !name || !category || !suppliedUnit) return false;
  if (product.sku !== sku || product.name !== name || product.category !== category || product.active !== (payload.active !== false)) return false;
  const reorder = numeric(payload.reorderLevel ?? 0);
  if (reorder === null || product.reorderLevel !== reorder) return false;
  if (payload.rate !== undefined) {
    const rate = payload.rate === null || typeof payload.rate === 'string' && payload.rate.trim() === '' ? null : numeric(payload.rate);
    if (rate === null && payload.rate !== null && !(typeof payload.rate === 'string' && payload.rate.trim() === '')) return false;
    if (product.rate !== rate) return false;
  }
  if (!Array.isArray(payload.units) || payload.units.length < 1 || payload.units.length > 20 || !Array.isArray(product.units)) return false;
  // Movement/document use locks legacy unit names; otherwise the engine canonicalizes aliases.
  const used = (Array.isArray(state.ledger) && state.ledger.some(row => row.productId === product.id)) ||
    [...(state.documents || []), ...(state.demands || [])].some(doc => Array.isArray(doc.lines) && doc.lines.some(line => line.productId === product.id));
  const baseUnit = used && suppliedUnit === product.baseUnit ? suppliedUnit : canonicalUnit(suppliedUnit);
  if (product.baseUnit !== baseUnit || product.units.length !== payload.units.length) return false;
  const units = payload.units.map(unit => record(unit) ? {
    name: text(unit.name, 40), factor: numeric(unit.factor, 0.000001),
  } : null);
  if (units.some(unit => !unit || !unit.name || unit.factor === null)) return false;
  // A newly posted count makes the product appear locked in the refreshed state;
  // allow the canonical alias normalization that happened before that first movement.
  const candidates = [units, units.map(unit => ({ ...unit, name: unit.name === suppliedUnit && unit.factor === 1 ? canonicalUnit(suppliedUnit) : unit.name }))];
  if (!candidates.some(candidate => candidate.some(unit => unit.name === product.baseUnit && Math.abs(unit.factor - 1) < EPS) &&
    new Set(candidate.map(unit => unit.name.toLowerCase())).size === candidate.length &&
    candidate.every((unit, index) => product.units[index]?.name === unit.name && product.units[index]?.factor === unit.factor))) return false;
  if (payload.warehouseQuantity === undefined) return true;
  const target = numeric(payload.warehouseQuantity);
  const baseline = numeric(payload.warehouseExpectedQuantity);
  if (target === null || canonicalUnit(product.baseUnit) === 'pc' && !Number.isInteger(target)) return false;
  const balance = Array.isArray(state.stock) ? state.stock.find(row => row.locationId === 'WH' && row.productId === product.id) : undefined;
  const quantity = balance?.qty ?? 0;
  const rateProvided = payload.warehouseRate !== undefined && payload.warehouseRate !== null && payload.warehouseRate !== '';
  const rate = rateProvided ? numeric(payload.warehouseRate, 0.000001) : null;
  if (rateProvided && rate === null) return false;
  const countDocument = (doc, status) => {
    if (!user?.id || baseline === null || doc.type !== 'adjustment' || doc.locationId !== 'WH' || doc.status !== status || doc.createdBy !== user.id) return false;
    const count = doc.productQuantitySetup;
    const delta = round(target - baseline);
    if (!record(count) || count.productId !== product.id || !near(count.fromQty, baseline) || !near(count.targetQty, target) || Math.abs(delta) <= EPS) return false;
    if (!Array.isArray(doc.lines) || doc.lines.length !== 1) return false;
    const line = doc.lines[0];
    return line.productId === product.id && line.unit === product.baseUnit && line.baseUnit === product.baseUnit &&
      near(line.factor, 1) && near(line.qty, delta) && near(line.baseQty, delta) &&
      (!rateProvided || line.rate === rate) &&
      (status !== 'Pending approval' || !rateProvided || near(line.unitCost, balance?.avgCost > 0 ? balance.avgCost : rate));
  };
  if (near(quantity, target)) {
    if (!rateProvided || baseline !== null && target <= baseline) return true;
    // Opening quantities have no prior inventory cost to blend with the entered rate.
    if (baseline === 0) return near(balance?.avgCost, rate);
    return (state.documents || []).some(doc => countDocument(doc, 'Completed') &&
      near(doc.lines[0].unitCost, rate) && near(balance?.avgCost, doc.lines[0].unitCost));
  }
  // An administrator may have saved a count awaiting an independent approval.
  return baseline !== null && near(quantity, baseline) && (state.documents || []).some(doc => countDocument(doc, 'Pending approval'));
}
