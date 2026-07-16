import Dexie, { type EntityTable } from "dexie";
import type {
  Club,
  Course,
  CourseVersion,
  Hole,
  HoleFeature,
  Round,
  RoundHole,
  SgBaselineScratch,
  Shot,
  TeeBox
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

export { db };
