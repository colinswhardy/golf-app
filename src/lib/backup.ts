import { db } from "./db";
import { ensureDefaultClubs, resetClubBagMigration } from "./courseRepo";

/**
 * Full-database export/import (REVISION-SPEC Phase 0.1). All golf data lives in one phone's
 * IndexedDB with no server copy — this is the only defence against site-data clearing, browser
 * storage eviction, or a lost phone. Everything except the (inert, reconstructible) outbox is
 * included.
 */

// Every syncable/user-data table. Deliberately NOT derived from db.tables so that adding a new
// table forces a conscious decision about whether it belongs in backups (outbox does not).
const BACKUP_TABLES = [
  "courses",
  "courseVersions",
  "holes",
  "teeBoxes",
  "holeFeatures",
  "clubs",
  "rounds",
  "roundHoles",
  "shots",
  "sgBaselineScratch",
  "watchLaps",
  "clubTaps",
  "roundTracks",
  "reviewFlags",
  "clubTags"
] as const;

export interface BackupEnvelope {
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

export interface BackupSummary {
  schemaVersion: number;
  exportedAt: string;
  /** table name -> row count */
  counts: Record<string, number>;
  totalRows: number;
}

export async function exportAll(): Promise<Blob> {
  const tables: Record<string, unknown[]> = {};
  await db.transaction("r", BACKUP_TABLES.map((t) => db.table(t)), async () => {
    for (const name of BACKUP_TABLES) {
      tables[name] = await db.table(name).toArray();
    }
  });
  const envelope: BackupEnvelope = {
    schemaVersion: db.verno,
    exportedAt: new Date().toISOString(),
    tables
  };
  return new Blob([JSON.stringify(envelope)], { type: "application/json" });
}

export function backupFilename(now: Date = new Date()): string {
  return `caddyshot-backup-${now.toISOString().slice(0, 10)}.json`;
}

/** Parses + validates a backup file without writing anything — used to show the confirm dialog
 * (mode + row counts) before importAll commits. Throws with a user-readable message on any
 * structural problem. */
export async function readBackup(file: File): Promise<{ envelope: BackupEnvelope; summary: BackupSummary }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  const envelope = parsed as BackupEnvelope;
  if (
    !envelope ||
    typeof envelope.schemaVersion !== "number" ||
    typeof envelope.exportedAt !== "string" ||
    typeof envelope.tables !== "object" ||
    envelope.tables === null
  ) {
    throw new Error("Not a CaddyShot backup file (missing schemaVersion/exportedAt/tables).");
  }
  if (envelope.schemaVersion > db.verno) {
    throw new Error(
      `This backup is from a newer app version (schema v${envelope.schemaVersion}; this app is v${db.verno}). ` +
        `Update the app first, then import.`
    );
  }
  const counts: Record<string, number> = {};
  let totalRows = 0;
  for (const name of BACKUP_TABLES) {
    const rows = envelope.tables[name];
    if (rows !== undefined && !Array.isArray(rows)) {
      throw new Error(`Backup table "${name}" is not an array.`);
    }
    counts[name] = rows?.length ?? 0;
    totalRows += counts[name];
  }
  return { envelope, summary: { schemaVersion: envelope.schemaVersion, exportedAt: envelope.exportedAt, counts, totalRows } };
}

/**
 * Writes a validated backup into Dexie in ONE transaction. "merge" upserts by primary key
 * (bulkPut); "replace" clears each table first. Older-schema backups are fine — rows just lack
 * the newer optional fields, same as rows that predate a migration. Never touches outbox.
 */
export async function importAll(envelope: BackupEnvelope, mode: "replace" | "merge"): Promise<void> {
  if (envelope.schemaVersion > db.verno) {
    throw new Error("Backup schema is newer than this app.");
  }
  await db.transaction("rw", BACKUP_TABLES.map((t) => db.table(t)), async () => {
    for (const name of BACKUP_TABLES) {
      const rows = envelope.tables[name];
      const table = db.table(name);
      if (mode === "replace") await table.clear();
      if (rows?.length) await table.bulkPut(rows);
    }
  });
  // The restored bag may predate clubs the app now ships with, so allow the additive
  // canonical-bag migration to run once more and top it back up.
  resetClubBagMigration();
  await ensureDefaultClubs();
}
