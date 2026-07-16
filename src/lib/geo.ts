import type { LatLng } from "../types/domain";

const EARTH_RADIUS_M = 6371000;
const METERS_PER_YARD = 0.9144;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in meters. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function distanceYards(a: LatLng, b: LatLng): number {
  return distanceMeters(a, b) / METERS_PER_YARD;
}

/** Forward azimuth from a to b, in degrees clockwise from north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Flat-plane (east, north) meters relative to an origin. Equirectangular
 * approximation — negligible error at golf-hole scale (well under 1km).
 */
export function toLocalMeters(origin: LatLng, point: LatLng): { east: number; north: number } {
  const east = toRad(point.lng - origin.lng) * Math.cos(toRad(origin.lat)) * EARTH_RADIUS_M;
  const north = toRad(point.lat - origin.lat) * EARTH_RADIUS_M;
  return { east, north };
}

/**
 * Projects a point into a shot's own (downrange, offline) frame, given the
 * aim point (origin/target) and the bearing the shot is being played along
 * (typically origin->target bearing, i.e. tee/start -> pin/aim point).
 * offline is signed: positive = right of the target line, negative = left.
 */
export function toDownrangeOffline(
  origin: LatLng,
  targetBearingDeg: number,
  point: LatLng
): { downrangeYards: number; offlineYards: number } {
  const { east, north } = toLocalMeters(origin, point);
  const theta = toRad(targetBearingDeg);

  // Rotate (east, north) into a frame where +y is "along bearing" and +x is "right of bearing".
  const downrangeM = east * Math.sin(theta) + north * Math.cos(theta);
  const offlineM = east * Math.cos(theta) - north * Math.sin(theta);

  return {
    downrangeYards: downrangeM / METERS_PER_YARD,
    offlineYards: offlineM / METERS_PER_YARD
  };
}

/** Inverse of toLocalMeters: turns an (east, north) offset from an origin back into a LatLng. */
export function fromLocalMeters(origin: LatLng, east: number, north: number): LatLng {
  const lat = origin.lat + toDeg(north / EARTH_RADIUS_M);
  const lng = origin.lng + toDeg(east / (EARTH_RADIUS_M * Math.cos(toRad(origin.lat))));
  return { lat, lng };
}

/**
 * Nearest point on the straight segment a->b to point p (flat-plane approximation,
 * fine at golf-hole scale). Used to snap a tap near the target line onto the line.
 */
export function nearestPointOnSegment(
  a: LatLng,
  b: LatLng,
  p: LatLng
): { point: LatLng; distanceMeters: number } {
  const A = toLocalMeters(a, a); // {0,0}
  const B = toLocalMeters(a, b);
  const P = toLocalMeters(a, p);

  const abx = B.east - A.east;
  const aby = B.north - A.north;
  const lenSq = abx * abx + aby * aby;

  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((P.east - A.east) * abx + (P.north - A.north) * aby) / lenSq));

  const closest = { east: A.east + t * abx, north: A.north + t * aby };
  const distanceMeters = Math.hypot(P.east - closest.east, P.north - closest.north);

  return { point: fromLocalMeters(a, closest.east, closest.north), distanceMeters };
}

export interface DispersionEllipse {
  centerDownrange: number;
  centerOffline: number;
  /** Semi-axis lengths (yards) and rotation (radians) for a given confidence level. */
  semiMajor: number;
  semiMinor: number;
  rotationRad: number;
  sampleSize: number;
}

// Chi-square critical values for 2 degrees of freedom, used to scale a covariance
// ellipse to a given confidence level for a 2D Gaussian.
const CHI2_2DOF: Record<number, number> = {
  0.5: 1.3863,
  0.9: 4.6052
};

/**
 * Computes a confidence ellipse from a set of (downrange, offline) points, e.g.
 * all recorded shots for one club. Returns null if there aren't enough points
 * to fit a meaningful ellipse.
 */
export function computeDispersionEllipse(
  points: { downrangeYards: number; offlineYards: number }[],
  confidence: 0.5 | 0.9 = 0.9
): DispersionEllipse | null {
  const n = points.length;
  if (n < 3) return null;

  const meanDownrange = points.reduce((s, p) => s + p.downrangeYards, 0) / n;
  const meanOffline = points.reduce((s, p) => s + p.offlineYards, 0) / n;

  let varDownrange = 0;
  let varOffline = 0;
  let covar = 0;
  for (const p of points) {
    const dd = p.downrangeYards - meanDownrange;
    const doff = p.offlineYards - meanOffline;
    varDownrange += dd * dd;
    varOffline += doff * doff;
    covar += dd * doff;
  }
  varDownrange /= n - 1;
  varOffline /= n - 1;
  covar /= n - 1;

  // Eigendecomposition of the 2x2 covariance matrix [[varDownrange, covar], [covar, varOffline]].
  const trace = varDownrange + varOffline;
  const det = varDownrange * varOffline - covar * covar;
  const discriminant = Math.sqrt(Math.max(trace * trace / 4 - det, 0));
  const eigen1 = trace / 2 + discriminant;
  const eigen2 = trace / 2 - discriminant;

  const rotationRad =
    covar === 0 && varDownrange >= varOffline
      ? 0
      : Math.atan2(eigen1 - varDownrange, covar);

  const scale = CHI2_2DOF[confidence];

  return {
    centerDownrange: meanDownrange,
    centerOffline: meanOffline,
    semiMajor: Math.sqrt(Math.max(eigen1, 0) * scale),
    semiMinor: Math.sqrt(Math.max(eigen2, 0) * scale),
    rotationRad,
    sampleSize: n
  };
}
