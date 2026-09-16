import { Router, type Request, type Response } from 'express';
import express from 'express';
import {
  findInvitationRecipient,
  getEffectiveAdultCount,
  getEffectiveChildCount,
  getGuestName,
  getGuestWhatsAppPhone,
  isEventCancelled,
  isRsvpDeadlinePassed,
  lookupShortRsvpTarget,
  setGuestWhatsAppPhone,
  type Event,
  type Invitation,
  type RsvpStatus,
} from '../db/store.js';
import { ensureWebGuestPhone } from './webGuest.js';
import {
  renderCancelledRsvpPage,
  renderClosedRsvpPage,
  renderInvalidRsvpPage,
  renderRsvpPage,
  renderSuccessPage,
} from './rsvpPage.js';
import {
  currentWebRsvp,
  isIndividualWebRsvp,
  isSavedWebGuestName,
  normalizeWebGuestName,
  recordWebRsvp,
  webGuestNameError,
  webGuestPhoneError,
} from '../rsvp/webRsvp.js';
import { parseGuestWhatsAppNumber } from '../config.js';
import {
  CONNECT_VCARD_FILENAME,
  CONNECT_VCARD_PATH,
  buildConnectVCard,
} from '../commands/saveContact.js';
export const shortRsvpRouter = Router();

shortRsvpRouter.use(express.urlencoded({ extended: false }));

/** urlencoded { extended: false } turns duplicate keys into string[]. */
function formScalar(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function parseStatus(value: unknown): RsvpStatus | null {
  const raw = formScalar(value);
  if (raw === 'yes' || raw === 'no' || raw === 'maybe') {
    return raw;
  }
  return null;
}

function wantsCountForm(req: Request, childrenAllowed: boolean): boolean {
  const status = parseStatus(req.body?.response);
  if (status !== 'yes') {
    return false;
  }
  const adults = String(req.body?.adults ?? '').trim();
  const children = String(req.body?.children ?? '').trim();
  if (!adults) {
    return true;
  }
  if (childrenAllowed && req.body?.children == null) {
    return true;
  }
  return false;
}

function formDefaults(
  event: Event,
  invitation: Invitation | null,
  phone: string,
  body?: { adults?: string; children?: string },
) {
  const current = currentWebRsvp(event.id, phone);
  const adults = body?.adults
    ? Number.parseInt(body.adults, 10)
    : current
      ? Math.max(getEffectiveAdultCount(current), 1)
      : 1;
  const children = body?.children
    ? Number.parseInt(body.children, 10)
    : current
      ? getEffectiveChildCount(current)
      : 0;
  return {
    current,
    adults: Number.isFinite(adults) && adults >= 1 ? adults : 1,
    children: Number.isFinite(children) && children >= 0 ? children : 0,
    maxGuests:
      invitation?.type === 'family' && invitation.max_guests != null
        ? invitation.max_guests
        : null,
    childrenAllowed: event.children_allowed === 1,
    isFamily: invitation?.type === 'family',
  };
}

function sendInvalid(res: Response): void {
  res.status(404).type('html').send(renderInvalidRsvpPage());
}

function sendClosed(res: Response, eventName?: string): void {
  res.status(410).type('html').send(renderClosedRsvpPage(eventName));
}

function sendCancelled(res: Response, eventName?: string): void {
  res.status(410).type('html').send(renderCancelledRsvpPage(eventName));
}

function resolveTarget(code: string) {
  const trimmed = code.trim();
  return trimmed ? lookupShortRsvpTarget(trimmed) : undefined;
}

/**
 * Cookie tracks the browser.
 * Family RSVPs still attach to the original WhatsApp phone when one exists.
 * Individual reusable links always use the cookie web:uuid — never a shared
 * invitation phone. The Individual invitation_id is still stored as the source.
 */
function resolveStoragePhone(
  event: Event,
  invitation: Invitation | null,
  cookiePhone: string,
): string {
  if (invitation?.type !== 'family') {
    return cookiePhone;
  }
  return (
    findInvitationRecipient(event.id, invitation, event.organizer_phone)?.phone ??
    cookiePhone
  );
}

shortRsvpRouter.get(CONNECT_VCARD_PATH, (_req, res) => {
  const vcard = buildConnectVCard();
  if (!vcard) {
    res.status(404).type('text').send('CONNECT contact is not available.');
    return;
  }
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${CONNECT_VCARD_FILENAME}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/vcard').send(vcard);
});

shortRsvpRouter.get('/r/:code', (req, res) => {
  const code = String(req.params.code ?? '');
  const target = resolveTarget(code);
  if (!target) {
    sendInvalid(res);
    return;
  }

  const { event, invitation } = target;
  if (isEventCancelled(event)) {
    sendCancelled(res, event.name);
    return;
  }
  if (isRsvpDeadlinePassed(event.rsvp_deadline, { eventDate: event.date })) {
    sendClosed(res, event.name);
    return;
  }

  const cookiePhone = ensureWebGuestPhone(req, res, code);
  const phone = resolveStoragePhone(event, invitation, cookiePhone);
  const defaults = formDefaults(event, invitation, phone);
  res.type('html').send(
    renderRsvpPage(event, {
      ...defaults,
      askCounts: defaults.current?.status === 'yes',
    }),
  );
});

shortRsvpRouter.post('/r/:code', (req, res) => {
  const code = String(req.params.code ?? '');
  const target = resolveTarget(code);
  if (!target) {
    sendInvalid(res);
    return;
  }

  const { event, invitation } = target;
  if (isEventCancelled(event)) {
    sendCancelled(res, event.name);
    return;
  }
  if (isRsvpDeadlinePassed(event.rsvp_deadline, { eventDate: event.date })) {
    sendClosed(res, event.name);
    return;
  }

  const cookiePhone = ensureWebGuestPhone(req, res, code);
  const phone = resolveStoragePhone(event, invitation, cookiePhone);
  const status = parseStatus(req.body?.response);
  const defaults = formDefaults(event, invitation, phone, {
    adults: req.body?.adults,
    children: req.body?.children,
  });

  if (!status) {
    res.status(400).type('html').send(
      renderRsvpPage(event, {
        ...defaults,
        askCounts: false,
        error: 'Please choose Yes, No, or Maybe.',
      }),
    );
    return;
  }

  const storedName = getGuestName(event.id, phone);
  const submittedName = normalizeWebGuestName(req.body?.name);
  const guestName =
    submittedName ?? (isSavedWebGuestName(storedName) ? storedName!.trim() : null);
  const nameFieldPresent = Object.prototype.hasOwnProperty.call(
    req.body ?? {},
    'name',
  );

  if (!guestName) {
    res.status(nameFieldPresent ? 400 : 200).type('html').send(
      renderRsvpPage(event, {
        ...defaults,
        askCounts: false,
        askName: true,
        selectedStatus: status,
        guestName: typeof req.body?.name === 'string' ? req.body.name : '',
        error: nameFieldPresent ? webGuestNameError(req.body?.name) : undefined,
      }),
    );
    return;
  }

  let notifyPhone: string | undefined;
  if (isIndividualWebRsvp(invitation)) {
    const storedWhatsApp = getGuestWhatsAppPhone(event.id, cookiePhone);
    const submittedWhatsApp = parseGuestWhatsAppNumber(formScalar(req.body?.whatsapp));
    const whatsappFieldPresent = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      'whatsapp',
    );
    const resolvedWhatsApp = submittedWhatsApp ?? storedWhatsApp;
    if (!resolvedWhatsApp) {
      res.status(whatsappFieldPresent ? 400 : 200).type('html').send(
        renderRsvpPage(event, {
          ...defaults,
          askCounts: false,
          askWhatsApp: true,
          selectedStatus: status,
          guestName,
          error: whatsappFieldPresent ? webGuestPhoneError('invalid') : undefined,
        }),
      );
      return;
    }
    const saved = setGuestWhatsAppPhone(
      event.id,
      cookiePhone,
      resolvedWhatsApp,
      event.organizer_phone,
    );
    if (!saved.ok) {
      res.status(400).type('html').send(
        renderRsvpPage(event, {
          ...defaults,
          askCounts: false,
          askWhatsApp: true,
          selectedStatus: status,
          guestName,
          error: webGuestPhoneError(saved.reason),
        }),
      );
      return;
    }
    notifyPhone = saved.phone;
  }

  if (status === 'yes' && wantsCountForm(req, defaults.childrenAllowed)) {
    res.type('html').send(
      renderRsvpPage(event, {
        ...defaults,
        askCounts: true,
        selectedStatus: status,
        guestName,
      }),
    );
    return;
  }

  const recorded = recordWebRsvp({
    event,
    invitation,
    phone: cookiePhone,
    status,
    adultsRaw: req.body?.adults,
    childrenRaw: req.body?.children,
    guestName,
    whatsapp: notifyPhone,
  });

  if (!recorded.ok) {
    if (recorded.reason === 'name') {
      res.status(400).type('html').send(
        renderRsvpPage(event, {
          ...defaults,
          askCounts: false,
          askName: true,
          selectedStatus: status,
          guestName: typeof req.body?.name === 'string' ? req.body.name : '',
          error: recorded.message,
        }),
      );
      return;
    }
    if (recorded.reason === 'phone') {
      res.status(400).type('html').send(
        renderRsvpPage(event, {
          ...defaults,
          askCounts: false,
          askWhatsApp: true,
          selectedStatus: status,
          guestName,
          error: recorded.message,
        }),
      );
      return;
    }
    if (recorded.reason === 'limit') {
      res.status(400).type('html').send(
        renderRsvpPage(event, {
          ...defaults,
          askCounts: true,
          selectedStatus: status,
          guestName,
          error: recorded.message,
        }),
      );
      return;
    }
    res.status(400).type('html').send(
      renderRsvpPage(event, {
        ...defaults,
        askCounts: status === 'yes',
        selectedStatus: status,
        guestName,
        error: 'Please enter how many people will attend.',
      }),
    );
    return;
  }

  res.type('html').send(renderSuccessPage(guestName));
});
