import fs from 'node:fs';
import path from 'node:path';
import { config, isReminderSendingEnabled } from '../config.js';
import { findEventByRsvpCode, getDb } from '../db/store.js';
import { eventImagesRoot } from '../events/image.js';
import { isReminderSchedulerStarted } from '../reminders/scheduler.js';

export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unmonitored';
export type OverallHealth = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheck {
  id: string;
  label: string;
  state: HealthState;
  detail: string;
  critical: boolean;
}

export interface AdminHealth {
  overall: OverallHealth;
  overallLabel: string;
  checks: HealthCheck[];
}

function envSet(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function checkDatabase(): HealthCheck {
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get() as { ok: number };
    if (row?.ok !== 1) {
      return {
        id: 'database',
        label: 'Database',
        state: 'unhealthy',
        detail: 'Database query did not return a successful result.',
        critical: true,
      };
    }
    return {
      id: 'database',
      label: 'Database',
      state: 'healthy',
      detail: 'SQLite responded to a live query.',
      critical: true,
    };
  } catch (error) {
    return {
      id: 'database',
      label: 'Database',
      state: 'unhealthy',
      detail:
        error instanceof Error
          ? 'Database is not reachable.'
          : 'Database is not reachable.',
      critical: true,
    };
  }
}

function checkWebApp(): HealthCheck {
  return {
    id: 'web',
    label: 'Web application',
    state: 'healthy',
    detail: 'Admin process is serving requests.',
    critical: true,
  };
}

function checkZernio(): HealthCheck {
  const configured =
    envSet('ZERNIO_API_KEY') &&
    envSet('ZERNIO_PROFILE_ID') &&
    envSet('ZERNIO_WHATSAPP_ACCOUNT_ID');
  if (!configured) {
    return {
      id: 'zernio',
      label: 'WhatsApp / Zernio',
      state: 'unhealthy',
      detail: 'Required WhatsApp API credentials are not configured.',
      critical: true,
    };
  }
  return {
    id: 'zernio',
    label: 'WhatsApp / Zernio',
    state: 'healthy',
    detail:
      'API credentials are configured. Live WhatsApp delivery is not pinged.',
    critical: true,
  };
}

function checkReminders(): HealthCheck {
  if (!isReminderSendingEnabled()) {
    return {
      id: 'reminders',
      label: 'Reminder scheduler',
      state: 'unmonitored',
      detail: 'RSVP reminders are not configured, so the scheduler is not monitored.',
      critical: false,
    };
  }
  if (!isReminderSchedulerStarted()) {
    return {
      id: 'reminders',
      label: 'Reminder scheduler',
      state: 'unmonitored',
      detail:
        'Reminder sending is configured, but this process has not started the scheduler.',
      critical: false,
    };
  }
  return {
    id: 'reminders',
    label: 'Reminder scheduler',
    state: 'healthy',
    detail: 'Reminder scheduler was started in this process.',
    critical: false,
  };
}

function checkWebRsvp(): HealthCheck {
  try {
    findEventByRsvpCode('__admin_health_probe__');
    return {
      id: 'web-rsvp',
      label: 'Web RSVP',
      state: 'healthy',
      detail: 'RSVP code lookup succeeded.',
      critical: true,
    };
  } catch {
    return {
      id: 'web-rsvp',
      label: 'Web RSVP',
      state: 'unhealthy',
      detail: 'RSVP code lookup failed.',
      critical: true,
    };
  }
}

function checkImageStorage(): HealthCheck {
  try {
    const root = eventImagesRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    return {
      id: 'images',
      label: 'Event image storage',
      state: 'healthy',
      detail: 'Event image directory is writable.',
      critical: true,
    };
  } catch {
    return {
      id: 'images',
      label: 'Event image storage',
      state: 'unhealthy',
      detail: 'Event image directory is not writable.',
      critical: true,
    };
  }
}

function checkPersistentStorage(): HealthCheck {
  const dbPath = (process.env.DATABASE_PATH ?? config.databasePath).trim();
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) {
    return {
      id: 'volume',
      label: 'Persistent storage',
      state: 'unmonitored',
      detail: 'This process is using an in-memory database.',
      critical: false,
    };
  }
  try {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return {
      id: 'volume',
      label: 'Persistent storage',
      state: 'healthy',
      detail: 'Database directory is writable.',
      critical: true,
    };
  } catch {
    return {
      id: 'volume',
      label: 'Persistent storage',
      state: 'unhealthy',
      detail: 'Database directory is not writable.',
      critical: true,
    };
  }
}

function railwayCheck(): HealthCheck {
  return {
    id: 'railway',
    label: 'Railway',
    state: 'unmonitored',
    detail: 'Railway platform status is not queried from the application.',
    critical: false,
  };
}

export function overallLabel(overall: OverallHealth): string {
  if (overall === 'healthy') {
    return 'All Systems Operational';
  }
  if (overall === 'degraded') {
    return 'Attention Needed';
  }
  return 'Action Required';
}

export function computeOverall(checks: HealthCheck[]): OverallHealth {
  const monitoredCritical = checks.filter(
    (check) => check.critical && check.state !== 'unmonitored',
  );
  if (monitoredCritical.some((check) => check.state === 'unhealthy')) {
    return 'unhealthy';
  }
  if (monitoredCritical.some((check) => check.state === 'degraded')) {
    return 'degraded';
  }
  return 'healthy';
}

export function getAdminHealth(): AdminHealth {
  const checks = [
    checkDatabase(),
    checkWebApp(),
    checkZernio(),
    checkReminders(),
    checkWebRsvp(),
    checkImageStorage(),
    checkPersistentStorage(),
    railwayCheck(),
  ];
  const overall = computeOverall(checks);
  return {
    overall,
    overallLabel: overallLabel(overall),
    checks,
  };
}
