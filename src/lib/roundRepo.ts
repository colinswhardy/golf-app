import { db } from "./db";
import { findPutter } from "./stats";
import { distanceMeters } from "./geo";
import type { FairwayResult, LatLng, Lie, PenaltyType, PositionSource, Round, RoundHole, Shot } from "../types/domain";

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

async function queueOutbox(table: string, op: "upsert" | "delete", payload: unknown) {
  await db.outbox.put({ id: uuid(), table, op, payload, createdAt: now() });
}

/** The in-progress round for this course, if one exists (any course version). Most recently
 * touched wins — nothing stops two in-progress rounds existing on one course (start one, walk
 * away, start another), and picking whichever the array happened to yield first meant you could
 * be dropped back into the older one. */
export async function getActiveRoundForCourse(courseId: string): Promise<Round | undefined> {
  const versionIds = (await db.courseVersions.where("courseId").equals(courseId).toArray()).map((v) => v.id);
  const inProgress = await db.rounds.where("status").equals("in_progress").toArray();
  return inProgress
    .filter((r) => versionIds.includes(r.courseVersionId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/**
 * Deletes a round and everything recorded against it. For abandoning a round started by mistake:
 * without this an accidental start is permanent, the dashboard offers to resume it forever, and
 * its empty holes sit in the data.
 */
export async function discardRound(roundId: string): Promise<void> {
  await db.transaction(
    "rw",
    [db.rounds, db.roundHoles, db.shots, db.watchLaps, db.clubTaps, db.reviewFlags, db.roundTracks, db.outbox],
    async () => {
      const roundHoles = await db.roundHoles.where("roundId").equals(roundId).toArray();
      for (const rh of roundHoles) {
        for (const s of await db.shots.where("roundHoleId").equals(rh.id).toArray()) {
          await db.shots.delete(s.id);
          await queueOutbox("shots", "delete", { id: s.id });
        }
        await db.roundHoles.delete(rh.id);
        await queueOutbox("roundHoles", "delete", { id: rh.id });
      }
      await db.watchLaps.where("roundId").equals(roundId).delete();
      await db.clubTaps.where("roundId").equals(roundId).delete();
      await db.reviewFlags.where("roundId").equals(roundId).delete();
      await db.roundTracks.delete(roundId);
      await db.rounds.delete(roundId);
      await queueOutbox("rounds", "delete", { id: roundId });
    }
  );
}

export async function startRound(courseVersionId: string, holeRange?: { startHole: number; endHole: number }): Promise<Round> {
  const round: Round = {
    id: uuid(),
    courseVersionId,
    playedOn: new Date().toISOString().slice(0, 10),
    status: "in_progress",
    startHole: holeRange?.startHole,
    endHole: holeRange?.endHole,
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
    const previousPutts = existing.filter((s) => s.reconciliation === "green_mark");
    for (const s of previousPutts) {
      await db.shots.delete(s.id);
      await queueOutbox("shots", "delete", { id: s.id });
    }
    const nonPutt = existing.filter((s) => s.reconciliation !== "green_mark");

    // The putts' timestamp is the hole-out moment: reconciliation reads it as "you were still on
    // this hole until then" when it segments laps. Re-marking from the review screen days later
    // must therefore keep the ORIGINAL marking time, not stamp the edit time — that would pin
    // every later lap of the round to this hole on the next re-run. A hole marked for the first
    // time in review has no such time; the last stroke's plus a minute stands in.
    const strokes = nonPutt.filter((s) => s.penaltyType === null);
    const lastStroke = strokes[strokes.length - 1];
    const markedAt =
      previousPutts.map((s) => s.recordedAt).sort()[0] ??
      (lastStroke ? new Date(Date.parse(lastStroke.recordedAt) + 60_000).toISOString() : now());

    // Close the approach (last real stroke — penalties carry no movement) onto the first putt's
    // start, or straight onto the pin for a chip-in with zero putts. Unconditional: when
    // re-marking, the approach already ends on the OLD first putt and has to follow.
    const approachEnd = params.puttStarts[0] ?? params.pin;
    if (lastStroke) {
      const closed: Shot = { ...lastStroke, endPoint: approachEnd, lieEnd: "green", updatedAt: now() };
      await db.shots.put(closed);
      await queueOutbox("shots", "upsert", closed);
    }

    const putter = findPutter(await db.clubs.toArray());
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
        recordedAt: markedAt,
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

/**
 * Review-screen repositioning of a stroke — the watch was pressed after walking off the tee, or
 * the phone's fix drifted. Moves the row's startPoint and marks the position hand-placed
 * (positionSource "manual", userEdited), which reconciliation honours even when the row later
 * adopts a lap. The previous stroke ended where this one starts, so its endPoint follows;
 * penalties carry no movement and are stepped over. Elevation is cleared — it belonged to the
 * old spot. Pass `lie` to restate the lie at the same time (snapping to the tee box means "played
 * from the tee"); otherwise the lie the player recorded stands.
 */
export async function moveShotStart(shotId: string, point: LatLng, lie?: Lie): Promise<void> {
  await db.transaction("rw", [db.shots, db.outbox], async () => {
    const shot = await db.shots.get(shotId);
    if (!shot) return;
    const moved: Shot = {
      ...shot,
      startPoint: point,
      // A penalty is a point, not a movement — both ends travel together.
      endPoint: shot.penaltyType !== null ? point : shot.endPoint,
      positionSource: "manual",
      accuracyM: null,
      elevationM: null,
      ...(lie ? { lieStart: lie } : {}),
      userEdited: true,
      updatedAt: now()
    };
    await db.shots.put(moved);
    await queueOutbox("shots", "upsert", moved);
    if (shot.penaltyType !== null) return;

    const ordered = await listShotsForRoundHole(shot.roundHoleId);
    const idx = ordered.findIndex((s) => s.id === shotId);
    for (let i = idx - 1; i >= 0; i--) {
      const prev = ordered[i];
      if (prev.penaltyType !== null) continue;
      const closed: Shot = { ...prev, endPoint: point, lieEnd: moved.lieStart ?? prev.lieEnd, updatedAt: now() };
      await db.shots.put(closed);
      await queueOutbox("shots", "upsert", closed);
      break;
    }
  });
}

/**
 * Removes a stroke entered by hand on the phone — the backup that duplicates a watch lap when the
 * two didn't merge, or a double tap of the Shot sheet — and joins the chain across the gap: the
 * previous stroke now ends where the removed one did. Only for Shot-sheet rows: a reconciled row
 * would just be regenerated from its lap on the next run, and penalties have their own removal,
 * which also recomputes the score. The hole score is left alone here — it was counted at hole-out
 * and the duplicate row was the thing that disagreed with it. Remaining strokes are renumbered.
 */
export async function deleteHandEnteredShot(shotId: string): Promise<void> {
  await db.transaction("rw", [db.shots, db.watchLaps, db.clubTaps, db.outbox], async () => {
    const shot = await db.shots.get(shotId);
    if (!shot || shot.reconciliation !== "manual" || shot.penaltyType !== null) return;
    await db.shots.delete(shotId);
    await queueOutbox("shots", "delete", { id: shotId });
    // The lap/tap this row had claimed is free again for the next reconciliation.
    if (shot.watchLapId) await db.watchLaps.update(shot.watchLapId, { matchedShotId: null });
    if (shot.clubTapId) await db.clubTaps.update(shot.clubTapId, { matchedShotId: null });

    const rest = await listShotsForRoundHole(shot.roundHoleId);
    const before = rest.filter((s) => s.shotNumber < shot.shotNumber && s.penaltyType === null);
    const prev = before[before.length - 1];
    if (prev) {
      // Null endPoint (the removed row was the open last stroke) re-opens the chain, correctly.
      const closed: Shot = { ...prev, endPoint: shot.endPoint, lieEnd: shot.lieEnd, updatedAt: now() };
      await db.shots.put(closed);
      await queueOutbox("shots", "upsert", closed);
    }
    const remaining = await listShotsForRoundHole(shot.roundHoleId);
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].shotNumber === i + 1) continue;
      const renumbered: Shot = { ...remaining[i], shotNumber: i + 1, updatedAt: now() };
      await db.shots.put(renumbered);
      await queueOutbox("shots", "upsert", renumbered);
    }
  });
}

/**
 * Re-derives a hole's numbering and chain from the rows' own order — the same order
 * reconciliation assembles: strokes and penalties by recordedAt, then the putts in their marked
 * order. Each stroke ends where the next stroke starts (penalties carry no movement and are
 * stepped over); the last stroke ends at the first putt, else the pin, else keeps whatever it
 * had; putts chain onto each other and the last onto the pin. Called after an edit that changes
 * ORDER (inserting or reordering a stroke); position edits keep their own narrower chain fixes.
 * Only rows that actually changed are written.
 */
async function rechainHole(roundHoleId: string): Promise<void> {
  const rh = await db.roundHoles.get(roundHoleId);
  const rows = await listShotsForRoundHole(roundHoleId);
  const putts = rows.filter((s) => s.swingType === "putt");
  const others = [...rows.filter((s) => s.swingType !== "putt")].sort(
    (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.shotNumber - b.shotNumber
  );
  const ordered = [...others, ...putts];
  const strokes = ordered.filter((s) => s.penaltyType === null);

  const next = new Map<string, Shot | null>();
  for (let i = 0; i < strokes.length; i++) next.set(strokes[i].id, strokes[i + 1] ?? null);

  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    let patched: Shot = s.shotNumber === i + 1 ? s : { ...s, shotNumber: i + 1 };
    if (s.penaltyType === null) {
      const following = next.get(s.id) ?? null;
      const end = following?.startPoint ?? rh?.pinLocation ?? s.endPoint;
      const lieEnd: Lie | null = following ? following.lieStart : end ? "green" : s.lieEnd;
      if (end && (end.lat !== s.endPoint?.lat || end.lng !== s.endPoint?.lng || lieEnd !== s.lieEnd)) {
        patched = { ...patched, endPoint: end, lieEnd };
      }
    }
    if (patched !== s) {
      const written: Shot = { ...patched, updatedAt: now() };
      await db.shots.put(written);
      await queueOutbox("shots", "upsert", written);
    }
  }
}

/**
 * Adds a stroke the player forgot to log at the time, from the review screen. It joins the
 * hole's stroke sequence wherever it lengthens the path least — a tap in the fairway between
 * the drive's landing spot and the green slots in as the approach, a tap on the tee goes first —
 * and takes a recordedAt between its new neighbours so reconciliation orders it the same way.
 * Hand-entered and hand-positioned, so it's frozen; if a watch lap turns out to sit at that
 * moment, reconciliation will still fold the lap into it. Returns the new row.
 */
export async function insertShot(params: {
  roundHoleId: string;
  point: LatLng;
  lie: Lie;
  clubId?: string | null;
}): Promise<Shot> {
  return db.transaction("rw", [db.shots, db.roundHoles, db.outbox], async () => {
    const rows = await listShotsForRoundHole(params.roundHoleId);
    const strokes = rows
      .filter((s) => s.swingType !== "putt" && s.penaltyType === null)
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.shotNumber - b.shotNumber);
    const firstPutt = rows.filter((s) => s.swingType === "putt")[0] ?? null;

    // The hole's path so far: every stroke's start, then where the last one finished (its end,
    // else the first putt, else the pin). Slot k inserts between nodes[k-1] and nodes[k]; the cost
    // is the extra length that detour adds. A slot past the last stroke's start — including one
    // past the tail — appends. Ties go to the later slot: a tap right where the last stroke
    // finished is the NEXT stroke, not a repeat of the last.
    const rh = await db.roundHoles.get(params.roundHoleId);
    const nodes: LatLng[] = strokes.map((s) => s.startPoint);
    const lastStroke = strokes[strokes.length - 1] ?? null;
    const tail = lastStroke ? (lastStroke.endPoint ?? firstPutt?.startPoint ?? rh?.pinLocation ?? null) : null;
    if (tail) nodes.push(tail);
    let bestSlot = nodes.length;
    let bestCost = Infinity;
    for (let k = 0; k <= nodes.length; k++) {
      const a = nodes[k - 1] ?? null;
      const b = nodes[k] ?? null;
      let cost: number;
      if (a && b) cost = distanceMeters(a, params.point) + distanceMeters(params.point, b) - distanceMeters(a, b);
      else if (b) cost = distanceMeters(params.point, b);
      else if (a) cost = distanceMeters(a, params.point);
      else cost = 0;
      if (cost <= bestCost + 1e-6) {
        bestCost = cost;
        bestSlot = k;
      }
    }
    const bestIdx = Math.min(bestSlot, strokes.length);
    const before = strokes[bestIdx - 1] ?? null;
    const after = strokes[bestIdx] ?? firstPutt;
    const t =
      before && after
        ? (Date.parse(before.recordedAt) + Date.parse(after.recordedAt)) / 2
        : before
          ? Date.parse(before.recordedAt) + 60_000
          : after
            ? Date.parse(after.recordedAt) - 60_000
            : Date.now();

    const shot: Shot = {
      id: uuid(),
      roundHoleId: params.roundHoleId,
      shotNumber: 0, // rechainHole numbers it
      clubId: params.clubId ?? null,
      startPoint: params.point,
      endPoint: null,
      positionSource: "manual",
      accuracyM: null,
      lieStart: params.lie,
      lieEnd: null,
      watchLapId: null,
      clubTapId: null,
      reconciliation: "manual",
      elevationM: null,
      targetPoint: null,
      targetSource: "default_green",
      // Always a stroke: putts are added on the green-marking screen, where they get positions
      // and a pin to chain onto.
      swingType: "full",
      intendedYards: null,
      penaltyType: null,
      excluded: null,
      exclusionNote: null,
      recordedAt: new Date(t).toISOString(),
      updatedAt: now(),
      userEdited: true
    };
    await db.shots.put(shot);
    await queueOutbox("shots", "upsert", shot);
    await rechainHole(params.roundHoleId);
    return (await db.shots.get(shot.id)) ?? shot;
  });
}

/**
 * Moves a stroke one place earlier or later in its hole's sequence by trading recordedAt with
 * the neighbouring stroke, then re-chains. Both rows become userEdited so reconciliation orders
 * them by that time rather than by their lap. Putts keep their marked order; penalties sit where
 * they were incurred and aren't reordered.
 */
export async function swapShotOrder(shotId: string, direction: -1 | 1): Promise<void> {
  await db.transaction("rw", [db.shots, db.roundHoles, db.outbox], async () => {
    const shot = await db.shots.get(shotId);
    if (!shot || shot.swingType === "putt" || shot.penaltyType !== null) return;
    const strokes = (await listShotsForRoundHole(shot.roundHoleId))
      .filter((s) => s.swingType !== "putt" && s.penaltyType === null)
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.shotNumber - b.shotNumber);
    const idx = strokes.findIndex((s) => s.id === shotId);
    const other = strokes[idx + direction];
    if (idx < 0 || !other) return;
    // Identical timestamps would swap into themselves; nudge a second past the neighbour instead.
    const swappedAt =
      other.recordedAt === shot.recordedAt
        ? new Date(Date.parse(shot.recordedAt) + direction * 1000).toISOString()
        : other.recordedAt;
    const a: Shot = { ...shot, recordedAt: swappedAt, userEdited: true, updatedAt: now() };
    const b: Shot = { ...other, recordedAt: shot.recordedAt, userEdited: true, updatedAt: now() };
    await db.shots.put(a);
    await queueOutbox("shots", "upsert", a);
    await db.shots.put(b);
    await queueOutbox("shots", "upsert", b);
    await rechainHole(shot.roundHoleId);
  });
}

/** Review-screen score correction. The score is the player's own count; nothing derives it. */
export async function setRoundHoleScore(roundHoleId: string, score: number | null): Promise<void> {
  const rh = await db.roundHoles.get(roundHoleId);
  if (!rh) return;
  const updated: RoundHole = { ...rh, score, updatedAt: now() };
  await db.roundHoles.put(updated);
  await queueOutbox("roundHoles", "upsert", updated);
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
