import Dexie, { type EntityTable } from "dexie";
import type {
  Club,
  ClubTag,
  ClubTap,
  Course,
  CourseVersion,
  Hole,
  HoleFeature,
  ReviewFlag,
  Round,
  RoundHole,
  RoundTrack,
  SgBaselineScratch,
  Shot,
  TeeBox,
  WatchLap
} from "../types/domain";

export interface OutboxEntry {
  id: string;
  table: string;
  op: "upsert" | "delete";
  payload: unknown;
  createdAt: string;
}

const db = new Dexie("golf-app") as Dexie & {
  courses: EntityTable<Course, "id">;
  courseVersions: EntityTable<CourseVersion, "id">;
  holes: EntityTable<Hole, "id">;
  teeBoxes: EntityTable<TeeBox, "id">;
  holeFeatures: EntityTable<HoleFeature, "id">;
  clubs: EntityTable<Club, "id">;
  rounds: EntityTable<Round, "id">;
  roundHoles: EntityTable<RoundHole, "id">;
  shots: EntityTable<Shot, "id">;
  sgBaselineScratch: EntityTable<SgBaselineScratch, "lie">;
  watchLaps: EntityTable<WatchLap, "id">;
  clubTaps: EntityTable<ClubTap, "id">;
  roundTracks: EntityTable<RoundTrack, "roundId">;
  reviewFlags: EntityTable<ReviewFlag, "id">;
  clubTags: EntityTable<ClubTag, "serialNumber">;
  outbox: EntityTable<OutboxEntry, "id">;
};

// v1 local schema — mirrors DESIGN.md's Supabase tables. Everything syncable is
// written here first (see lib/sync.ts, not yet implemented) and read from here always.
db.version(1).stores({
  courses: "id, updatedAt, deletedAt",
  courseVersions: "id, courseId, versionNumber",
  holes: "id, courseVersionId, number",
  teeBoxes: "id, holeId",
  holeFeatures: "id, holeId, featureType",
  clubs: "id, sortOrder",
  rounds: "id, courseVersionId, playedOn, status",
  roundHoles: "id, roundId, holeId",
  shots: "id, roundHoleId, shotNumber, clubId",
  sgBaselineScratch: "[lie+distanceYards], lie",
  outbox: "id, createdAt"
});

// v2: courseRepo/seedCourses both query courses by name (dedupe-by-name on
// import) — "name" needs to be indexed for `.where("name")` to work at all.
db.version(2).stores({
  courses: "id, name, updatedAt, deletedAt"
});

// v3 (REVISION-SPEC Phase 0): Course gains slug (stable natural key, replaces dedupe-by-name)
// and importerVersion (replaces the caddyshot_reseeded_* localStorage flags); Shot gains
// positionSource/accuracyM so tee-fallback fixes stop masquerading as real GPS.
const LEGACY_NAME_TO_SLUG: Record<string, string> = {
  "Tarandowah Golfers Club": "tarandowah",
  "Innerkip Highlands Golf Club": "innerkip-highlands"
};

db.version(3)
  .stores({
    courses: "id, name, slug, updatedAt, deletedAt"
  })
  .upgrade(async (tx) => {
    const legacyReseedFlag =
      typeof localStorage !== "undefined" && !!localStorage.getItem("caddyshot_reseeded_v3");
    await tx.table("courses").toCollection().modify((c: Record<string, unknown>) => {
      if (!c.slug) {
        const name = String(c.name ?? "");
        c.slug =
          LEGACY_NAME_TO_SLUG[name] ??
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
      }
      if (typeof c.importerVersion !== "number") {
        // Pre-slug installs: if the v3 reseed flag was set, the current geometry came from
        // importer v3; otherwise it's older. Either way < IMPORTER_VERSION, so bundled courses
        // pick up an ADDITIVE re-import (new version — never a wipe) on next seed.
        c.importerVersion = legacyReseedFlag ? 3 : 0;
      }
    });
    await tx.table("shots").toCollection().modify((s: Record<string, unknown>) => {
      if (!s.positionSource) s.positionSource = "gps";
      if (s.accuracyM === undefined) s.accuracyM = null;
    });
  });

// v4 (REVISION-SPEC Phase 1): two-stream capture tables (watch laps, NFC club taps, 1 Hz track,
// review flags, tag pairings) plus the Shot/Round reconciliation fields. aimPointOverride is
// migrated into targetPoint (+ targetSource "manual") and dropped; putts recorded via the old
// manual flow are identified by lieStart "green" and stamped swingType "putt".
db.version(4)
  .stores({
    watchLaps: "id, roundId, lapIndex",
    clubTaps: "id, roundId, tPhone",
    roundTracks: "roundId",
    reviewFlags: "id, roundId, status",
    clubTags: "serialNumber, clubId"
  })
  .upgrade(async (tx) => {
    await tx.table("shots").toCollection().modify((s: Record<string, unknown>) => {
      if (s.watchLapId === undefined) s.watchLapId = null;
      if (s.clubTapId === undefined) s.clubTapId = null;
      if (!s.reconciliation) s.reconciliation = "manual";
      if (s.elevationM === undefined) s.elevationM = null;
      if (s.targetPoint === undefined) s.targetPoint = s.aimPointOverride ?? null;
      if (!s.targetSource) s.targetSource = s.aimPointOverride ? "manual" : "default_green";
      delete s.aimPointOverride;
      if (!s.swingType) s.swingType = s.lieStart === "green" ? "putt" : "full";
      if (s.intendedYards === undefined) s.intendedYards = null;
      if (s.penaltyType === undefined) s.penaltyType = null;
      if (s.excluded === undefined) s.excluded = null;
      if (s.exclusionNote === undefined) s.exclusionNote = null;
    });
    await tx.table("rounds").toCollection().modify((r: Record<string, unknown>) => {
      if (r.fitActivityId === undefined) r.fitActivityId = null;
      if (r.fitIngestedAt === undefined) r.fitIngestedAt = null;
      if (r.clockOffsetMs === undefined) r.clockOffsetMs = null;
      if (r.watchCalibrationAt === undefined) r.watchCalibrationAt = null;
      if (r.reconciledAt === undefined) r.reconciledAt = null;
    });
  });

/** Deletes outbox entries older than 30 days (REVISION-SPEC 0.5). Nothing drains the outbox yet
 * (no sync worker exists), so without this it grows forever. The queueOutbox pattern itself stays
 * — a future sync implementation replays what's here — this just stops it consuming storage
 * indefinitely. Called fire-and-forget from App on start. */
export async function pruneOutbox(maxAgeDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  return db.outbox.where("createdAt").below(cutoff).delete();
}

export { db };
