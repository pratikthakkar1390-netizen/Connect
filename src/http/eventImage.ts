import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { applyAcceptedEventImage } from '../commands/createEventFlow.js';
import {
  editedEventNotifyButtons,
  persistEditedEventDraft,
} from '../commands/eventUpdateFlow.js';
import { formatEditedEventReview } from '../commands/eventUpdateMessage.js';
import {
  EVENT_IMAGE_MAX_UPLOAD_BYTES,
  EventImageError,
  readEventImageFile,
  saveOptimizedEventImage,
} from '../events/image.js';
import {
  getConversationState,
  getMessageSession,
  lookupEventWhenTokenByShortCode,
  lookupRsvpLinkTarget,
  setConversationState,
} from '../db/store.js';
import { sendInboxMessage, type InboxSendFn, type SendMessageParams } from '../zernio/client.js';
import {
  renderEventImageDonePage,
  renderEventImagePage,
  renderInvalidEventImagePage,
} from './eventImagePage.js';
import { verifyEventImageToken, type EventImagePayload } from './eventImageToken.js';

export const eventImageRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: EVENT_IMAGE_MAX_UPLOAD_BYTES, files: 1 },
});

let messageSender: InboxSendFn | null = null;

export function setEventImageMessageSender(
  sender?: InboxSendFn,
): void {
  messageSender = sender ?? null;
}

function sendMessage(params: SendMessageParams): Promise<unknown> {
  return (messageSender ?? sendInboxMessage)(params);
}

function formScalar(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0].trim();
  }
  return '';
}

function resolvePayload(req: Request): EventImagePayload | null {
  const raw = String(req.params.code ?? req.params.token ?? '').trim();
  if (!raw) {
    return null;
  }
  const fromShort = lookupEventWhenTokenByShortCode(raw);
  const token = fromShort ?? raw;
  return verifyEventImageToken(token);
}

function imageSession(phone: string): 'create' | 'edit' | null {
  const state = getConversationState(phone)?.state;
  if (state === 'WAITING_FOR_EVENT_IMAGE') {
    return 'create';
  }
  if (state === 'WAITING_FOR_EDIT_IMAGE') {
    return 'edit';
  }
  return null;
}

function sendInvalid(res: Response): void {
  res.status(404).type('html').send(renderInvalidEventImagePage());
}

async function notifyWhatsApp(
  phone: string,
  message: string,
  extras: {
    list?: SendMessageParams['list'];
    buttons?: Array<{ title: string; payload: string }>;
  } = {},
): Promise<void> {
  const session = getMessageSession(phone);
  if (!session) {
    return;
  }
  try {
    await sendMessage({
      conversationId: session.conversation_id,
      accountId: session.account_id,
      message,
      list: extras.list,
      buttons: extras.buttons,
    });
  } catch (error) {
    console.warn(
      `event image: failed to send WhatsApp follow-up for ${phone}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

function renderUploadPage(
  res: Response,
  req: Request,
  phone: string,
  extras: { error?: string } = {},
): void {
  const mode = imageSession(phone);
  if (!mode) {
    sendInvalid(res);
    return;
  }
  const state = getConversationState(phone);
  const code = encodeURIComponent(String(req.params.code ?? ''));
  res.type('html').send(
    renderEventImagePage({
      eventName: state?.name,
      previewSrc: state?.image_filename ? `/p/${code}/preview` : null,
      error: extras.error,
      mode,
    }),
  );
}

function handleMulter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  upload.single('image')(req, res, (err: unknown) => {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'LIMIT_FILE_SIZE'
    ) {
      const payload = resolvePayload(req);
      if (!payload || !imageSession(payload.phone)) {
        sendInvalid(res);
        return;
      }
      renderUploadPage(res, req, payload.phone, {
        error: 'That image is larger than 20 MB. Please choose a smaller file.',
      });
      return;
    }
    if (err) {
      const payload = resolvePayload(req);
      if (payload && imageSession(payload.phone)) {
        renderUploadPage(res, req, payload.phone, {
          error: 'Please choose a JPG, JPEG, PNG, or WEBP image.',
        });
        return;
      }
      sendInvalid(res);
      return;
    }
    next();
  });
}

eventImageRouter.get('/i/:token', (req, res) => {
  const target = lookupRsvpLinkTarget(String(req.params.token ?? ''));
  if (!target?.event.image_filename) {
    res.status(404).end();
    return;
  }
  const body = readEventImageFile(target.event.image_filename);
  if (!body) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(body);
});

eventImageRouter.get('/p/:code/preview', (req, res) => {
  const payload = resolvePayload(req);
  if (!payload || !imageSession(payload.phone)) {
    res.status(404).end();
    return;
  }
  const filename = getConversationState(payload.phone)?.image_filename;
  const body = filename ? readEventImageFile(filename) : null;
  if (!body) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(body);
});

eventImageRouter.get('/p/:code', (req, res) => {
  const payload = resolvePayload(req);
  if (!payload) {
    sendInvalid(res);
    return;
  }
  renderUploadPage(res, req, payload.phone);
});

eventImageRouter.get('/photo/:token', (req, res) => {
  const payload = verifyEventImageToken(String(req.params.token ?? ''));
  if (!payload) {
    sendInvalid(res);
    return;
  }
  renderUploadPage(res, req, payload.phone);
});

eventImageRouter.post('/p/:code', handleMulter, (req, res) => {
  void handleUploadPost(req, res);
});

async function finishEditImage(phone: string, res: Response): Promise<void> {
  const saved = persistEditedEventDraft(phone);
  if (!saved) {
    sendInvalid(res);
    return;
  }
  await notifyWhatsApp(phone, formatEditedEventReview(saved), {
    buttons: editedEventNotifyButtons(saved.id),
  });
  res.type('html').send(renderEventImageDonePage(true));
}

async function handleUploadPost(req: Request, res: Response): Promise<void> {
  const payload = resolvePayload(req);
  const mode = payload ? imageSession(payload.phone) : null;
  if (!payload || !mode) {
    sendInvalid(res);
    return;
  }

  const action = formScalar(req.body?.action);
  if (mode === 'create' && action === 'skip') {
    const next = applyAcceptedEventImage(payload.phone, null);
    await notifyWhatsApp(payload.phone, next.message, { list: next.list });
    res.type('html').send(renderEventImageDonePage());
    return;
  }
  if (mode === 'edit' && action === 'keep') {
    await finishEditImage(payload.phone, res);
    return;
  }
  if (mode === 'edit' && action === 'remove') {
    setConversationState(payload.phone, 'WAITING_FOR_EDIT_IMAGE', {
      image_filename: null,
    });
    await finishEditImage(payload.phone, res);
    return;
  }

  const file = req.file;
  if (file?.buffer?.length) {
    try {
      const filename = await saveOptimizedEventImage(file.buffer);
      setConversationState(
        payload.phone,
        mode === 'edit' ? 'WAITING_FOR_EDIT_IMAGE' : 'WAITING_FOR_EVENT_IMAGE',
        { image_filename: filename },
      );
    } catch (error) {
      const message =
        error instanceof EventImageError
          ? error.message
          : 'Please choose a JPG, JPEG, PNG, or WEBP image.';
      renderUploadPage(res, req, payload.phone, { error: message });
      return;
    }
  }

  if (mode === 'edit') {
    if (file?.buffer?.length) {
      await finishEditImage(payload.phone, res);
      return;
    }
    renderUploadPage(res, req, payload.phone, {
      error: 'Please choose a new photo, or keep or remove the current one.',
    });
    return;
  }

  const stored = getConversationState(payload.phone)?.image_filename;
  if (!stored) {
    renderUploadPage(res, req, payload.phone, {
      error: 'Please choose a photo, or tap Skip.',
    });
    return;
  }

  const next = applyAcceptedEventImage(payload.phone, stored);
  await notifyWhatsApp(payload.phone, next.message, { list: next.list });
  res.type('html').send(renderEventImageDonePage());
}
