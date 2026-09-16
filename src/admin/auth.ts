import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const REALM = 'CONNECT Admin';

function adminPassword(): string {
  return (process.env.ADMIN_PASSWORD ?? '').trim();
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseBasicPassword(header: string | undefined): string | null {
  if (!header || !header.startsWith('Basic ')) {
    return null;
  }
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colonIndex = decoded.indexOf(':');
    return colonIndex >= 0 ? decoded.slice(colonIndex + 1) : decoded;
  } catch {
    return null;
  }
}

export function isAdminEnabled(): boolean {
  return adminPassword().length > 0;
}

function rejectAdmin(req: Request, res: Response): void {
  if (!isAdminEnabled()) {
    res.status(404).send('Not Found');
    return;
  }
  res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
  res.status(401).send('Unauthorized');
}

export function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isAdminEnabled()) {
    res.status(404).send('Not Found');
    return;
  }

  const password = parseBasicPassword(req.headers.authorization);
  if (!password || !timingSafeEqual(password, adminPassword())) {
    rejectAdmin(req, res);
    return;
  }

  next();
}
