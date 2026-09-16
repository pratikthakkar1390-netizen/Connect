CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  location TEXT NOT NULL,
  organizer_phone TEXT NOT NULL,
  rsvp_token TEXT UNIQUE,
  rsvp_code TEXT UNIQUE,
  short_code TEXT UNIQUE,
  invitation_count INTEGER,
  rsvp_deadline TEXT,
  children_allowed INTEGER NOT NULL DEFAULT 1,
  reminder_days INTEGER,
  reminder_sent_at TEXT,
  organizer_post_event_sent_at TEXT,
  cancelled_at TEXT,
  deleted_at TEXT,
  theme TEXT,
  custom_theme TEXT,
  dress_code TEXT,
  location_place_id TEXT,
  location_maps_url TEXT,
  location_address TEXT,
  image_filename TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_name_organizer
  ON events (name, organizer_phone);

CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  family_name TEXT,
  group_name TEXT,
  max_guests INTEGER,
  rsvp_code TEXT UNIQUE,
  short_code TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invitations_event
  ON invitations (event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_rsvp_code
  ON invitations (rsvp_code);

CREATE TABLE IF NOT EXISTS invitation_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invitation_id INTEGER NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invitation_members_invitation
  ON invitation_members (invitation_id);

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT,
  conversation_id TEXT,
  invitation_id INTEGER,
  thank_you_sent_at TEXT,
  whatsapp_phone TEXT,
  invited_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, phone)
);

CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  guest_count INTEGER NOT NULL DEFAULT 1,
  adult_count INTEGER NOT NULL DEFAULT 0,
  child_count INTEGER NOT NULL DEFAULT 0,
  raw_reply TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, phone)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_states (
  organizer_phone TEXT PRIMARY KEY,
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE INDEX IF NOT EXISTS idx_event_updates_event
  ON event_updates (event_id);

CREATE TABLE IF NOT EXISTS event_update_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id INTEGER NOT NULL REFERENCES event_updates(id) ON DELETE CASCADE,
  invitation_id INTEGER REFERENCES invitations(id) ON DELETE SET NULL,
  guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  send_status TEXT NOT NULL,
  ack_token TEXT,
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

CREATE TABLE IF NOT EXISTS message_sessions (
  phone TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_when_codes (
  short_code TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_when_codes_expires
  ON event_when_codes (expires_at);

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
