import { describe, expect, it } from "vitest";
import { holeRangeFor, offersNines, offersTeeChoice, summariseTeeSets } from "./roundSetup";
import type { TeeBox } from "../types/domain";

const tee = (holeId: string, name: string): TeeBox => ({
  id: `${holeId}-${name}`,
  holeId,
  name,
  location: { lat: 0, lng: 0 }
});

describe("holeRangeFor", () => {
  it("covers the whole course for a full round", () => {
    expect(holeRangeFor("full", 1, 18)).toEqual({ start: 1, end: 18 });
  });

  it("splits an 18-hole course into nines", () => {
    expect(holeRangeFor("front", 1, 18)).toEqual({ start: 1, end: 9 });
    expect(holeRangeFor("back", 1, 18)).toEqual({ start: 10, end: 18 });
  });

  it("clamps the front nine to a course shorter than nine holes", () => {
    expect(holeRangeFor("front", 1, 6)).toEqual({ start: 1, end: 6 });
  });

  it("honours a course whose holes don't start at 1", () => {
    expect(holeRangeFor("full", 10, 18)).toEqual({ start: 10, end: 18 });
    expect(holeRangeFor("front", 10, 18)).toEqual({ start: 10, end: 9 });
  });
});

describe("offersNines", () => {
  it("offers a choice only once there is a back nine", () => {
    expect(offersNines(18)).toBe(true);
    expect(offersNines(9)).toBe(false);
    // A nine-hole course is played whole; there is nothing to choose between.
    expect(offersNines(17)).toBe(false);
  });
});

describe("summariseTeeSets", () => {
  it("counts holes per named tee set, not tee boxes", () => {
    const boxes = [tee("h1", "Blue"), tee("h1", "White"), tee("h2", "Blue")];
    expect(summariseTeeSets(boxes)).toEqual([
      { name: "Blue", holes: 2 },
      { name: "White", holes: 1 }
    ]);
  });

  it("drops the importer's generic 'Tee' placeholder when real colours exist", () => {
    const boxes = [tee("h1", "Blue"), tee("h2", "Tee")];
    expect(summariseTeeSets(boxes)).toEqual([{ name: "Blue", holes: 1 }]);
  });

  it("keeps the placeholder when it is the only thing mapped", () => {
    const boxes = [tee("h1", "Tee"), tee("h2", "Tee")];
    expect(summariseTeeSets(boxes)).toEqual([{ name: "Tee", holes: 2 }]);
  });

  it("returns nothing for a course with no tee boxes", () => {
    expect(summariseTeeSets([])).toEqual([]);
  });

  it("does not double-count two boxes of the same set on one hole", () => {
    const boxes = [tee("h1", "Red"), { ...tee("h1", "Red"), id: "other" }];
    expect(summariseTeeSets(boxes)).toEqual([{ name: "Red", holes: 1 }]);
  });
});

describe("offersTeeChoice", () => {
  it("offers nothing when no tee boxes are mapped", () => {
    expect(offersTeeChoice([])).toBe(false);
  });

  it("offers nothing when the only set is the importer's placeholder", () => {
    // Picking it would mean exactly what the backmost fallback already does.
    expect(offersTeeChoice([{ name: "Tee", holes: 18 }])).toBe(false);
  });

  it("offers a choice once a course has named colours", () => {
    expect(offersTeeChoice([{ name: "Blue", holes: 18 }])).toBe(true);
    expect(
      offersTeeChoice([
        { name: "Blue", holes: 18 },
        { name: "Tee", holes: 2 }
      ])
    ).toBe(true);
  });
});
