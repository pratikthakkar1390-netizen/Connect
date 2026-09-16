import type { VendorCategory } from '../db/store.js';
import {
  truncateListText,
  WHATSAPP_LIST_ROW_TITLE_LIMIT,
} from '../whatsapp/eventList.js';

export interface VendorProductStarter {
  key: string;
  title: string;
  listTitle: string;
}

export const CATERING_PRODUCT_STARTERS: VendorProductStarter[] = [
  { key: 'full_catering', title: 'Full Catering', listTitle: 'Full Catering' },
  { key: 'party_trays', title: 'Party Trays', listTitle: 'Party Trays' },
  { key: 'samosas', title: 'Samosas', listTitle: 'Samosas' },
  { key: 'snacks', title: 'Snacks', listTitle: 'Snacks' },
  { key: 'custom_menu', title: 'Custom Menu', listTitle: 'Custom Menu' },
];

export const INDIAN_BAKERY_PRODUCT_STARTERS: VendorProductStarter[] = [
  { key: 'roti', title: 'Roti', listTitle: '🫓 Roti' },
  { key: 'plain_paratha', title: 'Plain Paratha', listTitle: '🫓 Plain Paratha' },
  {
    key: 'methi_paratha',
    title: 'Methi Paratha (Thepla)',
    listTitle: '🌿 Methi Paratha',
  },
  { key: 'cakes', title: 'Cakes', listTitle: '🎂 Cakes' },
  { key: 'pastries', title: 'Pastries', listTitle: '🍰 Pastries' },
  { key: 'indian_sweets', title: 'Indian Sweets', listTitle: '🍬 Indian Sweets' },
  { key: 'desserts', title: 'Desserts', listTitle: '🍮 Desserts' },
  { key: 'other', title: 'Other', listTitle: '📦 Other' },
];

export function productStartersForCategory(
  category: VendorCategory | null | undefined,
): VendorProductStarter[] {
  if (category === 'INDIAN_BAKERY') {
    return INDIAN_BAKERY_PRODUCT_STARTERS;
  }
  return CATERING_PRODUCT_STARTERS;
}

export function findProductStarter(
  category: VendorCategory | null | undefined,
  key: string,
): VendorProductStarter | undefined {
  return productStartersForCategory(category).find((item) => item.key === key);
}

export function starterListTitle(starter: VendorProductStarter): string {
  return truncateListText(starter.listTitle, WHATSAPP_LIST_ROW_TITLE_LIMIT);
}
