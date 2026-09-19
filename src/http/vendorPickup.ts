import { Router, type Request, type Response } from 'express';
import express from 'express';
import { getVendorById } from '../vendors/store.js';
import { applyPickedVendorPickup } from '../vendors/orders/flow.js';
import {
  formatPickupTime,
  minSelectablePickupDate,
  pickupValidationMessage,
  validateVendorPickup,
  validateVendorPickupDate,
} from '../vendors/orders/pickup.js';
import {
  renderInvalidVendorPickupPage,
  renderVendorPickupDatePage,
  renderVendorPickupDonePage,
  renderVendorPickupTimePage,
} from './vendorPickupPage.js';
import { verifyVendorPickupToken } from './vendorPickupToken.js';

export const vendorPickupRouter = Router();

vendorPickupRouter.use(express.urlencoded({ extended: false }));

function formScalar(value: unknown): string {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

function sendInvalid(res: Response): void {
  res.status(404).type('html').send(renderInvalidVendorPickupPage());
}

function datePage(res: Response, status: number, extra: { dateValue?: string; error?: string }): void {
  res.status(status).type('html').send(
    renderVendorPickupDatePage({
      minDate: minSelectablePickupDate(),
      ...extra,
    }),
  );
}

function pickedTime(hour: string, minute: string, meridiem: string): string | null {
  const hourNum = Number(hour);
  const minuteNum = Number(minute);
  const mer = meridiem.trim().toUpperCase();
  if (
    !Number.isInteger(hourNum) ||
    hourNum < 1 ||
    hourNum > 12 ||
    !Number.isInteger(minuteNum) ||
    minuteNum < 0 ||
    minuteNum > 59 ||
    (mer !== 'AM' && mer !== 'PM')
  ) {
    return null;
  }
  const hour24 =
    mer === 'AM' ? (hourNum === 12 ? 0 : hourNum) : hourNum === 12 ? 12 : hourNum + 12;
  return formatPickupTime(hour24, minuteNum);
}

function handleGet(req: Request, res: Response): void {
  const payload = verifyVendorPickupToken(String(req.params.token ?? ''));
  if (!payload || !getVendorById(payload.vendorId)) {
    sendInvalid(res);
    return;
  }
  const date = formScalar(req.query?.date);
  if (date) {
    const dateCheck = validateVendorPickupDate(date);
    if (dateCheck.ok) {
      res.type('html').send(renderVendorPickupTimePage({ dateValue: date }));
      return;
    }
    datePage(res, 400, {
      dateValue: date,
      error: pickupValidationMessage(dateCheck.reason),
    });
    return;
  }
  datePage(res, 200, {});
}

async function handlePost(req: Request, res: Response): Promise<void> {
  const payload = verifyVendorPickupToken(String(req.params.token ?? ''));
  const vendor = payload ? getVendorById(payload.vendorId) : undefined;
  if (!payload || !vendor) {
    sendInvalid(res);
    return;
  }
  const step = formScalar(req.body?.step) || 'date';
  const date = formScalar(req.body?.date);
  if (step !== 'time') {
    const dateCheck = validateVendorPickupDate(date);
    if (!dateCheck.ok) {
      datePage(res, 400, {
        dateValue: date,
        error: pickupValidationMessage(dateCheck.reason),
      });
      return;
    }
    res.type('html').send(renderVendorPickupTimePage({ dateValue: date }));
    return;
  }
  const time =
    pickedTime(
      formScalar(req.body?.hour),
      formScalar(req.body?.minute),
      formScalar(req.body?.meridiem) || 'PM',
    ) ?? formScalar(req.body?.time);
  const pickupCheck = validateVendorPickup(date, time);
  if (!pickupCheck.ok) {
    res.status(400).type('html').send(
      renderVendorPickupTimePage({
        dateValue: date,
        hour: formScalar(req.body?.hour),
        minute: formScalar(req.body?.minute),
        error: pickupValidationMessage(pickupCheck.reason),
      }),
    );
    return;
  }
  const applied = await applyPickedVendorPickup(
    payload.phone,
    payload.accountId,
    vendor,
    date,
    time,
  );
  if (!applied.ok) {
    res.status(400).type('html').send(
      renderVendorPickupTimePage({
        dateValue: date,
        error: applied.error,
      }),
    );
    return;
  }
  res.type('html').send(renderVendorPickupDonePage());
}

vendorPickupRouter.get('/pickup/:token', handleGet);
vendorPickupRouter.post('/pickup/:token', (req, res) => {
  void handlePost(req, res);
});
