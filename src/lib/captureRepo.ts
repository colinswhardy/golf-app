import { db } from "./db";
import type { ClubTag, ClubTap, LatLng, ReviewFlag, ReviewFlagType, Round, RoundTrack, WatchLap } from "../types/domain";

/** Dexie writes for the two-stream capture system (REVISION-SPEC Phase 2): NFC tag pairings,
 * live club taps, ingested watch laps/track, review flags, and clock calibration. Same
 * repo+outbox pattern as roundRepo/courseRepo. */

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

async function queueOutbox(table: string, op: "upsert" | "delete", payload: unknown) {
  await db.outbox.put({ id: uuid(), table, op, payload, createdAt: now() });
}

// --- NFC tag pairing (2.1) ---

export async function listClubTags(): Promise<ClubTag[]> {
  return db.clubTags.toArray();
}

export async function pairClubTag(serialNumber: string, clubId: string): Promise<ClubTag> {
  const tag: ClubTag = { serialNumber, clubId, pairedAt: now() };
  await db.clubTags.put(tag); // re-pairing an existing serial just overwrites the row
  await queueOutbox("clubTags", "upsert", tag);
  return tag;
}

export async function unpairClubTag(serialNumber: string): Promise<void> {
  await db.clubTags.delete(serialNumber);
  await queueOutbox("clubTags", "delete", { serialNumber });
}

/** Resolves a tag serial to its paired club id, or null for an unpaired tag. */
export async function clubIdForSerial(serialNumber: string): Promise<string | null> {
  return (await db.clubTags.get(serialNumber))?.clubId ?? null;
}

// --- Live club taps (2.1) ---

export async function recordClubTap(params: {
  roundId: string;
  clubId: string;
  serialNumber: string;
  at: Date;
  /** Phone GPS fix at the moment of the tap, if one was available — the fallback position when
   * the watch track has a gap at this timestamp (reconcile STEP 4). */
  point: LatLng | null;
  accuracyM: number | null;
}): Promise<ClubTap> {
  const tap: ClubTap = {
    id: uuid(),
    roundId: params.roundId,
    tPhone: params.at.toISOString(),
    clubId: params.clubId,
    serialNumber: params.serialNumber,
    point: params.point,
    accuracyM: params.accuracyM,
    matchedShotId: null
  };
  await db.clubTaps.put(tap);
  await queueOutbox("clubTaps", "upsert", tap);
  return tap;
}

export async function listClubTapsForRound(roundId: string): Promise<ClubTap[]> {
  return (await db.clubTaps.where("roundId").equals(roundId).toArray()).sort((a, b) => a.tPhone.localeCompare(b.tPhone));
}

// --- Watch data ingest (2.4) ---

/** Stores a parsed FIT file's laps + track for a round, replacing any previous ingest for the
 * same round (re-attaching a corrected file is supported; laps/track are raw capture data, not
 * user edits, so replacement is safe). Also stamps the round's fit fields. */
export async function saveWatchData(params: {
  roundId: string;
  laps: WatchLap[];
  track: RoundTrack;
  activityId: string;
  clockOffsetMs: number | null;
}): Promise<void> {
  await db.transaction("rw", [db.watchLaps, db.roundTracks, db.rounds, db.outbox], async () => {
    await db.watchLaps.where("roundId").equals(params.roundId).delete();
    for (const lap of params.laps) {
      await db.watchLaps.put(lap);
      await queueOutbox("watchLaps", "upsert", lap);
    }
    await db.roundTracks.put(params.track);
    await queueOutbox("roundTracks", "upsert", params.track);

    const round = await db.rounds.get(params.roundId);
    if (round) {
      const updated: Round = {
        ...round,
        fitActivityId: params.activityId,
        fitIngestedAt: now(),
        clockOffsetMs: params.clockOffsetMs ?? round.clockOffsetMs,
        updatedAt: now()
      };
      await db.rounds.put(updated);
      await queueOutbox("rounds", "upsert", updated);
    }
  });
}

export async function listWatchLapsForRound(roundId: string): Promise<WatchLap[]> {
  return (await db.watchLaps.where("roundId").equals(roundId).toArray()).sort((a, b) => a.lapIndex - b.lapIndex);
}

// --- Clock calibration (2.5) ---

/** Records the phone timestamp of the "Calibrate watch" press (the user presses the watch lap
 * button at the same moment). Ingest later matches this to the nearest lap to derive the offset. */
export async function recordWatchCalibration(roundId: string): Promise<void> {
  const round = await db.rounds.get(roundId);
  if (!round) return;
  const updated: Round = { ...round, watchCalibrationAt: now(), updatedAt: now() };
  await db.rounds.put(updated);
  await queueOutbox("rounds", "upsert", updated);
}

// --- Review flags (Phase 3/4) ---

export async function addReviewFlag(flag: Omit<ReviewFlag, "id" | "createdAt" | "resolvedAt" | "status"> & { status?: ReviewFlag["status"] }): Promise<ReviewFlag> {
  const full: ReviewFlag = {
    id: uuid(),
    createdAt: now(),
    resolvedAt: null,
    status: flag.status ?? "open",
    roundId: flag.roundId,
    roundHoleId: flag.roundHoleId,
    shotId: flag.shotId,
    type: flag.type,
    detail: flag.detail
  };
  await db.reviewFlags.put(full);
  await queueOutbox("reviewFlags", "upsert", full);
  return full;
}

export async function setReviewFlagStatus(flagId: string, status: ReviewFlag["status"]): Promise<void> {
  const flag = await db.reviewFlags.get(flagId);
  if (!flag) return;
  const updated: ReviewFlag = {
    ...flag,
    status,
    resolvedAt: status === "resolved" ? now() : flag.resolvedAt
  };
  await db.reviewFlags.put(updated);
  await queueOutbox("reviewFlags", "upsert", updated);
}

export async function listFlagsForRound(roundId: string): Promise<ReviewFlag[]> {
  return db.reviewFlags.where("roundId").equals(roundId).toArray();
}

/** Deletes reconciliation-owned flags for a round before a re-run so it stays idempotent —
 * flags the user resolved/dismissed for shots that still exist are preserved by the caller
 * passing keepIds. */
export async function clearFlagsForRound(roundId: string, types: ReviewFlagType[], keepIds: Set<string> = new Set()): Promise<void> {
  const flags = await db.reviewFlags.where("roundId").equals(roundId).toArray();
  for (const f of flags) {
    if (!types.includes(f.type) || keepIds.has(f.id)) continue;
    await db.reviewFlags.delete(f.id);
    await queueOutbox("reviewFlags", "delete", { id: f.id });
  }
}
