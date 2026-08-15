import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import {
  addPenaltyStroke,
  completeRound,
  getOrCreateRoundHole,
  listShotsForRoundHole,
  recordShot,
  saveGreenMarks,
  startRound
} from "./roundRepo";
import type { LatLng } from "../types/domain";

const PIN: LatLng = { lat: 43.05, lng: -79.03 };
const p = (offset: number): LatLng => ({ lat: 43.05 + offset / 10000, lng: -79.03 });

beforeEach(async () => {
  await Promise.all([db.rounds, db.roundHoles, db.shots, db.clubs, db.outbox].map((t) => t.clear()));
});

async function freshRoundHole() {
  const round = await startRound("cv1");
  const rh = await getOrCreateRoundHole(round.id, "hole1");
  return { round, rh };
}

describe("saveGreenMarks — chips added on the marking screen", () => {
  it("writes chips as full-swing rows before the putts, chained through to the pin", async () => {
    const { rh } = await freshRoundHole();
    await recordShot({ roundHoleId: rh.id, clubId: "7i", point: p(-50), lie: "fairway", positionSource: "gps", accuracyM: 4 });

    const chips = [
      { point: p(1), lie: "recovery" as const },
      { point: p(2), lie: "rough" as const }
    ];
    const putts = [p(3), p(4)];
    await saveGreenMarks({ roundHoleId: rh.id, pin: PIN, puttStarts: putts, chips });

    const shots = await listShotsForRoundHole(rh.id);
    expect(shots).toHaveLength(5);

    // The approach closes onto the FIRST chip, carrying the chip's lie.
    expect(shots[0].endPoint).toEqual(chips[0].point);
    expect(shots[0].lieEnd).toBe("recovery");

    const [chip1, chip2, putt1, putt2] = shots.slice(1);
    expect(chip1.swingType).toBe("full");
    expect(chip1.reconciliation).toBe("green_mark");
    expect(chip1.clubId).toBeNull(); // the phone stayed in the cart — club unknown
    expect(chip1.lieStart).toBe("recovery");
    expect(chip1.endPoint).toEqual(chips[1].point);
    expect(chip1.lieEnd).toBe("rough");

    expect(chip2.endPoint).toEqual(putts[0]);
    expect(chip2.lieEnd).toBe("green");

    expect(putt1.swingType).toBe("putt");
    expect(putt1.endPoint).toEqual(putts[1]);
    expect(putt2.endPoint).toEqual(PIN);
    expect(shots.map((s) => s.shotNumber)).toEqual([1, 2, 3, 4, 5]);

    // Putt count on the hole is putts only — chips are swings, not putts.
    expect((await db.roundHoles.get(rh.id))?.putts).toBe(2);
  });

  it("stores the chip's club and classifies it partial when inside the club's full-swing floor", async () => {
    const { rh } = await freshRoundHole();
    await db.clubs.put({ id: "sw", name: "56°", sortOrder: 1, fullSwingMinYards: 80, updatedAt: new Date().toISOString() });

    // p(1) is ~11 yards from PIN — well inside the 56°'s 80-yard full-swing floor.
    await saveGreenMarks({
      roundHoleId: rh.id,
      pin: PIN,
      puttStarts: [p(3)],
      chips: [{ point: p(1), lie: "rough", clubId: "sw" }]
    });

    const chip = (await listShotsForRoundHole(rh.id))[0];
    expect(chip.clubId).toBe("sw");
    expect(chip.swingType).toBe("partial");
    expect(chip.intendedYards).toBeGreaterThan(0);
    expect(chip.intendedYards).toBeLessThan(80);
  });

  it("keeps an unknown-club chip as a plain full swing with no club", async () => {
    const { rh } = await freshRoundHole();
    await saveGreenMarks({
      roundHoleId: rh.id,
      pin: PIN,
      puttStarts: [],
      chips: [{ point: p(1), lie: "fringe" }]
    });

    const chip = (await listShotsForRoundHole(rh.id))[0];
    expect(chip.clubId).toBeNull();
    expect(chip.swingType).toBe("full");
    expect(chip.intendedYards).toBeNull();
  });

  it("re-marking replaces previous chips and putts wholesale", async () => {
    const { rh } = await freshRoundHole();
    await saveGreenMarks({
      roundHoleId: rh.id,
      pin: PIN,
      puttStarts: [p(3), p(4)],
      chips: [{ point: p(1), lie: "fringe" }]
    });
    await saveGreenMarks({ roundHoleId: rh.id, pin: PIN, puttStarts: [p(5)] });

    const shots = await listShotsForRoundHole(rh.id);
    expect(shots).toHaveLength(1);
    expect(shots[0].swingType).toBe("putt");
    expect((await db.roundHoles.get(rh.id))?.putts).toBe(1);
  });

  it("zero marks still sets the pin and closes the approach onto it", async () => {
    const { rh } = await freshRoundHole();
    await recordShot({ roundHoleId: rh.id, clubId: "7i", point: p(-50), lie: "fairway", positionSource: "gps", accuracyM: 4 });
    await saveGreenMarks({ roundHoleId: rh.id, pin: PIN, puttStarts: [] });

    const shots = await listShotsForRoundHole(rh.id);
    expect(shots).toHaveLength(1);
    expect(shots[0].endPoint).toEqual(PIN);
    expect((await db.roundHoles.get(rh.id))?.pinLocation).toEqual(PIN);
  });
});

describe("addPenaltyStroke — live (mid-round) score mode", () => {
  it("leaves an unscored hole unscored; the score sheet folds the penalty in later", async () => {
    const { rh } = await freshRoundHole();
    await addPenaltyStroke(rh.id, "penalty_red", p(1), "live");

    const shots = await listShotsForRoundHole(rh.id);
    expect(shots).toHaveLength(1);
    expect(shots[0].penaltyType).toBe("penalty_red");
    expect((await db.roundHoles.get(rh.id))?.score).toBeNull();
  });

  it("bumps an already-entered score by one instead of recomputing from sparse rows", async () => {
    const { rh } = await freshRoundHole();
    // Score entered at hole-out; swings came via watch/tag capture, so there are no Shot rows —
    // a recompute here would trash the 6 down to 1.
    await db.roundHoles.update(rh.id, { score: 6 });
    await addPenaltyStroke(rh.id, "ob", p(1), "live");
    expect((await db.roundHoles.get(rh.id))?.score).toBe(7);
  });

  it("default recompute mode still derives the score from the rows (review behaviour)", async () => {
    const { rh } = await freshRoundHole();
    await recordShot({ roundHoleId: rh.id, clubId: "7i", point: p(-50), lie: "fairway", positionSource: "gps", accuracyM: 4 });
    await saveGreenMarks({ roundHoleId: rh.id, pin: PIN, puttStarts: [p(3)] });
    await addPenaltyStroke(rh.id, "lost_ball", p(1));
    // 1 swing + 1 putt + 1 penalty.
    expect((await db.roundHoles.get(rh.id))?.score).toBe(3);
  });
});

describe("completeRound — partial saves", () => {
  it("marks the round partial when asked, and completed either way", async () => {
    const a = await startRound("cv1");
    const b = await startRound("cv1");
    await completeRound(a.id, { partial: true });
    await completeRound(b.id);

    const savedA = await db.rounds.get(a.id);
    const savedB = await db.rounds.get(b.id);
    expect(savedA?.status).toBe("completed");
    expect(savedA?.partial).toBe(true);
    expect(savedB?.status).toBe("completed");
    expect(savedB?.partial).toBeUndefined();
  });
});
