import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  config,
  connectWhatsAppAccountId,
  isWebGuestPhone,
  normalizePhone,
  parseGuestWhatsAppNumber,
} from '../config.js';
import { isCalendarDayAfterEvent, parseRsvpDeadline, resolveEventTimezone } from '../dates/eventDate.js';
import {
  deleteEventImageFile,
  deleteUnreferencedEventImageFiles,
} from '../events/image.js';

export type RsvpStatus = 'yes' | 'no' | 'maybe' | 'pending';

export interface Event {
  id: number;
  name: string;
  date: string;
  location: string;
  organizer_phone: string;
  rsvp_token: string;
  rsvp_code: string;
  short_code?: string | null;
  invitation_count: number | null;
  rsvp_deadline: string | null;
  children_allowed: number;
  reminder_days: number | null;
  reminder_sent_at: string | null;
  organizer_post_event_sent_at?: string | null;
  cancelled_at?: string | null;
  deleted_at?: string | null;
  theme?: string | null;
  custom_theme?: string | null;
  dress_code?: string | null;
  location_place_id?: string | null;
  location_maps_url?: string | null;
  location_address?: string | null;
  image_filename?: string | null;
  timezone?: string | null;
  created_at: string;
}

export type InvitationType = 'individual' | 'family' | 'group';

export interface Invitation {
  id: number;
  event_id: number;
  type: InvitationType;
  family_name: string | null;
  group_name: string | null;
  max_guests: number | null;
  rsvp_code: string | null;
  short_code: string | null;
  created_at: string;
}

export interface InvitationMember {
  id: number;
  invitation_id: number;
  member_name: string;
  created_at: string;
}

export interface InvitationWithMembers extends Invitation {
  members: InvitationMember[];
}

export interface Guest {
  id: number;
  event_id: number;
  phone: string;
  name: string | null;
  conversation_id: string | null;
  invitation_id?: number | null;
  thank_you_sent_at?: string | null;
  whatsapp_phone?: string | null;
  invited_at: string;
}

export interface Rsvp {
  id: number;
  event_id: number;
  phone: string;
  status: RsvpStatus;
  guest_count: number;
  adult_count: number;
  child_count: number;
  raw_reply: string | null;
  updated_at: string;
  guest_name?: string | null;
}

export interface RsvpSummary {
  yes: number;
  no: number;
  maybe: number;
  pending: number;
  totalGuests: number;
  totalAdults: number;
  totalChildren: number;
  expectedAttendance: number;
}

export type ConversationStep =
  | 'WAITING_FOR_EVENT_NAME'
  | 'WAITING_FOR_EVENT_TIMEZONE'
  | 'WAITING_FOR_EVENT_DATE'
  | 'WAITING_FOR_EVENT_TIME'
  | 'WAITING_FOR_EVENT_LOCATION'
  | 'WAITING_FOR_ADD_DETAILS'
  | 'WAITING_FOR_EVENT_THEME'
  | 'WAITING_FOR_CUSTOM_THEME'
  | 'WAITING_FOR_DRESS_CODE'
  | 'WAITING_FOR_DRESS_CODE_TEXT'
  | 'WAITING_FOR_EVENT_IMAGE'
  | 'WAITING_FOR_INVITATION_COUNT'
  | 'WAITING_FOR_RSVP_DEADLINE'
  | 'WAITING_FOR_CHILDREN_POLICY'
  | 'WAITING_FOR_REMINDER_SETTING'
  | 'CONFIRMING_EVENT'
  | 'WAITING_FOR_RSVP_ADULTS'
  | 'WAITING_FOR_RSVP_CHILDREN'
  | 'WAITING_FOR_RSVP_COUNTS'
  | 'WAITING_FOR_FAMILY_NAME'
  | 'WAITING_FOR_FAMILY_GUEST_LIMIT'
  | 'WAITING_FOR_GROUP_NAME'
  | 'WAITING_FOR_GROUP_MEMBER'
  | 'WAITING_FOR_EDIT_FIELD'
  | 'WAITING_FOR_EDIT_NAME'
  | 'WAITING_FOR_EDIT_DATE'
  | 'WAITING_FOR_EDIT_TIMEZONE'
  | 'WAITING_FOR_EDIT_TIME'
  | 'WAITING_FOR_EDIT_LOCATION'
  | 'WAITING_FOR_EDIT_THEME'
  | 'WAITING_FOR_EDIT_CUSTOM_THEME'
  | 'WAITING_FOR_EDIT_DRESS'
  | 'WAITING_FOR_EDIT_DRESS_TEXT'
  | 'WAITING_FOR_EDIT_DEADLINE'
  | 'WAITING_FOR_EDIT_IMAGE'
  | 'WAITING_FOR_UPDATE_MESSAGE'
  | 'WAITING_FOR_UPDATE_TYPE'
  | 'WAITING_FOR_CANCEL_CONFIRM'
  | 'WAITING_FOR_DELETE_CONFIRM'
  | 'VENDOR_MENU'
  | 'VENDOR_REG_CATEGORY'
  | 'VENDOR_REG_NAME'
  | 'VENDOR_REG_CONTACT'
  | 'VENDOR_REG_EMAIL'
  | 'VENDOR_REG_ADDRESS'
  | 'VENDOR_REG_AREA'
  | 'VENDOR_REG_DESCRIPTION'
  | 'VENDOR_REG_PRICING'
  | 'VENDOR_REG_REVIEW'
  | 'VENDOR_EDIT_MENU'
  | 'VENDOR_EDIT_VALUE'
  | 'VENDOR_PRODUCTS'
  | 'VENDOR_PRODUCT_STARTER'
  | 'VENDOR_PRODUCT_NAME'
  | 'VENDOR_PRODUCT_DESCRIPTION'
  | 'VENDOR_PRODUCT_PRICE'
  | 'VENDOR_PRODUCT_UNIT'
  | 'VENDOR_PRODUCT_REVIEW'
  | 'VENDOR_PRODUCT_ACTIONS'
  | 'VENDOR_PRODUCT_EDIT_VALUE'
  | 'VENDOR_AVAILABILITY'
  | 'VENDOR_AVAILABILITY_EDIT'
  | 'VENDOR_ORDER_HOME'
  | 'VENDOR_ORDER_MENU'
  | 'VENDOR_ORDER_QTY'
  | 'VENDOR_ORDER_CART'
  | 'VENDOR_ORDER_CHANGE'
  | 'VENDOR_ORDER_PICKUP_DATE'
  | 'VENDOR_ORDER_PICKUP_TIME'
  | 'VENDOR_ORDER_REVIEW'
  | 'VENDOR_ORDERS_LIST'
  | 'VENDOR_ORDER_DETAIL'
  | 'VENDOR_ORDER_CANCEL_CONFIRM';

export type EventUpdateType = 'info' | 'ack' | 'cancel';
export type EventUpdateSendStatus = 'sent' | 'failed';

export interface EventUpdate {
  id: number;
  event_id: number;
  type: EventUpdateType;
  acknowledgement_required: number;
  snapshot_name: string;
  snapshot_date: string;
  snapshot_location: string;
  message: string | null;
  organizer_all_acked_notified_at: string | null;
  created_at: string;
}

export interface EventUpdateRecipient {
  id: number;
  update_id: number;
  invitation_id: number | null;
  guest_id: number | null;
  phone: string;
  send_status: EventUpdateSendStatus;
  ack_token?: string | null;
  acknowledged_at: string | null;
  reminder_sent_at: string | null;
  created_at: string;
  guest_name?: string | null;
  family_name?: string | null;
  invitation_type?: InvitationType | null;
}

export interface EventUpdateTarget {
  invitationId: number | null;
  guestId: number | null;
  phone: string;
  name: string | null;
  familyName: string | null;
  invitationType: InvitationType | null;
}

export interface EventUpdateAckCounts {
  sent: number;
  acknowledged: number;
  awaiting: number;
  failed: number;
}

export interface ConversationState {
  organizer_phone: string;
  account_id?: string;
  state: ConversationStep;
  name: string | null;
  date: string | null;
  location: string | null;
  invitation_count: number | null;
  rsvp_deadline: string | null;
  children_allowed: number | null;
  reminder_days: number | null;
  event_id: number | null;
  adult_count: number | null;
  child_count: number | null;
  invitation_id: number | null;
  invite_type: string | null;
  family_name: string | null;
  group_name: string | null;
  max_guests: number | null;
  update_message?: string | null;
  theme?: string | null;
  custom_theme?: string | null;
  dress_code?: string | null;
  location_place_id?: string | null;
  location_maps_url?: string | null;
  location_address?: string | null;
  image_filename?: string | null;
  vendor_draft?: string | null;
  timezone?: string | null;
  updated_at: string;
}

export interface MessageSession {
  phone: string;
  conversation_id: string;
  account_id: string;
  updated_at: string;
}

export interface ConversationDraft {
  name?: string | null;
  date?: string | null;
  location?: string | null;
  invitation_count?: number | null;
  rsvp_deadline?: string | null;
  children_allowed?: number | null;
  reminder_days?: number | null;
  event_id?: number | null;
  adult_count?: number | null;
  child_count?: number | null;
  invitation_id?: number | null;
  invite_type?: string | null;
  family_name?: string | null;
  group_name?: string | null;
  max_guests?: number | null;
  update_message?: string | null;
  theme?: string | null;
  custom_theme?: string | null;
  dress_code?: string | null;
  location_place_id?: string | null;
  location_maps_url?: string | null;
  location_address?: string | null;
  image_filename?: string | null;
  vendor_draft?: string | null;
  timezone?: string | null;
}

export interface CreateEventOptions {
  invitationCount?: number | null;
  rsvpDeadline?: string | null;
  childrenAllowed?: boolean;
  reminderDays?: number | null;
  theme?: string | null;
  customTheme?: string | null;
  dressCode?: string | null;
  locationPlaceId?: string | null;
  locationMapsUrl?: string | null;
  locationAddress?: string | null;
  imageFilename?: string | null;
  timezone?: string | null;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) {
    return db;
  }

  const dir = path.dirname(config.databasePath);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'schema.sql',
  );
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  ensureEventNameOrganizerIndex(db);
  ensureRsvpTokenColumn(db);
  ensureRsvpCodeColumn(db);
  ensureEventExpansionColumns(db);
  ensureRsvpCountColumns(db);
  ensureConversationStateColumns(db);
  ensureEventThemeAndMapsColumns(db);
  ensureGuestConversationIdColumn(db);
  ensureInvitationTables(db);
  ensureGuestWhatsAppPhoneColumn(db);
  ensureShortCodeColumns(db);
  ensureEventImageColumn(db);
  ensureEventTimezoneColumns(db);
  ensureEventWhenCodeTable(db);
  ensureGuestListCodeTable(db);
  ensureConnectFollowUpColumns(db);
  ensureEventUpdateTables(db);
  ensureVendorTables(db);
  ensureConversationAccountScope(db);
  return db;
}

const RSVP_TOKEN_BYTES = 16;
const RSVP_TOKEN_ATTEMPTS = 8;
const RSVP_CODE_LENGTH = 8;
const RSVP_CODE_ATTEMPTS = 8;
const SHORT_CODE_LENGTH = 8;
const GUEST_LIST_CODE_LENGTH = 6;
const SHORT_CODE_ATTEMPTS = 8;
const ACK_TOKEN_BYTES = 16;
const ACK_TOKEN_ATTEMPTS = 8;
/** Crockford Base32 (no I, L, O, U) — 256 % 32 == 0 so byte % 32 is unbiased. */
const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRsvpToken(): string {
  return crypto.randomBytes(RSVP_TOKEN_BYTES).toString('hex');
}

export function generateRsvpCode(): string {
  const bytes = crypto.randomBytes(RSVP_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += CROCKFORD32[byte % 32];
  }
  return code;
}

/** URL short code: 8+ Crockford chars from cryptographically random bytes. */
export function generateShortCode(): string {
  const bytes = crypto.randomBytes(SHORT_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += CROCKFORD32[byte % 32];
  }
  return code;
}

/** Guest List short code: 6 Crockford chars. Separate from RSVP 8-char codes. */
export function generateGuestListShortCode(): string {
  const bytes = crypto.randomBytes(GUEST_LIST_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += CROCKFORD32[byte % 32];
  }
  return code;
}

/** Secure non-sequential ack token (32 hex). Never use sequential recipient/update IDs. */
export function generateAckToken(): string {
  return crypto.randomBytes(ACK_TOKEN_BYTES).toString('hex');
}

function isSqliteUniqueError(error: unknown, column: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code ?? '';
  return (
    (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') &&
    new RegExp(column, 'i').test(error.message)
  );
}

function isRsvpTokenUniqueError(error: unknown): boolean {
  return isSqliteUniqueError(error, 'rsvp_token');
}

function isRsvpCodeUniqueError(error: unknown): boolean {
  return isSqliteUniqueError(error, 'rsvp_code');
}

function isShortCodeUniqueError(error: unknown): boolean {
  return isSqliteUniqueError(error, 'short_code');
}

function isAckTokenUniqueError(error: unknown): boolean {
  return isSqliteUniqueError(error, 'ack_token');
}

function isRsvpUniqueError(error: unknown): boolean {
  return (
    isRsvpTokenUniqueError(error) ||
    isRsvpCodeUniqueError(error) ||
    isShortCodeUniqueError(error)
  );
}

function quoteSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Duplicate event names are allowed. Older DBs had a UNIQUE (name, organizer)
 * index — drop that uniqueness only. Never touch rsvp_token / rsvp_code /
 * short_code uniqueness.
 */
export function ensureEventNameOrganizerIndex(
  database: Database.Database = getDb(),
): void {
  database.exec(`DROP INDEX IF EXISTS idx_events_name_organizer`);

  const indexes = database.prepare(`PRAGMA index_list(events)`).all() as Array<{
    name: string;
    unique: number;
  }>;
  for (const index of indexes) {
    if (!index.unique) {
      continue;
    }
    const columns = database
      .prepare(`PRAGMA index_info(${quoteSqlIdent(index.name)})`)
      .all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    const nameOnly = names.length === 1 && names[0] === 'name';
    const nameAndOrganizer =
      names.length === 2 &&
      names.includes('name') &&
      names.includes('organizer_phone');
    if (nameOnly || nameAndOrganizer) {
      database.exec(`DROP INDEX IF EXISTS ${quoteSqlIdent(index.name)}`);
    }
  }

  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_events_name_organizer ON events (name, organizer_phone)`,
  );
}

/** Existing Railway DBs already have `events`; CREATE TABLE IF NOT EXISTS will not add columns. */
function ensureRsvpTokenColumn(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(events)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'rsvp_token')) {
    database.exec(`ALTER TABLE events ADD COLUMN rsvp_token TEXT`);
  }

  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_rsvp_token ON events (rsvp_token)`,
  );

  const missing = database
    .prepare(
      `SELECT id FROM events WHERE rsvp_token IS NULL OR rsvp_token = ''`,
    )
    .all() as Array<{ id: number }>;
  const update = database.prepare(
    `UPDATE events SET rsvp_token = ? WHERE id = ?`,
  );
  for (const row of missing) {
    for (let attempt = 0; attempt < RSVP_TOKEN_ATTEMPTS; attempt++) {
      try {
        update.run(generateRsvpToken(), row.id);
        break;
      } catch (error) {
        if (attempt === RSVP_TOKEN_ATTEMPTS - 1 || !isRsvpTokenUniqueError(error)) {
          throw error;
        }
      }
    }
  }
}

/** Existing Railway DBs already have `events`; CREATE TABLE IF NOT EXISTS will not add columns. */
function ensureRsvpCodeColumn(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(events)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'rsvp_code')) {
    database.exec(`ALTER TABLE events ADD COLUMN rsvp_code TEXT`);
  }

  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_rsvp_code ON events (rsvp_code)`,
  );

  const missing = database
    .prepare(
      `SELECT id FROM events
       WHERE (rsvp_code IS NULL OR rsvp_code = '')
         AND rsvp_token IS NOT NULL AND rsvp_token != ''`,
    )
    .all() as Array<{ id: number }>;
  const update = database.prepare(
    `UPDATE events SET rsvp_code = ? WHERE id = ?`,
  );
  for (const row of missing) {
    for (let attempt = 0; attempt < RSVP_CODE_ATTEMPTS; attempt++) {
      try {
        update.run(generateRsvpCode(), row.id);
        break;
      } catch (error) {
        if (attempt === RSVP_CODE_ATTEMPTS - 1 || !isRsvpCodeUniqueError(error)) {
          throw error;
        }
      }
    }
  }
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((col) => col.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureEventExpansionColumns(database: Database.Database): void {
  ensureColumn(database, 'events', 'invitation_count', 'INTEGER');
  ensureColumn(database, 'events', 'rsvp_deadline', 'TEXT');
  ensureColumn(database, 'events', 'children_allowed', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(database, 'events', 'reminder_days', 'INTEGER');
  ensureColumn(database, 'events', 'reminder_sent_at', 'TEXT');
}

function ensureRsvpCountColumns(database: Database.Database): void {
  ensureColumn(database, 'rsvps', 'adult_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'rsvps', 'child_count', 'INTEGER NOT NULL DEFAULT 0');
}

function ensureConversationStateColumns(database: Database.Database): void {
  ensureColumn(database, 'conversation_states', 'invitation_count', 'INTEGER');
  ensureColumn(database, 'conversation_states', 'rsvp_deadline', 'TEXT');
  ensureColumn(database, 'conversation_states', 'children_allowed', 'INTEGER');
  ensureColumn(database, 'conversation_states', 'reminder_days', 'INTEGER');
  ensureColumn(database, 'conversation_states', 'event_id', 'INTEGER');
  ensureColumn(database, 'conversation_states', 'adult_count', 'INTEGER');
  ensureColumn(database, 'conversation_states', 'child_count', 'INTEGER');
}

function ensureEventThemeAndMapsColumns(database: Database.Database): void {
  ensureColumn(database, 'events', 'theme', 'TEXT');
  ensureColumn(database, 'events', 'custom_theme', 'TEXT');
  ensureColumn(database, 'events', 'dress_code', 'TEXT');
  ensureColumn(database, 'events', 'location_place_id', 'TEXT');
  ensureColumn(database, 'events', 'location_maps_url', 'TEXT');
  ensureColumn(database, 'events', 'location_address', 'TEXT');
  ensureColumn(database, 'conversation_states', 'theme', 'TEXT');
  ensureColumn(database, 'conversation_states', 'custom_theme', 'TEXT');
  ensureColumn(database, 'conversation_states', 'dress_code', 'TEXT');
  ensureColumn(database, 'conversation_states', 'location_place_id', 'TEXT');
  ensureColumn(database, 'conversation_states', 'location_maps_url', 'TEXT');
  ensureColumn(database, 'conversation_states', 'location_address', 'TEXT');
}

function ensureGuestConversationIdColumn(database: Database.Database): void {
  ensureColumn(database, 'guests', 'conversation_id', 'TEXT');
}

function tableHasColumn(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return columns.some((col) => col.name === column);
}

function sqliteTableSql(
  database: Database.Database,
  table: string,
): string {
  const row = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? '';
}

/** CONNECT traffic keeps the legacy empty account_id so existing wizard rows still match. */
export const CONNECT_CONVERSATION_ACCOUNT_ID = '';

function isVendorWhatsAppAccountId(accountId: string): boolean {
  try {
    const row = getDb()
      .prepare(
        `SELECT 1 FROM vendors WHERE zernio_whatsapp_account_id = ? LIMIT 1`,
      )
      .get(accountId);
    return Boolean(row);
  } catch {
    return false;
  }
}

export function conversationAccountScope(accountId?: string | null): string {
  const trimmed = accountId?.trim() ?? '';
  const connect = connectWhatsAppAccountId();
  if (!connect || !trimmed || trimmed === connect) {
    return CONNECT_CONVERSATION_ACCOUNT_ID;
  }
  if (isVendorWhatsAppAccountId(trimmed)) {
    return trimmed;
  }
  return CONNECT_CONVERSATION_ACCOUNT_ID;
}

function ensureConversationAccountScope(database: Database.Database): void {
  const stateSql = sqliteTableSql(database, 'conversation_states');
  if (
    !stateSql.includes('PRIMARY KEY (organizer_phone, account_id)') &&
    !stateSql.includes('PRIMARY KEY(organizer_phone, account_id)')
  ) {
    const hasAccount = tableHasColumn(database, 'conversation_states', 'account_id');
    database.exec(`
      CREATE TABLE conversation_states_account_scoped (
        organizer_phone TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        name TEXT,
        date TEXT,
        location TEXT,
        invitation_count INTEGER,
        rsvp_deadline TEXT,
        children_allowed INTEGER,
        reminder_days INTEGER,
        event_id INTEGER,
        adult_count INTEGER,
        child_count INTEGER,
        invitation_id INTEGER,
        invite_type TEXT,
        family_name TEXT,
        group_name TEXT,
        max_guests INTEGER,
        update_message TEXT,
        theme TEXT,
        custom_theme TEXT,
        dress_code TEXT,
        location_place_id TEXT,
        location_maps_url TEXT,
        location_address TEXT,
        image_filename TEXT,
        vendor_draft TEXT,
        timezone TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (organizer_phone, account_id)
      );
    `);
    if (hasAccount) {
      database.exec(`
        INSERT INTO conversation_states_account_scoped
        SELECT organizer_phone, COALESCE(account_id, ''), state, name, date, location,
               invitation_count, rsvp_deadline, children_allowed, reminder_days,
               event_id, adult_count, child_count, invitation_id, invite_type,
               family_name, group_name, max_guests, update_message,
               theme, custom_theme, dress_code,
               location_place_id, location_maps_url, location_address, image_filename,
               vendor_draft, timezone, updated_at
        FROM conversation_states
      `);
    } else {
      database.exec(`
        INSERT INTO conversation_states_account_scoped
        SELECT organizer_phone, '', state, name, date, location,
               invitation_count, rsvp_deadline, children_allowed, reminder_days,
               event_id, adult_count, child_count, invitation_id, invite_type,
               family_name, group_name, max_guests, update_message,
               theme, custom_theme, dress_code,
               location_place_id, location_maps_url, location_address, image_filename,
               vendor_draft, timezone, updated_at
        FROM conversation_states
      `);
    }
    database.exec(`DROP TABLE conversation_states`);
    database.exec(
      `ALTER TABLE conversation_states_account_scoped RENAME TO conversation_states`,
    );
  }

  const sessionSql = sqliteTableSql(database, 'message_sessions');
  if (
    sessionSql &&
    !sessionSql.includes('PRIMARY KEY (phone, account_id)') &&
    !sessionSql.includes('PRIMARY KEY(phone, account_id)')
  ) {
    database.exec(`
      CREATE TABLE message_sessions_account_scoped (
        phone TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (phone, account_id)
      );
    `);
    database.exec(`
      INSERT INTO message_sessions_account_scoped
      SELECT phone, conversation_id, account_id, updated_at
      FROM message_sessions
    `);
    database.exec(`DROP TABLE message_sessions`);
    database.exec(
      `ALTER TABLE message_sessions_account_scoped RENAME TO message_sessions`,
    );
  }
}

/** Additive follow-up columns. Existing RSVPed guests / past events are marked sent so deploy does not re-message them. */
function ensureConnectFollowUpColumns(database: Database.Database): void {
  const hadThankYou = tableHasColumn(database, 'guests', 'thank_you_sent_at');
  if (!hadThankYou) {
    database.exec(`ALTER TABLE guests ADD COLUMN thank_you_sent_at TEXT`);
    database.exec(`
      UPDATE guests
      SET thank_you_sent_at = datetime('now')
      WHERE thank_you_sent_at IS NULL
        AND EXISTS (
          SELECT 1 FROM rsvps
          WHERE rsvps.event_id = guests.event_id
            AND rsvps.phone = guests.phone
            AND rsvps.status IN ('yes', 'no', 'maybe')
        )
    `);
  }

  const hadPostEvent = tableHasColumn(database, 'events', 'organizer_post_event_sent_at');
  if (!hadPostEvent) {
    database.exec(
      `ALTER TABLE events ADD COLUMN organizer_post_event_sent_at TEXT`,
    );
    const events = database
      .prepare(`SELECT id, date, timezone FROM events`)
      .all() as Array<{ id: number; date: string; timezone?: string | null }>;
    const nowMs = Date.now();
    const mark = database.prepare(
      `UPDATE events SET organizer_post_event_sent_at = datetime('now') WHERE id = ?`,
    );
    for (const event of events) {
      if (isCalendarDayAfterEvent(event.date, nowMs, event.timezone ?? undefined)) {
        mark.run(event.id);
      }
    }
  }
}

/** Additive event-update + cancellation columns. Never deletes events, invitations, or RSVPs. */
export function ensureEventUpdateTables(
  database: Database.Database = getDb(),
): void {
  ensureColumn(database, 'events', 'cancelled_at', 'TEXT');
  // Additive soft-delete — after events exists, never index-before-column.
  ensureColumn(database, 'events', 'deleted_at', 'TEXT');
  ensureColumn(database, 'conversation_states', 'update_message', 'TEXT');
  database.exec(`
    CREATE TABLE IF NOT EXISTS event_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      acknowledgement_required INTEGER NOT NULL DEFAULT 0,
      snapshot_name TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      snapshot_location TEXT NOT NULL,
      message TEXT,
      organizer_all_acked_notified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_updates_event ON event_updates (event_id);
    CREATE TABLE IF NOT EXISTS event_update_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      update_id INTEGER NOT NULL REFERENCES event_updates(id) ON DELETE CASCADE,
      invitation_id INTEGER REFERENCES invitations(id) ON DELETE SET NULL,
      guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
      phone TEXT NOT NULL,
      send_status TEXT NOT NULL,
      acknowledged_at TEXT,
      reminder_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_update_recipients_update
      ON event_update_recipients (update_id);
    CREATE INDEX IF NOT EXISTS idx_event_update_recipients_phone
      ON event_update_recipients (phone);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_update_recipients_update_phone
      ON event_update_recipients (update_id, phone);
  `);
  // Column AFTER the table exists — never index ack_token before this ALTER.
  ensureColumn(database, 'event_update_recipients', 'ack_token', 'TEXT');
  backfillAckTokens(database);
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_event_update_recipients_ack_token
     ON event_update_recipients (ack_token)`,
  );
}

function backfillAckTokens(database: Database.Database): void {
  if (!tableHasColumn(database, 'event_update_recipients', 'ack_token')) {
    return;
  }
  const missing = database
    .prepare(
      `SELECT id FROM event_update_recipients
       WHERE ack_token IS NULL OR ack_token = ''`,
    )
    .all() as Array<{ id: number }>;
  const update = database.prepare(
    `UPDATE event_update_recipients SET ack_token = ? WHERE id = ?`,
  );
  for (const row of missing) {
    for (let attempt = 0; attempt < ACK_TOKEN_ATTEMPTS; attempt++) {
      try {
        update.run(generateAckToken(), row.id);
        break;
      } catch (error) {
        if (attempt === ACK_TOKEN_ATTEMPTS - 1 || !isAckTokenUniqueError(error)) {
          throw error;
        }
      }
    }
  }
}

export function ensureInvitationTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      family_name TEXT,
      group_name TEXT,
      max_guests INTEGER,
      rsvp_code TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invitations_event ON invitations (event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_rsvp_code ON invitations (rsvp_code);
    CREATE TABLE IF NOT EXISTS invitation_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invitation_id INTEGER NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
      member_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invitation_members_invitation
      ON invitation_members (invitation_id);
  `);
  ensureColumn(database, 'guests', 'invitation_id', 'INTEGER');
  ensureColumn(database, 'conversation_states', 'invitation_id', 'INTEGER');
  ensureColumn(database, 'conversation_states', 'invite_type', 'TEXT');
  ensureColumn(database, 'conversation_states', 'family_name', 'TEXT');
  ensureColumn(database, 'conversation_states', 'group_name', 'TEXT');
  ensureColumn(database, 'conversation_states', 'max_guests', 'INTEGER');
}

/** Additive notify number for Individual web guests. Existing rows stay NULL. */
export function ensureGuestWhatsAppPhoneColumn(
  database: Database.Database = getDb(),
): void {
  ensureColumn(database, 'guests', 'whatsapp_phone', 'TEXT');
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_event_whatsapp_phone
     ON guests (event_id, whatsapp_phone)
     WHERE whatsapp_phone IS NOT NULL AND trim(whatsapp_phone) != ''`,
  );
}

/** Additive event image filename. Existing events stay NULL (no image). */
export function ensureEventImageColumn(
  database: Database.Database = getDb(),
): void {
  ensureColumn(database, 'events', 'image_filename', 'TEXT');
  ensureColumn(database, 'conversation_states', 'image_filename', 'TEXT');
}

/** Additive event timezone. Existing rows backfill to EVENT_TIMEZONE. */
export function ensureEventTimezoneColumns(
  database: Database.Database = getDb(),
): void {
  ensureColumn(database, 'events', 'timezone', 'TEXT');
  ensureColumn(database, 'conversation_states', 'timezone', 'TEXT');
  database
    .prepare(
      `UPDATE events
       SET timezone = ?
       WHERE timezone IS NULL OR trim(timezone) = ''`,
    )
    .run(resolveEventTimezone());
}

export const VENDOR_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'ACTIVE',
] as const;

export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const VENDOR_CATEGORIES = ['CATERING', 'INDIAN_BAKERY'] as const;
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

export function ensureVendorTables(
  database: Database.Database = getDb(),
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      whatsapp_phone TEXT NOT NULL UNIQUE,
      business_name TEXT,
      category TEXT,
      contact_name TEXT,
      email TEXT,
      address TEXT,
      service_area TEXT,
      description TEXT,
      pricing TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      provider_type TEXT,
      menu_source_method TEXT,
      ordering_frequency TEXT,
      payment_preference TEXT,
      onboarding_completed_at TEXT,
      onboarding_source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vendors_whatsapp_phone
      ON vendors (whatsapp_phone);
    CREATE INDEX IF NOT EXISTS idx_vendors_category ON vendors (category);
    CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors (status);
    CREATE TABLE IF NOT EXISTS vendor_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      price TEXT,
      unit TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vendor_products_vendor
      ON vendor_products (vendor_id);
    CREATE TABLE IF NOT EXISTS vendor_availability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL UNIQUE REFERENCES vendors(id) ON DELETE CASCADE,
      availability_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vendor_onboarding_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      expected_phone TEXT NOT NULL,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      step TEXT NOT NULL DEFAULT 'AWAITING_CLAIM',
      draft_json TEXT,
      expires_at INTEGER NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vendor_onboarding_phone
      ON vendor_onboarding_sessions (expected_phone, completed_at, expires_at);
  `);
  ensureColumn(database, 'conversation_states', 'vendor_draft', 'TEXT');
  ensureColumn(database, 'vendors', 'zernio_whatsapp_account_id', 'TEXT');
  ensureColumn(database, 'vendors', 'provider_type', 'TEXT');
  ensureColumn(database, 'vendors', 'menu_source_method', 'TEXT');
  ensureColumn(database, 'vendors', 'ordering_frequency', 'TEXT');
  ensureColumn(database, 'vendors', 'payment_preference', 'TEXT');
  ensureColumn(database, 'vendors', 'onboarding_completed_at', 'TEXT');
  ensureColumn(database, 'vendors', 'onboarding_source', 'TEXT');
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_zernio_whatsapp_account_id
      ON vendors (zernio_whatsapp_account_id)
      WHERE zernio_whatsapp_account_id IS NOT NULL
        AND trim(zernio_whatsapp_account_id) != ''
  `);
  ensureVendorOrderTables(database);
}

function ensureVendorOrderTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS vendor_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      order_number TEXT NOT NULL UNIQUE,
      customer_phone TEXT NOT NULL,
      customer_name TEXT,
      pickup_date TEXT NOT NULL,
      pickup_time TEXT NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'PAY_AT_COUNTER',
      status TEXT NOT NULL DEFAULT 'NEW',
      total_amount INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      accepted_at TEXT,
      preparing_at TEXT,
      ready_at TEXT,
      picked_up_at TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT,
      vendor_notified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vendor_orders_vendor
      ON vendor_orders (vendor_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_vendor_orders_customer
      ON vendor_orders (customer_phone, created_at);
    CREATE INDEX IF NOT EXISTS idx_vendor_orders_status
      ON vendor_orders (vendor_id, status);
    CREATE TABLE IF NOT EXISTS vendor_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES vendor_orders(id) ON DELETE CASCADE,
      vendor_product_id INTEGER,
      product_name_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      line_total INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vendor_order_items_order
      ON vendor_order_items (order_id);
    CREATE TABLE IF NOT EXISTS vendor_order_sequences (
      vendor_id INTEGER PRIMARY KEY,
      next_number INTEGER NOT NULL
    );
  `);
  ensureColumn(database, 'vendor_orders', 'vendor_notified_at', 'TEXT');
  applyOrderAheadProductPrices(database);
}

function applyOrderAheadProductPrices(database: Database.Database): void {
  const updates: Array<[string, string, string]> = [
    ['Roti', '25 ct', '$10.00'],
    ['Methi Paratha', '10 ct', '$10.00'],
    ['Plain Paratha', '10 ct', '$9.00'],
  ];
  const statement = database.prepare(
    `UPDATE vendor_products
     SET price = ?, updated_at = datetime('now')
     WHERE lower(trim(product_name)) = lower(trim(?))
       AND lower(trim(ifnull(unit, ''))) = lower(trim(?))
       AND ifnull(price, '') != ?`,
  );
  for (const [name, unit, price] of updates) {
    statement.run(price, name, unit, price);
  }
}

export const EVENT_IMAGE_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function sqliteTimeToMs(value: string | null | undefined): number {
  const raw = value?.trim() ?? '';
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isEventImageReferenced(
  filename: string,
  database: Database.Database = getDb(),
): boolean {
  if (!filename.trim()) {
    return false;
  }
  const eventHit = database
    .prepare(
      `SELECT 1 FROM events WHERE image_filename = ? LIMIT 1`,
    )
    .get(filename);
  if (eventHit) {
    return true;
  }
  const draftHit = database
    .prepare(
      `SELECT 1 FROM conversation_states WHERE image_filename = ? LIMIT 1`,
    )
    .get(filename);
  return Boolean(draftHit);
}

export function deleteEventImageIfUnreferenced(filename: string | null | undefined): void {
  if (!filename?.trim()) {
    return;
  }
  if (isEventImageReferenced(filename)) {
    return;
  }
  deleteEventImageFile(filename);
}

/** Delete image files that are not on a saved event and are not an in-progress draft. */
export function sweepAbandonedEventImages(
  nowMs = Date.now(),
  maxAgeMs = EVENT_IMAGE_DRAFT_MAX_AGE_MS,
): string[] {
  const database = getDb();
  const cutoffMs = nowMs - maxAgeMs;
  const staleDrafts = database
    .prepare(
      `SELECT organizer_phone, image_filename, updated_at
       FROM conversation_states
       WHERE image_filename IS NOT NULL AND trim(image_filename) != ''`,
    )
    .all() as Array<{
    organizer_phone: string;
    image_filename: string;
    updated_at: string;
  }>;
  const clearDraft = database.prepare(
    `UPDATE conversation_states SET image_filename = NULL WHERE organizer_phone = ?`,
  );
  for (const row of staleDrafts) {
    if (sqliteTimeToMs(row.updated_at) > cutoffMs) {
      continue;
    }
    const saved = database
      .prepare(`SELECT 1 FROM events WHERE image_filename = ? LIMIT 1`)
      .get(row.image_filename);
    if (saved) {
      continue;
    }
    clearDraft.run(row.organizer_phone);
  }

  const keep = new Set<string>();
  for (const row of database
    .prepare(
      `SELECT image_filename FROM events
       WHERE image_filename IS NOT NULL AND trim(image_filename) != ''`,
    )
    .all() as Array<{ image_filename: string }>) {
    keep.add(row.image_filename);
  }
  for (const row of database
    .prepare(
      `SELECT image_filename FROM conversation_states
       WHERE image_filename IS NOT NULL AND trim(image_filename) != ''`,
    )
    .all() as Array<{ image_filename: string }>) {
    keep.add(row.image_filename);
  }
  return deleteUnreferencedEventImageFiles(keep);
}

/** Additive short URL codes. Existing values are kept; only blank rows are filled. */
export function ensureShortCodeColumns(
  database: Database.Database = getDb(),
): void {
  ensureColumn(database, 'events', 'short_code', 'TEXT');
  ensureColumn(database, 'invitations', 'short_code', 'TEXT');
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_short_code ON events (short_code)`,
  );
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_short_code ON invitations (short_code)`,
  );

  const missingEvents = database
    .prepare(
      `SELECT id FROM events WHERE short_code IS NULL OR short_code = ''`,
    )
    .all() as Array<{ id: number }>;
  const updateEvent = database.prepare(
    `UPDATE events SET short_code = ? WHERE id = ?`,
  );
  for (const row of missingEvents) {
    for (let attempt = 0; attempt < SHORT_CODE_ATTEMPTS; attempt++) {
      try {
        updateEvent.run(allocateUniqueShortCode(database), row.id);
        break;
      } catch (error) {
        if (attempt === SHORT_CODE_ATTEMPTS - 1 || !isShortCodeUniqueError(error)) {
          throw error;
        }
      }
    }
  }

  const missingFamilies = database
    .prepare(
      `SELECT id FROM invitations
       WHERE type = 'family'
         AND (short_code IS NULL OR short_code = '')`,
    )
    .all() as Array<{ id: number }>;
  const updateInvitation = database.prepare(
    `UPDATE invitations SET short_code = ? WHERE id = ?`,
  );
  const updateFamilyRsvpCode = database.prepare(
    `UPDATE invitations SET rsvp_code = ? WHERE id = ? AND (rsvp_code IS NULL OR rsvp_code = '')`,
  );
  for (const row of missingFamilies) {
    for (let attempt = 0; attempt < SHORT_CODE_ATTEMPTS; attempt++) {
      try {
        updateInvitation.run(allocateUniqueShortCode(database), row.id);
        break;
      } catch (error) {
        if (attempt === SHORT_CODE_ATTEMPTS - 1 || !isShortCodeUniqueError(error)) {
          throw error;
        }
      }
    }
    if (
      !database
        .prepare(
          `SELECT rsvp_code FROM invitations WHERE id = ? AND rsvp_code IS NOT NULL AND rsvp_code != ''`,
        )
        .get(row.id)
    ) {
      updateFamilyRsvpCode.run(allocateUniqueRsvpCode(database), row.id);
    }
  }
}

function rsvpCodeExists(database: Database.Database, code: string): boolean {
  const eventHit = database
    .prepare(`SELECT 1 FROM events WHERE lower(rsvp_code) = lower(?) LIMIT 1`)
    .get(code);
  if (eventHit) {
    return true;
  }
  const invitationHit = database
    .prepare(
      `SELECT 1 FROM invitations WHERE rsvp_code IS NOT NULL AND lower(rsvp_code) = lower(?) LIMIT 1`,
    )
    .get(code);
  return Boolean(invitationHit);
}

function shortCodeExists(database: Database.Database, code: string): boolean {
  const eventHit = database
    .prepare(`SELECT 1 FROM events WHERE lower(short_code) = lower(?) LIMIT 1`)
    .get(code);
  if (eventHit) {
    return true;
  }
  const invitationHit = database
    .prepare(
      `SELECT 1 FROM invitations WHERE short_code IS NOT NULL AND lower(short_code) = lower(?) LIMIT 1`,
    )
    .get(code);
  return Boolean(invitationHit);
}

export function allocateUniqueRsvpCode(
  database: Database.Database = getDb(),
): string {
  for (let attempt = 0; attempt < RSVP_CODE_ATTEMPTS; attempt++) {
    const code = generateRsvpCode();
    if (!rsvpCodeExists(database, code)) {
      return code;
    }
  }
  throw new Error('Failed to allocate a unique RSVP code');
}

export function allocateUniqueShortCode(
  database: Database.Database = getDb(),
): string {
  for (let attempt = 0; attempt < SHORT_CODE_ATTEMPTS; attempt++) {
    const code = generateShortCode();
    if (!shortCodeExists(database, code) && !pickerShortCodeExists(database, code)) {
      return code;
    }
  }
  throw new Error('Failed to allocate a unique short RSVP code');
}

/** Additive ephemeral picker short codes. HMAC tokens stay the source of truth. */
export function ensureEventWhenCodeTable(
  database: Database.Database = getDb(),
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS event_when_codes (
      short_code TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_when_codes_expires
      ON event_when_codes (expires_at);
  `);
}

function pickerShortCodeExists(
  database: Database.Database,
  code: string,
): boolean {
  try {
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM event_when_codes WHERE lower(short_code) = lower(?) LIMIT 1`,
        )
        .get(code),
    );
  } catch {
    return false;
  }
}

function purgeExpiredEventWhenCodes(
  database: Database.Database,
  nowMs = Date.now(),
): void {
  database
    .prepare(`DELETE FROM event_when_codes WHERE expires_at <= ?`)
    .run(nowMs);
}

export function allocateEventWhenShortCode(
  token: string,
  expiresAt: number,
  database: Database.Database = getDb(),
): string {
  ensureEventWhenCodeTable(database);
  purgeExpiredEventWhenCodes(database);
  const insert = database.prepare(
    `INSERT INTO event_when_codes (short_code, token, expires_at) VALUES (?, ?, ?)`,
  );
  for (let attempt = 0; attempt < SHORT_CODE_ATTEMPTS; attempt++) {
    const code = generateShortCode();
    if (shortCodeExists(database, code) || pickerShortCodeExists(database, code)) {
      continue;
    }
    try {
      insert.run(code, token, expiresAt);
      return code;
    } catch (error) {
      if (attempt === SHORT_CODE_ATTEMPTS - 1 || !isShortCodeUniqueError(error)) {
        throw error;
      }
    }
  }
  throw new Error('Failed to allocate a unique event-when short code');
}

export function lookupEventWhenTokenByShortCode(
  code: string,
  nowMs = Date.now(),
  database: Database.Database = getDb(),
): string | null {
  ensureEventWhenCodeTable(database);
  const trimmed = code.trim();
  if (!trimmed) {
    return null;
  }
  const row = database
    .prepare(
      `SELECT token, expires_at FROM event_when_codes
       WHERE lower(short_code) = lower(?) LIMIT 1`,
    )
    .get(trimmed) as { token: string; expires_at: number } | undefined;
  if (!row || row.expires_at <= nowMs) {
    return null;
  }
  return row.token;
}

/** Additive Guest List short codes. HMAC tokens stay the source of truth. */
export function ensureGuestListCodeTable(
  database: Database.Database = getDb(),
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS guest_list_codes (
      short_code TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_guest_list_codes_expires
      ON guest_list_codes (expires_at);
    CREATE INDEX IF NOT EXISTS idx_guest_list_codes_event
      ON guest_list_codes (event_id);
  `);
}

function guestListShortCodeExists(
  database: Database.Database,
  code: string,
): boolean {
  try {
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM guest_list_codes WHERE lower(short_code) = lower(?) LIMIT 1`,
        )
        .get(code),
    );
  } catch {
    return false;
  }
}

function purgeExpiredGuestListCodes(
  database: Database.Database,
  nowMs = Date.now(),
): void {
  database
    .prepare(`DELETE FROM guest_list_codes WHERE expires_at <= ?`)
    .run(nowMs);
}

export function allocateGuestListShortCode(
  token: string,
  eventId: number,
  expiresAt: number,
  database: Database.Database = getDb(),
): string {
  ensureGuestListCodeTable(database);
  purgeExpiredGuestListCodes(database);
  const insert = database.prepare(
    `INSERT INTO guest_list_codes (short_code, token, event_id, expires_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (let attempt = 0; attempt < SHORT_CODE_ATTEMPTS; attempt++) {
    const code = generateGuestListShortCode();
    if (guestListShortCodeExists(database, code)) {
      continue;
    }
    try {
      insert.run(code, token, eventId, expiresAt);
      return code;
    } catch (error) {
      if (attempt === SHORT_CODE_ATTEMPTS - 1 || !isShortCodeUniqueError(error)) {
        throw error;
      }
    }
  }
  throw new Error('Failed to allocate a unique guest-list short code');
}

export function lookupGuestListByShortCode(
  code: string,
  nowMs = Date.now(),
  database: Database.Database = getDb(),
): { token: string; eventId: number } | null {
  ensureGuestListCodeTable(database);
  const trimmed = code.trim();
  if (!trimmed) {
    return null;
  }
  const row = database
    .prepare(
      `SELECT token, event_id, expires_at FROM guest_list_codes
       WHERE lower(short_code) = lower(?) LIMIT 1`,
    )
    .get(trimmed) as
    | { token: string; event_id: number; expires_at: number }
    | undefined;
  if (!row || row.expires_at <= nowMs) {
    return null;
  }
  return { token: row.token, eventId: row.event_id };
}

export function getEffectiveAdultCount(rsvp: Rsvp): number {
  if (rsvp.status !== 'yes') {
    return 0;
  }
  if (rsvp.adult_count > 0) {
    return rsvp.adult_count;
  }
  return rsvp.guest_count;
}

export function getEffectiveChildCount(rsvp: Rsvp): number {
  if (rsvp.status !== 'yes') {
    return 0;
  }
  return rsvp.child_count;
}

export function getEffectiveTotalAttending(rsvp: Rsvp): number {
  if (rsvp.status !== 'yes') {
    return 0;
  }
  const adults = getEffectiveAdultCount(rsvp);
  const children = getEffectiveChildCount(rsvp);
  if (rsvp.adult_count > 0 || rsvp.child_count > 0) {
    return adults + children;
  }
  return rsvp.guest_count;
}

export interface RsvpDeadlineCheckOptions {
  now?: Date;
  eventDate?: string | null;
  timezone?: string;
}

/** Compare RSVP deadline text to now; null/empty deadline means open. */
export function isRsvpDeadlinePassed(
  deadline: string | null | undefined,
  options: RsvpDeadlineCheckOptions = {},
): boolean {
  const trimmed = deadline?.trim();
  if (!trimmed) {
    return false;
  }

  const now = options.now ?? new Date();
  const parsed = parseRsvpDeadline(trimmed, {
    reference: now,
    eventDate: options.eventDate,
    timezone: resolveEventTimezone(options.timezone),
  });
  if (!parsed.ok) {
    return false;
  }

  return now.getTime() > parsed.instantMs;
}

export function parsePositiveInteger(text: string): number | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\d+$/);
  if (!match) {
    return null;
  }
  const value = parseInt(match[0], 10);
  return value >= 1 ? value : null;
}

export function createEvent(
  name: string,
  date: string,
  location: string,
  organizerPhone: string,
  options: CreateEventOptions = {},
): Event {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO events (
      name, date, location, organizer_phone, rsvp_token, rsvp_code, short_code,
      invitation_count, rsvp_deadline, children_allowed, reminder_days,
      theme, custom_theme, dress_code,
      location_place_id, location_maps_url, location_address, image_filename,
      timezone
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);
  const phone = normalizePhone(organizerPhone);
  const childrenAllowed = options.childrenAllowed !== false ? 1 : 0;
  const reminderDays =
    options.reminderDays !== undefined && options.reminderDays !== null
      ? options.reminderDays
      : null;

  for (let attempt = 0; attempt < RSVP_TOKEN_ATTEMPTS; attempt++) {
    try {
      return stmt.get(
        name,
        date,
        location,
        phone,
        generateRsvpToken(),
        allocateUniqueRsvpCode(),
        allocateUniqueShortCode(),
        options.invitationCount ?? null,
        options.rsvpDeadline?.trim() || null,
        childrenAllowed,
        reminderDays,
        options.theme?.trim() || null,
        options.customTheme?.trim() || null,
        options.dressCode?.trim() || null,
        options.locationPlaceId?.trim() || null,
        options.locationMapsUrl?.trim() || null,
        options.locationAddress?.trim() || null,
        options.imageFilename?.trim() || null,
        resolveEventTimezone(options.timezone),
      ) as Event;
    } catch (error) {
      if (attempt === RSVP_TOKEN_ATTEMPTS - 1 || !isRsvpUniqueError(error)) {
        throw error;
      }
    }
  }
  throw new Error('Failed to allocate a unique RSVP token');
}

export function findEventByRsvpToken(token: string): Event | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM events
    WHERE lower(rsvp_token) = lower(?)
    LIMIT 1
  `);
  return stmt.get(token.trim()) as Event | undefined;
}

/** Shared Individual invitation for the event RSVP link, if one exists. */
export function findReusableIndividualInvitation(
  eventId: number,
): Invitation | undefined {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM invitations
       WHERE event_id = ? AND type = 'individual'
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(eventId) as Invitation | undefined;
}

export function lookupRsvpLinkTarget(token: string): {
  event: Event;
  invitation: Invitation | null;
} | undefined {
  const invitation = findInvitationByRsvpCode(token);
  if (invitation) {
    const event = getEventById(invitation.event_id);
    if (!event || isEventDeleted(event)) {
      return undefined;
    }
    return { event, invitation };
  }

  const event =
    findEventByRsvpCode(token) ?? findEventByRsvpToken(token);
  if (!event || isEventDeleted(event)) {
    return undefined;
  }
  return {
    event,
    invitation: findReusableIndividualInvitation(event.id) ?? null,
  };
}

export function findEventByRsvpCode(code: string): Event | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM events
    WHERE lower(rsvp_code) = lower(?)
    LIMIT 1
  `);
  return stmt.get(code.trim()) as Event | undefined;
}

export function getEventById(id: number): Event | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM events WHERE id = ? LIMIT 1
  `);
  return stmt.get(id) as Event | undefined;
}

export function findEventByNameForOrganizer(
  name: string,
  organizerPhone: string,
): Event | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM events
    WHERE lower(name) = lower(?) AND organizer_phone = ?
      AND (deleted_at IS NULL OR trim(deleted_at) = '')
    ORDER BY id DESC
    LIMIT 1
  `);
  return stmt.get(name, normalizePhone(organizerPhone)) as Event | undefined;
}

export function listEventsForOrganizer(organizerPhone: string): Event[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM events
    WHERE organizer_phone = ?
      AND (deleted_at IS NULL OR trim(deleted_at) = '')
    ORDER BY created_at DESC
  `);
  return stmt.all(normalizePhone(organizerPhone)) as Event[];
}

export function listEventsWithReminderConfigured(): Event[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM events
    WHERE reminder_days IS NOT NULL
      AND reminder_days >= 1
      AND reminder_sent_at IS NULL
      AND rsvp_deadline IS NOT NULL
      AND trim(rsvp_deadline) != ''
      AND (cancelled_at IS NULL OR trim(cancelled_at) = '')
      AND (deleted_at IS NULL OR trim(deleted_at) = '')
    ORDER BY created_at ASC
  `);
  return stmt.all() as Event[];
}

export function getPendingGuestPhonesForEvent(eventId: number): string[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT r.phone
    FROM rsvps r
    INNER JOIN guests g ON g.event_id = r.event_id AND g.phone = r.phone
    WHERE r.event_id = ? AND r.status = 'pending'
    ORDER BY g.invited_at ASC
  `);
  const rows = stmt.all(eventId) as Array<{ phone: string }>;
  return rows
    .map((row) => row.phone)
    .filter((phone) => !isWebGuestPhone(phone));
}

export function markReminderSent(eventId: number): void {
  const database = getDb();
  database
    .prepare(
      `UPDATE events SET reminder_sent_at = datetime('now') WHERE id = ?`,
    )
    .run(eventId);
}

export function listEventsPendingOrganizerPostEvent(): Event[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM events
       WHERE organizer_post_event_sent_at IS NULL
         AND (deleted_at IS NULL OR trim(deleted_at) = '')
       ORDER BY id ASC`,
    )
    .all() as Event[];
}

/** Claims the one-shot organizer post-event message. Returns false if already sent. */
export function markOrganizerPostEventSent(eventId: number): boolean {
  const database = getDb();
  const result = database
    .prepare(
      `UPDATE events
       SET organizer_post_event_sent_at = datetime('now')
       WHERE id = ? AND organizer_post_event_sent_at IS NULL`,
    )
    .run(eventId);
  return result.changes > 0;
}

/** Claims the one-shot guest thank-you. Returns false if already sent or guest missing. */
export function markGuestThankYouSent(eventId: number, phone: string): boolean {
  const database = getDb();
  const result = database
    .prepare(
      `UPDATE guests
       SET thank_you_sent_at = datetime('now')
       WHERE event_id = ? AND phone = ? AND thank_you_sent_at IS NULL`,
    )
    .run(eventId, normalizePhone(phone));
  return result.changes > 0;
}

export function addGuests(
  eventId: number,
  phones: string[],
  invitationId?: number | null,
): Guest[] {
  const database = getDb();
  const insertGuest = database.prepare(`
    INSERT INTO guests (event_id, phone, invitation_id)
    VALUES (?, ?, ?)
    ON CONFLICT (event_id, phone) DO UPDATE SET
      invited_at = datetime('now'),
      invitation_id = COALESCE(excluded.invitation_id, guests.invitation_id)
    RETURNING *
  `);
  const insertRsvp = database.prepare(`
    INSERT INTO rsvps (event_id, phone, status)
    VALUES (?, ?, 'pending')
    ON CONFLICT (event_id, phone) DO NOTHING
  `);

  const guests: Guest[] = [];
  const tx = database.transaction((numbers: string[]) => {
    for (const phone of numbers) {
      const normalized = normalizePhone(phone);
      const guest = insertGuest.get(
        eventId,
        normalized,
        invitationId ?? null,
      ) as Guest;
      insertRsvp.run(eventId, normalized);
      guests.push(guest);
    }
  });
  tx(phones);
  return guests;
}

export function getGuest(eventId: number, phone: string): Guest | undefined {
  const database = getDb();
  return database
    .prepare(`SELECT * FROM guests WHERE event_id = ? AND phone = ?`)
    .get(eventId, normalizePhone(phone)) as Guest | undefined;
}

export function createInvitation(input: {
  eventId: number;
  type: InvitationType;
  familyName?: string | null;
  groupName?: string | null;
  maxGuests?: number | null;
  rsvpCode?: string | null;
  shortCode?: string | null;
}): Invitation {
  const database = getDb();
  return database
    .prepare(
      `INSERT INTO invitations (
         event_id, type, family_name, group_name, max_guests, rsvp_code, short_code
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      input.eventId,
      input.type,
      input.familyName?.trim() || null,
      input.groupName?.trim() || null,
      input.maxGuests ?? null,
      input.rsvpCode ?? null,
      input.shortCode ?? null,
    ) as Invitation;
}

export function createFamilyInvitation(
  eventId: number,
  familyName: string,
  maxGuests: number,
): Invitation {
  let lastError: unknown;
  for (let attempt = 0; attempt < RSVP_CODE_ATTEMPTS; attempt++) {
    try {
      return createInvitation({
        eventId,
        type: 'family',
        familyName,
        maxGuests,
        rsvpCode: allocateUniqueRsvpCode(),
        shortCode: allocateUniqueShortCode(),
      });
    } catch (error) {
      lastError = error;
      if (!isRsvpCodeUniqueError(error) && !isShortCodeUniqueError(error)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to allocate a unique family RSVP code');
}

export function addInvitationMember(
  invitationId: number,
  memberName: string,
): InvitationMember {
  const trimmed = memberName.trim();
  const database = getDb();
  return database
    .prepare(
      `INSERT INTO invitation_members (invitation_id, member_name)
       VALUES (?, ?)
       RETURNING *`,
    )
    .get(invitationId, trimmed) as InvitationMember;
}

export function getInvitationById(id: number): Invitation | undefined {
  const database = getDb();
  return database
    .prepare(`SELECT * FROM invitations WHERE id = ? LIMIT 1`)
    .get(id) as Invitation | undefined;
}

export function findInvitationByRsvpCode(code: string): Invitation | undefined {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM invitations
       WHERE rsvp_code IS NOT NULL AND lower(rsvp_code) = lower(?)
       LIMIT 1`,
    )
    .get(code.trim()) as Invitation | undefined;
}

export function findEventByShortCode(code: string): Event | undefined {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM events
       WHERE short_code IS NOT NULL AND lower(short_code) = lower(?)
       LIMIT 1`,
    )
    .get(code.trim()) as Event | undefined;
}

export function findInvitationByShortCode(code: string): Invitation | undefined {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM invitations
       WHERE short_code IS NOT NULL AND lower(short_code) = lower(?)
       LIMIT 1`,
    )
    .get(code.trim()) as Invitation | undefined;
}

export function lookupShortRsvpTarget(code: string): {
  event: Event;
  invitation: Invitation | null;
} | undefined {
  const invitation = findInvitationByShortCode(code);
  if (invitation) {
    const event = getEventById(invitation.event_id);
    if (!event || isEventDeleted(event)) {
      return undefined;
    }
    return { event, invitation };
  }

  const event = findEventByShortCode(code);
  if (!event || isEventDeleted(event)) {
    return undefined;
  }
  return {
    event,
    invitation: findReusableIndividualInvitation(event.id) ?? null,
  };
}

export function listInvitationsForEvent(eventId: number): Invitation[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM invitations WHERE event_id = ? ORDER BY id ASC`,
    )
    .all(eventId) as Invitation[];
}

export function listInvitationMembers(invitationId: number): InvitationMember[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM invitation_members
       WHERE invitation_id = ?
       ORDER BY id ASC`,
    )
    .all(invitationId) as InvitationMember[];
}

export function listInvitationsWithMembers(
  eventId: number,
): InvitationWithMembers[] {
  return listInvitationsForEvent(eventId).map((invitation) => ({
    ...invitation,
    members:
      invitation.type === 'group' ? listInvitationMembers(invitation.id) : [],
  }));
}

export function checkFamilyRsvpLimit(
  invitation: Invitation | null | undefined,
  adults: number,
  children: number,
): { allowed: true } | { allowed: false; maxGuests: number } {
  if (!invitation || invitation.type !== 'family' || invitation.max_guests == null) {
    return { allowed: true };
  }
  if (adults + children <= invitation.max_guests) {
    return { allowed: true };
  }
  return { allowed: false, maxGuests: invitation.max_guests };
}

export function getEventGuests(eventId: number): Guest[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM guests WHERE event_id = ? ORDER BY invited_at ASC
  `);
  return stmt.all(eventId) as Guest[];
}

export function upsertRsvp(
  eventId: number,
  phone: string,
  status: RsvpStatus,
  guestCount: number,
  rawReply: string,
  adultCount = 0,
  childCount = 0,
): Rsvp {
  const database = getDb();
  const adults = status === 'yes' ? Math.max(adultCount, 0) : 0;
  const children = status === 'yes' ? Math.max(childCount, 0) : 0;
  const total =
    status === 'yes'
      ? adults > 0 || children > 0
        ? adults + children
        : Math.max(guestCount, 1)
      : 0;

  const stmt = database.prepare(`
    INSERT INTO rsvps (event_id, phone, status, guest_count, adult_count, child_count, raw_reply, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (event_id, phone) DO UPDATE SET
      status = excluded.status,
      guest_count = excluded.guest_count,
      adult_count = excluded.adult_count,
      child_count = excluded.child_count,
      raw_reply = excluded.raw_reply,
      updated_at = datetime('now')
    RETURNING *
  `);
  return stmt.get(
    eventId,
    normalizePhone(phone),
    status,
    total,
    adults,
    children,
    rawReply,
  ) as Rsvp;
}

export function getRsvp(eventId: number, phone: string): Rsvp | undefined {
  const database = getDb();
  return database
    .prepare(`SELECT * FROM rsvps WHERE event_id = ? AND phone = ?`)
    .get(eventId, normalizePhone(phone)) as Rsvp | undefined;
}

export function setGuestConversationId(
  eventId: number,
  phone: string,
  conversationId: string,
): void {
  const database = getDb();
  database
    .prepare(
      `UPDATE guests SET conversation_id = ? WHERE event_id = ? AND phone = ?`,
    )
    .run(conversationId, eventId, normalizePhone(phone));
}

export function setGuestName(
  eventId: number,
  phone: string,
  name: string,
): void {
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  const database = getDb();
  database
    .prepare(
      `UPDATE guests SET name = ? WHERE event_id = ? AND phone = ?`,
    )
    .run(trimmed, eventId, normalizePhone(phone));
}

export function getGuestName(eventId: number, phone: string): string | null {
  const database = getDb();
  const row = database
    .prepare(`SELECT name FROM guests WHERE event_id = ? AND phone = ?`)
    .get(eventId, normalizePhone(phone)) as { name: string | null } | undefined;
  return row?.name ?? null;
}

export function getGuestWhatsAppPhone(
  eventId: number,
  phone: string,
): string | null {
  const guest = getGuest(eventId, phone);
  return parseGuestWhatsAppNumber(guest?.whatsapp_phone ?? null);
}

export function findGuestByWhatsAppPhone(
  eventId: number,
  whatsappPhone: string,
): Guest | undefined {
  const normalized = parseGuestWhatsAppNumber(whatsappPhone);
  if (!normalized) {
    return undefined;
  }
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM guests WHERE event_id = ? AND whatsapp_phone = ? LIMIT 1`,
    )
    .get(eventId, normalized) as Guest | undefined;
}

export function setGuestWhatsAppPhone(
  eventId: number,
  phone: string,
  whatsappPhone: string,
  organizerPhone: string,
): { ok: true; phone: string } | { ok: false; reason: 'invalid' | 'organizer' | 'taken' } {
  const normalized = parseGuestWhatsAppNumber(whatsappPhone);
  if (!normalized) {
    return { ok: false, reason: 'invalid' };
  }
  if (normalizePhone(organizerPhone) === normalized) {
    return { ok: false, reason: 'organizer' };
  }
  const ownerPhone = normalizePhone(phone);
  const existing = findGuestByWhatsAppPhone(eventId, normalized);
  if (existing && existing.phone !== ownerPhone) {
    return { ok: false, reason: 'taken' };
  }
  addGuests(eventId, [ownerPhone]);
  const database = getDb();
  database
    .prepare(
      `UPDATE guests SET whatsapp_phone = ? WHERE event_id = ? AND phone = ?`,
    )
    .run(normalized, eventId, ownerPhone);
  return { ok: true, phone: normalized };
}

export function upsertMessageSession(
  phone: string,
  conversationId: string,
  accountId: string,
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO message_sessions (phone, conversation_id, account_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (phone, account_id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         account_id = excluded.account_id,
         updated_at = datetime('now')`,
    )
    .run(normalizePhone(phone), conversationId, accountId);
}

export function getMessageSession(
  phone: string,
  accountId?: string | null,
): MessageSession | undefined {
  const database = getDb();
  const normalized = normalizePhone(phone);
  const requested = accountId?.trim();
  if (requested) {
    return database
      .prepare(
        `SELECT * FROM message_sessions WHERE phone = ? AND account_id = ?`,
      )
      .get(normalized, requested) as MessageSession | undefined;
  }
  const connect = connectWhatsAppAccountId();
  if (connect) {
    const connectSession = database
      .prepare(
        `SELECT * FROM message_sessions WHERE phone = ? AND account_id = ?`,
      )
      .get(normalized, connect) as MessageSession | undefined;
    if (connectSession) {
      return connectSession;
    }
  }
  return database
    .prepare(
      `SELECT * FROM message_sessions
       WHERE phone = ?
       ORDER BY updated_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(normalized) as MessageSession | undefined;
}

export function listRsvpsForEvent(eventId: number): Rsvp[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT r.*, g.name AS guest_name
    FROM rsvps r
    LEFT JOIN guests g ON g.event_id = r.event_id AND g.phone = r.phone
    WHERE r.event_id = ?
    ORDER BY
      CASE r.status
        WHEN 'yes' THEN 1
        WHEN 'maybe' THEN 2
        WHEN 'no' THEN 3
        ELSE 4
      END,
      r.updated_at ASC
  `);
  return stmt.all(eventId) as Rsvp[];
}

export function getRsvpSummary(eventId: number): RsvpSummary {
  const database = getDb();
  const counts = database
    .prepare(
      `
    SELECT status, COUNT(*) as count
    FROM rsvps
    WHERE event_id = ?
    GROUP BY status
  `,
    )
    .all(eventId) as Array<{ status: string; count: number }>;

  const guestTotal = database
    .prepare(
      `
    SELECT COALESCE(SUM(guest_count), 0) as total
    FROM rsvps
    WHERE event_id = ? AND status = 'yes'
  `,
    )
    .get(eventId) as { total: number };

  const attendance = database
    .prepare(
      `
    SELECT
      COALESCE(SUM(CASE WHEN adult_count > 0 THEN adult_count WHEN status = 'yes' THEN guest_count ELSE 0 END), 0) AS adults,
      COALESCE(SUM(CASE WHEN status = 'yes' THEN child_count ELSE 0 END), 0) AS children
    FROM rsvps
    WHERE event_id = ? AND status = 'yes'
  `,
    )
    .get(eventId) as { adults: number; children: number };

  const summary: RsvpSummary = {
    yes: 0,
    no: 0,
    maybe: 0,
    pending: 0,
    totalGuests: guestTotal.total,
    totalAdults: attendance.adults,
    totalChildren: attendance.children,
    expectedAttendance: attendance.adults + attendance.children,
  };

  for (const row of counts) {
    if (row.status in summary) {
      summary[row.status as keyof Omit<RsvpSummary, 'totalGuests'>] = row.count;
    }
  }

  return summary;
}

export function findLatestPendingEventForGuest(phone: string): Event | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT e.*
    FROM events e
    JOIN guests g ON g.event_id = e.id
    LEFT JOIN rsvps r ON r.event_id = e.id AND r.phone = g.phone
    WHERE g.phone = ?
      AND e.cancelled_at IS NULL
      AND (e.deleted_at IS NULL OR trim(e.deleted_at) = '')
      AND (r.status IS NULL OR r.status = 'pending' OR r.status IN ('yes', 'no', 'maybe'))
    ORDER BY g.invited_at DESC
    LIMIT 1
  `);
  return stmt.get(normalizePhone(phone)) as Event | undefined;
}

export function getConversationState(
  organizerPhone: string,
  accountId?: string | null,
): ConversationState | undefined {
  const database = getDb();
  const phone = normalizePhone(organizerPhone);
  const scope = conversationAccountScope(accountId);
  const stmt = database.prepare(`
    SELECT * FROM conversation_states
    WHERE organizer_phone = ? AND account_id = ?
  `);
  const exact = stmt.get(phone, scope) as ConversationState | undefined;
  if (exact) {
    return exact;
  }
  if (scope === CONNECT_CONVERSATION_ACCOUNT_ID) {
    const connect = connectWhatsAppAccountId();
    if (connect) {
      return stmt.get(phone, connect) as ConversationState | undefined;
    }
  }
  return undefined;
}

export function setConversationState(
  organizerPhone: string,
  state: ConversationStep,
  draft: ConversationDraft = {},
  accountId?: string | null,
): ConversationState {
  const database = getDb();
  const existing = getConversationState(organizerPhone, accountId);
  const previousImage = existing?.image_filename ?? null;
  const merged = {
    name: draft.name !== undefined ? draft.name : (existing?.name ?? null),
    date: draft.date !== undefined ? draft.date : (existing?.date ?? null),
    location:
      draft.location !== undefined ? draft.location : (existing?.location ?? null),
    invitation_count:
      draft.invitation_count !== undefined
        ? draft.invitation_count
        : (existing?.invitation_count ?? null),
    rsvp_deadline:
      draft.rsvp_deadline !== undefined
        ? draft.rsvp_deadline
        : (existing?.rsvp_deadline ?? null),
    children_allowed:
      draft.children_allowed !== undefined
        ? draft.children_allowed
        : (existing?.children_allowed ?? null),
    reminder_days:
      draft.reminder_days !== undefined
        ? draft.reminder_days
        : (existing?.reminder_days ?? null),
    event_id:
      draft.event_id !== undefined ? draft.event_id : (existing?.event_id ?? null),
    adult_count:
      draft.adult_count !== undefined
        ? draft.adult_count
        : (existing?.adult_count ?? null),
    child_count:
      draft.child_count !== undefined
        ? draft.child_count
        : (existing?.child_count ?? null),
    invitation_id:
      draft.invitation_id !== undefined
        ? draft.invitation_id
        : (existing?.invitation_id ?? null),
    invite_type:
      draft.invite_type !== undefined
        ? draft.invite_type
        : (existing?.invite_type ?? null),
    family_name:
      draft.family_name !== undefined
        ? draft.family_name
        : (existing?.family_name ?? null),
    group_name:
      draft.group_name !== undefined
        ? draft.group_name
        : (existing?.group_name ?? null),
    max_guests:
      draft.max_guests !== undefined
        ? draft.max_guests
        : (existing?.max_guests ?? null),
    update_message:
      draft.update_message !== undefined
        ? draft.update_message
        : (existing?.update_message ?? null),
    theme: draft.theme !== undefined ? draft.theme : (existing?.theme ?? null),
    custom_theme:
      draft.custom_theme !== undefined
        ? draft.custom_theme
        : (existing?.custom_theme ?? null),
    dress_code:
      draft.dress_code !== undefined
        ? draft.dress_code
        : (existing?.dress_code ?? null),
    location_place_id:
      draft.location_place_id !== undefined
        ? draft.location_place_id
        : (existing?.location_place_id ?? null),
    location_maps_url:
      draft.location_maps_url !== undefined
        ? draft.location_maps_url
        : (existing?.location_maps_url ?? null),
    location_address:
      draft.location_address !== undefined
        ? draft.location_address
        : (existing?.location_address ?? null),
    image_filename:
      draft.image_filename !== undefined
        ? draft.image_filename
        : (existing?.image_filename ?? null),
    vendor_draft:
      draft.vendor_draft !== undefined
        ? draft.vendor_draft
        : (existing?.vendor_draft ?? null),
    timezone:
      draft.timezone !== undefined
        ? draft.timezone
        : (existing?.timezone ?? null),
  };

  const stmt = database.prepare(`
    INSERT INTO conversation_states (
      organizer_phone, account_id, state, name, date, location,
      invitation_count, rsvp_deadline, children_allowed, reminder_days,
      event_id, adult_count, child_count, invitation_id, invite_type,
      family_name, group_name, max_guests, update_message,
      theme, custom_theme, dress_code,
      location_place_id, location_maps_url, location_address, image_filename,
      vendor_draft, timezone, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(organizer_phone, account_id) DO UPDATE SET
      state = excluded.state,
      name = excluded.name,
      date = excluded.date,
      location = excluded.location,
      invitation_count = excluded.invitation_count,
      rsvp_deadline = excluded.rsvp_deadline,
      children_allowed = excluded.children_allowed,
      reminder_days = excluded.reminder_days,
      event_id = excluded.event_id,
      adult_count = excluded.adult_count,
      child_count = excluded.child_count,
      invitation_id = excluded.invitation_id,
      invite_type = excluded.invite_type,
      family_name = excluded.family_name,
      group_name = excluded.group_name,
      max_guests = excluded.max_guests,
      update_message = excluded.update_message,
      theme = excluded.theme,
      custom_theme = excluded.custom_theme,
      dress_code = excluded.dress_code,
      location_place_id = excluded.location_place_id,
      location_maps_url = excluded.location_maps_url,
      location_address = excluded.location_address,
      image_filename = excluded.image_filename,
      vendor_draft = excluded.vendor_draft,
      timezone = excluded.timezone,
      updated_at = datetime('now')
    RETURNING *
  `);
  const saved = stmt.get(
    normalizePhone(organizerPhone),
    conversationAccountScope(accountId),
    state,
    merged.name,
    merged.date,
    merged.location,
    merged.invitation_count,
    merged.rsvp_deadline,
    merged.children_allowed,
    merged.reminder_days,
    merged.event_id,
    merged.adult_count,
    merged.child_count,
    merged.invitation_id,
    merged.invite_type,
    merged.family_name,
    merged.group_name,
    merged.max_guests,
    merged.update_message,
    merged.theme,
    merged.custom_theme,
    merged.dress_code,
    merged.location_place_id,
    merged.location_maps_url,
    merged.location_address,
    merged.image_filename,
    merged.vendor_draft,
    merged.timezone,
  ) as ConversationState;

  if (
    previousImage &&
    previousImage !== merged.image_filename
  ) {
    deleteEventImageIfUnreferenced(previousImage);
  }
  return saved;
}

export function clearConversationState(
  organizerPhone: string,
  accountId?: string | null,
): void {
  const database = getDb();
  const existing = getConversationState(organizerPhone, accountId);
  const phone = normalizePhone(organizerPhone);
  const scope = conversationAccountScope(accountId);
  database
    .prepare(
      `DELETE FROM conversation_states
       WHERE organizer_phone = ? AND account_id = ?`,
    )
    .run(phone, scope);
  if (scope === CONNECT_CONVERSATION_ACCOUNT_ID) {
    const connect = connectWhatsAppAccountId();
    if (connect) {
      database
        .prepare(
          `DELETE FROM conversation_states
           WHERE organizer_phone = ? AND account_id = ?`,
        )
        .run(phone, connect);
    }
  }
  deleteEventImageIfUnreferenced(existing?.image_filename);
}

export function isWebhookProcessed(eventId: string): boolean {
  const database = getDb();
  const row = database
    .prepare('SELECT 1 FROM webhook_events WHERE id = ?')
    .get(eventId);
  return Boolean(row);
}

export function markWebhookProcessed(eventId: string): void {
  const database = getDb();
  database
    .prepare('INSERT OR IGNORE INTO webhook_events (id) VALUES (?)')
    .run(eventId);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function isEventCancelled(event: Event | null | undefined): boolean {
  return Boolean(event?.cancelled_at?.trim());
}

export function isEventDeleted(event: Event | null | undefined): boolean {
  return Boolean(event?.deleted_at?.trim());
}

export function updateEventDetails(
  eventId: number,
  details: {
    name: string;
    date: string;
    location: string;
    theme?: string | null;
    custom_theme?: string | null;
    dress_code?: string | null;
    rsvp_deadline?: string | null;
    location_place_id?: string | null;
    location_maps_url?: string | null;
    location_address?: string | null;
    image_filename?: string | null;
    timezone?: string | null;
  },
): Event | undefined {
  const database = getDb();
  const existing = getEventById(eventId);
  if (!existing) {
    return undefined;
  }
  const keep = (
    value: string | null | undefined,
    previous: string | null | undefined,
  ): string | null =>
    value !== undefined ? value?.trim() || null : previous?.trim() || null;
  return database
    .prepare(
      `UPDATE events
       SET name = ?, date = ?, location = ?,
           theme = ?, custom_theme = ?, dress_code = ?,
           rsvp_deadline = ?,
           location_place_id = ?, location_maps_url = ?, location_address = ?,
           image_filename = ?, timezone = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(
      details.name,
      details.date,
      details.location,
      keep(details.theme, existing.theme),
      keep(details.custom_theme, existing.custom_theme),
      keep(details.dress_code, existing.dress_code),
      keep(details.rsvp_deadline, existing.rsvp_deadline),
      keep(details.location_place_id, existing.location_place_id),
      keep(details.location_maps_url, existing.location_maps_url),
      keep(details.location_address, existing.location_address),
      keep(details.image_filename, existing.image_filename),
      keep(details.timezone, existing.timezone),
      eventId,
    ) as Event | undefined;
}

export function cancelEvent(eventId: number): Event | undefined {
  const database = getDb();
  return database
    .prepare(
      `UPDATE events
       SET cancelled_at = COALESCE(cancelled_at, datetime('now'))
       WHERE id = ?
       RETURNING *`,
    )
    .get(eventId) as Event | undefined;
}

export function deleteEvent(eventId: number): Event | undefined {
  const database = getDb();
  return database
    .prepare(
      `UPDATE events
       SET deleted_at = COALESCE(deleted_at, datetime('now'))
       WHERE id = ?
       RETURNING *`,
    )
    .get(eventId) as Event | undefined;
}

/**
 * Soft-delete only events the organizer owns. Already-deleted and foreign IDs
 * are skipped — they never delete someone else's event.
 */
export function softDeleteOwnedEvents(
  organizerPhone: string,
  eventIds: number[],
): { deletedIds: number[]; skippedIds: number[] } {
  const phone = normalizePhone(organizerPhone);
  const seen = new Set<number>();
  const deletedIds: number[] = [];
  const skippedIds: number[] = [];

  for (const rawId of eventIds) {
    const eventId = Number(rawId);
    if (!Number.isInteger(eventId) || eventId < 1 || seen.has(eventId)) {
      continue;
    }
    seen.add(eventId);

    const event = getEventById(eventId);
    if (
      !event ||
      event.organizer_phone !== phone ||
      isEventDeleted(event)
    ) {
      skippedIds.push(eventId);
      continue;
    }

    const deleted = deleteEvent(eventId);
    if (deleted) {
      deletedIds.push(eventId);
    } else {
      skippedIds.push(eventId);
    }
  }

  return { deletedIds, skippedIds };
}

function isOrganizerGuestPhone(phone: string, organizerPhone: string): boolean {
  return normalizePhone(phone) === normalizePhone(organizerPhone);
}

function isWhatsAppRecipientPhone(phone: string, organizerPhone: string): boolean {
  return (
    !isWebGuestPhone(phone) && !isOrganizerGuestPhone(phone, organizerPhone)
  );
}

/**
 * Original invitation WhatsApp recipient, if one is already on file.
 * Never invents a number from cookies, names, or the organizer's own phone.
 */
export function findInvitationRecipient(
  eventId: number,
  invitation: Invitation | null,
  organizerPhone: string,
): { phone: string; invitationId: number | null } | null {
  const guests = getEventGuests(eventId).filter((guest) =>
    isWhatsAppRecipientPhone(guest.phone, organizerPhone),
  );

  if (invitation) {
    const linked = guests.filter((guest) => guest.invitation_id === invitation.id);
    if (linked.length === 0) {
      return null;
    }
    if (invitation.type === 'family' || linked.length === 1) {
      return { phone: linked[0].phone, invitationId: invitation.id };
    }
    return null;
  }

  const familyIds = new Set(
    listInvitationsForEvent(eventId)
      .filter((row) => row.type === 'family')
      .map((row) => row.id),
  );
  const nonFamily = guests.filter(
    (guest) => guest.invitation_id == null || !familyIds.has(guest.invitation_id),
  );
  const uniquePhones = [...new Set(nonFamily.map((guest) => guest.phone))];
  if (uniquePhones.length !== 1) {
    return null;
  }
  const match = nonFamily.find((guest) => guest.phone === uniquePhones[0]);
  return match
    ? { phone: match.phone, invitationId: match.invitation_id ?? null }
    : null;
}

export function listEventUpdateTargets(eventId: number): EventUpdateTarget[] {
  const event = getEventById(eventId);
  const organizerPhone = event?.organizer_phone ?? '';
  const invitations = listInvitationsForEvent(eventId);
  const guests = getEventGuests(eventId).filter((guest) =>
    isWhatsAppRecipientPhone(guest.phone, organizerPhone),
  );
  const usedGuestIds = new Set<number>();
  const seenPhones = new Set<string>();
  const targets: EventUpdateTarget[] = [];

  for (const invitation of invitations.filter((row) => row.type === 'family')) {
    const familyGuests = guests.filter(
      (guest) => guest.invitation_id === invitation.id,
    );
    if (familyGuests.length === 0) {
      continue;
    }
    const contact = familyGuests[0];
    for (const guest of familyGuests) {
      usedGuestIds.add(guest.id);
    }
    const phone = normalizePhone(contact.phone);
    if (seenPhones.has(phone)) {
      continue;
    }
    seenPhones.add(phone);
    targets.push({
      invitationId: invitation.id,
      guestId: contact.id,
      phone: contact.phone,
      name: contact.name,
      familyName: invitation.family_name,
      invitationType: invitation.type,
    });
  }

  for (const guest of guests) {
    if (usedGuestIds.has(guest.id)) {
      continue;
    }
    const phone = normalizePhone(guest.phone);
    if (seenPhones.has(phone)) {
      continue;
    }
    seenPhones.add(phone);
    const invitation = guest.invitation_id
      ? getInvitationById(guest.invitation_id)
      : undefined;
    targets.push({
      invitationId: guest.invitation_id ?? null,
      guestId: guest.id,
      phone: guest.phone,
      name: guest.name,
      familyName: invitation?.family_name ?? null,
      invitationType: invitation?.type ?? null,
    });
  }

  const webGuests = getEventGuests(eventId).filter((guest) =>
    isWebGuestPhone(guest.phone),
  );
  for (const guest of webGuests) {
    const notify = parseGuestWhatsAppNumber(guest.whatsapp_phone ?? null);
    if (!notify || isOrganizerGuestPhone(notify, organizerPhone)) {
      continue;
    }
    if (seenPhones.has(notify)) {
      continue;
    }
    seenPhones.add(notify);
    const invitation = guest.invitation_id
      ? getInvitationById(guest.invitation_id)
      : undefined;
    targets.push({
      invitationId: guest.invitation_id ?? null,
      guestId: guest.id,
      phone: notify,
      name: guest.name,
      familyName: invitation?.family_name ?? null,
      invitationType: invitation?.type ?? 'individual',
    });
  }

  return targets;
}

/**
 * Awaiting = known WhatsApp invitation phones without Yes/No/Maybe.
 * Does not invent awaiting for unopened reusable Individual forwards.
 * Family invitations count as one unit when they have a WhatsApp phone.
 */
export function countKnownAwaitingRecipients(input: {
  organizerPhone: string;
  guests: Guest[];
  rsvps: Array<{ phone: string; status: string }>;
  invitations?: Array<{ id: number; type: string }>;
}): number {
  const responded = new Set(
    input.rsvps
      .filter(
        (row) =>
          row.status === 'yes' || row.status === 'no' || row.status === 'maybe',
      )
      .map((row) => row.phone),
  );
  const guests = input.guests.filter((guest) =>
    isWhatsAppRecipientPhone(guest.phone, input.organizerPhone),
  );
  const usedGuestIds = new Set<number>();
  const seenPhones = new Set<string>();
  let awaiting = 0;

  for (const invitation of (input.invitations ?? []).filter(
    (row) => row.type === 'family',
  )) {
    const familyGuests = guests.filter(
      (guest) => guest.invitation_id === invitation.id,
    );
    if (familyGuests.length === 0) {
      continue;
    }
    for (const guest of familyGuests) {
      usedGuestIds.add(guest.id);
    }
    if (!familyGuests.some((guest) => responded.has(guest.phone))) {
      awaiting += 1;
    }
  }

  for (const guest of guests) {
    if (usedGuestIds.has(guest.id)) {
      continue;
    }
    const phone = normalizePhone(guest.phone);
    if (seenPhones.has(phone)) {
      continue;
    }
    seenPhones.add(phone);
    if (!responded.has(guest.phone)) {
      awaiting += 1;
    }
  }

  return awaiting;
}

export function createEventUpdate(input: {
  eventId: number;
  type: EventUpdateType;
  name: string;
  date: string;
  location: string;
  message?: string | null;
}): EventUpdate {
  const database = getDb();
  return database
    .prepare(
      `INSERT INTO event_updates (
         event_id, type, acknowledgement_required,
         snapshot_name, snapshot_date, snapshot_location, message
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      input.eventId,
      input.type,
      input.type === 'ack' ? 1 : 0,
      input.name,
      input.date,
      input.location,
      input.message?.trim() || null,
    ) as EventUpdate;
}

export function allocateUniqueAckToken(
  database: Database.Database = getDb(),
): string {
  for (let attempt = 0; attempt < ACK_TOKEN_ATTEMPTS; attempt++) {
    const token = generateAckToken();
    const hit = database
      .prepare(
        `SELECT 1 FROM event_update_recipients
         WHERE ack_token IS NOT NULL AND lower(ack_token) = lower(?)
         LIMIT 1`,
      )
      .get(token);
    if (!hit) {
      return token;
    }
  }
  throw new Error('Failed to allocate a unique acknowledgement token');
}

export function insertEventUpdateRecipient(input: {
  updateId: number;
  invitationId?: number | null;
  guestId?: number | null;
  phone: string;
  sendStatus: EventUpdateSendStatus;
  ackToken?: string | null;
}): EventUpdateRecipient {
  const database = getDb();
  const ackToken = input.ackToken?.trim() || allocateUniqueAckToken(database);
  return database
    .prepare(
      `INSERT INTO event_update_recipients (
         update_id, invitation_id, guest_id, phone, send_status, ack_token
       )
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(update_id, phone) DO UPDATE SET
         send_status = excluded.send_status,
         invitation_id = COALESCE(excluded.invitation_id, invitation_id),
         guest_id = COALESCE(excluded.guest_id, guest_id),
         ack_token = COALESCE(event_update_recipients.ack_token, excluded.ack_token)
       RETURNING *`,
    )
    .get(
      input.updateId,
      input.invitationId ?? null,
      input.guestId ?? null,
      normalizePhone(input.phone),
      input.sendStatus,
      ackToken,
    ) as EventUpdateRecipient;
}

export function getEventUpdateById(id: number): EventUpdate | undefined {
  const database = getDb();
  return database
    .prepare(`SELECT * FROM event_updates WHERE id = ? LIMIT 1`)
    .get(id) as EventUpdate | undefined;
}

export function listEventUpdatesForEvent(eventId: number): EventUpdate[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM event_updates WHERE event_id = ? ORDER BY id DESC`,
    )
    .all(eventId) as EventUpdate[];
}

export function listEventUpdateRecipients(
  updateId: number,
): EventUpdateRecipient[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT r.*, g.name AS guest_name, i.family_name, i.type AS invitation_type
       FROM event_update_recipients r
       LEFT JOIN guests g ON g.id = r.guest_id
       LEFT JOIN invitations i ON i.id = r.invitation_id
       WHERE r.update_id = ?
       ORDER BY r.id ASC`,
    )
    .all(updateId) as EventUpdateRecipient[];
}

export function getEventUpdateRecipient(
  updateId: number,
  phone: string,
): EventUpdateRecipient | undefined {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM event_update_recipients
       WHERE update_id = ? AND phone = ?
       LIMIT 1`,
    )
    .get(updateId, normalizePhone(phone)) as EventUpdateRecipient | undefined;
}

export interface AckUpdateTarget {
  update: EventUpdate;
  recipient: EventUpdateRecipient;
  event: Event;
  invitation: Invitation | null;
}

export function normalizeAckToken(token: string): string {
  return token.trim().toLowerCase();
}

export function lookupAckUpdateTarget(token: string): AckUpdateTarget | undefined {
  const normalized = normalizeAckToken(token);
  if (!normalized) {
    return undefined;
  }
  const database = getDb();
  const recipient = database
    .prepare(
      `SELECT r.*, g.name AS guest_name, i.family_name, i.type AS invitation_type
       FROM event_update_recipients r
       LEFT JOIN guests g ON g.id = r.guest_id
       LEFT JOIN invitations i ON i.id = r.invitation_id
       WHERE r.ack_token IS NOT NULL AND lower(r.ack_token) = ?
       LIMIT 1`,
    )
    .get(normalized) as EventUpdateRecipient | undefined;
  if (!recipient) {
    return undefined;
  }
  const update = getEventUpdateById(recipient.update_id);
  const event = update ? getEventById(update.event_id) : undefined;
  if (!update || !event || isEventDeleted(event)) {
    return undefined;
  }
  const invitation = recipient.invitation_id
    ? getInvitationById(recipient.invitation_id)
    : undefined;
  return {
    update,
    recipient,
    event,
    invitation: invitation ?? null,
  };
}

/** Records an ack for the recipient that owns this token. Other tokens cannot be used. */
export function acknowledgeUpdateRecipientByToken(token: string): {
  ok: boolean;
  already: boolean;
  recipient?: EventUpdateRecipient;
  update?: EventUpdate;
  event?: Event;
} {
  const target = lookupAckUpdateTarget(token);
  if (!target || target.recipient.send_status !== 'sent') {
    return { ok: false, already: false };
  }
  if (target.recipient.acknowledged_at) {
    return {
      ok: true,
      already: true,
      recipient: target.recipient,
      update: target.update,
      event: target.event,
    };
  }

  const database = getDb();
  const updated = database
    .prepare(
      `UPDATE event_update_recipients
       SET acknowledged_at = datetime('now')
       WHERE id = ? AND send_status = 'sent' AND acknowledged_at IS NULL
       RETURNING *`,
    )
    .get(target.recipient.id) as EventUpdateRecipient | undefined;

  if (!updated) {
    const again = lookupAckUpdateTarget(token);
    if (again?.recipient.acknowledged_at) {
      return {
        ok: true,
        already: true,
        recipient: again.recipient,
        update: again.update,
        event: again.event,
      };
    }
    return { ok: false, already: false };
  }

  return {
    ok: true,
    already: false,
    recipient: updated,
    update: target.update,
    event: target.event,
  };
}

export function getEventUpdateAckCounts(updateId: number): EventUpdateAckCounts {
  const recipients = listEventUpdateRecipients(updateId);
  const sent = recipients.filter((row) => row.send_status === 'sent');
  const acknowledged = sent.filter((row) => Boolean(row.acknowledged_at)).length;
  return {
    sent: sent.length,
    acknowledged,
    awaiting: sent.length - acknowledged,
    failed: recipients.filter((row) => row.send_status === 'failed').length,
  };
}

export function listUnacknowledgedSentRecipients(
  updateId: number,
): EventUpdateRecipient[] {
  return listEventUpdateRecipients(updateId).filter(
    (row) => row.send_status === 'sent' && !row.acknowledged_at,
  );
}

export function markUpdateRecipientReminderSent(
  recipientId: number,
): boolean {
  const database = getDb();
  const result = database
    .prepare(
      `UPDATE event_update_recipients
       SET reminder_sent_at = datetime('now')
       WHERE id = ? AND send_status = 'sent' AND acknowledged_at IS NULL`,
    )
    .run(recipientId);
  return result.changes > 0;
}

/** Records an ack for a successfully sent recipient. Duplicate acks are idempotent. */
export function acknowledgeUpdateRecipient(
  updateId: number,
  phone: string,
): { ok: boolean; already: boolean; recipient?: EventUpdateRecipient } {
  const database = getDb();
  const existing = getEventUpdateRecipient(updateId, phone);
  if (!existing || existing.send_status !== 'sent') {
    return { ok: false, already: false };
  }
  if (existing.acknowledged_at) {
    return { ok: true, already: true, recipient: existing };
  }

  const updated = database
    .prepare(
      `UPDATE event_update_recipients
       SET acknowledged_at = datetime('now')
       WHERE id = ? AND send_status = 'sent' AND acknowledged_at IS NULL
       RETURNING *`,
    )
    .get(existing.id) as EventUpdateRecipient | undefined;

  if (!updated) {
    const again = getEventUpdateRecipient(updateId, phone);
    if (again?.acknowledged_at) {
      return { ok: true, already: true, recipient: again };
    }
    return { ok: false, already: false };
  }

  return { ok: true, already: false, recipient: updated };
}

/** Claims the one-shot “everyone acknowledged” organizer notice. */
export function claimOrganizerAllAckedNotified(updateId: number): boolean {
  const database = getDb();
  const result = database
    .prepare(
      `UPDATE event_updates
       SET organizer_all_acked_notified_at = datetime('now')
       WHERE id = ?
         AND acknowledgement_required = 1
         AND organizer_all_acked_notified_at IS NULL`,
    )
    .run(updateId);
  return result.changes > 0;
}

// --- Admin dashboard queries ---

export interface AdminOverviewStats {
  totalCustomers: number;
  totalEvents: number;
  totalResponses: number;
  newCustomers7d: number;
  newCustomers30d: number;
  totalGuests: number;
  rsvpYes: number;
  rsvpNo: number;
  rsvpMaybe: number;
  rsvpAwaiting: number;
  invitationsSent: number;
  remindersSent: number;
  eventUpdatesSent: number;
  eventUpdatesFailed: number;
  yesAdults: number;
  yesChildren: number;
}

export interface AdminRecentRsvpActivity {
  eventName: string;
  guestPhone: string;
  guestName: string | null;
  status: RsvpStatus;
  guestCount: number;
  adultCount: number;
  childCount: number;
  updatedAt: string;
}

export interface AdminRecentEventActivity {
  eventName: string;
  organizerPhone: string;
  createdAt: string;
}

export interface AdminCustomerRow {
  phone: string;
  joinedAt: string;
  lastActivityAt: string;
  eventCount: number;
  rsvpReceivedCount: number;
  invitationCount: number;
}

export interface AdminEventRow {
  id: number;
  name: string;
  organizerPhone: string;
  date: string;
  location: string;
  invitedCount: number;
  guestCount: number;
  invitationCount: number;
  yes: number;
  no: number;
  maybe: number;
  pending: number;
  totalResponses: number;
  cancelledAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reminderSentAt: string | null;
  hasImage: number;
}

export interface AdminActivityRow {
  eventName: string;
  guestPhone: string;
  guestName: string | null;
  status: RsvpStatus;
  guestCount: number;
  adultCount: number;
  childCount: number;
  updatedAt: string;
}

function adminCount(sql: string, params: unknown[] = []): number {
  const row = getDb().prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getAdminOverviewStats(): AdminOverviewStats {
  const totalCustomers = adminCount(
    `SELECT COUNT(DISTINCT organizer_phone) AS count FROM events`,
  );
  const totalEvents = adminCount(`SELECT COUNT(*) AS count FROM events`);
  const totalResponses = adminCount(
    `SELECT COUNT(*) AS count FROM rsvps WHERE status IN ('yes', 'no', 'maybe')`,
  );
  const newCustomers7d = adminCount(
    `SELECT COUNT(*) AS count FROM (
          SELECT organizer_phone, MIN(created_at) AS first_event
          FROM events
          GROUP BY organizer_phone
          HAVING first_event >= datetime('now', '-7 days')
        )`,
  );
  const newCustomers30d = adminCount(
    `SELECT COUNT(*) AS count FROM (
          SELECT organizer_phone, MIN(created_at) AS first_event
          FROM events
          GROUP BY organizer_phone
          HAVING first_event >= datetime('now', '-30 days')
        )`,
  );
  const totalGuests = adminCount(`SELECT COUNT(*) AS count FROM guests`);
  const rsvpYes = adminCount(
    `SELECT COUNT(*) AS count FROM rsvps WHERE status = 'yes'`,
  );
  const rsvpNo = adminCount(
    `SELECT COUNT(*) AS count FROM rsvps WHERE status = 'no'`,
  );
  const rsvpMaybe = adminCount(
    `SELECT COUNT(*) AS count FROM rsvps WHERE status = 'maybe'`,
  );
  const rsvpAwaiting = adminCount(
    `SELECT COUNT(*) AS count FROM (
       SELECT g.event_id AS event_id, g.phone AS phone
       FROM guests g
       LEFT JOIN rsvps r ON r.event_id = g.event_id AND r.phone = g.phone
       WHERE r.id IS NULL OR r.status = 'pending'
       UNION
       SELECT r.event_id, r.phone
       FROM rsvps r
       WHERE r.status = 'pending'
     )`,
  );
  const invitationsSent = adminCount(
    `SELECT COUNT(*) AS count FROM invitations`,
  );
  const remindersSent = adminCount(
    `SELECT COUNT(*) AS count FROM events
     WHERE reminder_sent_at IS NOT NULL AND trim(reminder_sent_at) != ''`,
  );
  const eventUpdatesSent = adminCount(
    `SELECT COUNT(*) AS count FROM event_update_recipients WHERE send_status = 'sent'`,
  );
  const eventUpdatesFailed = adminCount(
    `SELECT COUNT(*) AS count FROM event_update_recipients WHERE send_status = 'failed'`,
  );
  const attendance = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN adult_count > 0 THEN adult_count WHEN status = 'yes' THEN guest_count ELSE 0 END), 0) AS adults,
         COALESCE(SUM(CASE WHEN status = 'yes' THEN child_count ELSE 0 END), 0) AS children
       FROM rsvps
       WHERE status = 'yes'`,
    )
    .get() as { adults: number; children: number };

  return {
    totalCustomers,
    totalEvents,
    totalResponses,
    newCustomers7d,
    newCustomers30d,
    totalGuests,
    rsvpYes,
    rsvpNo,
    rsvpMaybe,
    rsvpAwaiting,
    invitationsSent,
    remindersSent,
    eventUpdatesSent,
    eventUpdatesFailed,
    yesAdults: attendance.adults,
    yesChildren: attendance.children,
  };
}

export function getAdminRecentRsvpActivity(limit = 20): AdminRecentRsvpActivity[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT e.name AS eventName, r.phone AS guestPhone, g.name AS guestName,
              r.status, r.guest_count AS guestCount, r.adult_count AS adultCount,
              r.child_count AS childCount, r.updated_at AS updatedAt
       FROM rsvps r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN guests g ON g.event_id = r.event_id AND g.phone = r.phone
       WHERE r.status IN ('yes', 'no', 'maybe')
       ORDER BY r.updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as AdminRecentRsvpActivity[];
}

export function getAdminRecentEventActivity(
  limit = 10,
): AdminRecentEventActivity[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT name AS eventName, organizer_phone AS organizerPhone,
              created_at AS createdAt
       FROM events
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as AdminRecentEventActivity[];
}

export function listAdminCustomers(search = ''): AdminCustomerRow[] {
  const database = getDb();
  const term = search.trim();
  const where = term ? `WHERE e.organizer_phone LIKE '%' || ? || '%'` : '';
  const params = term ? [term] : [];

  return database
    .prepare(
      `SELECT
         e.organizer_phone AS phone,
         MIN(e.created_at) AS joinedAt,
         MAX(
           CASE
             WHEN r.updated_at IS NULL THEN e.created_at
             WHEN e.created_at > r.updated_at THEN e.created_at
             ELSE r.updated_at
           END
         ) AS lastActivityAt,
         COUNT(DISTINCT e.id) AS eventCount,
         (
           SELECT COUNT(*)
           FROM rsvps r2
           JOIN events e2 ON e2.id = r2.event_id
           WHERE e2.organizer_phone = e.organizer_phone
             AND r2.status IN ('yes', 'no', 'maybe')
         ) AS rsvpReceivedCount,
         (
           SELECT COUNT(*)
           FROM invitations i
           JOIN events e3 ON e3.id = i.event_id
           WHERE e3.organizer_phone = e.organizer_phone
         ) AS invitationCount
       FROM events e
       LEFT JOIN rsvps r ON r.event_id = e.id
       ${where}
       GROUP BY e.organizer_phone
       ORDER BY lastActivityAt DESC`,
    )
    .all(...params) as AdminCustomerRow[];
}

export function listAdminEvents(
  search = '',
  organizerPhone?: string,
): AdminEventRow[] {
  const database = getDb();
  const term = search.trim();
  const phone = organizerPhone ? normalizePhone(organizerPhone) : '';
  const filters: string[] = [];
  const params: unknown[] = [];
  if (term) {
    filters.push(
      `(e.name LIKE '%' || ? || '%' OR e.organizer_phone LIKE '%' || ? || '%')`,
    );
    params.push(term, term);
  }
  if (phone) {
    filters.push(`e.organizer_phone = ?`);
    params.push(phone);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = database
    .prepare(
      `SELECT
         e.id,
         e.name,
         e.organizer_phone AS organizerPhone,
         e.date,
         e.location,
         e.cancelled_at AS cancelledAt,
         e.deleted_at AS deletedAt,
         e.created_at AS createdAt,
         e.reminder_sent_at AS reminderSentAt,
         CASE
           WHEN e.image_filename IS NOT NULL AND trim(e.image_filename) != '' THEN 1
           ELSE 0
         END AS hasImage,
         COALESCE(
           e.invitation_count,
           NULLIF((SELECT COUNT(*) FROM guests g WHERE g.event_id = e.id), 0),
           (SELECT COUNT(*) FROM rsvps r0 WHERE r0.event_id = e.id)
         ) AS invitedCount,
         (SELECT COUNT(*) FROM guests g2 WHERE g2.event_id = e.id) AS guestCount,
         (SELECT COUNT(*) FROM invitations inv WHERE inv.event_id = e.id) AS invitationCount,
         COALESCE(SUM(CASE WHEN r.status = 'yes' THEN 1 ELSE 0 END), 0) AS yes,
         COALESCE(SUM(CASE WHEN r.status = 'no' THEN 1 ELSE 0 END), 0) AS no,
         COALESCE(SUM(CASE WHEN r.status = 'maybe' THEN 1 ELSE 0 END), 0) AS maybe,
         COALESCE(SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
       FROM events e
       LEFT JOIN rsvps r ON r.event_id = e.id
       ${where}
       GROUP BY e.id
       ORDER BY e.created_at DESC`,
    )
    .all(...params) as Array<Omit<AdminEventRow, 'totalResponses'>>;

  return rows.map((row) => ({
    ...row,
    totalResponses: row.yes + row.no + row.maybe,
  }));
}

export function getAdminCustomer(phone: string): AdminCustomerRow | undefined {
  const normalized = normalizePhone(phone);
  return listAdminCustomers().find((row) => row.phone === normalized);
}

export interface AdminFeedRow {
  at: string;
  type: string;
  eventId: number | null;
  eventName: string | null;
  organizerPhone: string | null;
  guestPhone: string | null;
  guestName: string | null;
  detail: string | null;
}

export function listAdminFeed(limit = 50): AdminFeedRow[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT at, type, eventId, eventName, organizerPhone, guestPhone, guestName, detail
       FROM (
         SELECT e.created_at AS at, 'event_created' AS type, e.id AS eventId,
                e.name AS eventName, e.organizer_phone AS organizerPhone,
                NULL AS guestPhone, NULL AS guestName, NULL AS detail
         FROM events e
         UNION ALL
         SELECT r.updated_at, 'rsvp_' || r.status, r.event_id, e.name,
                e.organizer_phone, r.phone, g.name, NULL
         FROM rsvps r
         JOIN events e ON e.id = r.event_id
         LEFT JOIN guests g ON g.event_id = r.event_id AND g.phone = r.phone
         WHERE r.status IN ('yes', 'no', 'maybe')
         UNION ALL
         SELECT i.created_at, 'invitation_created', i.event_id, e.name,
                e.organizer_phone, NULL, NULL, i.type
         FROM invitations i
         JOIN events e ON e.id = i.event_id
         UNION ALL
         SELECT e.reminder_sent_at, 'reminder_sent', e.id, e.name,
                e.organizer_phone, NULL, NULL, NULL
         FROM events e
         WHERE e.reminder_sent_at IS NOT NULL AND trim(e.reminder_sent_at) != ''
         UNION ALL
         SELECT u.created_at, 'event_update_' || u.type, u.event_id, e.name,
                e.organizer_phone, NULL, NULL, u.message
         FROM event_updates u
         JOIN events e ON e.id = u.event_id
         UNION ALL
         SELECT e.cancelled_at, 'event_cancelled', e.id, e.name,
                e.organizer_phone, NULL, NULL, NULL
         FROM events e
         WHERE e.cancelled_at IS NOT NULL AND trim(e.cancelled_at) != ''
         UNION ALL
         SELECT rec.created_at, 'update_failed', u.event_id, e.name,
                e.organizer_phone, rec.phone, g.name, u.type
         FROM event_update_recipients rec
         JOIN event_updates u ON u.id = rec.update_id
         JOIN events e ON e.id = u.event_id
         LEFT JOIN guests g ON g.id = rec.guest_id
         WHERE rec.send_status = 'failed'
       )
       WHERE at IS NOT NULL
       ORDER BY at DESC
       LIMIT ?`,
    )
    .all(limit) as AdminFeedRow[];
}

export interface AdminFailedSendRow {
  at: string;
  type: string;
  eventId: number;
  eventName: string;
  organizerPhone: string;
  guestPhone: string;
  guestName: string | null;
  status: string;
}

export function listAdminFailedSends(limit = 50): AdminFailedSendRow[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT rec.created_at AS at, 'event_update_failed' AS type,
              e.id AS eventId, e.name AS eventName,
              e.organizer_phone AS organizerPhone,
              rec.phone AS guestPhone, g.name AS guestName,
              rec.send_status AS status
       FROM event_update_recipients rec
       JOIN event_updates u ON u.id = rec.update_id
       JOIN events e ON e.id = u.event_id
       LEFT JOIN guests g ON g.id = rec.guest_id
       WHERE rec.send_status = 'failed'
       ORDER BY rec.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as AdminFailedSendRow[];
}

export interface AdminEventDetail {
  event: Event;
  summary: RsvpSummary;
  guestCount: number;
  invitationCount: number;
  rsvps: Rsvp[];
  invitations: InvitationWithMembers[];
  updates: Array<EventUpdate & EventUpdateAckCounts>;
}

export function getAdminEventDetail(eventId: number): AdminEventDetail | undefined {
  const event = getEventById(eventId);
  if (!event) {
    return undefined;
  }
  const updates = listEventUpdatesForEvent(eventId).map((update) => ({
    ...update,
    ...getEventUpdateAckCounts(update.id),
  }));
  return {
    event,
    summary: getRsvpSummary(eventId),
    guestCount: adminCount(
      `SELECT COUNT(*) AS count FROM guests WHERE event_id = ?`,
      [eventId],
    ),
    invitationCount: adminCount(
      `SELECT COUNT(*) AS count FROM invitations WHERE event_id = ?`,
      [eventId],
    ),
    rsvps: listRsvpsForEvent(eventId),
    invitations: listInvitationsWithMembers(eventId),
    updates,
  };
}

export function listAdminActivity(limit = 100): AdminActivityRow[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT e.name AS eventName, r.phone AS guestPhone, g.name AS guestName,
              r.status, r.guest_count AS guestCount, r.adult_count AS adultCount,
              r.child_count AS childCount, r.updated_at AS updatedAt
       FROM rsvps r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN guests g ON g.event_id = r.event_id AND g.phone = r.phone
       WHERE r.status IN ('yes', 'no', 'maybe')
       ORDER BY r.updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as AdminActivityRow[];
}

