/**
 * SQLite snapshots for CONNECT.
 *
 * This is same-volume backup protection only. It is NOT an off-machine
 * disaster-recovery backup. Snapshots live next to the live database
 * (by default /app/data/backups on Railway) and would be lost if that
 * volume is lost.
 *
 * Uses SQLite's online backup API so CONNECT can keep serving traffic
 * while a consistent snapshot is written (WAL included). The live
 * database file is never the write target.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { config } from '../config.js';
import { getDb } from './store.js';

export const SQLITE_BACKUP_FILE_PATTERN =
  /^connect-sqlite-\d{8}T\d{6}Z\.db$/;

const DEFAULT_KEEP = 7;
const MAX_KEEP = 14;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FIRST_DELAY_MS = 30_000;

export interface SqliteBackupResult {
  skipped?: boolean;
  reason?: string;
  fileName?: string;
  bytes?: number;
  kept?: number;
}

function optionalEnv(name: string): string {
  return process.env[name]?.trim() ?? '';
}

export function isFileDatabasePath(databasePath: string): boolean {
  const trimmed = databasePath.trim();
  return Boolean(trimmed) && trimmed !== ':memory:';
}

/** Opt-in only. Absent / unknown values do not enable backups. */
export function isSqliteBackupEnabled(): boolean {
  const raw = optionalEnv('SQLITE_BACKUP_ENABLED').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

export function sqliteBackupKeepCount(): number {
  const parsed = Number.parseInt(optionalEnv('SQLITE_BACKUP_KEEP'), 10);
  if (Number.isInteger(parsed) && parsed >= 1) {
    return Math.min(parsed, MAX_KEEP);
  }
  return DEFAULT_KEEP;
}

export function sqliteBackupIntervalMs(): number {
  const parsed = Number.parseInt(optionalEnv('SQLITE_BACKUP_INTERVAL_MS'), 10);
  if (Number.isInteger(parsed) && parsed >= 60_000) {
    return parsed;
  }
  return DEFAULT_INTERVAL_MS;
}

export function defaultSqliteBackupDir(databasePath: string): string {
  const override = optionalEnv('SQLITE_BACKUP_DIR');
  if (override) {
    return path.resolve(override);
  }
  return path.join(path.dirname(path.resolve(databasePath)), 'backups');
}

export function sqliteBackupFileName(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `connect-sqlite-${stamp}.db`;
}

export function listSqliteBackupFiles(backupDir: string): string[] {
  if (!fs.existsSync(backupDir)) {
    return [];
  }
  return fs
    .readdirSync(backupDir)
    .filter((name) => SQLITE_BACKUP_FILE_PATTERN.test(name))
    .sort();
}

export function pruneSqliteBackups(
  backupDir: string,
  keep = sqliteBackupKeepCount(),
): number {
  const bounded = Math.min(Math.max(keep, 1), MAX_KEEP);
  const files = listSqliteBackupFiles(backupDir);
  const extra = files.length - bounded;
  if (extra <= 0) {
    return files.length;
  }
  for (const name of files.slice(0, extra)) {
    fs.unlinkSync(path.join(backupDir, name));
  }
  return bounded;
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

function assertSafeDestination(livePath: string, destination: string): void {
  if (path.resolve(destination) === path.resolve(livePath)) {
    throw new Error('SQLite backup destination cannot be the live database');
  }
}

function verifyBackupFile(filePath: string): void {
  const copy = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const check = copy.pragma('integrity_check', { simple: true });
    if (check !== 'ok') {
      throw new Error('SQLite backup failed integrity check');
    }
  } finally {
    copy.close();
  }
}

export async function backupSqliteDatabase(input: {
  database: BetterSqlite3.Database;
  livePath: string;
  backupDir?: string;
  keep?: number;
  now?: Date;
}): Promise<SqliteBackupResult> {
  if (!isFileDatabasePath(input.livePath)) {
    return { skipped: true, reason: 'memory' };
  }

  const livePath = path.resolve(input.livePath);
  const backupDir = input.backupDir
    ? path.resolve(input.backupDir)
    : defaultSqliteBackupDir(livePath);
  fs.mkdirSync(backupDir, { recursive: true });

  const fileName = sqliteBackupFileName(input.now ?? new Date());
  const destination = path.join(backupDir, fileName);
  const temporary = path.join(
    backupDir,
    `${fileName}.${process.pid}.${Date.now()}.tmp`,
  );
  assertSafeDestination(livePath, destination);
  assertSafeDestination(livePath, temporary);

  try {
    await input.database.backup(temporary);
    verifyBackupFile(temporary);
    fs.renameSync(temporary, destination);
  } catch (error) {
    removeIfExists(temporary);
    throw error;
  }

  const bytes = fs.statSync(destination).size;
  const kept = pruneSqliteBackups(backupDir, input.keep ?? sqliteBackupKeepCount());
  return { fileName, bytes, kept };
}

export async function runSqliteBackupNow(
  now = new Date(),
): Promise<SqliteBackupResult> {
  return backupSqliteDatabase({
    database: getDb(),
    livePath: config.databasePath,
    now,
  });
}

let backupSchedulerStarted = false;

export function isSqliteBackupSchedulerStarted(): boolean {
  return backupSchedulerStarted;
}

export function startSqliteBackupScheduler(): void {
  if (backupSchedulerStarted || !isSqliteBackupEnabled()) {
    return;
  }
  if (!isFileDatabasePath(config.databasePath)) {
    return;
  }
  backupSchedulerStarted = true;
  const intervalMs = sqliteBackupIntervalMs();
  console.log(
    'SQLite snapshot scheduler active (same-volume only, not off-machine DR). First copy in ' +
      `${Math.round(DEFAULT_FIRST_DELAY_MS / 1000)}s, then every ${Math.round(intervalMs / 3600000)}h`,
  );
  setTimeout(() => {
    void runScheduledBackup();
    setInterval(() => {
      void runScheduledBackup();
    }, intervalMs);
  }, DEFAULT_FIRST_DELAY_MS);
}

async function runScheduledBackup(): Promise<void> {
  try {
    const result = await runSqliteBackupNow();
    if (result.skipped) {
      return;
    }
    console.log(
      `SQLite snapshot saved ${result.fileName} (${result.bytes} bytes); kept ${result.kept}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`SQLite snapshot failed: ${message}`);
  }
}
