import { normalizePhone } from '../../config.js';
import { getDb } from '../../db/store.js';
import { getVendorProductById, type VendorProduct } from '../store.js';
import { parsePriceToCents } from './money.js';
import {
  formatPickupTimeInput,
  pickupValidationMessage,
  validateVendorPickup,
  vendorPickupNow,
} from './pickup.js';

export const PAY_AT_COUNTER = 'PAY_AT_COUNTER';

export const VENDOR_ORDER_STATUSES = [
  'NEW',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'CANCELLED',
] as const;

export type VendorOrderStatus = (typeof VENDOR_ORDER_STATUSES)[number];

export type VendorOrderCancelledBy = 'VENDOR' | 'CUSTOMER';

export interface VendorOrder {
  id: number;
  vendor_id: number;
  order_number: string;
  customer_phone: string;
  customer_name: string | null;
  pickup_date: string;
  pickup_time: string;
  payment_method: string;
  status: VendorOrderStatus;
  total_amount: number;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  preparing_at: string | null;
  ready_at: string | null;
  picked_up_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  vendor_notified_at: string | null;
}

export interface VendorOrderItem {
  id: number;
  order_id: number;
  vendor_product_id: number | null;
  product_name_snapshot: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  created_at: string;
}

export interface CartItem {
  productId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateOrderInput {
  vendorId: number;
  customerPhone: string;
  customerName?: string | null;
  pickupDate: string;
  pickupTime: string;
  items: CartItem[];
  now?: Date;
}

export type TransitionResult =
  | { ok: false; reason: 'not_found' }
  | { ok: true; order: VendorOrder; changed: boolean; stale?: boolean };

const ALLOWED_TRANSITIONS: Record<VendorOrderStatus, VendorOrderStatus[]> = {
  NEW: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['PICKED_UP'],
  PICKED_UP: [],
  CANCELLED: [],
};

const STATUS_TIMESTAMP: Partial<Record<VendorOrderStatus, string>> = {
  ACCEPTED: 'accepted_at',
  PREPARING: 'preparing_at',
  READY_FOR_PICKUP: 'ready_at',
  PICKED_UP: 'picked_up_at',
  CANCELLED: 'cancelled_at',
};

export function isVendorOrderStatus(value: string): value is VendorOrderStatus {
  return (VENDOR_ORDER_STATUSES as readonly string[]).includes(value);
}

export function cartLineTotal(item: CartItem): number {
  return item.unitPrice * item.quantity;
}

export function cartTotalCents(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + cartLineTotal(item), 0);
}

export function productToCartItem(
  product: VendorProduct,
  quantity: number,
): CartItem | { error: 'missing_price' | 'inactive' | 'invalid_quantity' } {
  if (product.is_active === 0) {
    return { error: 'inactive' };
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: 'invalid_quantity' };
  }
  const unitPrice = parsePriceToCents(product.price);
  if (unitPrice == null) {
    return { error: 'missing_price' };
  }
  return {
    productId: product.id,
    productName: product.unit?.trim()
      ? `${product.product_name} — ${product.unit}`
      : product.product_name,
    quantity,
    unitPrice,
  };
}

export function getVendorOrderById(id: number): VendorOrder | undefined {
  return getDb()
    .prepare(`SELECT * FROM vendor_orders WHERE id = ? LIMIT 1`)
    .get(id) as VendorOrder | undefined;
}

export function getVendorOrderByNumber(
  orderNumber: string,
): VendorOrder | undefined {
  return getDb()
    .prepare(`SELECT * FROM vendor_orders WHERE order_number = ? LIMIT 1`)
    .get(orderNumber.trim()) as VendorOrder | undefined;
}

export function listVendorOrderItems(orderId: number): VendorOrderItem[] {
  return getDb()
    .prepare(
      `SELECT * FROM vendor_order_items WHERE order_id = ? ORDER BY id ASC`,
    )
    .all(orderId) as VendorOrderItem[];
}

export function listVendorOrders(
  vendorId: number,
  status?: VendorOrderStatus | 'RECENT',
): VendorOrder[] {
  const database = getDb();
  if (!status || status === 'RECENT') {
    return database
      .prepare(
        `SELECT * FROM vendor_orders
         WHERE vendor_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 10`,
      )
      .all(vendorId) as VendorOrder[];
  }
  return database
    .prepare(
      `SELECT * FROM vendor_orders
       WHERE vendor_id = ? AND status = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 20`,
    )
    .all(vendorId, status) as VendorOrder[];
}

export function listUnnotifiedNewVendorOrders(vendorId: number): VendorOrder[] {
  return getDb()
    .prepare(
      `SELECT * FROM vendor_orders
       WHERE vendor_id = ?
         AND status = 'NEW'
         AND vendor_notified_at IS NULL
       ORDER BY created_at ASC, id ASC`,
    )
    .all(vendorId) as VendorOrder[];
}

export function markVendorOrderNotified(orderId: number): boolean {
  const updated = getDb()
    .prepare(
      `UPDATE vendor_orders
       SET vendor_notified_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND vendor_notified_at IS NULL
       RETURNING id`,
    )
    .get(orderId) as { id: number } | undefined;
  return Boolean(updated);
}

export function getLatestCustomerOrder(
  vendorId: number,
  customerPhone: string,
): VendorOrder | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM vendor_orders
       WHERE vendor_id = ? AND customer_phone = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(vendorId, normalizePhone(customerPhone)) as VendorOrder | undefined;
}

function nextOrderNumber(vendorId: number): string {
  const database = getDb();
  const row = database
    .prepare(
      `INSERT INTO vendor_order_sequences (vendor_id, next_number)
       VALUES (?, 1001)
       ON CONFLICT(vendor_id) DO UPDATE SET next_number = next_number + 1
       RETURNING next_number`,
    )
    .get(vendorId) as { next_number: number };
  return `RB-${row.next_number}`;
}

export function createVendorOrder(input: CreateOrderInput): VendorOrder {
  if (!input.items.length) {
    throw new Error('Order requires at least one item');
  }
  if (!input.pickupDate.trim() || !input.pickupTime.trim()) {
    throw new Error('Pickup date and time are required');
  }
  const pickupTime =
    formatPickupTimeInput(input.pickupTime) ?? input.pickupTime.trim();
  const pickupCheck = validateVendorPickup(
    input.pickupDate,
    pickupTime,
    input.now ?? vendorPickupNow(),
  );
  if (!pickupCheck.ok) {
    throw new Error(pickupValidationMessage(pickupCheck.reason));
  }
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new Error('Invalid quantity');
    }
    const product = getVendorProductById(item.productId);
    if (!product || product.vendor_id !== input.vendorId) {
      throw new Error('Invalid product');
    }
    const livePrice = parsePriceToCents(product.price);
    if (livePrice == null) {
      throw new Error('Product is missing a valid price');
    }
    if (livePrice !== item.unitPrice) {
      item.unitPrice = livePrice;
    }
    item.productName = product.unit?.trim()
      ? `${product.product_name} — ${product.unit}`
      : product.product_name;
  }
  const total = cartTotalCents(input.items);
  const database = getDb();
  return database.transaction(() => {
    let order: VendorOrder | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const orderNumber = nextOrderNumber(input.vendorId);
      try {
        order = database
          .prepare(
            `INSERT INTO vendor_orders (
               vendor_id, order_number, customer_phone, customer_name,
               pickup_date, pickup_time, payment_method, status, total_amount
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, 'NEW', ?)
             RETURNING *`,
          )
          .get(
            input.vendorId,
            orderNumber,
            normalizePhone(input.customerPhone),
            input.customerName?.trim() || null,
            input.pickupDate.trim(),
            pickupTime,
            PAY_AT_COUNTER,
            total,
          ) as VendorOrder;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!message.includes('UNIQUE')) {
          throw error;
        }
      }
    }
    if (!order) {
      throw new Error('Could not allocate a unique order number');
    }
    const insertItem = database.prepare(
      `INSERT INTO vendor_order_items (
         order_id, vendor_product_id, product_name_snapshot,
         quantity, unit_price, line_total
       )
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of input.items) {
      insertItem.run(
        order.id,
        item.productId,
        item.productName,
        item.quantity,
        item.unitPrice,
        cartLineTotal(item),
      );
    }
    return order;
  })();
}

export function transitionVendorOrder(
  orderId: number,
  next: VendorOrderStatus,
  options: { cancelledBy?: VendorOrderCancelledBy } = {},
): TransitionResult {
  const existing = getVendorOrderById(orderId);
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }
  if (existing.status === next) {
    return { ok: true, order: existing, changed: false, stale: true };
  }
  if (!ALLOWED_TRANSITIONS[existing.status].includes(next)) {
    return { ok: true, order: existing, changed: false, stale: true };
  }
  const timestampColumn = STATUS_TIMESTAMP[next];
  const cancelledBy =
    next === 'CANCELLED' ? (options.cancelledBy ?? 'VENDOR') : null;
  const assignments = [
    `status = ?`,
    `updated_at = datetime('now')`,
    timestampColumn ? `${timestampColumn} = datetime('now')` : null,
    next === 'CANCELLED' ? `cancelled_by = ?` : null,
  ].filter(Boolean);
  const params: Array<string | number> = [next];
  if (next === 'CANCELLED') {
    params.push(cancelledBy as string);
  }
  params.push(orderId);
  const updated = getDb()
    .prepare(
      `UPDATE vendor_orders
       SET ${assignments.join(', ')}
       WHERE id = ? AND status = ?
       RETURNING *`,
    )
    .get(...params, existing.status) as VendorOrder | undefined;
  if (!updated) {
    const current = getVendorOrderById(orderId);
    if (!current) {
      return { ok: false, reason: 'not_found' };
    }
    return { ok: true, order: current, changed: false, stale: true };
  }
  return { ok: true, order: updated, changed: true };
}
