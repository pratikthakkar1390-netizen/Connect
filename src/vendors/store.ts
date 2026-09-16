import { normalizePhone } from '../config.js';
import {
  getDb,
  VENDOR_CATEGORIES,
  VENDOR_STATUSES,
  type VendorCategory,
  type VendorStatus,
} from '../db/store.js';

export type { VendorCategory, VendorStatus };

export interface Vendor {
  id: number;
  whatsapp_phone: string;
  business_name: string | null;
  category: VendorCategory | null;
  contact_name: string | null;
  email: string | null;
  address: string | null;
  service_area: string | null;
  description: string | null;
  pricing: string | null;
  status: VendorStatus;
  created_at: string;
  updated_at: string;
}

export interface VendorProduct {
  id: number;
  vendor_id: number;
  product_name: string;
  category: string | null;
  description: string | null;
  price: string | null;
  unit: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface VendorAvailability {
  id: number;
  vendor_id: number;
  availability_text: string;
  created_at: string;
  updated_at: string;
}

export class DuplicateVendorError extends Error {
  constructor(readonly phone: string) {
    super('A vendor already exists for this WhatsApp number.');
    this.name = 'DuplicateVendorError';
  }
}

export function isVendorStatus(value: string): value is VendorStatus {
  return (VENDOR_STATUSES as readonly string[]).includes(value);
}

export function isVendorCategory(value: string): value is VendorCategory {
  return (VENDOR_CATEGORIES as readonly string[]).includes(value);
}

export function getVendorByWhatsAppPhone(phone: string): Vendor | undefined {
  return getDb()
    .prepare(`SELECT * FROM vendors WHERE whatsapp_phone = ? LIMIT 1`)
    .get(normalizePhone(phone)) as Vendor | undefined;
}

export function getVendorById(id: number): Vendor | undefined {
  return getDb()
    .prepare(`SELECT * FROM vendors WHERE id = ? LIMIT 1`)
    .get(id) as Vendor | undefined;
}

export function createVendor(input: {
  whatsappPhone: string;
  category?: VendorCategory | null;
  businessName?: string | null;
  contactName?: string | null;
  email?: string | null;
  address?: string | null;
  serviceArea?: string | null;
  description?: string | null;
  pricing?: string | null;
  status?: VendorStatus;
}): Vendor {
  const phone = normalizePhone(input.whatsappPhone);
  const existing = getVendorByWhatsAppPhone(phone);
  if (existing) {
    throw new DuplicateVendorError(phone);
  }
  return getDb()
    .prepare(
      `INSERT INTO vendors (
         whatsapp_phone, business_name, category, contact_name, email,
         address, service_area, description, pricing, status
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      phone,
      input.businessName?.trim() || null,
      input.category ?? null,
      input.contactName?.trim() || null,
      input.email?.trim() || null,
      input.address?.trim() || null,
      input.serviceArea?.trim() || null,
      input.description?.trim() || null,
      input.pricing?.trim() || null,
      input.status ?? 'DRAFT',
    ) as Vendor;
}

export function updateVendor(
  id: number,
  patch: {
    businessName?: string | null;
    category?: VendorCategory | null;
    contactName?: string | null;
    email?: string | null;
    address?: string | null;
    serviceArea?: string | null;
    description?: string | null;
    pricing?: string | null;
  },
): Vendor | undefined {
  const existing = getVendorById(id);
  if (!existing) {
    return undefined;
  }
  return getDb()
    .prepare(
      `UPDATE vendors SET
         business_name = ?,
         category = ?,
         contact_name = ?,
         email = ?,
         address = ?,
         service_area = ?,
         description = ?,
         pricing = ?,
         updated_at = datetime('now')
       WHERE id = ?
       RETURNING *`,
    )
    .get(
      patch.businessName !== undefined
        ? patch.businessName?.trim() || null
        : existing.business_name,
      patch.category !== undefined ? patch.category : existing.category,
      patch.contactName !== undefined
        ? patch.contactName?.trim() || null
        : existing.contact_name,
      patch.email !== undefined ? patch.email?.trim() || null : existing.email,
      patch.address !== undefined
        ? patch.address?.trim() || null
        : existing.address,
      patch.serviceArea !== undefined
        ? patch.serviceArea?.trim() || null
        : existing.service_area,
      patch.description !== undefined
        ? patch.description?.trim() || null
        : existing.description,
      patch.pricing !== undefined
        ? patch.pricing?.trim() || null
        : existing.pricing,
      id,
    ) as Vendor;
}

function registrationComplete(vendor: Vendor): boolean {
  return Boolean(
    vendor.category &&
      vendor.business_name?.trim() &&
      vendor.contact_name?.trim() &&
      vendor.email?.trim() &&
      vendor.address?.trim() &&
      vendor.service_area?.trim() &&
      vendor.description?.trim() &&
      vendor.pricing?.trim(),
  );
}

export function submitVendor(id: number): Vendor | undefined {
  const existing = getVendorById(id);
  if (!existing || !registrationComplete(existing)) {
    return undefined;
  }
  return getDb()
    .prepare(
      `UPDATE vendors
       SET status = 'UNDER_REVIEW', updated_at = datetime('now')
       WHERE id = ?
       RETURNING *`,
    )
    .get(id) as Vendor;
}

export function setVendorStatus(
  id: number,
  status: VendorStatus,
): Vendor | undefined {
  if (!isVendorStatus(status)) {
    return undefined;
  }
  return getDb()
    .prepare(
      `UPDATE vendors
       SET status = ?, updated_at = datetime('now')
       WHERE id = ?
       RETURNING *`,
    )
    .get(status, id) as Vendor | undefined;
}

export function getVendorProducts(vendorId: number): VendorProduct[] {
  return getDb()
    .prepare(
      `SELECT * FROM vendor_products
       WHERE vendor_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(vendorId) as VendorProduct[];
}

export function getVendorProductById(id: number): VendorProduct | undefined {
  return getDb()
    .prepare(`SELECT * FROM vendor_products WHERE id = ? LIMIT 1`)
    .get(id) as VendorProduct | undefined;
}

export function addVendorProduct(input: {
  vendorId: number;
  productName: string;
  category?: string | null;
  description?: string | null;
  price?: string | null;
  unit?: string | null;
}): VendorProduct {
  return getDb()
    .prepare(
      `INSERT INTO vendor_products (
         vendor_id, product_name, category, description, price, unit, is_active
       )
       VALUES (?, ?, ?, ?, ?, ?, 1)
       RETURNING *`,
    )
    .get(
      input.vendorId,
      input.productName.trim(),
      input.category?.trim() || null,
      input.description?.trim() || null,
      input.price?.trim() || null,
      input.unit?.trim() || null,
    ) as VendorProduct;
}

export function updateVendorProduct(
  id: number,
  patch: {
    productName?: string;
    description?: string | null;
    price?: string | null;
    unit?: string | null;
    isActive?: boolean;
  },
): VendorProduct | undefined {
  const existing = getVendorProductById(id);
  if (!existing) {
    return undefined;
  }
  return getDb()
    .prepare(
      `UPDATE vendor_products SET
         product_name = ?,
         description = ?,
         price = ?,
         unit = ?,
         is_active = ?,
         updated_at = datetime('now')
       WHERE id = ?
       RETURNING *`,
    )
    .get(
      patch.productName !== undefined
        ? patch.productName.trim()
        : existing.product_name,
      patch.description !== undefined
        ? patch.description?.trim() || null
        : existing.description,
      patch.price !== undefined ? patch.price?.trim() || null : existing.price,
      patch.unit !== undefined ? patch.unit?.trim() || null : existing.unit,
      patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : existing.is_active,
      id,
    ) as VendorProduct;
}

export function removeVendorProduct(id: number): boolean {
  const result = getDb()
    .prepare(`DELETE FROM vendor_products WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

export function getVendorAvailability(
  vendorId: number,
): VendorAvailability | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM vendor_availability WHERE vendor_id = ? LIMIT 1`,
    )
    .get(vendorId) as VendorAvailability | undefined;
}

export function setVendorAvailability(
  vendorId: number,
  availabilityText: string,
): VendorAvailability {
  const text = availabilityText.trim();
  return getDb()
    .prepare(
      `INSERT INTO vendor_availability (vendor_id, availability_text)
       VALUES (?, ?)
       ON CONFLICT(vendor_id) DO UPDATE SET
         availability_text = excluded.availability_text,
         updated_at = datetime('now')
       RETURNING *`,
    )
    .get(vendorId, text) as VendorAvailability;
}
