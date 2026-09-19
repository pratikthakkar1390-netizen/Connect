import { getDb } from '../../db/store.js';
import {
  addVendorProduct,
  getVendorProducts,
  type VendorProduct,
} from '../store.js';

export const ORDER_AHEAD_PRODUCTS = [
  { productName: 'Roti', unit: '25 ct', price: '$10.00' },
  { productName: 'Methi Paratha', unit: '10 ct', price: '$10.00' },
  { productName: 'Plain Paratha', unit: '10 ct', price: '$9.00' },
] as const;

function sameProduct(left: VendorProduct, name: string, unit: string): boolean {
  return (
    left.product_name.trim().toLowerCase() === name.trim().toLowerCase() &&
    (left.unit ?? '').trim().toLowerCase() === unit.trim().toLowerCase()
  );
}

export function ensureOrderAheadCatalog(vendorId: number): VendorProduct[] {
  const existing = getVendorProducts(vendorId);
  for (const seed of ORDER_AHEAD_PRODUCTS) {
    const found = existing.find((product) =>
      sameProduct(product, seed.productName, seed.unit),
    );
    if (!found) {
      addVendorProduct({
        vendorId,
        productName: seed.productName,
        unit: seed.unit,
        category: 'INDIAN_BAKERY',
      });
    }
  }
  applyOrderAheadPrices(vendorId);
  return getVendorProducts(vendorId).filter((product) =>
    ORDER_AHEAD_PRODUCTS.some((seed) =>
      sameProduct(product, seed.productName, seed.unit),
    ),
  );
}

/** Update price only for the three order-ahead SKUs. Never inserts or changes names/units. */
export function applyOrderAheadPrices(vendorId?: number): number {
  const database = getDb();
  let changes = 0;
  const update = database.prepare(
    `UPDATE vendor_products
     SET price = ?, updated_at = datetime('now')
     WHERE lower(trim(product_name)) = lower(trim(?))
       AND lower(trim(ifnull(unit, ''))) = lower(trim(?))
       AND (vendor_id = ? OR ? IS NULL)
       AND ifnull(price, '') != ?`,
  );
  for (const seed of ORDER_AHEAD_PRODUCTS) {
    const result = update.run(
      seed.price,
      seed.productName,
      seed.unit,
      vendorId ?? null,
      vendorId ?? null,
      seed.price,
    );
    changes += result.changes;
  }
  return changes;
}

export function orderAheadProducts(vendorId: number): VendorProduct[] {
  const catalog = ensureOrderAheadCatalog(vendorId);
  return catalog.filter((product) => product.is_active !== 0);
}

export function productLabel(product: {
  product_name: string;
  unit?: string | null;
}): string {
  const unit = product.unit?.trim();
  return unit ? `${product.product_name} — ${unit}` : product.product_name;
}
