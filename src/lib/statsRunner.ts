import { db } from "./db";
import { computeClubDistances, type ClubDistanceSummary } from "./stats";
import { demElevation } from "./elevation";
import type { LatLng, Shot } from "../types/domain";

/** Dexie-facing side of the stats engine (Phase 5): persists MAD auto-outlier marks and
 * backfills DEM elevations. The maths lives in lib/stats.ts (pure). */

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

async function queueOutbox(table: string, op: "upsert" | "delete", payload: unknown) {
  await db.outbox.put({ id: uuid(), table, op, payload, createdAt: now() });
}

/**
 * Runs the full-swing distance computation and persists its outlier verdicts:
 * `excluded: "auto_outlier"` written on flagged rows (never deleting them, never touching
 * "manual"), and cleared again on rows that stopped being outliers as more data arrived.
 * Returns the summaries for display.
 */
export async function computeAndPersistClubDistances(
  elevationAt?: (p: LatLng) => number | null
): Promise<ClubDistanceSummary[]> {
  const [shots, clubs] = await Promise.all([db.shots.toArray(), db.clubs.toArray()]);
  const summaries = computeClubDistances(shots, clubs, elevationAt);

  for (const summary of summaries) {
    for (const id of summary.autoOutlierShotIds) {
      const shot = await db.shots.get(id);
      if (!shot || shot.excluded !== null) continue; // never override manual
      const updated: Shot = { ...shot, excluded: "auto_outlier", updatedAt: now() };
      await db.shots.put(updated);
      await queueOutbox("shots", "upsert", updated);
    }
    for (const id of summary.clearOutlierShotIds) {
      const shot = await db.shots.get(id);
      if (!shot || shot.excluded !== "auto_outlier") continue;
      const updated: Shot = { ...shot, excluded: null, updatedAt: now() };
      await db.shots.put(updated);
      await queueOutbox("shots", "upsert", updated);
    }
  }
  return summaries;
}

/**
 * Backfills Shot.elevationM from the DEM for shots that have none (phone-GPS-recorded rows;
 * watch rows already carry barometric altitude). Fire-and-forget after reconciliation; no-op
 * offline until the DEM tiles are cached.
 */
export async function backfillShotElevations(roundId: string): Promise<number> {
  const roundHoleIds = (await db.roundHoles.where("roundId").equals(roundId).toArray()).map((rh) => rh.id);
  if (!roundHoleIds.length) return 0;
  const shots = await db.shots.where("roundHoleId").anyOf(roundHoleIds).toArray();
  let updated = 0;
  for (const shot of shots) {
    if (shot.elevationM !== null) continue;
    const elevation = await demElevation(shot.startPoint);
    if (elevation === null) continue;
    const patched: Shot = { ...shot, elevationM: elevation, updatedAt: now() };
    await db.shots.put(patched);
    await queueOutbox("shots", "upsert", patched);
    updated++;
  }
  return updated;
}
