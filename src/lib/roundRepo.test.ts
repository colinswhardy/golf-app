import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { fromLocalMeters } from "./geo";
import { deleteHandEnteredShot, insertShot, moveShotStart, saveGreenMarks, swapShotOrder } from "./roundRepo";
import type { LatLng, RoundHole, Shot } from "../types/domain";

// A straight hole laid out in local metres: tee at (0,0), green around (0,350).
const O: LatLng = { lat: 43.5, lng: -80.2 };
const pt = (east: number, north: number) => fromLocalMeters(O, east, north);
const T0 = Date.parse("2026-08-10T14:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const RH: RoundHole = {
  id: "rh1",
  roundId: "r1",
  holeId: "h1",
  score: null,
  putts: null,
  puttDistancesFeet: null,
  pinLocation: pt(0, 355),
  fairwayResult: null,
  updatedAt: ""
};

function stroke(id: string, shotNumber: number, start: LatLng, end: LatLng | null, tSec: number, extra: Partial<Shot> = {}): Shot {
  return {
    id,
    roundHoleId: "rh1",
    shotNumber,
    clubId: "driver",
    startPoint: start,
    endPoint: end,
    positionSource: "watch_lap",
    accuracyM: null,
    lieStart: "fairway",
    lieEnd: end ? "fairway" : null,
    watchLapId: null,
    clubTapId: null,
    reconciliation: "manual",
    elevationM: null,
    targetPoint: null,
    targetSource: "default_green",
    swingType: "full",
    intendedYards: null,
    penaltyType: null,
    excluded: null,
    exclusionNote: null,
    recordedAt: at(tSec),
    updatedAt: "",
    ...extra
  };
}

function putt(id: string, shotNumber: number, start: LatLng, end: LatLng, tSec: number): Shot {
  return stroke(id, shotNumber, start, end, tSec, {
    clubId: "putter",
    positionSource: "manual",
    lieStart: "green",
    lieEnd: "green",
    reconciliation: "green_mark",
    swingType: "putt",
    targetPoint: RH.pinLocation,
    targetSource: "default_pin"
  });
}

const ordered = async () => (await db.shots.where("roundHoleId").equals("rh1").toArray()).sort((a, b) => a.shotNumber - b.shotNumber);

beforeEach(async () => {
  await Promise.all([db.shots, db.roundHoles, db.clubs, db.watchLaps, db.clubTaps, db.outbox].map((t) => t.clear()));
  await db.roundHoles.put(RH);
  await db.clubs.put({ id: "putter", name: "Putter", sortOrder: 9, updatedAt: "" });
});

describe("insertShot — a stroke forgotten at the time", () => {
  it("slots in where it lengthens the path least, takes a time between its neighbours, and re-chains", async () => {
    // Drive logged, approach forgotten, then a putt from the marking screen.
    await db.shots.bulkPut([
      stroke("s1", 1, pt(0, 0), pt(0, 340), 0, { lieStart: "tee" }),
      putt("p1", 2, pt(0, 340), pt(0, 355), 900)
    ]);
    const added = await insertShot({ roundHoleId: "rh1", point: pt(3, 240), lie: "fairway" });
    const rows = await ordered();
    expect(rows.map((s) => s.id)).toEqual(["s1", added.id, "p1"]);
    expect(rows.map((s) => s.shotNumber)).toEqual([1, 2, 3]);
    // Drive now ends where the approach starts; the approach ends on the putt.
    expect(rows[0].endPoint).toEqual(pt(3, 240));
    expect(rows[1].endPoint).toEqual(pt(0, 340));
    expect(rows[1].lieEnd).toBe("green");
    // Between the drive and the putt in time, frozen, and hand-positioned.
    const t = Date.parse(rows[1].recordedAt);
    expect(t).toBeGreaterThan(T0);
    expect(t).toBeLessThan(T0 + 900_000);
    expect(rows[1].userEdited).toBe(true);
    expect(rows[1].positionSource).toBe("manual");
    expect(rows[1].reconciliation).toBe("manual");
  });

  it("a tap at the tee goes first (the forgotten tee shot), before the existing rows", async () => {
    await db.shots.bulkPut([stroke("s1", 1, pt(0, 240), pt(0, 340), 300), stroke("s2", 2, pt(0, 340), pt(0, 355), 600)]);
    const added = await insertShot({ roundHoleId: "rh1", point: pt(0, 0), lie: "tee" });
    const rows = await ordered();
    expect(rows.map((s) => s.id)).toEqual([added.id, "s1", "s2"]);
    expect(rows[0].endPoint).toEqual(pt(0, 240));
    expect(Date.parse(rows[0].recordedAt)).toBeLessThan(T0 + 300_000);
  });

  it("appends after the last stroke when nothing follows, ending at the pin", async () => {
    await db.shots.bulkPut([stroke("s1", 1, pt(0, 0), pt(0, 240), 0)]);
    const added = await insertShot({ roundHoleId: "rh1", point: pt(0, 240), lie: "fairway" });
    const rows = await ordered();
    expect(rows.map((s) => s.id)).toEqual(["s1", added.id]);
    expect(rows[1].endPoint).toEqual(RH.pinLocation);
  });
});

describe("swapShotOrder", () => {
  it("moves a stroke earlier by trading times, re-chains, and leaves putts where they were", async () => {
    await db.shots.bulkPut([
      stroke("s1", 1, pt(0, 0), pt(0, 200), 0),
      stroke("s2", 2, pt(0, 200), pt(0, 340), 300),
      putt("p1", 3, pt(0, 340), pt(0, 355), 900)
    ]);
    await swapShotOrder("s2", -1);
    const rows = await ordered();
    expect(rows.map((s) => s.id)).toEqual(["s2", "s1", "p1"]);
    expect(rows[0].endPoint).toEqual(pt(0, 0));
    expect(rows[1].endPoint).toEqual(pt(0, 340));
    expect(rows.slice(0, 2).every((s) => s.userEdited)).toBe(true);
    // Swapping back restores the original order.
    await swapShotOrder("s2", 1);
    expect((await ordered()).map((s) => s.id)).toEqual(["s1", "s2", "p1"]);
  });

  it("does nothing at the ends, and never reorders putts", async () => {
    await db.shots.bulkPut([stroke("s1", 1, pt(0, 0), pt(0, 340), 0), putt("p1", 2, pt(0, 340), pt(0, 355), 900)]);
    await swapShotOrder("s1", -1);
    await swapShotOrder("p1", -1);
    expect((await ordered()).map((s) => s.id)).toEqual(["s1", "p1"]);
  });
});

describe("saveGreenMarks — re-marking from review", () => {
  it("keeps the original marking time on the new putts and re-closes the approach onto the new first putt", async () => {
    await db.shots.bulkPut([
      stroke("s1", 1, pt(0, 0), pt(0, 345), 0),
      putt("p1", 2, pt(0, 345), pt(0, 355), 900),
      putt("p2", 3, pt(0, 352), pt(0, 355), 900)
    ]);
    // Days later: pin nudged, three putts instead of two, from a different first spot.
    await saveGreenMarks({ roundHoleId: "rh1", pin: pt(1, 356), puttStarts: [pt(0, 342), pt(0, 350), pt(0, 354)] });
    const rows = await ordered();
    expect(rows.map((s) => s.reconciliation)).toEqual(["manual", "green_mark", "green_mark", "green_mark"]);
    expect(rows[0].endPoint).toEqual(pt(0, 342));
    // Not stamped with "now": reconciliation reads a putt's time as the hole-out moment.
    expect(rows.slice(1).every((s) => s.recordedAt === at(900))).toBe(true);
    expect((await db.roundHoles.get("rh1"))?.putts).toBe(3);
    expect((await db.roundHoles.get("rh1"))?.pinLocation).toEqual(pt(1, 356));
  });

  it("a hole marked for the first time in review dates its putts just after the last stroke", async () => {
    await db.shots.bulkPut([stroke("s1", 1, pt(0, 0), null, 0), stroke("s2", 2, pt(0, 240), null, 300)]);
    await saveGreenMarks({ roundHoleId: "rh1", pin: pt(0, 355), puttStarts: [pt(0, 350)] });
    const rows = await ordered();
    expect(rows[2].recordedAt).toBe(at(360));
    expect(rows[1].endPoint).toEqual(pt(0, 350));
  });
});

describe("moveShotStart / deleteHandEnteredShot keep the chain joined", () => {
  it("moving a stroke drags the previous stroke's end along; deleting joins across the gap", async () => {
    await db.shots.bulkPut([
      stroke("s1", 1, pt(0, 0), pt(0, 200), 0),
      stroke("s2", 2, pt(0, 200), pt(0, 340), 300),
      putt("p1", 3, pt(0, 340), pt(0, 355), 900)
    ]);
    await moveShotStart("s2", pt(5, 210));
    let rows = await ordered();
    expect(rows[0].endPoint).toEqual(pt(5, 210));
    expect(rows[1].positionSource).toBe("manual");
    await deleteHandEnteredShot("s2");
    rows = await ordered();
    expect(rows.map((s) => s.id)).toEqual(["s1", "p1"]);
    expect(rows[0].endPoint).toEqual(pt(0, 340));
    expect(rows.map((s) => s.shotNumber)).toEqual([1, 2]);
  });
});
