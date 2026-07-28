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
  | "tee"
  | "centerline";

export interface Course {
  id: string;
  name: string;
  /** Stable natural key (derived from the bundled filename, or slugified name for ad-hoc
   * imports). Dedupe key for imports — names are display-only. Backfilled by the Dexie v3
   * migration for pre-slug rows. */
  slug: string;
  /** The importer version whose output this course's LATEST version was produced by. A bundled
   * course re-imports (additively — new CourseVersion, never a wipe) whenever the app ships a
   * newer IMPORTER_VERSION. Replaces the old caddyshot_reseeded_* localStorage flags, which were
   * invisible across devices and un-backupable. */
  importerVersion: number;
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
  /** Polygon for every playable-surface feature. LineString ONLY for featureType "centerline"
   * (the OSM tee→green hole line, kept for target-line defaults). Lie detection and all
   * proximity math skip non-Polygon rows — assert on featureType before using coordinates. */
  geometry: GeoJSON.Polygon | GeoJSON.LineString;
  /** Lie-detection precedence (higher wins). -1 marks a SYNTHETIC feature (e.g. a straight
   * tee→green centerline fabricated for holes whose OSM data has none). */
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
  /** A shot with this club is a PARTIAL swing when the pin is closer than this at address
   * (REVISION-SPEC 5.4). Null/undefined = this club is never partial. Defaults seeded for the
   * 56° (80) and 50° (100). */
  fullSwingMinYards?: number | null;
  /** Descent angle (degrees) for elevation-normalised distances (5.2). Null = use the per-club-
   * type default table in lib/stats.ts. User-editable. */
  descentAngleDeg?: number | null;
  updatedAt: string;
}

export interface Round {
  id: string;
  courseVersionId: string;
  playedOn: string;
  status: "in_progress" | "completed";
  /** FIT-file ingest bookkeeping (Phase 1.2). */
  fitActivityId: string | null;
  fitIngestedAt: string | null;
  /** watch clock − phone clock, in ms; null until calibrated or estimated at ingest. */
  clockOffsetMs: number | null;
  /** Marks the generated sample round (lib/demoRound.ts) so it can be removed cleanly and never
   * mistaken for real play. Absent on every genuine round. */
  isDemo?: boolean;
  /** Phone timestamp of the "Calibrate watch" press (user hits the watch lap button at the same
   * moment); used at ingest to compute clockOffsetMs. */
  watchCalibrationAt: string | null;
  reconciledAt: string | null;
  updatedAt: string;
}

export type FairwayResult = "hit" | "left" | "right" | "short" | "long";

export interface RoundHole {
  id: string;
  roundId: string;
  holeId: string;
  score: number | null;
  putts: number | null;
  /** DEPRECATED (Phase 1.4): putts are real Shot rows now (swingType "putt", positions from the
   * green-marking screen). Kept one release for old rounds' display; no new writes. */
  puttDistancesFeet: (number | null)[] | null;
  /** Authoritative pin position for this hole/round, written by the green-marking screen at
   * hole-out (and by target drags mid-round). Null only on legacy/unmarked holes — consumers
   * fall back to the green centroid. */
  pinLocation: LatLng | null;
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

/** Where a shot's startPoint actually came from. "tee_fallback" = no GPS lock, silently recorded
 * at the tee-box coordinate — excluded from all distance statistics. */
export type PositionSource = "gps" | "watch_lap" | "watch_track" | "manual" | "tee_fallback";

/** How this Shot row came to exist: matched lap+tap pair, one side only, hand-entered, or a
 * green-marking-screen putt. Rows with "manual" reconciliation (or user-overridden fields) are
 * FROZEN — re-running reconciliation must never change them. */
export type Reconciliation = "matched" | "lap_only" | "tap_only" | "manual" | "green_mark";

export type TargetSource = "default_green" | "default_fairway" | "default_pin" | "manual";

export type SwingType = "full" | "partial" | "putt";

export type ExclusionReason = "auto_outlier" | "manual" | "bad_position";

/** Penalty strokes are Shot rows too (clubId null, no swing) so `laps + putts + penalties ===
 * score` balances and Appendix C's "every stroke is a Shot row" holds. Null = a normal stroke. */
export type PenaltyType =
  | "lost_ball"
  | "penalty_red"
  | "penalty_yellow"
  | "ob"
  | "unplayable"
  | "stroke_distance";

export interface Shot {
  id: string;
  roundHoleId: string;
  shotNumber: number;
  clubId: string | null;
  startPoint: LatLng;
  endPoint: LatLng | null;
  positionSource: PositionSource;
  /** GeolocationPosition.coords.accuracy in metres for GPS-sourced fixes; null otherwise
   * (and null on rows recorded before this field existed). Shots with accuracyM > 15 are
   * excluded from distance statistics. */
  accuracyM: number | null;
  lieStart: Lie | null;
  lieEnd: Lie | null;

  // --- capture-event identity (Phase 1.1): which events this shot was reconciled from ---
  watchLapId: string | null;
  clubTapId: string | null;
  reconciliation: Reconciliation;

  // --- geometry ---
  /** DEM elevation at startPoint (metres), for slope-normalised distances. */
  elevationM: number | null;
  /** Where the player was actually aiming. Null = not yet set; Phase 4 applies the
   * targetSource default automatically. Supersedes the old aimPointOverride field. */
  targetPoint: LatLng | null;
  targetSource: TargetSource;

  // --- classification ---
  swingType: SwingType;
  /** Partials only: startPoint → pin distance at address, the bucketing key for wedge stats. */
  intendedYards: number | null;
  penaltyType: PenaltyType | null;

  // --- stats participation ---
  excluded: ExclusionReason | null;
  exclusionNote: string | null;

  /** True once the user has hand-corrected any field (Phase 4 review edits). Freezes the row
   * against re-reconciliation — the engine may still recompute derived chain fields
   * (endPoint/lieEnd/shotNumber) but never club/lie/position/target. */
  userEdited?: boolean;

  recordedAt: string;
  updatedAt: string;
}

export interface SgBaselineScratch {
  lie: Lie;
  distanceYards: number;
  expectedStrokes: number;
}

// ---------------------------------------------------------------------------
// Two-stream capture (Phase 1.3): watch lap presses + phone NFC club taps, raw
// as recorded, reconciled into Shot rows after the round by lib/reconcile.ts.
// ---------------------------------------------------------------------------

/** One COROS lap-button press, from the FIT file's lap messages. Watch clock. */
export interface WatchLap {
  id: string;
  roundId: string;
  lapIndex: number;
  /** ISO timestamp, WATCH clock (apply Round.clockOffsetMs to compare with phone events). */
  tWatch: string;
  /** The lap's END position — where the watch was when the button was pressed. */
  point: LatLng;
  /** Barometric altitude from the FIT record, if present. */
  elevationM: number | null;
  matchedShotId: string | null;
}

/** One NFC club-tag read on the phone, captured live during the round. Phone clock. */
export interface ClubTap {
  id: string;
  roundId: string;
  /** ISO timestamp, PHONE clock. */
  tPhone: string;
  clubId: string;
  serialNumber: string;
  /** Phone GPS fix at the moment of the tap, if one was available — the position fallback when
   * the watch track has a gap at this timestamp. */
  point: LatLng | null;
  accuracyM: number | null;
  matchedShotId: string | null;
}

/** The watch's 1 Hz position track for a round, delta-encoded to keep the row small.
 * Encode/decode in lib/track.ts — do not touch the arrays directly. */
export interface RoundTrack {
  roundId: string; // primary key — one track per round
  /** Epoch ms of the first sample (watch clock). */
  t0: number;
  /** Per-sample ms deltas from the previous sample. */
  dt: number[];
  /** 1e-7-degree integers (same fixed-point scheme FIT itself uses). */
  lat: number[];
  lng: number[];
  /** Decimetres. */
  ele: number[];
}

export type ReviewFlagType =
  | "ambiguous_lie"
  | "missing_club"
  | "score_mismatch"
  | "bad_position"
  | "unmatched_lap"
  | "unmatched_tap";

/** A problem reconciliation (or capture) noticed, queued for the player to resolve. "dismissed"
 * means deferred to the end-of-round queue, NOT resolved. */
export interface ReviewFlag {
  id: string;
  roundId: string;
  roundHoleId: string | null;
  shotId: string | null;
  type: ReviewFlagType;
  detail: string;
  status: "open" | "resolved" | "dismissed";
  createdAt: string;
  resolvedAt: string | null;
}

/** NFC tag → club pairing. Tags are identified by hardware serial (NDEFReadingEvent.serialNumber),
 * never by written content — blank NTAG213 stickers work and stay reassignable. */
export interface ClubTag {
  serialNumber: string; // primary key
  clubId: string;
  pairedAt: string;
}
