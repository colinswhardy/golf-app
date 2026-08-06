import * as turf from "@turf/turf";
import { distanceMeters, distanceYards } from "./geo";
import { findPutter } from "./stats";
import { trackLookup } from "./track";
import type {
  Club,
  FeatureType,
  LatLng,
  Lie,
  ReviewFlagType,
  RoundTrack,
  Shot,
  WatchLap,
  ClubTap
} from "../types/domain";

/**
 * Two-stream reconciliation engine (REVISION-SPEC Phase 3). PURE — no Dexie, no React, no
 * Mapbox. Everything comes in through ReconcileInput and goes out through ReconcileResult;
 * lib/reconcileRunner.ts does the I/O on either side. Unit tests in reconcile.test.ts cover
 * Appendix A.
 *
 * Idempotency contract: FROZEN rows — reconciliation "manual" (old tap-to-record flow),
 * "green_mark" (green-marking screen), penalty strokes, and anything the user edited
 * (userEdited) — are never regenerated; reconcile may only touch their derived chain fields
 * (endPoint/lieEnd/shotNumber). Regenerated rows keep their previous id when the same
 * (watchLapId, clubTapId) identity existed before, so a re-run with unchanged inputs is a
 * byte-level no-op.
 *
 * Known limitation, deliberate: a round tracked with BOTH the old manual ShotSheet flow and
 * laps/taps will double-count those swings — the engine has no way to know a manual row and a
 * lap are the same physical shot. Use one capture flow per round.
 */

// --- Tunables (spec values) ---
const TAP_COLLAPSE_WINDOW_MS = 20_000; // STEP 2: club-change collapse
const MATCH_WINDOW_MS = 90_000; // STEP 3: max |dt| for a (lap, tap) pair
const TEE_PROXIMITY_M = 35; // STEP 1: "inside the tee polygon" fallback radius around the tee point
const AMBIGUOUS_LIE_BOUNDARY_M = 2; // STEP 6
/** A lap this close to the calibration press is the calibration press, not a shot. */
const CALIBRATION_LAP_WINDOW_MS = 120_000;

export interface ReconcileHoleInput {
  roundHoleId: string;
  holeId: string;
  number: number;
  par: number;
  score: number | null;
  /** This hole's features (polygons + centerline) from the round's own CourseVersion. */
  features: { featureType: FeatureType; geometry: GeoJSON.Polygon | GeoJSON.LineString; zOrder: number }[];
  teeLocation: LatLng | null;
  /** RoundHole.pinLocation — the green-marking screen's pin, when marked. */
  pin: LatLng | null;
}

export interface ReconcileInput {
  laps: WatchLap[];
  track: RoundTrack | null;
  taps: ClubTap[];
  /** Ordered by hole number ascending. */
  holes: ReconcileHoleInput[];
  /** Every existing Shot for the round (all its roundHoles). */
  existingShots: Shot[];
  clubs: Club[];
  /** Round.clockOffsetMs when already known (previous ingest); null to derive. */
  clockOffsetMs: number | null;
  /** Round.watchCalibrationAt — phone time of the calibration press, if performed. */
  calibrationPhoneTime: string | null;
}

export interface NewReconcileFlag {
  type: ReviewFlagType;
  detail: string;
  roundHoleId: string | null;
  shotId: string | null;
}

export interface ReconcileResult {
  /** The complete post-reconciliation shot set for the round, ordered per hole. Includes
   * preserved frozen rows (possibly with updated chain fields). */
  shots: Shot[];
  /** Previously generated (non-frozen) rows whose identity no longer exists. */
  deleteShotIds: string[];
  flags: NewReconcileFlag[];
  lapMatches: { lapId: string; shotId: string | null }[];
  tapMatches: { tapId: string; shotId: string | null }[];
  clockOffsetMs: number;
  clockOffsetMethod: "calibrated" | "estimated" | "assumed_zero";
}

const uuid = () => crypto.randomUUID();

function isFrozen(s: Shot): boolean {
  return (
    s.reconciliation === "manual" ||
    s.reconciliation === "green_mark" ||
    s.penaltyType !== null ||
    s.userEdited === true
  );
}

// ---------------------------------------------------------------------------
// STEP 0 — clock alignment
// ---------------------------------------------------------------------------

function estimateOffset(laps: WatchLap[], taps: ClubTap[]): number {
  if (!laps.length || !taps.length) return 0;
  const lapTimes = laps.map((l) => Date.parse(l.tWatch));
  const tapTimes = taps.map((t) => Date.parse(t.tPhone));

  // Candidate offsets: every pairwise delta, quantised to the second to bound the set. For each
  // candidate, greedily match under it and score by summed |dt|; the true offset minimises it.
  const candidates = new Set<number>();
  for (const lt of lapTimes) for (const tt of tapTimes) candidates.add(Math.round((lt - tt) / 1000) * 1000);

  let best = { offset: 0, cost: Infinity };
  for (const offset of candidates) {
    const pairs: { d: number; li: number; ti: number }[] = [];
    for (let li = 0; li < lapTimes.length; li++) {
      for (let ti = 0; ti < tapTimes.length; ti++) {
        const d = Math.abs(lapTimes[li] - (tapTimes[ti] + offset));
        if (d <= MATCH_WINDOW_MS) pairs.push({ d, li, ti });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const usedL = new Set<number>();
    const usedT = new Set<number>();
    let cost = 0;
    let matched = 0;
    for (const p of pairs) {
      if (usedL.has(p.li) || usedT.has(p.ti)) continue;
      usedL.add(p.li);
      usedT.add(p.ti);
      cost += p.d;
      matched++;
    }
    // Unmatched events cost a full window each, so offsets that match more events win even if
    // their matched deltas are slightly larger.
    cost += (lapTimes.length + tapTimes.length - 2 * matched) * MATCH_WINDOW_MS;
    if (cost < best.cost) best = { offset, cost };
  }
  return best.offset;
}

// ---------------------------------------------------------------------------
// STEP 1 — hole segmentation
// ---------------------------------------------------------------------------

function pointInPolygonFeature(point: LatLng, geometry: GeoJSON.Polygon): boolean {
  return turf.booleanPointInPolygon(turf.point([point.lng, point.lat]), turf.polygon(geometry.coordinates));
}

function isOnTee(hole: ReconcileHoleInput, point: LatLng): boolean {
  for (const f of hole.features) {
    if (f.featureType === "tee" && f.geometry.type === "Polygon" && pointInPolygonFeature(point, f.geometry)) {
      return true;
    }
  }
  // Real courses frequently have no tee polygon mapped — fall back to a radius around the tee box.
  return hole.teeLocation !== null && distanceMeters(point, hole.teeLocation) <= TEE_PROXIMITY_M;
}

/**
 * Assigns each lap (time-ordered) to a hole. Monotonic: the current hole only advances when a
 * lap lands on a LATER hole's tee — never by raw proximity. Parallel holes cross-assign under
 * nearest-geometry matching (a lap on hole 3's fairway can be metres from hole 4's), so this
 * guard is required, not defensive (spec STEP 1 / Appendix A case 7). Skipped holes are handled
 * by scanning every later hole's tee, not just number+1.
 *
 * `holedOutAt` supplies a second, much stronger constraint where it's known: a hole's own putts
 * are timestamped, and you cannot be teeing off the next hole before you've holed out on this
 * one. Greens sit right beside the next tee on most courses, so an approach shot landing within
 * the tee-proximity radius was advancing the sequence a hole early and handing that stroke to the
 * wrong hole. When a hole has no green marks the entry is absent and behaviour is unchanged.
 */
function segmentLaps(
  laps: WatchLap[],
  holes: ReconcileHoleInput[],
  holedOutAt: Map<string, number>
): Map<string, ReconcileHoleInput> {
  const byLap = new Map<string, ReconcileHoleInput>();
  if (!holes.length) return byLap;
  const ordered = [...laps].sort((a, b) => a.tWatch.localeCompare(b.tWatch));
  let currentIdx = 0;
  for (const lap of ordered) {
    const lapMs = Date.parse(lap.tWatch);
    const currentHoledOut = holedOutAt.get(holes[currentIdx].roundHoleId);
    // Still putting on this hole? Then no tee sighting can move us off it.
    const mayAdvance = currentHoledOut === undefined || lapMs > currentHoledOut;
    if (mayAdvance) {
      for (let j = currentIdx + 1; j < holes.length; j++) {
        if (isOnTee(holes[j], lap.point)) {
          currentIdx = j;
          break;
        }
      }
    }
    byLap.set(lap.id, holes[currentIdx]);
  }
  return byLap;
}

// ---------------------------------------------------------------------------
// STEP 6 helpers — lie derivation with boundary ambiguity
// ---------------------------------------------------------------------------

const FEATURE_TO_LIE: Partial<Record<FeatureType, Lie>> = {
  fairway: "fairway",
  green: "green",
  fringe: "fringe",
  bunker_greenside: "bunker_greenside",
  bunker_fairway: "bunker_fairway",
  hazard: "hazard",
  ob: "ob",
  rough: "rough",
  tee: "tee"
};

function deriveLie(
  point: LatLng,
  features: ReconcileHoleInput["features"]
): { lie: Lie; ambiguous: boolean } {
  const pt = turf.point([point.lng, point.lat]);
  const polygons = features.filter(
    (f): f is { featureType: FeatureType; geometry: GeoJSON.Polygon; zOrder: number } =>
      f.featureType !== "centerline" && f.geometry.type === "Polygon"
  );
  const sorted = [...polygons].sort((a, b) => b.zOrder - a.zOrder);

  let lie: Lie = "rough";
  for (const f of sorted) {
    if (pointInPolygonFeature(point, f.geometry)) {
      lie = FEATURE_TO_LIE[f.featureType] ?? "rough";
      break;
    }
  }

  // Within 2m of ANY polygon boundary → the GPS could equally be on the other side. Keep the
  // best guess but mark it ambiguous (spec STEP 6).
  let ambiguous = false;
  for (const f of polygons) {
    const boundary = turf.polygonToLine(turf.polygon(f.geometry.coordinates)) as GeoJSON.Feature<
      GeoJSON.LineString | GeoJSON.MultiLineString
    >;
    const nearest = turf.nearestPointOnLine(boundary, pt, { units: "meters" });
    if ((nearest.properties.dist as number) <= AMBIGUOUS_LIE_BOUNDARY_M) {
      ambiguous = true;
      break;
    }
  }
  return { lie, ambiguous };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function reconcile(input: ReconcileInput): ReconcileResult {
  const flags: NewReconcileFlag[] = [];
  const holes = [...input.holes].sort((a, b) => a.number - b.number);
  const holeByRoundHoleId = new Map(holes.map((h) => [h.roundHoleId, h]));

  // ----- STEP 0: clock alignment -----
  let clockOffsetMs: number;
  let clockOffsetMethod: ReconcileResult["clockOffsetMethod"];
  let laps = [...input.laps].sort((a, b) => a.tWatch.localeCompare(b.tWatch));

  const calibT = input.calibrationPhoneTime ? Date.parse(input.calibrationPhoneTime) : null;
  // A lap this close to the calibration press IS that press. The window is generous relative to
  // real clock drift (seconds) but far tighter than the gap to a genuine shot, which is the whole
  // point: it has to be able to say "no lap here".
  const calibrationLap =
    calibT === null
      ? null
      : laps.find((l) => Math.abs(Date.parse(l.tWatch) - calibT) <= CALIBRATION_LAP_WINDOW_MS) ?? null;

  if (calibrationLap) {
    clockOffsetMs = Date.parse(calibrationLap.tWatch) - calibT!;
    clockOffsetMethod = "calibrated";
    // The calibration press produced a lap that is not a shot, so it's dropped.
    //
    // This used to take the lap NEAREST the calibration time and guard it with a check that
    // compared the lap against an offset derived from that same lap — always zero, so the guard
    // always passed. The effect was that any calibrated round lost a lap: if the watch never
    // registered the calibration press, the nearest lap was a real stroke and reconciliation ate
    // it. Now a lap has to genuinely sit at the calibration moment to be treated as one.
    laps = laps.filter((l) => l.id !== calibrationLap.id);
  } else if (input.clockOffsetMs !== null) {
    clockOffsetMs = input.clockOffsetMs;
    clockOffsetMethod = "calibrated";
  } else if (laps.length && input.taps.length) {
    clockOffsetMs = estimateOffset(laps, input.taps);
    clockOffsetMethod = "estimated";
  } else {
    clockOffsetMs = 0;
    clockOffsetMethod = "assumed_zero";
  }

  // All event times below are on the WATCH clock; taps are shifted by the offset.
  const tapWatchTime = (t: ClubTap) => Date.parse(t.tPhone) + clockOffsetMs;
  const lapTime = (l: WatchLap) => Date.parse(l.tWatch);
  /** Shot.recordedAt stays in the PHONE clock domain, like every pre-existing row. */
  const watchToPhoneIso = (watchMs: number) => new Date(watchMs - clockOffsetMs).toISOString();

  // ----- Frozen rows and consumed capture events -----
  const frozen = input.existingShots.filter(isFrozen);
  const previousGenerated = input.existingShots.filter((s) => !isFrozen(s));
  const consumedLapIds = new Set(frozen.map((s) => s.watchLapId).filter((id): id is string => !!id));
  const consumedTapIds = new Set(frozen.map((s) => s.clubTapId).filter((id): id is string => !!id));

  const openLaps = laps.filter((l) => !consumedLapIds.has(l.id));
  let openTaps = [...input.taps]
    .filter((t) => !consumedTapIds.has(t.id))
    .sort((a, b) => tapWatchTime(a) - tapWatchTime(b));

  // ----- STEP 1: hole segmentation (all laps, so frozen-consumed ones still anchor taps) -----
  // When a hole was holed out is known from its green-marked putts, and it bounds the sequence far
  // more reliably than tee proximity alone can.
  const holedOutAt = new Map<string, number>();
  for (const s of input.existingShots) {
    if (s.reconciliation !== "green_mark") continue;
    const t = Date.parse(s.recordedAt);
    if (!Number.isFinite(t)) continue;
    const prev = holedOutAt.get(s.roundHoleId);
    if (prev === undefined || t > prev) holedOutAt.set(s.roundHoleId, t);
  }
  const holeByLapId = segmentLaps(laps, holes, holedOutAt);

  // ----- STEP 2: club-change collapse -----
  const lapTimes = laps.map(lapTime).sort((a, b) => a - b);
  const hasLapBetween = (a: number, b: number) => lapTimes.some((t) => t > a && t <= b);
  const collapsed: ClubTap[] = [];
  for (let i = 0; i < openTaps.length; i++) {
    const cur = openTaps[i];
    const next = openTaps[i + 1];
    if (
      next &&
      tapWatchTime(next) - tapWatchTime(cur) <= TAP_COLLAPSE_WINDOW_MS &&
      !hasLapBetween(tapWatchTime(cur), tapWatchTime(next))
    ) {
      continue; // grabbed a 5i, changed to a 4i — the later tap wins
    }
    collapsed.push(cur);
  }
  openTaps = collapsed;

  // ----- STEP 3: greedy nearest-in-time matching -----
  const pairs: { d: number; lap: WatchLap; tap: ClubTap }[] = [];
  for (const lap of openLaps) {
    for (const tap of openTaps) {
      const d = Math.abs(lapTime(lap) - tapWatchTime(tap));
      if (d <= MATCH_WINDOW_MS) pairs.push({ d, lap, tap });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const matchedLap = new Map<string, ClubTap>();
  const matchedTap = new Set<string>();
  for (const p of pairs) {
    if (matchedLap.has(p.lap.id) || matchedTap.has(p.tap.id)) continue;
    matchedLap.set(p.lap.id, p.tap);
    matchedTap.add(p.tap.id);
  }

  // ----- STEP 3/4: build generated shot descriptors -----
  interface Generated {
    tWatch: number;
    hole: ReconcileHoleInput;
    lap: WatchLap | null;
    tap: ClubTap | null;
    startPoint: LatLng;
    positionSource: Shot["positionSource"];
    accuracyM: number | null;
    elevationM: number | null;
    flagType: ReviewFlagType | null;
    flagDetail: string;
  }
  const generated: Generated[] = [];

  for (const lap of openLaps) {
    const hole = holeByLapId.get(lap.id);
    if (!hole) continue;
    const tap = matchedLap.get(lap.id) ?? null;
    generated.push({
      tWatch: lapTime(lap),
      hole,
      lap,
      tap,
      startPoint: lap.point,
      positionSource: "watch_lap",
      accuracyM: null,
      elevationM: lap.elevationM,
      flagType: tap ? null : "missing_club",
      flagDetail: tap ? "" : `Lap ${lap.lapIndex + 1}: no club tap within ${MATCH_WINDOW_MS / 1000}s — which club was this?`
    });
  }

  // Unmatched taps → shots positioned from the track (or the tap's own phone GPS fix).
  const lapsByTimeWithHole = laps
    .map((l) => ({ t: lapTime(l), hole: holeByLapId.get(l.id)! }))
    .filter((x) => x.hole)
    .sort((a, b) => a.t - b.t);
  function holeForTime(tWatch: number, point: LatLng | null): ReconcileHoleInput | null {
    // Hole of the last lap before this moment; before all laps → first lap's hole. With no laps
    // at all, fall back to geometric containment when a position exists.
    let last: ReconcileHoleInput | null = null;
    for (const x of lapsByTimeWithHole) {
      if (x.t <= tWatch) last = x.hole;
      else break;
    }
    if (last) return last;
    if (lapsByTimeWithHole.length) return lapsByTimeWithHole[0].hole;
    if (point) {
      let best: { hole: ReconcileHoleInput; d: number } | null = null;
      for (const h of holes) {
        if (!h.teeLocation) continue;
        const d = distanceMeters(point, h.teeLocation);
        if (!best || d < best.d) best = { hole: h, d };
      }
      return best?.hole ?? null;
    }
    return holes[0] ?? null;
  }

  for (const tap of openTaps) {
    if (matchedTap.has(tap.id)) continue;
    const tWatch = tapWatchTime(tap);
    const fromTrack = input.track ? trackLookup(input.track, tWatch) : null;
    const startPoint = fromTrack?.point ?? tap.point;
    const hole = holeForTime(tWatch, startPoint);
    if (!hole) continue;
    if (!startPoint) {
      flags.push({
        type: "unmatched_tap",
        detail: "Club tap with no lap press and no position (track gap, no phone GPS) — add the shot manually if it was real.",
        roundHoleId: hole.roundHoleId,
        shotId: null
      });
      continue;
    }
    generated.push({
      tWatch,
      hole,
      lap: null,
      tap,
      startPoint,
      positionSource: fromTrack ? "watch_track" : "gps",
      accuracyM: fromTrack ? null : tap.accuracyM,
      elevationM: fromTrack?.elevationM ?? null,
      flagType: "unmatched_tap",
      flagDetail: "Club tap with no matching lap press — was there a swing here?"
    });
  }

  // ----- STEP 5/6: assemble per hole, derive, chain -----
  const clubById = new Map(input.clubs.map((c) => [c.id, c]));
  const putterId = findPutter(input.clubs)?.id ?? null;
  // Reuse ids from previous non-frozen rows with the same capture identity, so unchanged re-runs
  // are byte-identical (Appendix C: "re-running reconciliation changes nothing").
  const previousByIdentity = new Map<string, Shot>();
  for (const s of previousGenerated) {
    previousByIdentity.set(`${s.watchLapId ?? ""}|${s.clubTapId ?? ""}|${s.reconciliation}`, s);
  }

  const outShots: Shot[] = [];
  const lapMatches: ReconcileResult["lapMatches"] = [];
  const tapMatches: ReconcileResult["tapMatches"] = [];
  const usedPreviousIds = new Set<string>();

  for (const hole of holes) {
    const holeGenerated = generated.filter((g) => g.hole.roundHoleId === hole.roundHoleId).sort((a, b) => a.tWatch - b.tWatch);
    const holeFrozen = frozen
      .filter((s) => s.roundHoleId === hole.roundHoleId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    // Putts order by shotNumber, NOT by recordedAt. saveGreenMarks writes a hole's putts in one
    // tight loop (roundRepo.ts), so they routinely share a millisecond; `recordedAt` then ties and
    // the stable sort falls back to the order Dexie happened to return them in, which is UUID
    // order. That matters more than it looks: the LAST swing of the hole is closed onto
    // frozenPutts[0].startPoint below, so a tie could chain the approach to the second putt and
    // inflate its recorded distance by the length of the first one. shotNumber is assigned
    // explicitly and sequentially by the writer, so it's the ordering that was always intended.
    const frozenPutts = holeFrozen
      .filter((s) => s.swingType === "putt")
      .sort((a, b) => a.shotNumber - b.shotNumber);
    const frozenPenalties = holeFrozen.filter((s) => s.penaltyType !== null);
    const frozenSwings = holeFrozen.filter((s) => s.swingType !== "putt" && s.penaltyType === null);

    // Swings: generated (lap/tap) + frozen manual swings, merged by time.
    type Entry = { time: number; gen: Generated | null; frozen: Shot | null };
    const entries: Entry[] = [
      ...holeGenerated.map((g) => ({ time: g.tWatch - clockOffsetMs, gen: g, frozen: null as Shot | null })),
      ...frozenSwings.map((s) => ({ time: Date.parse(s.recordedAt), gen: null as Generated | null, frozen: s }))
    ].sort((a, b) => a.time - b.time);

    const holeShots: Shot[] = [];
    for (const e of entries) {
      if (e.frozen) {
        holeShots.push({ ...e.frozen });
        continue;
      }
      const g = e.gen!;
      const { lie, ambiguous } = deriveLie(g.startPoint, hole.features);
      const club = g.tap ? clubById.get(g.tap.clubId) ?? null : null;
      // A tagged putter, or a stroke played from the green surface, is a putt — not a full swing.
      // Reconciliation used to label every lap-and-tag stroke "full", so a putt captured the
      // intended way was counted as a full swing with the putter. Both signals are honoured so a
      // putt from the fringe (putter tagged, lie not green) classifies correctly too.
      const isPuttSwing = (putterId !== null && club?.id === putterId) || lie === "green";
      const pinDistance = hole.pin ? distanceYards(g.startPoint, hole.pin) : null;
      const isPartial =
        club?.fullSwingMinYards != null && pinDistance !== null && pinDistance < club.fullSwingMinYards;

      const identity = `${g.lap?.id ?? ""}|${g.tap?.id ?? ""}|${g.lap ? (g.tap ? "matched" : "lap_only") : "tap_only"}`;
      const previous = previousByIdentity.get(identity);
      if (previous) usedPreviousIds.add(previous.id);

      const shot: Shot = {
        id: previous?.id ?? uuid(),
        roundHoleId: hole.roundHoleId,
        shotNumber: 0, // renumbered below
        clubId: g.tap?.clubId ?? null,
        startPoint: g.startPoint,
        endPoint: null, // chained below
        positionSource: g.positionSource,
        accuracyM: g.accuracyM,
        lieStart: lie,
        lieEnd: null,
        watchLapId: g.lap?.id ?? null,
        clubTapId: g.tap?.id ?? null,
        reconciliation: g.lap ? (g.tap ? "matched" : "lap_only") : "tap_only",
        elevationM: g.elevationM,
        targetPoint: previous?.targetPoint ?? null,
        targetSource: previous?.targetSource ?? "default_green",
        swingType: isPuttSwing ? "putt" : isPartial ? "partial" : "full",
        intendedYards: !isPuttSwing && isPartial && pinDistance !== null ? Math.round(pinDistance) : null,
        penaltyType: null,
        excluded: previous?.excluded ?? null,
        exclusionNote: previous?.exclusionNote ?? null,
        recordedAt: previous?.recordedAt ?? watchToPhoneIso(g.tWatch),
        updatedAt: previous?.updatedAt ?? new Date().toISOString(),
        userEdited: false
      };
      holeShots.push(shot);

      if (g.lap) lapMatches.push({ lapId: g.lap.id, shotId: shot.id });
      if (g.tap) tapMatches.push({ tapId: g.tap.id, shotId: shot.id });
      if (g.flagType) {
        flags.push({ type: g.flagType, detail: g.flagDetail, roundHoleId: hole.roundHoleId, shotId: shot.id });
      }
      if (ambiguous) {
        flags.push({
          type: "ambiguous_lie",
          detail: `Position is within ${AMBIGUOUS_LIE_BOUNDARY_M}m of a surface boundary — best guess "${lie}".`,
          roundHoleId: hole.roundHoleId,
          shotId: shot.id
        });
      }
    }

    // Chain endpoints across the SWING sequence: each swing ends where the next begins; the last
    // swing ends at the first putt (or the pin, or stays open on an unscored hole). endPoint /
    // lieEnd are DERIVED chain fields, so they're recomputed even on frozen rows — clubs, lies,
    // positions and targets the user set are never touched here. Penalties are deliberately
    // excluded: they carry no movement, so chaining through them would break the geometry.
    for (let i = 0; i < holeShots.length; i++) {
      const next = holeShots[i + 1] ?? null;
      const nextStart: LatLng | null = next ? next.startPoint : frozenPutts[0]?.startPoint ?? hole.pin ?? null;
      if (!nextStart) continue;
      // Derived from where the ball actually finished, including for the last swing. That used to
      // be hardcoded "green", which is wrong whenever you hole out or start putting from a
      // greenside bunker or the fringe — and the lie is what decides the strokes-gained category.
      const lieEnd: Lie = deriveLie(nextStart, hole.features).lie;
      const cur = holeShots[i];
      if (cur.endPoint?.lat !== nextStart.lat || cur.endPoint?.lng !== nextStart.lng || cur.lieEnd !== lieEnd) {
        holeShots[i] = { ...cur, endPoint: nextStart, lieEnd };
      }
    }

    // Assembled AFTER chaining, so the chain operates on a clean swing sequence and ordering is a
    // presentation concern only. Putts go after the last swing; penalties are interleaved among
    // the swings by when they were incurred rather than dumped at the end of the hole — a penalty
    // off the tee belongs at stroke two when you read the hole back, not after the putts.
    const assembled = [
      ...[...holeShots, ...frozenPenalties].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)),
      ...frozenPutts
    ];

    // Renumber the whole hole.
    for (let i = 0; i < assembled.length; i++) {
      if (assembled[i].shotNumber !== i + 1) assembled[i] = { ...assembled[i], shotNumber: i + 1 };
    }
    outShots.push(...assembled);

    // ----- STEP 7: balance check -----
    if (hole.score !== null) {
      const swings = assembled.filter((s) => s.swingType !== "putt" && s.penaltyType === null).length;
      const putts = assembled.filter((s) => s.swingType === "putt").length;
      const penalties = frozenPenalties.length;
      const accounted = swings + putts + penalties;
      if (accounted !== hole.score) {
        flags.push({
          type: "score_mismatch",
          detail: `Hole ${hole.number}: score ${hole.score}, but ${swings} swings + ${putts} putts + ${penalties} penalties = ${accounted}.`,
          roundHoleId: hole.roundHoleId,
          shotId: null
        });
      }
    }
  }

  // Frozen rows on roundHoles not in the holes list (shouldn't happen) pass through untouched.
  for (const s of frozen) {
    if (!holeByRoundHoleId.has(s.roundHoleId) && !outShots.some((o) => o.id === s.id)) outShots.push(s);
  }

  const outIds = new Set(outShots.map((s) => s.id));
  const deleteShotIds = previousGenerated.filter((s) => !outIds.has(s.id)).map((s) => s.id);

  // Capture events consumed by frozen rows keep their existing linkage.
  for (const id of consumedLapIds) {
    const shot = frozen.find((s) => s.watchLapId === id);
    lapMatches.push({ lapId: id, shotId: shot?.id ?? null });
  }
  for (const id of consumedTapIds) {
    const shot = frozen.find((s) => s.clubTapId === id);
    tapMatches.push({ tapId: id, shotId: shot?.id ?? null });
  }

  return { shots: outShots, deleteShotIds, flags, lapMatches, tapMatches, clockOffsetMs, clockOffsetMethod };
}
