import { db } from "./db";
import type { FairwayResult, LatLng, Lie, PenaltyType, PositionSource, Round, RoundHole, Shot } from "../types/domain";

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

async function queueOutbox(table: string, op: "upsert" | "delete", payload: unknown) {
  await db.outbox.put({ id: uuid(), table, op, payload, createdAt: now() });
}

/** The in-progress round for this course, if one exists (any course version). */
export async function getActiveRoundForCourse(courseId: string): Promise<Round | undefined> {
  const versionIds = (await db.courseVersions.where("courseId").equals(courseId).toArray()).map((v) => v.id);
  const inProgress = await db.rounds.where("status").equals("in_progress").toArray();
  return inProgress.find((r) => versionIds.includes(r.courseVersionId));
}

export async function startRound(courseVersionId: string): Promise<Round> {
  const round: Round = {
    id: uuid(),
    courseVersionId,
    playedOn: new Date().toISOString().slice(0, 10),
    status: "in_progress",
    fitActivityId: null,
    fitIngestedAt: null,
    clockOffsetMs: null,
    watchCalibrationAt: null,
    reconciledAt: null,
    updatedAt: now()
  };
  await db.rounds.put(round);
  await queueOutbox("rounds", "upsert", round);
  return round;
}

export async function getOrCreateRoundHole(roundId: string, holeId: string): Promise<RoundHole> {
  const existing = (await db.roundHoles.where("roundId").equals(roundId).toArray()).find((rh) => rh.holeId === holeId);
  if (existing) return existing;
  const roundHole: RoundHole = {
    id: uuid(),
    roundId,
    holeId,
    score: null,
    putts: null,
    puttDistancesFeet: null,
    pinLocation: null,
    fairwayResult: null,
    updatedAt: now()
  };
  await db.roundHoles.put(roundHole);
  await queueOutbox("roundHoles", "upsert", roundHole);
  return roundHole;
}

export async function listShotsForRoundHole(roundHoleId: string): Promise<Shot[]> {
  return (await db.shots.where("roundHoleId").equals(roundHoleId).toArray()).sort((a, b) => a.shotNumber - b.shotNumber);
}

/**
 * Records a shot played FROM `point` with `lie`. Also closes out the previous
 * shot on the hole: its end point is where this one starts (you play your next
 * shot from wherever the last one finished).
 */
export async function recordShot(params: {
  roundHoleId: string;
  clubId: string | null;
  point: LatLng;
  lie: Lie;
  /** Where `point` came from. "tee_fallback" = no GPS lock — recorded so stats can exclude it
   * instead of the old behaviour of silently passing the tee coordinate off as a real fix. */
  positionSource: PositionSource;
  /** GPS accuracy (metres) for gps-sourced points, null otherwise. */
  accuracyM: number | null;
}): Promise<Shot> {
  return db.transaction("rw", [db.shots, db.outbox], async () => {
    const existing = await listShotsForRoundHole(params.roundHoleId);
    // Close out the previous SWING, not the previous row. If the green has already been marked,
    // the last rows are putts whose positions came from the marking screen — chaining a new
    // swing's start onto a putt would overwrite a real coordinate with an unrelated one.
    const swings = existing.filter((s) => s.reconciliation !== "green_mark" && s.penaltyType === null);
    const prev = swings[swings.length - 1];

    if (prev && !prev.endPoint) {
      const updatedPrev: Shot = { ...prev, endPoint: params.point, lieEnd: params.lie, updatedAt: now() };
      await db.shots.put(updatedPrev);
      await queueOutbox("shots", "upsert", updatedPrev);
    }

    const shot: Shot = {
      id: uuid(),
      roundHoleId: params.roundHoleId,
      shotNumber: existing.length + 1,
      clubId: params.clubId,
      startPoint: params.point,
      endPoint: null,
      positionSource: params.positionSource,
      accuracyM: params.accuracyM,
      lieStart: params.lie,
      lieEnd: null,
      watchLapId: null,
      clubTapId: null,
      reconciliation: "manual",
      elevationM: null,
      targetPoint: null,
      targetSource: "default_green",
      swingType: params.lie === "green" ? "putt" : "full",
      intendedYards: null,
      penaltyType: null,
      excluded: null,
      exclusionNote: null,
      recordedAt: now(),
      updatedAt: now()
    };
    await db.shots.put(shot);
    await queueOutbox("shots", "upsert", shot);
    return shot;
  });
}

/**
 * Saves score/putts for the hole and closes out the final recorded shot: its end is the hole —
 * the round-hole's pinLocation when one has been marked (authoritative, Phase 1.4), otherwise
 * the caller-supplied fallback (green centroid) — lie "green".
 */
export async function saveHoleResult(params: {
  roundHoleId: string;
  score: number;
  putts: number;
  fairwayResult: FairwayResult | null;
  /** Fallback hole-out point (green centroid) used only when no pinLocation was marked. */
  holeOutPoint: LatLng | null;
}): Promise<void> {
  await db.transaction("rw", [db.roundHoles, db.shots, db.outbox], async () => {
    const rh = await db.roundHoles.get(params.roundHoleId);
    if (!rh) return;
    const updated: RoundHole = {
      ...rh,
      score: params.score,
      putts: params.putts,
      fairwayResult: params.fairwayResult,
      updatedAt: now()
    };
    await db.roundHoles.put(updated);
    await queueOutbox("roundHoles", "upsert", updated);

    const shots = await listShotsForRoundHole(params.roundHoleId);
    const last = shots[shots.length - 1];
    const holeOut = updated.pinLocation ?? params.holeOutPoint;
    if (last && !last.endPoint && holeOut) {
      const closed: Shot = { ...last, endPoint: holeOut, lieEnd: "green", updatedAt: now() };
      await db.shots.put(closed);
      await queueOutbox("shots", "upsert", closed);
    }
  });
}

/**
 * Persists the green-marking screen's output (REVISION-SPEC 1.5 + 2.3): the authoritative pin
 * position for this hole/round, plus one real Shot row per putt — swingType "putt",
 * reconciliation "green_mark", positions from the marking taps. Each putt's endPoint is the next
 * putt's start; the last putt's endPoint is the pin. Re-marking a hole replaces its previous
 * green_mark rows wholesale (they're capture data, not user edits) and re-closes the approach
 * shot's endPoint onto the first putt.
 */
export async function saveGreenMarks(params: {
  roundHoleId: string;
  pin: LatLng;
  /** Putt start positions, in the order they were holed. Empty = chip-in / holed from off green. */
  puttStarts: LatLng[];
  /** Lie detector for putt start positions (fringe putts are real; the lie decides the SG
   * baseline later). Omit to default every putt lie to "green". */
  detectLieAt?: (p: LatLng) => Lie;
}): Promise<void> {
  await db.transaction("rw", [db.roundHoles, db.shots, db.clubs, db.outbox], async () => {
    const rh = await db.roundHoles.get(params.roundHoleId);
    if (!rh) return;

    const updatedRh: RoundHole = { ...rh, pinLocation: params.pin, putts: params.puttStarts.length, updatedAt: now() };
    await db.roundHoles.put(updatedRh);
    await queueOutbox("roundHoles", "upsert", updatedRh);

    // Replace any previous green_mark rows for this hole (re-marking).
    const existing = await listShotsForRoundHole(params.roundHoleId);
    for (const s of existing) {
      if (s.reconciliation === "green_mark") {
        await db.shots.delete(s.id);
        await queueOutbox("shots", "delete", { id: s.id });
      }
    }
    const nonPutt = existing.filter((s) => s.reconciliation !== "green_mark");

    // Close the approach (last non-putt shot) onto the first putt's start — or straight onto the
    // pin for a chip-in with zero putts.
    const last = nonPutt[nonPutt.length - 1];
    const approachEnd = params.puttStarts[0] ?? params.pin;
    if (last && !last.endPoint) {
      const closed: Shot = { ...last, endPoint: approachEnd, lieEnd: "green", updatedAt: now() };
      await db.shots.put(closed);
      await queueOutbox("shots", "upsert", closed);
    }

    const putter = (await db.clubs.toArray()).find((c) => c.name === "Putter") ?? null;
    for (let i = 0; i < params.puttStarts.length; i++) {
      const start = params.puttStarts[i];
      const end = params.puttStarts[i + 1] ?? params.pin;
      const shot: Shot = {
        id: uuid(),
        roundHoleId: params.roundHoleId,
        shotNumber: nonPutt.length + i + 1,
        clubId: putter?.id ?? null,
        startPoint: start,
        endPoint: end,
        positionSource: "manual",
        accuracyM: null,
        lieStart: params.detectLieAt?.(start) ?? "green",
        lieEnd: "green",
        watchLapId: null,
        clubTapId: null,
        reconciliation: "green_mark",
        elevationM: null,
        targetPoint: params.pin,
        targetSource: "default_pin",
        swingType: "putt",
        intendedYards: null,
        penaltyType: null,
        excluded: null,
        exclusionNote: null,
        recordedAt: now(),
        updatedAt: now()
      };
      await db.shots.put(shot);
      await queueOutbox("shots", "upsert", shot);
    }
  });
}

/**
 * Review-screen correction of a reconciled shot (REVISION-SPEC 4.2). Marks the row userEdited —
 * frozen against re-reconciliation (the engine keeps user-set fields; only derived chain fields
 * may still change).
 */
export async function correctShot(
  shotId: string,
  patch: Partial<Pick<Shot, "clubId" | "lieStart" | "targetPoint" | "targetSource" | "swingType" | "intendedYards">>
): Promise<void> {
  const shot = await db.shots.get(shotId);
  if (!shot) return;
  const updated: Shot = { ...shot, ...patch, userEdited: true, updatedAt: now() };
  await db.shots.put(updated);
  await queueOutbox("shots", "upsert", updated);
}

/** Manual stats exclusion toggle (4.2). Force-include clears even an auto_outlier mark. */
export async function setShotExcluded(shotId: string, exclude: boolean, note: string | null = null): Promise<void> {
  const shot = await db.shots.get(shotId);
  if (!shot) return;
  const updated: Shot = {
    ...shot,
    excluded: exclude ? "manual" : null,
    exclusionNote: exclude ? note : null,
    userEdited: true,
    updatedAt: now()
  };
  await db.shots.put(updated);
  await queueOutbox("shots", "upsert", updated);
}

/**
 * Inserts a penalty stroke as a real Shot row (4.2 / Appendix C: every stroke in the score is a
 * Shot row) at the tapped point, then recomputes the hole score as swings + putts + penalties so
 * the balance check holds again. Penalty rows carry no club and never enter club statistics.
 */
export async function addPenaltyStroke(roundHoleId: string, penaltyType: PenaltyType, point: LatLng): Promise<void> {
  await db.transaction("rw", [db.shots, db.roundHoles, db.outbox], async () => {
    const existing = await listShotsForRoundHole(roundHoleId);
    const shot: Shot = {
      id: uuid(),
      roundHoleId,
      shotNumber: existing.length + 1,
      clubId: null,
      startPoint: point,
      endPoint: point,
      positionSource: "manual",
      accuracyM: null,
      lieStart: null,
      lieEnd: null,
      watchLapId: null,
      clubTapId: null,
      reconciliation: "manual",
      elevationM: null,
      targetPoint: null,
      targetSource: "default_green",
      swingType: "full",
      intendedYards: null,
      penaltyType,
      excluded: null,
      exclusionNote: null,
      recordedAt: now(),
      updatedAt: now(),
      userEdited: true
    };
    await db.shots.put(shot);
    await queueOutbox("shots", "upsert", shot);

    const rh = await db.roundHoles.get(roundHoleId);
    if (!rh) return;
    const all = [...existing, shot];
    const swings = all.filter((s) => s.swingType !== "putt" && s.penaltyType === null).length;
    const putts = all.filter((s) => s.swingType === "putt").length;
    const penalties = all.filter((s) => s.penaltyType !== null).length;
    const updated: RoundHole = { ...rh, score: swings + putts + penalties, updatedAt: now() };
    await db.roundHoles.put(updated);
    await queueOutbox("roundHoles", "upsert", updated);
  });
}

/** Removes a penalty stroke and recomputes the hole score the same way addPenaltyStroke does. */
export async function removePenaltyStroke(shotId: string): Promise<void> {
  await db.transaction("rw", [db.shots, db.roundHoles, db.outbox], async () => {
    const shot = await db.shots.get(shotId);
    if (!shot || shot.penaltyType === null) return;
    await db.shots.delete(shotId);
    await queueOutbox("shots", "delete", { id: shotId });
    const rh = await db.roundHoles.get(shot.roundHoleId);
    if (!rh) return;
    const rest = await listShotsForRoundHole(shot.roundHoleId);
    const swings = rest.filter((s) => s.swingType !== "putt" && s.penaltyType === null).length;
    const putts = rest.filter((s) => s.swingType === "putt").length;
    const penalties = rest.filter((s) => s.penaltyType !== null).length;
    const updated: RoundHole = { ...rh, score: swings + putts + penalties, updatedAt: now() };
    await db.roundHoles.put(updated);
    await queueOutbox("roundHoles", "upsert", updated);
  });
}

export async function completeRound(roundId: string): Promise<void> {
  const round = await db.rounds.get(roundId);
  if (!round) return;
  const updated: Round = { ...round, status: "completed", updatedAt: now() };
  await db.rounds.put(updated);
  await queueOutbox("rounds", "upsert", updated);
}

/** Sets (or clears, with `point: null`) a shot's target point from post-round review. Setting a
 * point marks it "manual" (frozen against re-reconciliation); clearing reverts to the default. */
export async function setShotTargetPoint(shotId: string, point: LatLng | null): Promise<void> {
  const shot = await db.shots.get(shotId);
  if (!shot) return;
  const updated: Shot = {
    ...shot,
    targetPoint: point,
    targetSource: point ? "manual" : "default_green",
    updatedAt: now()
  };
  await db.shots.put(updated);
  await queueOutbox("shots", "upsert", updated);
}

export async function listCompletedRounds(): Promise<Round[]> {
  return (await db.rounds.where("status").equals("completed").toArray()).sort((a, b) => b.playedOn.localeCompare(a.playedOn));
}

/** Sets (or clears, with `point: null`) a custom pin location for a hole in this round, overriding
 * the green centroid default. Persists across leaving and returning to the hole. */
export async function setRoundHolePinLocation(roundHoleId: string, point: LatLng | null): Promise<void> {
  const rh = await db.roundHoles.get(roundHoleId);
  if (!rh) return;
  const updated: RoundHole = { ...rh, pinLocation: point, updatedAt: now() };
  await db.roundHoles.put(updated);
  await queueOutbox("roundHoles", "upsert", updated);
}

/** Sets the fairway result for a hole in this round — used both for the auto-detected value
 * written the moment Shot 2 is logged, and the hole-out sheet's final (possibly overridden) one. */
export async function setRoundHoleFairwayResult(roundHoleId: string, result: FairwayResult | null): Promise<void> {
  const rh = await db.roundHoles.get(roundHoleId);
  if (!rh) return;
  const updated: RoundHole = { ...rh, fairwayResult: result, updatedAt: now() };
  await db.roundHoles.put(updated);
  await queueOutbox("roundHoles", "upsert", updated);
}
