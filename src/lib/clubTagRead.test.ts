import { describe, expect, it } from "vitest";
import { formatTagSerial, resolveTagRead } from "./clubTagRead";

const base = { clubId: "club-7i", pairingMode: false, pairPending: false, hasRound: true };

describe("resolveTagRead", () => {
  it("logs a swing for a known tag during normal play", () => {
    expect(resolveTagRead(base)).toEqual({ kind: "log", clubId: "club-7i" });
  });

  it("asks which club an unknown tag is on, and treats the read as a swing", () => {
    // You tapped it because you were about to hit; losing that stroke is the whole failure mode.
    expect(resolveTagRead({ ...base, clubId: null })).toEqual({
      kind: "pair",
      currentClubId: null,
      defaultLogShot: true
    });
  });

  it("re-pairs a known tag while pairing mode is armed, without logging a phantom shot", () => {
    expect(resolveTagRead({ ...base, pairingMode: true })).toEqual({
      kind: "pair",
      currentClubId: "club-7i",
      defaultLogShot: false
    });
  });

  it("still defaults to no shot for an unknown tag read in pairing mode", () => {
    expect(resolveTagRead({ ...base, clubId: null, pairingMode: true })).toEqual({
      kind: "pair",
      currentClubId: null,
      defaultLogShot: false
    });
  });

  it("ignores reads while a pair prompt is already open", () => {
    // Otherwise a second tap swaps the sheet under a finger already reaching for a club tile.
    expect(resolveTagRead({ ...base, pairPending: true })).toEqual({ kind: "ignore" });
    expect(resolveTagRead({ ...base, clubId: null, pairPending: true })).toEqual({ kind: "ignore" });
  });

  it("ignores reads when no round is in progress", () => {
    expect(resolveTagRead({ ...base, hasRound: false })).toEqual({ kind: "ignore" });
    expect(resolveTagRead({ ...base, clubId: null, hasRound: false })).toEqual({ kind: "ignore" });
  });

  it("never logs without a club id", () => {
    // Guards the invariant the caller relies on: a "log" outcome always carries a club.
    for (const pairingMode of [true, false]) {
      for (const clubId of [null, "club-pw"]) {
        const out = resolveTagRead({ ...base, clubId, pairingMode });
        if (out.kind === "log") expect(out.clubId).toBeTruthy();
      }
    }
  });
});

describe("formatTagSerial", () => {
  it("strips separators so the tail doesn't start mid-colon", () => {
    expect(formatTagSerial("04:a1:b2:c3:d4:e5:f6")).toBe("D4E5F6");
    expect(formatTagSerial("04:a1:b2:c3:d4:e5:f6", 8)).toBe("C3D4E5F6");
  });

  it("handles serials with no separators", () => {
    expect(formatTagSerial("04a1b2c3d4e5f6")).toBe("D4E5F6");
  });

  it("returns short serials whole rather than padding", () => {
    expect(formatTagSerial("ab:cd")).toBe("ABCD");
  });

  it("falls back to the raw value when there's nothing alphanumeric to show", () => {
    expect(formatTagSerial(":::")).toBe(":::");
  });
});
