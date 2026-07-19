// Mirrors the Supabase schema in DESIGN.md. Kept as plain types (not classes) since
// Dexie and Supabase both just move plain objects around.

export type LatLng = { lat: number; lng: number };

export type FeatureType =
  | "fairway"
  | "green"
  | "fringe"
  | "bunker_greenside"
  | "bunker_fairway"
  | "hazard"
  | "ob"
  | "rough"
  | "tee";

export interface Course {
  id: string;
  name: string;
  location: LatLng | null;
  updatedAt: string;
  deletedAt: string | null;
  isFeatured?: boolean;
  lastSelectedAt?: string | null;
}

export interface CourseVersion {
  id: string;
  courseId: string;
  versionNumber: number;
  effectiveFrom: string;
  source: "overpass_import" | "manual_edit";
  updatedAt: string;
}

export interface Hole {
  id: string;
  courseVersionId: string;
  number: number;
  par: number;
  defaultYardage: number | null;
  /** Freeform per-hole notes (yardage reminders, strategy, etc), persisted so they reload the
   * next time this course/hole is played — not tied to a specific round. */
  notes?: string | null;
  /** Course-editor override for the green center / aim target. When set, the round map uses this
   * as the green (target + camera framing) instead of deriving a centroid from the green polygon —
   * lets you correct a mis-mapped green, or give a green to a hole the OSM import left without one. */
  greenPoint?: LatLng | null;
  /** Saved mid-hole waypoints (layup / aim points), set in the course editor and seeded as
   * measure dots automatically the next time this hole is played. Persist with the course, not the
   * round, so a considered layup line reloads every time. */
  waypoints?: LatLng[] | null;
  updatedAt: string;
}

export interface TeeBox {
  id: string;
  holeId: string;
  name: string;
  location: LatLng;
}

export interface HoleFeature {
  id: string;
  holeId: string;
  featureType: FeatureType;
  geometry: GeoJSON.Polygon;
  zOrder: number;
}

export interface Club {
  id: string;
  name: string;
  sortOrder: number;
  /** Manual dispersion overrides (yards), used when useActualDispersion is false or there isn't
   * enough shot history yet to compute an actual ellipse. */
  manualFrontBackYards?: number | null;
  manualLeftRightYards?: number | null;
  /** When true, the dispersion overlay is computed from this club's actual recorded shots
   * (see lib/dispersion.ts) instead of the manual front/back + left/right values. */
  useActualDispersion?: boolean;
  updatedAt: string;
}

export interface Round {
  id: string;
  courseVersionId: string;
  playedOn: string;
  status: "in_progress" | "completed";
  updatedAt: string;
}

export type FairwayResult = "hit" | "left" | "right" | "short" | "long";

export interface RoundHole {
  id: string;
  roundId: string;
  holeId: string;
  score: number | null;
  putts: number | null;
  /** One entry per putt, in feet; null entry = distance not recorded. First putt = SG-putting input. */
  puttDistancesFeet: (number | null)[] | null;
  pinLocation: LatLng | null; // null = assume green-center for this hole/round
  /** Tee shot result relative to the fairway, Par 4+ only. Null = not recorded (e.g. Par 3s, or
   * unrecorded older rounds). */
  fairwayResult?: FairwayResult | null;
  updatedAt: string;
}

export type Lie =
  | "tee"
  | "fairway"
  | "rough"
  | "bunker_greenside"
  | "bunker_fairway"
  | "hazard"
  | "ob"
  | "green"
  | "fringe"
  | "recovery";

export interface Shot {
  id: string;
  roundHoleId: string;
  shotNumber: number;
  clubId: string | null;
  startPoint: LatLng;
  endPoint: LatLng | null;
  lieStart: Lie | null;
  lieEnd: Lie | null;
  aimPointOverride: LatLng | null;
  recordedAt: string;
  updatedAt: string;
}

export interface SgBaselineScratch {
  lie: Lie;
  distanceYards: number;
  expectedStrokes: number;
}
