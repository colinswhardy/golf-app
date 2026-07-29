import { bearingDegrees, distanceYards, toDownrangeOffline } from "./geo";
import type { Club, LatLng, Shot } from "../types/domain";

/**
 * Per-club distance / partial-wedge statistics engine (REVISION-SPEC Phase 5). PURE — no Dexie,
 * no React. lib/statsRunner.ts persists auto-outlier marks; StatsPage renders the summaries.
 */

export const MAX_ACCURACY_M = 15;
const METERS_PER_YARD = 0.9144;

/**
 * Is this the putter? Matched on the name CONTAINING "putt", not equalling "Putter" — the bag is
 * user-editable now, so "Odyssey Putter" or a lowercase rename must still be recognised. Several
 * paths depend on finding it (instant-save on the green, green-marked putts, excluding it from
 * full-swing distances), and an exact-match miss silently dropped the club from every putt.
 */
export function isPutter(club: Pick<Club, "name">): boolean {
  return /putt/i.test(club.name);
}

/** The putter in a bag, or null if there isn't one. */
export function findPutter<T extends Pick<Club, "name">>(clubs: T[]): T | null {
  return clubs.find(isPutter) ?? null;
}

// ---------------------------------------------------------------------------
// 5.1 Eligibility
// ---------------------------------------------------------------------------

/** Strict eligibility: what actually counts toward displayed statistics. */
export function isEligibleForClubStats(s: Shot): boolean {
  return (
    s.clubId !== null &&
    s.swingType !== "putt" &&
    s.penaltyType === null &&
    s.excluded === null &&
    s.positionSource !== "tee_fallback" &&
    (s.accuracyM === null || s.accuracyM <= MAX_ACCURACY_M) &&
    s.endPoint !== null
  );
}

/** Computation input: like eligibility, but auto-outliers stay IN the input set so the MAD pass
 * re-derives them from scratch each run — otherwise a shot flagged once could never rejoin when
 * more data arrives. Manual exclusions stay out (never overridden, spec 5.3). */
function isComputationInput(s: Shot): boolean {
  return (
    s.clubId !== null &&
    s.swingType !== "putt" &&
    s.penaltyType === null &&
    (s.excluded === null || s.excluded === "auto_outlier") &&
    s.positionSource !== "tee_fallback" &&
    (s.accuracyM === null || s.accuracyM <= MAX_ACCURACY_M) &&
    s.endPoint !== null
  );
}

// ---------------------------------------------------------------------------
// 5.2 Elevation normalisation
// ---------------------------------------------------------------------------

/** Descent angles outside this range are physically meaningless, and the maths divides by their
 * tangent — tan(0) is zero, so a 0 typed into the Settings field turned every distance for that
 * club into ±Infinity and NaN'd out its whole row. Clamped at the single choke point. */
const MIN_DESCENT_DEG = 10;
const MAX_DESCENT_DEG = 80;

/** Spec default descent angles (degrees) by club type; Club.descentAngleDeg overrides. */
export function descentAngleDeg(club: Club): number {
  if (club.descentAngleDeg != null) {
    return Math.min(MAX_DESCENT_DEG, Math.max(MIN_DESCENT_DEG, club.descentAngleDeg));
  }
  const n = club.name.toLowerCase();
  if (/driver|wood/.test(n)) return 38;
  if (/hybrid|4\s*iron|5\s*iron/.test(n)) return 43;
  if (/6\s*iron|7\s*iron|8\s*iron/.test(n)) return 47;
  // Pitching wedge sits between the 9 iron and the 50° in descent, as it does in loft.
  if (/pitching|(^|\W)pw(\W|$)/.test(n)) return 50;
  if (/9\s*iron|50/.test(n)) return 51;
  if (/54|56|58|60|sand|lob/.test(n)) return 54;
  return 45;
}

/**
 * Flat-equivalent carry given the start−end elevation drop (positive = downhill) and the club's
 * descent angle: downhill shots land long by deltaH / tan(descentAngle), so that extra is taken
 * back off. Never overwrites the measurement — both numbers are reported.
 */
export function flatEquivalentYards(measuredYards: number, deltaHMeters: number, angleDeg: number): number {
  const tan = Math.tan((Math.min(MAX_DESCENT_DEG, Math.max(MIN_DESCENT_DEG, angleDeg)) * Math.PI) / 180);
  const extraYds = deltaHMeters / METERS_PER_YARD / tan;
  // Belt and braces: a non-finite correction must never propagate into the medians, or one bad
  // value NaNs out an entire club's statistics.
  return Number.isFinite(extraYds) ? measuredYards - extraYds : measuredYards;
}

// ---------------------------------------------------------------------------
// Robust statistics helpers
// ---------------------------------------------------------------------------

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/**
 * MAD outlier rejection (spec 5.3): |x − median| > 2.5 · 1.4826 · MAD. MAD, not standard
 * deviation — golf distances are left-skewed (mishits go short, almost never long) and n is
 * small, so SD gets dragged around by exactly the points it should exclude. mad === 0
 * (identical values) → no exclusion.
 */
export function madOutlierIndices(values: number[]): Set<number> {
  const out = new Set<number>();
  if (values.length < 4) return out;
  const med = median(values);
  const mad = median(values.map((x) => Math.abs(x - med)));
  if (mad === 0) return out;
  const limit = 2.5 * 1.4826 * mad;
  values.forEach((x, i) => {
    if (Math.abs(x - med) > limit) out.add(i);
  });
  return out;
}

export type ConfidenceTier = "none" | "low" | "medium" | "high" | "confident";
const TIER_ORDER: ConfidenceTier[] = ["none", "low", "medium", "high", "confident"];

export function countTier(n: number): ConfidenceTier {
  if (n < 4) return "none";
  if (n < 10) return "low";
  if (n < 15) return "medium";
  if (n < 20) return "high";
  return "confident";
}

export function spreadTier(p80MinusP20: number): ConfidenceTier {
  if (p80MinusP20 > 25) return "low";
  if (p80MinusP20 > 15) return "medium";
  if (p80MinusP20 > 8) return "high";
  return "confident";
}

/** Confidence = the LOWER of the count tier and the spread tier (spec 5.3). */
export function confidence(n: number, p80MinusP20: number): ConfidenceTier {
  const c = countTier(n);
  if (c === "none") return "none";
  const s = spreadTier(p80MinusP20);
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(c), TIER_ORDER.indexOf(s))];
}

// ---------------------------------------------------------------------------
// 5.3 Full-swing club distances
// ---------------------------------------------------------------------------

export interface ClubDistanceSummary {
  clubId: string;
  clubName: string;
  /** Retained (post-MAD) shot count. */
  count: number;
  /** Median flat-equivalent distance — the club-selection number. */
  typicalYards: number | null;
  /** 80th percentile — the flushed number. The gap to typical is itself a statistic. */
  flushedYards: number | null;
  /** p80 − p20 spread of retained shots. */
  spreadYards: number | null;
  confidence: ConfidenceTier;
  /** Shots the MAD pass wants marked excluded: "auto_outlier". */
  autoOutlierShotIds: string[];
  /** Previously auto-flagged shots that are no longer outliers and should be un-marked. */
  clearOutlierShotIds: string[];
}

interface MeasuredShot {
  shot: Shot;
  measuredYards: number;
  flatYards: number;
}

/** Both distances for a shot. End elevation comes from `elevationAt` (DEM lookup) when present,
 * else from the NEXT shot's recorded start elevation (they're the same physical point), else the
 * flat-equivalent equals the measurement. */
function measure(shot: Shot, club: Club, endElevationM: number | null): MeasuredShot {
  const measuredYards = distanceYards(shot.startPoint, shot.endPoint!);
  const deltaH = shot.elevationM !== null && endElevationM !== null ? shot.elevationM - endElevationM : 0;
  return { shot, measuredYards, flatYards: flatEquivalentYards(measuredYards, deltaH, descentAngleDeg(club)) };
}

export function computeClubDistances(
  allShots: Shot[],
  clubs: Club[],
  elevationAt?: (p: LatLng) => number | null
): ClubDistanceSummary[] {
  // End elevation via the chain: shot.endPoint === next shot's startPoint.
  const startElevationByKey = new Map<string, number>();
  for (const s of allShots) {
    if (s.elevationM !== null) {
      startElevationByKey.set(`${s.startPoint.lat.toFixed(7)},${s.startPoint.lng.toFixed(7)}`, s.elevationM);
    }
  }
  function endElevation(s: Shot): number | null {
    if (!s.endPoint) return null;
    const dem = elevationAt?.(s.endPoint);
    if (dem != null) return dem;
    return startElevationByKey.get(`${s.endPoint.lat.toFixed(7)},${s.endPoint.lng.toFixed(7)}`) ?? null;
  }

  const summaries: ClubDistanceSummary[] = [];
  for (const club of clubs) {
    if (isPutter(club)) continue;
    const input = allShots.filter((s) => s.clubId === club.id && s.swingType === "full" && isComputationInput(s));
    const measured = input.map((s) => measure(s, club, endElevation(s)));
    const outlierIdx = madOutlierIndices(measured.map((m) => m.flatYards));

    const retained = measured.filter((_, i) => !outlierIdx.has(i));
    const flat = retained.map((m) => m.flatYards);
    const spread = flat.length >= 4 ? percentile(flat, 80) - percentile(flat, 20) : null;

    summaries.push({
      clubId: club.id,
      clubName: club.name,
      count: retained.length,
      typicalYards: flat.length ? Math.round(median(flat)) : null,
      flushedYards: flat.length ? Math.round(percentile(flat, 80)) : null,
      spreadYards: spread !== null ? Math.round(spread) : null,
      confidence: spread !== null ? confidence(retained.length, spread) : countTier(retained.length),
      autoOutlierShotIds: measured.filter((m, i) => outlierIdx.has(i) && m.shot.excluded === null).map((m) => m.shot.id),
      clearOutlierShotIds: measured
        .filter((m, i) => !outlierIdx.has(i) && m.shot.excluded === "auto_outlier")
        .map((m) => m.shot.id)
    });
  }
  return summaries;
}

/** Quick synchronous median (measured yards, no elevation) for target-line defaults — null under
 * 4 usable shots. Kept deliberately simpler than computeClubDistances: a default aim point
 * doesn't need outlier rejection to be useful. */
export function clubTypicalYardsSync(clubId: string, allShots: Shot[]): number | null {
  const distances = allShots
    .filter((s) => s.clubId === clubId && s.swingType === "full" && isEligibleForClubStats(s))
    .map((s) => distanceYards(s.startPoint, s.endPoint!));
  return distances.length >= 4 ? median(distances) : null;
}

// ---------------------------------------------------------------------------
// 5.4 Partial wedges
// ---------------------------------------------------------------------------

export const PARTIAL_BUCKETS = [30, 40, 50, 60, 70, 80] as const;

export interface PartialBucketSummary {
  clubId: string;
  clubName: string;
  bucketYards: number;
  count: number;
  /** Median distance from endPoint to the pin. */
  proximityYards: number | null;
  /** Signed median along-target component: negative = short (spec 5.4). */
  biasYards: number | null;
  /** Signed median cross-target component: negative = left. */
  lateralBiasYards: number | null;
  confidence: ConfidenceTier;
}

/** Bucket on INTENDED distance, never result distance — bucketing on the outcome makes the
 * statistic circular (spec 5.4). */
export function bucketForIntendedYards(intendedYards: number): number {
  const rounded = Math.round(intendedYards / 10) * 10;
  return Math.min(80, Math.max(30, rounded));
}

export function computePartialWedges(
  allShots: Shot[],
  clubs: Club[],
  pinForShot: (s: Shot) => LatLng | null
): PartialBucketSummary[] {
  const out: PartialBucketSummary[] = [];
  for (const club of clubs) {
    if (club.fullSwingMinYards == null) continue;
    const partials = allShots.filter(
      (s) => s.clubId === club.id && s.swingType === "partial" && s.intendedYards !== null && isEligibleForClubStats(s)
    );
    for (const bucket of PARTIAL_BUCKETS) {
      const inBucket = partials.filter((s) => bucketForIntendedYards(s.intendedYards!) === bucket);
      const rows: { proximity: number; along: number; cross: number }[] = [];
      for (const s of inBucket) {
        const pin = pinForShot(s);
        if (!pin || !s.endPoint) continue;
        const bearing = bearingDegrees(s.startPoint, pin);
        const end = toDownrangeOffline(s.startPoint, bearing, s.endPoint);
        const pinFrame = toDownrangeOffline(s.startPoint, bearing, pin);
        rows.push({
          proximity: distanceYards(s.endPoint, pin),
          along: end.downrangeYards - pinFrame.downrangeYards,
          cross: end.offlineYards - pinFrame.offlineYards
        });
      }
      if (!rows.length) continue;
      const proximities = rows.map((r) => r.proximity);
      const spread = proximities.length >= 4 ? percentile(proximities, 80) - percentile(proximities, 20) : null;
      out.push({
        clubId: club.id,
        clubName: club.name,
        bucketYards: bucket,
        count: rows.length,
        proximityYards: Math.round(median(proximities) * 10) / 10,
        biasYards: Math.round(median(rows.map((r) => r.along)) * 10) / 10,
        lateralBiasYards: Math.round(median(rows.map((r) => r.cross)) * 10) / 10,
        confidence: spread !== null ? confidence(rows.length, spread) : countTier(rows.length)
      });
    }
  }
  return out;
}
