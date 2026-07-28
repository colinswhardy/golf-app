import { db } from "./db";
import { reconcile, type ReconcileHoleInput } from "./reconcile";
import { listClubTapsForRound, listWatchLapsForRound } from "./captureRepo";
import { getOrCreateRoundHole } from "./roundRepo";
import { getHolesForVersion, getFeaturesForHole, getTeeBoxesForHole, listClubs } from "./courseRepo";
import { centerlineOf, defaultTargetForShot, greenCentroidOf } from "./targets";
import { clubTypicalYardsSync } from "./stats";
import type { ReviewFlag, ReviewFlagType, Round, Shot } from "../types/domain";

/**
 * Dexie-facing wrapper around the pure reconciliation engine (Phase 3): loads a round's capture
 * streams + geometry, runs reconcile(), persists the resulting shot set / flags / event links,
 * then applies default target lines (4.2) to every shot without one. Safe to re-run — the engine
 * is idempotent and user edits are frozen (see reconcile.ts's contract).
 */

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

const RECONCILE_FLAG_TYPES: ReviewFlagType[] = [
  "ambiguous_lie",
  "missing_club",
  "score_mismatch",
  "unmatched_lap",
  "unmatched_tap"
];

async function queueOutbox(table: string, op: "upsert" | "delete", payload: unknown) {
  await db.outbox.put({ id: uuid(), table, op, payload, createdAt: now() });
}

export interface ReconcileRunSummary {
  shotCount: number;
  flagCount: number;
  clockOffsetMs: number;
  clockOffsetMethod: "calibrated" | "estimated" | "assumed_zero";
}

export async function reconcileRound(roundId: string): Promise<ReconcileRunSummary> {
  const round = await db.rounds.get(roundId);
  if (!round) throw new Error("Round not found.");

  const [laps, taps, track, clubs, holes] = await Promise.all([
    listWatchLapsForRound(roundId),
    listClubTapsForRound(roundId),
    db.roundTracks.get(roundId),
    listClubs(),
    getHolesForVersion(round.courseVersionId)
  ]);

  // Every hole needs a RoundHole row before segmentation can target it — the UI creates them
  // lazily, but laps exist for holes never opened on the phone.
  const holeInputs: ReconcileHoleInput[] = [];
  for (const hole of holes) {
    const rh = await getOrCreateRoundHole(roundId, hole.id);
    const features = await getFeaturesForHole(hole.id);
    const tees = await getTeeBoxesForHole(hole.id);
    holeInputs.push({
      roundHoleId: rh.id,
      holeId: hole.id,
      number: hole.number,
      par: hole.par,
      score: rh.score,
      features: features.map((f) => ({ featureType: f.featureType, geometry: f.geometry, zOrder: f.zOrder })),
      teeLocation: tees[0]?.location ?? hole.greenPoint ?? null,
      pin: rh.pinLocation
    });
  }

  const roundHoleIds = holeInputs.map((h) => h.roundHoleId);
  const existingShots = await db.shots.where("roundHoleId").anyOf(roundHoleIds).toArray();

  const result = reconcile({
    laps,
    taps,
    track: track ?? null,
    holes: holeInputs,
    existingShots,
    clubs,
    clockOffsetMs: round.clockOffsetMs,
    calibrationPhoneTime: round.watchCalibrationAt
  });

  // ----- Apply default targets (4.2) to shots still without one -----
  const holeByRoundHoleId = new Map(holeInputs.map((h) => [h.roundHoleId, h]));
  const shotsWithTargets: Shot[] = result.shots.map((shot) => {
    if (shot.targetPoint || shot.targetSource === "manual" || shot.penaltyType !== null) return shot;
    const hole = holeByRoundHoleId.get(shot.roundHoleId);
    if (!hole) return shot;
    const resolved = defaultTargetForShot(shot, {
      par: hole.par,
      pin: hole.pin,
      greenCentroid: greenCentroidOf(hole.features),
      teeLocation: hole.teeLocation,
      centerline: centerlineOf(hole.features),
      clubMedianYards: (clubId) => clubTypicalYardsSync(clubId, existingShots)
    });
    return resolved ? { ...shot, targetPoint: resolved.point, targetSource: resolved.source } : shot;
  });

  // ----- Persist everything in one transaction -----
  await db.transaction("rw", [db.shots, db.watchLaps, db.clubTaps, db.reviewFlags, db.rounds, db.outbox], async () => {
    for (const id of result.deleteShotIds) {
      await db.shots.delete(id);
      await queueOutbox("shots", "delete", { id });
    }
    for (const shot of shotsWithTargets) {
      await db.shots.put(shot);
      await queueOutbox("shots", "upsert", shot);
    }
    for (const m of result.lapMatches) {
      await db.watchLaps.update(m.lapId, { matchedShotId: m.shotId });
    }
    for (const m of result.tapMatches) {
      await db.clubTaps.update(m.tapId, { matchedShotId: m.shotId });
    }

    // Flags: reconcile-owned types are reconciled against the fresh run. A flag whose
    // (type, shotId, roundHoleId) already exists keeps its row — resolved stays resolved,
    // dismissed stays deferred. Open flags whose condition vanished are deleted; brand-new
    // conditions get new open flags.
    const existingFlags = await db.reviewFlags.where("roundId").equals(roundId).toArray();
    const freshKeys = new Set(result.flags.map((f) => `${f.type}|${f.shotId ?? ""}|${f.roundHoleId ?? ""}`));
    for (const f of existingFlags) {
      if (!RECONCILE_FLAG_TYPES.includes(f.type)) continue;
      const key = `${f.type}|${f.shotId ?? ""}|${f.roundHoleId ?? ""}`;
      if (!freshKeys.has(key)) {
        await db.reviewFlags.delete(f.id);
        await queueOutbox("reviewFlags", "delete", { id: f.id });
      }
    }
    const existingKeys = new Set(
      existingFlags
        .filter((f) => RECONCILE_FLAG_TYPES.includes(f.type))
        .map((f) => `${f.type}|${f.shotId ?? ""}|${f.roundHoleId ?? ""}`)
    );
    for (const f of result.flags) {
      const key = `${f.type}|${f.shotId ?? ""}|${f.roundHoleId ?? ""}`;
      if (existingKeys.has(key)) continue;
      const flag: ReviewFlag = {
        id: uuid(),
        roundId,
        roundHoleId: f.roundHoleId,
        shotId: f.shotId,
        type: f.type,
        detail: f.detail,
        status: "open",
        createdAt: now(),
        resolvedAt: null
      };
      await db.reviewFlags.put(flag);
      await queueOutbox("reviewFlags", "upsert", flag);
    }

    const updatedRound: Round = {
      ...round,
      clockOffsetMs: result.clockOffsetMs,
      reconciledAt: now(),
      updatedAt: now()
    };
    await db.rounds.put(updatedRound);
    await queueOutbox("rounds", "upsert", updatedRound);
  });

  // DEM elevation backfill for rows still missing one (fire-and-forget — needs network or
  // already-cached DEM tiles; harmless no-op otherwise). Dynamic import keeps the elevation
  // module (and its fetch machinery) out of the reconcile path proper.
  import("./statsRunner")
    .then((m) => m.backfillShotElevations(roundId))
    .catch(() => {});

  return {
    shotCount: shotsWithTargets.length,
    flagCount: result.flags.length,
    clockOffsetMs: result.clockOffsetMs,
    clockOffsetMethod: result.clockOffsetMethod
  };
}
