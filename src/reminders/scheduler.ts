import { buildRsvpWhatsAppLink, isReminderSendingEnabled } from '../config.js';
import { ORGANIZER_POST_EVENT_MESSAGE } from '../commands/saveContact.js';
import { isCalendarDayAfterEvent } from '../dates/eventDate.js';
import {
  getMessageSession,
  getPendingGuestPhonesForEvent,
  listEventsPendingOrganizerPostEvent,
  listEventsWithReminderConfigured,
  markOrganizerPostEventSent,
  markReminderSent,
  type Event,
} from '../db/store.js';
import { sendInboxMessage, sendReminderBroadcast } from '../zernio/client.js';
import { isReminderDue } from './targeting.js';

const INTERVAL_MS = 15 * 60 * 1000;

let reminderSchedulerStarted = false;

export function isReminderSchedulerStarted(): boolean {
  return reminderSchedulerStarted;
}

export function startReminderScheduler(): void {
  reminderSchedulerStarted = true;
  console.log(
    'Scheduler active — checking every 15 minutes for RSVP reminders and post-event messages',
  );
  void runReminderTick();
  setInterval(() => {
    void runReminderTick();
  }, INTERVAL_MS);
}

export function shouldSendOrganizerPostEvent(
  event: Event,
  nowMs: number,
): boolean {
  if (event.organizer_post_event_sent_at) {
    return false;
  }
  return isCalendarDayAfterEvent(event.date, nowMs);
}

export async function runOrganizerPostEventTick(
  nowMs = Date.now(),
): Promise<void> {
  const events = listEventsPendingOrganizerPostEvent();

  for (const event of events) {
    if (!shouldSendOrganizerPostEvent(event, nowMs)) {
      continue;
    }

    const session = getMessageSession(event.organizer_phone);
    if (!session) {
      continue;
    }

    const claimed = markOrganizerPostEventSent(event.id);
    if (!claimed) {
      continue;
    }

    try {
      await sendInboxMessage({
        conversationId: session.conversation_id,
        accountId: session.account_id,
        message: ORGANIZER_POST_EVENT_MESSAGE,
      });
      console.log(
        `Organizer post-event message sent for event ${event.id} (${event.name})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Organizer post-event message failed for event ${event.id} (${event.name}): ${message}`,
      );
    }
  }
}

export async function runReminderTick(nowMs = Date.now()): Promise<void> {
  if (isReminderSendingEnabled()) {
    await runRsvpReminderTick(nowMs);
  }
  await runOrganizerPostEventTick(nowMs);
}

async function runRsvpReminderTick(nowMs: number): Promise<void> {
  const events = listEventsWithReminderConfigured();

  for (const event of events) {
    if (
      !event.reminder_days ||
      !event.rsvp_deadline ||
      event.reminder_sent_at
    ) {
      continue;
    }

    if (
      !isReminderDue({
        nowMs,
        deadline: event.rsvp_deadline,
        eventDate: event.date,
        reminderDays: event.reminder_days,
        reminderSentAt: event.reminder_sent_at,
      })
    ) {
      continue;
    }

    const phones = getPendingGuestPhonesForEvent(event.id);
    if (phones.length === 0) {
      markReminderSent(event.id);
      continue;
    }

    const rsvpHint =
      buildRsvpWhatsAppLink(event.rsvp_code) ?? `RSVP ${event.rsvp_code}`;

    try {
      const result = await sendReminderBroadcast({
        eventName: event.name,
        eventDate: event.date,
        rsvpDeadline: event.rsvp_deadline,
        rsvpCode: event.rsvp_code,
        phones,
        broadcastName: `RSVP reminder ${event.name} ${new Date(nowMs).toISOString()}`,
      });

      if ((result.sent ?? 0) < 1) {
        console.error(
          `Reminder broadcast reported no successful sends for event ${event.id} (${event.name}): sent=${result.sent} failed=${result.failed}`,
        );
        continue;
      }

      markReminderSent(event.id);
      console.log(
        `Reminder sent for event ${event.id} (${event.name}): ${result.sent} sent, ${result.failed} failed; RSVP link: ${rsvpHint}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Reminder broadcast failed for event ${event.id} (${event.name}): ${message}`,
      );
    }
  }
}
