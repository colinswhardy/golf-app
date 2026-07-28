import { describe, expect, it } from "vitest";
import { decodeTrack, encodeTrack, trackLookup } from "./track";
import type { LatLng } from "../types/domain";

const P: LatLng = { lat: 43.5001234, lng: -80.2005678 };

describe("track codec", () => {
  it("round-trips samples through encode/decode", () => {
    const t0 = Date.parse("2026-07-28T14:00:00Z");
    const samples = [
      { t: t0, point: P, elevationM: 312.4 },
      { t: t0 + 1000, point: { lat: P.lat + 0.0001, lng: P.lng }, elevationM: 312.6 },
      { t: t0 + 2000, point: { lat: P.lat + 0.0002, lng: P.lng }, elevationM: null }
    ];
    const decoded = decodeTrack(encodeTrack("r1", samples));
    expect(decoded).toHaveLength(3);
    expect(decoded[0].t).toBe(t0);
    expect(decoded[0].point.lat).toBeCloseTo(P.lat, 6);
    expect(decoded[0].elevationM).toBeCloseTo(312.4, 1);
    expect(decoded[2].elevationM).toBeNull();
  });

  it("trackLookup finds the nearest sample and respects the gap limit", () => {
    const t0 = Date.parse("2026-07-28T14:00:00Z");
    const samples = Array.from({ length: 60 }, (_, i) => ({
      t: t0 + i * 1000,
      point: { lat: P.lat + i * 1e-5, lng: P.lng },
      elevationM: 300 + i
    }));
    const track = encodeTrack("r1", samples);

    const hit = trackLookup(track, t0 + 30_400);
    expect(hit).not.toBeNull();
    expect(hit!.point.lat).toBeCloseTo(P.lat + 30 * 1e-5, 6);

    // 60s past the end of the track = a gap beyond the 10s default.
    expect(trackLookup(track, t0 + 120_000)).toBeNull();
  });
});
