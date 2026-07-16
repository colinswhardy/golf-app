import { db } from "./db";
import type { LatLng, Lie, Round, RoundHole, Shot } from "../types/domain";

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
}): Promise<Shot> {
  return db.transaction("rw", [db.shots, db.outbox], async () => {
    const existing = await listShotsForRoundHole(params.roundHoleId);
    const prev = existing[existing.length - 1];

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
      lieStart: params.lie,
      lieEnd: null,
      aimPointOverride: null,
      recordedAt: now(),
      updatedAt: now()
    };
    await db.shots.put(shot);
    await queueOutbox("shots", "upsert", shot);
    return shot;
  });
}

/**
 * Saves score/putts for the hole and closes out the final recorded shot: its
 * end is the hole (green centroid stand-in until per-round pin positions are
 * wired up), lie "green".
 */
export async function saveHoleResult(params: {
  roundHoleId: string;
  score: number;
  putts: number;
  puttDistancesFeet: (number | null)[];
  holeOutPoint: LatLng | null;
}): Promise<void> {
  await db.transaction("rw", [db.roundHoles, db.shots, db.outbox], async () => {
    const rh = await db.roundHoles.get(params.roundHoleId);
    if (!rh) return;
    const updated: RoundHole = {
      ...rh,
      score: params.score,
      putts: params.putts,
      puttDistancesFeet: params.puttDistancesFeet,
      updatedAt: now()
    };
    await db.roundHoles.put(updated);
    await queueOutbox("roundHoles", "upsert", updated);

    const shots = await listShotsForRoundHole(params.roundHoleId);
    const last = shots[shots.length - 1];
    if (last && !last.endPoint && params.holeOutPoint) {
      const closed: Shot = { ...last, endPoint: params.holeOutPoint, lieEnd: "green", updatedAt: now() };
      await db.shots.put(closed);
      await queueOutbox("shots", "upsert", closed);
    }
  });
}

export async function completeRound(roundId: string): Promise<void> {
  const round = await db.rounds.get(roundId);
  if (!round) return;
  const updated: Round = { ...round, status: "completed", updatedAt: now() };
  await db.rounds.put(updated);
  await queueOutbox("rounds", "upsert", updated);
}
