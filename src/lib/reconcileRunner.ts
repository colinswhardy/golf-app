import { db } from "./db";
import { reconcile, type ReconcileHoleInput } from "./reconcile";
import { listClubTapsForRound, listWatchLapsForRound } from "./captureRepo";
import { getOrCreateRoundHole } from "./roundRepo";
import { getHolesForVersion, getFeaturesForHole, getTeeBoxesForHole, listClubs } from "./courseRepo";
import { centerlineOf, defaultTargetForShot, greenCentroidOf } from "./targets";
import { classifyFairwayResult } from "./fairway";
import { clubTypicalYardsSync } from "./stats";
import type { ReviewFlag, ReviewFlagType, Round, RoundHole, Shot } from "../types/domain";

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
  /** Laps folded into shots that were entered by hand on the phone (one stroke, two records). */
  handEnteredMerges: number;
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

  // Only the holes this round actually covers. A back-nine round must not be reconciled against
  // holes 1-9: hole segmentation walks the list in order from the first entry, so including them
  // lets a lap land on a hole that was never played, and it would also create nine empty
  // RoundHole rows. Rounds recorded before nines existed carry no range and get the full course,
  // which is what they were.
  const playedHoles = holes.filter(
    (h) => h.number >= (round.startHole ?? -Infinity) && h.number <= (round.endHole ?? Infinity)
  );

  // Every hole needs a RoundHole row before segmentation can target it — the UI creates them
  // lazily, but laps exist for holes never opened on the phone.
  const holeInputs: ReconcileHoleInput[] = [];
  for (const hole of playedHoles) {
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
  // Club medians for the default tee-shot target come from the WHOLE history, not just this
  // round — four shots with a club is the threshold, which a single round rarely reaches, so
  // scoping it to the round meant the default almost always fell back to a fixed 230 yards.
  const allShotsEver = await db.shots.toArray();

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
      clubMedianYards: (clubId) => clubTypicalYardsSync(clubId, allShotsEver)
    });
    return resolved ? { ...shot, targetPoint: resolved.point, targetSource: resolved.source } : shot;
  });

  // ----- Fairway result per hole -----
  // Auto-detection previously only ran when a shot was entered by hand, so a round captured the
  // intended way — watch laps and club tags — never got one. Derived here from the reconciled
  // tee shot's landing point, and only where it's absent: a value chosen in the hole-out sheet is
  // the player's own call and outranks the geometry.
  const fairwayUpdates: RoundHole[] = [];
  for (const hole of holeInputs) {
    if (hole.par < 4) continue;
    const rh = await db.roundHoles.get(hole.roundHoleId);
    if (!rh || rh.fairwayResult != null) continue;
    const fairway = hole.features.find((f) => f.featureType === "fairway" && f.geometry.type === "Polygon");
    const green = greenCentroidOf(hole.features);
    if (!fairway || !green || !hole.teeLocation) continue;
    const holeShots = shotsWithTargets
      .filter((s) => s.roundHoleId === hole.roundHoleId && s.swingType !== "putt" && s.penaltyType === null)
      .sort((a, b) => a.shotNumber - b.shotNumber);
    const landing = holeShots[0]?.endPoint;
    if (!landing) continue;
    fairwayUpdates.push({
      ...rh,
      fairwayResult: classifyFairwayResult(fairway.geometry as GeoJSON.Polygon, hole.teeLocation, green, landing),
      updatedAt: now()
    });
  }

  // ----- Persist everything in one transaction -----
  await db.transaction("rw", [db.shots, db.watchLaps, db.clubTaps, db.reviewFlags, db.rounds, db.roundHoles, db.outbox], async () => {
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

    for (const rh of fairwayUpdates) {
      await db.roundHoles.put(rh);
      await queueOutbox("roundHoles", "upsert", rh);
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
    handEnteredMerges: result.handEnteredMerges,
    clockOffsetMs: result.clockOffsetMs,
    clockOffsetMethod: result.clockOffsetMethod
  };
}
