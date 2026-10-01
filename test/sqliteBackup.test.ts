import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  backupSqliteDatabase,
  isFileDatabasePath,
  isSqliteBackupEnabled,
  listSqliteBackupFiles,
  pruneSqliteBackups,
  sqliteBackupFileName,
  sqliteBackupKeepCount,
  startSqliteBackupScheduler,
  isSqliteBackupSchedulerStarted,
} from '../src/db/backup.js';
import { closeDb, createEvent, getDb } from '../src/db/store.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'connect-sqlite-backup-'));
}

function tmpFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

test('memory database paths are not treated as files', () => {
  assert.equal(isFileDatabasePath(':memory:'), false);
  assert.equal(isFileDatabasePath('  :memory:  '), false);
  assert.equal(isFileDatabasePath('/app/data/rsvp.db'), true);
});

test('SQLite backup skips in-memory databases and does not write files', async () => {
  const dir = tempDir();
  const db = new Database(':memory:');
  db.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY); INSERT INTO demo VALUES (1);');
  const result = await backupSqliteDatabase({
    database: db,
    livePath: ':memory:',
    backupDir: dir,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'memory');
  assert.equal(listSqliteBackupFiles(dir).length, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('successful backup is a consistent copy and leaves no temp files', async () => {
  const dir = tempDir();
  const livePath = path.join(dir, 'rsvp.db');
  const backupDir = path.join(dir, 'backups');
  const db = new Database(livePath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO events (name) VALUES ('Wedding');
  `);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };

  const result = await backupSqliteDatabase({
    database: db,
    livePath,
    backupDir,
    keep: 5,
    now: new Date('2026-10-01T22:00:00.000Z'),
  });

  assert.equal(result.fileName, 'connect-sqlite-20261001T220000Z.db');
  const snapshotPath = path.join(backupDir, result.fileName ?? '');
  assert.equal(fs.existsSync(snapshotPath), true);
  assert.equal(tmpFiles(backupDir).length, 0);
  assert.ok((result.bytes ?? 0) > 0);

  const after = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
  assert.equal(after.n, before.n);
  assert.equal(path.resolve(livePath), path.join(dir, 'rsvp.db'));

  const copy = new Database(snapshotPath, { readonly: true });
  const copied = copy.prepare(`SELECT name FROM events`).get() as { name: string };
  assert.equal(copied.name, 'Wedding');
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  copy.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failed backup cleans temp files and keeps the previous good snapshot', async () => {
  const dir = tempDir();
  const livePath = path.join(dir, 'rsvp.db');
  const backupDir = path.join(dir, 'backups');
  const db = new Database(livePath);
  db.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO events (name) VALUES ('Kept');
  `);

  const good = await backupSqliteDatabase({
    database: db,
    livePath,
    backupDir,
    keep: 7,
    now: new Date('2026-10-01T21:00:00.000Z'),
  });
  const goodPath = path.join(backupDir, good.fileName ?? '');
  const goodBytes = fs.statSync(goodPath).size;

  db.close();
  await assert.rejects(
    () =>
      backupSqliteDatabase({
        database: db,
        livePath,
        backupDir,
        keep: 7,
        now: new Date('2026-10-01T22:00:00.000Z'),
      }),
  );

  assert.equal(fs.existsSync(goodPath), true);
  assert.equal(fs.statSync(goodPath).size, goodBytes);
  assert.equal(fs.existsSync(path.join(backupDir, 'connect-sqlite-20261001T220000Z.db')), false);
  assert.equal(tmpFiles(backupDir).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite backup pruning keeps only the newest snapshots within the bound', () => {
  const dir = tempDir();
  const names = [
    'connect-sqlite-20261001T010000Z.db',
    'connect-sqlite-20261001T020000Z.db',
    'connect-sqlite-20261001T030000Z.db',
    'connect-sqlite-20261001T040000Z.db',
    'connect-sqlite-20261001T050000Z.db',
    'connect-sqlite-20261001T060000Z.db',
    'connect-sqlite-20261001T070000Z.db',
    'connect-sqlite-20261001T080000Z.db',
  ];
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), 'snapshot');
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore');
  assert.equal(pruneSqliteBackups(dir, 7), 7);
  assert.deepEqual(listSqliteBackupFiles(dir), names.slice(-7));
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);
  assert.equal(pruneSqliteBackups(dir, 999), 7);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup file names are UTC stamps with no guest data', () => {
  assert.equal(
    sqliteBackupFileName(new Date('2026-10-01T18:27:05.123Z')),
    'connect-sqlite-20261001T182705Z.db',
  );
});

test('backup scheduler is disabled by default and only opt-in via SQLITE_BACKUP_ENABLED=1', () => {
  const previousEnabled = process.env.SQLITE_BACKUP_ENABLED;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.SQLITE_BACKUP_ENABLED;
    process.env.NODE_ENV = 'production';
    assert.equal(isSqliteBackupEnabled(), false);
    startSqliteBackupScheduler();
    assert.equal(isSqliteBackupSchedulerStarted(), false);

    process.env.SQLITE_BACKUP_ENABLED = '0';
    assert.equal(isSqliteBackupEnabled(), false);

    process.env.SQLITE_BACKUP_ENABLED = '1';
    assert.equal(isSqliteBackupEnabled(), true);
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.SQLITE_BACKUP_ENABLED;
    } else {
      process.env.SQLITE_BACKUP_ENABLED = previousEnabled;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test('retention defaults to 7 and never grows without bound', () => {
  const previous = process.env.SQLITE_BACKUP_KEEP;
  try {
    delete process.env.SQLITE_BACKUP_KEEP;
    assert.equal(sqliteBackupKeepCount(), 7);
    process.env.SQLITE_BACKUP_KEEP = '3';
    assert.equal(sqliteBackupKeepCount(), 3);
    process.env.SQLITE_BACKUP_KEEP = '999';
    assert.equal(sqliteBackupKeepCount(), 14);
  } finally {
    if (previous === undefined) {
      delete process.env.SQLITE_BACKUP_KEEP;
    } else {
      process.env.SQLITE_BACKUP_KEEP = previous;
    }
  }
});

test('existing in-memory CONNECT tests still open after backup helpers load', () => {
  process.env.DATABASE_PATH = ':memory:';
  closeDb();
  getDb();
  const event = createEvent('Safety Check', 'Oct 2', 'Hall', '+15551110000');
  assert.equal(event.name, 'Safety Check');
  closeDb();
});
