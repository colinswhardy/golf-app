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
  updatedAt: string;
}

export interface Round {
  id: string;
  courseVersionId: string;
  playedOn: string;
  status: "in_progress" | "completed";
  updatedAt: string;
}

export interface RoundHole {
  id: string;
  roundId: string;
  holeId: string;
  score: number | null;
  putts: number | null;
  /** One entry per putt, in feet; null entry = distance not recorded. First putt = SG-putting input. */
  puttDistancesFeet: (number | null)[] | null;
  pinLocation: LatLng | null; // null = assume green-center for this hole/round
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
