import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';

export const EVENT_IMAGE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const EVENT_IMAGE_TARGET_WIDTH = 1600;
export const EVENT_IMAGE_TARGET_MAX_BYTES = 2 * 1024 * 1024;
export const EVENT_IMAGE_FILENAME_RE = /^[a-f0-9]{32}\.webp$/;

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type EventImageKind = 'jpeg' | 'png' | 'webp';

export class EventImageError extends Error {
  constructor(
    message: string,
    readonly code: 'too_large' | 'invalid_type' | 'optimize_failed',
  ) {
    super(message);
    this.name = 'EventImageError';
  }
}

export function eventImagesRoot(): string {
  const dbPath = config.databasePath.trim();
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) {
    return path.join(os.tmpdir(), 'connect-event-images');
  }
  return path.join(path.dirname(path.resolve(dbPath)), 'event-images');
}

export function isSafeEventImageFilename(filename: string): boolean {
  return EVENT_IMAGE_FILENAME_RE.test(filename);
}

export function eventImageFilePath(filename: string): string | null {
  if (!isSafeEventImageFilename(filename)) {
    return null;
  }
  const root = path.resolve(eventImagesRoot());
  const resolved = path.resolve(root, filename);
  if (resolved !== path.join(root, filename)) {
    return null;
  }
  return resolved;
}

export function detectEventImageKind(buffer: Buffer): EventImageKind | null {
  if (buffer.length >= JPEG_MAGIC.length && buffer.subarray(0, 3).equals(JPEG_MAGIC)) {
    return 'jpeg';
  }
  if (buffer.length >= PNG_MAGIC.length && buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    return 'png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export function newEventImageFilename(): string {
  return `${crypto.randomBytes(16).toString('hex')}.webp`;
}

export async function optimizeEventImage(buffer: Buffer): Promise<Buffer> {
  if (buffer.length > EVENT_IMAGE_MAX_UPLOAD_BYTES) {
    throw new EventImageError(
      'That image is larger than 20 MB. Please choose a smaller file.',
      'too_large',
    );
  }
  if (!detectEventImageKind(buffer)) {
    throw new EventImageError(
      'Please choose a JPG, JPEG, PNG, or WEBP image.',
      'invalid_type',
    );
  }

  try {
    const meta = await sharp(buffer, { failOn: 'error' }).metadata();
    const format = meta.format;
    if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
      throw new EventImageError(
        'Please choose a JPG, JPEG, PNG, or WEBP image.',
        'invalid_type',
      );
    }

    const resized = sharp(buffer, { failOn: 'error' }).rotate().resize({
      width: EVENT_IMAGE_TARGET_WIDTH,
      withoutEnlargement: true,
    });

    let quality = 82;
    let output = await resized.webp({ quality, effort: 4 }).toBuffer();
    if (output.length > EVENT_IMAGE_TARGET_MAX_BYTES) {
      quality = 72;
      output = await sharp(output).webp({ quality, effort: 4 }).toBuffer();
    }
    if (output.length > EVENT_IMAGE_TARGET_MAX_BYTES) {
      output = await sharp(output).webp({ quality: 62, effort: 4 }).toBuffer();
    }
    return output;
  } catch (error) {
    if (error instanceof EventImageError) {
      throw error;
    }
    throw new EventImageError(
      'Please choose a JPG, JPEG, PNG, or WEBP image.',
      'optimize_failed',
    );
  }
}

export async function saveOptimizedEventImage(buffer: Buffer): Promise<string> {
  const optimized = await optimizeEventImage(buffer);
  const filename = newEventImageFilename();
  const filePath = eventImageFilePath(filename);
  if (!filePath) {
    throw new EventImageError('Could not store that image.', 'optimize_failed');
  }
  fs.mkdirSync(eventImagesRoot(), { recursive: true });
  fs.writeFileSync(filePath, optimized);
  return filename;
}

export function readEventImageFile(filename: string): Buffer | null {
  const filePath = eventImageFilePath(filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath);
}

export function deleteEventImageFile(filename: string | null | undefined): void {
  if (!filename) {
    return;
  }
  const filePath = eventImageFilePath(filename);
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Missing draft files are fine.
  }
}

export function listStoredEventImageFilenames(): string[] {
  const root = eventImagesRoot();
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root).filter((name) => isSafeEventImageFilename(name));
}

export function deleteUnreferencedEventImageFiles(keep: Set<string>): string[] {
  const deleted: string[] = [];
  for (const filename of listStoredEventImageFilenames()) {
    if (keep.has(filename)) {
      continue;
    }
    deleteEventImageFile(filename);
    deleted.push(filename);
  }
  return deleted;
}

