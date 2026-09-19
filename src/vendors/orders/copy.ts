import { getEventTimezone } from '../../dates/eventDate.js';
import { formatCents } from './money.js';
import type { VendorOrder, VendorOrderItem, VendorOrderStatus } from './store.js';

export function formatPickupWhen(dateIso: string, time: string): string {
  const match = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return `${dateIso} ${time}`.trim();
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: getEventTimezone(),
  }).format(date);
  return `${weekday}\n${time}`;
}

export function formatOrderItems(items: Array<{ productName?: string; product_name_snapshot?: string; quantity: number }>): string {
  return items
    .map((item) => {
      const name = item.productName ?? item.product_name_snapshot ?? 'Item';
      return `${name} × ${item.quantity}`;
    })
    .join('\n');
}

export function statusLabel(status: VendorOrderStatus): string {
  switch (status) {
    case 'NEW':
      return '🆕 New';
    case 'ACCEPTED':
      return '✅ Accepted';
    case 'PREPARING':
      return '👨‍🍳 Preparing';
    case 'READY_FOR_PICKUP':
      return '🎉 Ready for Pickup';
    case 'PICKED_UP':
      return '✅ Picked Up';
    case 'CANCELLED':
      return '❌ Cancelled';
    default:
      return status;
  }
}

export function staleStatusMessage(order: VendorOrder): string {
  if (order.status === 'READY_FOR_PICKUP') {
    return `ℹ️ Order #${order.order_number} is already ready for pickup.`;
  }
  if (order.status === 'PICKED_UP') {
    return `ℹ️ Order #${order.order_number} has already been picked up.`;
  }
  if (order.status === 'CANCELLED') {
    return `ℹ️ Order #${order.order_number} has been cancelled.`;
  }
  return `ℹ️ Order #${order.order_number} is already ${statusLabel(order.status).replace(/^[^ ]+ /, '').toLowerCase()}.`;
}

export function customerOrderReceived(order: VendorOrder, items: VendorOrderItem[]): string {
  return [
    '✅ Order Received!',
    '',
    `Order #${order.order_number}`,
    '',
    'Your order:',
    formatOrderItems(items),
    '',
    'Pickup:',
    formatPickupWhen(order.pickup_date, order.pickup_time),
    '',
    `Total: ${formatCents(order.total_amount)}`,
    '',
    '💵 Payment: Pay at Counter',
    '',
    "We'll let you know when your order is ready.",
    '',
    'Thank you!',
  ].join('\n');
}

export function vendorNewOrderMessage(
  order: VendorOrder,
  items: VendorOrderItem[],
): string {
  return [
    '🛎️ New Pickup Order',
    '',
    `Order #${order.order_number}`,
    '',
    formatOrderItems(items),
    '',
    'Pickup:',
    formatPickupWhen(order.pickup_date, order.pickup_time),
    '',
    `Total: ${formatCents(order.total_amount)}`,
    '',
    '💵 Pay at Counter',
    '',
    'Customer:',
    order.customer_name?.trim() || 'Customer',
    order.customer_phone,
  ].join('\n');
}

export function customerAccepted(order: VendorOrder): string {
  return [
    '✅ Order Accepted!',
    '',
    `Order #${order.order_number} has been accepted.`,
    '',
    'Pickup:',
    formatPickupWhen(order.pickup_date, order.pickup_time),
    '',
    '💵 Payment: Pay at Counter',
    '',
    "We'll have your order ready for pickup.",
  ].join('\n');
}

export function customerPreparing(order: VendorOrder): string {
  return [
    '👨‍🍳 Your order is being prepared.',
    '',
    `Order #${order.order_number}`,
    '',
    'Pickup:',
    formatPickupWhen(order.pickup_date, order.pickup_time),
    '',
    "We'll let you know when it's ready.",
  ].join('\n');
}

export function customerReady(order: VendorOrder, address?: string | null): string {
  const lines = [
    '🎉 Your order is ready for pickup!',
    '',
    `Order #${order.order_number}`,
    '',
  ];
  const location = address?.trim();
  if (location) {
    lines.push('📍 Pickup:', location, '');
  }
  lines.push(
    '🕐 ' + formatPickupWhen(order.pickup_date, order.pickup_time).replace('\n', ' '),
    '',
    '💵 Payment: Pay at Counter',
    '',
    'Please pay at the counter when you pick up your order.',
  );
  return lines.join('\n');
}

export function customerPickedUp(order: VendorOrder): string {
  return [
    `✅ Order #${order.order_number}`,
    '',
    'Your order has been picked up.',
    '',
    'Thank you!',
  ].join('\n');
}

export function customerCancelled(order: VendorOrder): string {
  return [
    '❌ Order Cancelled',
    '',
    `We're sorry, but your order #${order.order_number} has been cancelled by the vendor.`,
    '',
    'Please contact the vendor if you have questions.',
  ].join('\n');
}

export function myOrderMessage(
  order: VendorOrder,
  items: VendorOrderItem[],
): string {
  if (order.status === 'PICKED_UP') {
    return [
      `📦 Order #${order.order_number}`,
      '',
      'Status:',
      '✅ Picked Up',
      '',
      'Thank you!',
    ].join('\n');
  }
  if (order.status === 'CANCELLED') {
    return [
      `📦 Order #${order.order_number}`,
      '',
      'Status:',
      '❌ Cancelled',
    ].join('\n');
  }
  return [
    '📦 Your Order',
    '',
    `Order #${order.order_number}`,
    '',
    formatOrderItems(items),
    '',
    'Pickup:',
    formatPickupWhen(order.pickup_date, order.pickup_time),
    '',
    'Status:',
    statusLabel(order.status),
    '',
    '💵 Pay at Counter',
  ].join('\n');
}
