import type { LatLng, RoundTrack } from "../types/domain";

/**
 * Delta codec for the watch's 1 Hz position track (REVISION-SPEC 1.3). A 4-hour round is
 * ~14k samples; stored as parallel integer arrays (fixed-point, same 1e-7-degree scheme FIT
 * uses) one RoundTrack row stays a few hundred KB instead of a few MB of objects. Pure module —
 * no Dexie, unit-testable.
 */

const LATLNG_SCALE = 1e7;
const ELE_SCALE = 10; // decimetres
/** Sentinel for "no elevation in this sample" — far below any real altitude. */
const ELE_MISSING = -1_000_000;

export interface TrackSample {
  /** Epoch ms, watch clock. */
  t: number;
  point: LatLng;
  elevationM: number | null;
}

export function encodeTrack(roundId: string, samples: TrackSample[]): RoundTrack {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const t0 = sorted[0]?.t ?? 0;
  const dt: number[] = [];
  const lat: number[] = [];
  const lng: number[] = [];
  const ele: number[] = [];
  let prevT = t0;
  for (const s of sorted) {
    dt.push(s.t - prevT);
    prevT = s.t;
    lat.push(Math.round(s.point.lat * LATLNG_SCALE));
    lng.push(Math.round(s.point.lng * LATLNG_SCALE));
    ele.push(s.elevationM === null ? ELE_MISSING : Math.round(s.elevationM * ELE_SCALE));
  }
  return { roundId, t0, dt, lat, lng, ele };
}

export function decodeTrack(track: RoundTrack): TrackSample[] {
  const samples: TrackSample[] = [];
  let t = track.t0;
  for (let i = 0; i < track.dt.length; i++) {
    t += track.dt[i];
    samples.push({
      t,
      point: { lat: track.lat[i] / LATLNG_SCALE, lng: track.lng[i] / LATLNG_SCALE },
      elevationM: track.ele[i] === ELE_MISSING ? null : track.ele[i] / ELE_SCALE
    });
  }
  return samples;
}

/**
 * Nearest-in-time sample to `epochMs` (watch clock), or null when the track has a GAP there —
 * i.e. no sample within `maxGapMs`. Callers treat null as "position unknown at that moment"
 * and fall back to the phone GPS fix recorded with the tap (reconcile STEP 4).
 */
export function trackLookup(
  track: RoundTrack,
  epochMs: number,
  maxGapMs = 10_000
): { point: LatLng; elevationM: number | null } | null {
  if (track.dt.length === 0) return null;

  // Binary search over cumulative times. Times are reconstructed on the fly — dt arrays are
  // monotone by construction (encodeTrack sorts), so cumulative time is increasing.
  const times: number[] = new Array(track.dt.length);
  let t = track.t0;
  for (let i = 0; i < track.dt.length; i++) {
    t += track.dt[i];
    times[i] = t;
  }

  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < epochMs) lo = mid + 1;
    else hi = mid;
  }
  // lo = first index with time >= epochMs; nearest is lo or lo-1.
  let best = lo;
  if (lo > 0 && Math.abs(times[lo - 1] - epochMs) < Math.abs(times[lo] - epochMs)) best = lo - 1;
  if (Math.abs(times[best] - epochMs) > maxGapMs) return null;

  return {
    point: { lat: track.lat[best] / LATLNG_SCALE, lng: track.lng[best] / LATLNG_SCALE },
    elevationM: track.ele[best] === ELE_MISSING ? null : track.ele[best] / ELE_SCALE
  };
}
