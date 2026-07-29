import { db } from "./db";
import { distanceMeters } from "./geo";
import { getLatestCourseVersion } from "./courseRepo";
import type { LatLng, Round, RoundHole, Shot } from "../types/domain";

/**
 * REVISION-SPEC 0.2: IndexedDB has no referential integrity, and the old reseed machinery
 * (deleted in this revision) wiped courses/versions/holes while leaving rounds/roundHoles/shots
 * pointing at dead UUIDs. This module finds those orphans and repairs them.
 *
 * Repair note: a dangling holeId carries no recoverable hole *number* (the row it pointed at is
 * gone), so the spec's "(courseSlug, holeNumber)" match is implemented geometrically — a round is
 * re-pointed to the course whose holes its recorded shot positions are nearest to, and each
 * roundHole to the nearest hole (by tee position) in that course's latest version. RoundHoles
 * with no recorded shots have no position to match on and stay unrepairable (reported, not
 * silently dropped).
 */

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

async function queueOutbox(table: string, op: "upsert" | "delete", payload: unknown) {
  await db.outbox.put({ id: uuid(), table, op, payload, createdAt: now() });
}

export interface DanglingReport {
  /** Rounds whose courseVersionId no longer resolves. */
  rounds: Round[];
  /** RoundHoles whose holeId (or parent round) no longer resolves. */
  roundHoles: RoundHole[];
  /** Shots whose roundHoleId no longer resolves. */
  shots: Shot[];
  total: number;
}

export async function findDanglingReferences(): Promise<DanglingReport> {
  const [versionIds, holeIds, roundIds, roundHoleIds] = await Promise.all([
    db.courseVersions.toCollection().primaryKeys().then((ks) => new Set(ks as string[])),
    db.holes.toCollection().primaryKeys().then((ks) => new Set(ks as string[])),
    db.rounds.toCollection().primaryKeys().then((ks) => new Set(ks as string[])),
    db.roundHoles.toCollection().primaryKeys().then((ks) => new Set(ks as string[]))
  ]);

  const rounds = (await db.rounds.toArray()).filter((r) => !versionIds.has(r.courseVersionId));
  const roundHoles = (await db.roundHoles.toArray()).filter(
    (rh) => !holeIds.has(rh.holeId) || !roundIds.has(rh.roundId)
  );
  const shots = (await db.shots.toArray()).filter((s) => !roundHoleIds.has(s.roundHoleId));

  return { rounds, roundHoles, shots, total: rounds.length + roundHoles.length + shots.length };
}

interface HoleCandidate {
  holeId: string;
  courseVersionId: string;
  position: LatLng;
}

/** Every hole in every course's LATEST version that has a locatable position (tee box, else
 * green override). These are the re-pointing targets for orphaned rows. */
async function buildHoleCandidates(): Promise<HoleCandidate[]> {
  const candidates: HoleCandidate[] = [];
  const courses = (await db.courses.toArray()).filter((c) => !c.deletedAt);
  for (const course of courses) {
    const version = await getLatestCourseVersion(course.id);
    if (!version) continue;
    const holes = await db.holes.where("courseVersionId").equals(version.id).toArray();
    for (const hole of holes) {
      const tees = await db.teeBoxes.where("holeId").equals(hole.id).toArray();
      const position = tees[0]?.location ?? hole.greenPoint ?? null;
      if (!position) continue;
      candidates.push({ holeId: hole.id, courseVersionId: version.id, position });
    }
  }
  return candidates;
}

function nearest(candidates: HoleCandidate[], point: LatLng): HoleCandidate | null {
  let best: { c: HoleCandidate; d: number } | null = null;
  for (const c of candidates) {
    const d = distanceMeters(point, c.position);
    if (!best || d < best.d) best = { c, d };
  }
  return best?.c ?? null;
}

/** First recorded shot position for a roundHole, if any — the anchor for geometric repair. */
async function firstShotPoint(roundHoleId: string): Promise<LatLng | null> {
  const shots = await db.shots.where("roundHoleId").equals(roundHoleId).toArray();
  shots.sort((a, b) => a.shotNumber - b.shotNumber);
  return shots[0]?.startPoint ?? null;
}

export interface RepairResult {
  repairedRounds: number;
  repairedRoundHoles: number;
  unrepairable: number;
}

export async function repairDanglingReferences(): Promise<RepairResult> {
  const report = await findDanglingReferences();
  const candidates = await buildHoleCandidates();
  let repairedRounds = 0;
  let repairedRoundHoles = 0;
  let unrepairable = report.shots.length; // shots with a dead roundHole have nothing to hang off

  // 1. Rounds: re-point courseVersionId to the version whose holes the round's shots are nearest.
  for (const round of report.rounds) {
    const roundHoles = await db.roundHoles.where("roundId").equals(round.id).toArray();
    let anchor: LatLng | null = null;
    for (const rh of roundHoles) {
      anchor = await firstShotPoint(rh.id);
      if (anchor) break;
    }
    const match = anchor ? nearest(candidates, anchor) : null;
    if (!match) {
      unrepairable++;
      continue;
    }
    const updated: Round = { ...round, courseVersionId: match.courseVersionId, updatedAt: now() };
    await db.rounds.put(updated);
    await queueOutbox("rounds", "upsert", updated);
    repairedRounds++;
  }

  // 2. RoundHoles: re-point holeId to the geometrically nearest hole within the round's
  // (possibly just-repaired) course version.
  //
  // Holes already taken within a round are excluded from the candidates. Repairing each row
  // independently could otherwise map two of a round's holes onto the SAME hole, which reads as
  // one hole scored twice and another missing — corrupting the scorecard while appearing to fix
  // it. Rows already resolving correctly count as taken too, so a repair can't collide with them.
  const takenByRound = new Map<string, Set<string>>();
  for (const rh of await db.roundHoles.toArray()) {
    if (report.roundHoles.some((bad) => bad.id === rh.id)) continue; // this one is being moved
    const set = takenByRound.get(rh.roundId) ?? new Set<string>();
    set.add(rh.holeId);
    takenByRound.set(rh.roundId, set);
  }

  for (const rh of report.roundHoles) {
    const round = await db.rounds.get(rh.roundId);
    if (!round) {
      unrepairable++;
      continue;
    }
    const anchor = await firstShotPoint(rh.id);
    if (!anchor) {
      unrepairable++;
      continue;
    }
    const taken = takenByRound.get(rh.roundId) ?? new Set<string>();
    const free = candidates.filter((c) => !taken.has(c.holeId));
    const versionCandidates = free.filter((c) => c.courseVersionId === round.courseVersionId);
    const match = nearest(versionCandidates.length ? versionCandidates : free, anchor);
    if (!match) {
      unrepairable++;
      continue;
    }
    taken.add(match.holeId);
    takenByRound.set(rh.roundId, taken);
    const updated: RoundHole = { ...rh, holeId: match.holeId, updatedAt: now() };
    await db.roundHoles.put(updated);
    await queueOutbox("roundHoles", "upsert", updated);
    repairedRoundHoles++;
  }

  return { repairedRounds, repairedRoundHoles, unrepairable };
}
