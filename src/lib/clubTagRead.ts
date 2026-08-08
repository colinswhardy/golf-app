/**
 * What a club-tag read means, given what else is going on. Pure, because the branches decide
 * whether a swing gets recorded at all — a wrong turn here loses a stroke silently, which is
 * exactly the failure the capture system exists to prevent.
 */

/**
 * The tail of a tag serial, for telling one sticker from another by eye.
 *
 * Serials arrive colon-separated ("04:a1:b2:c3:d4:e5:f6"), so slicing the raw string lands
 * mid-separator and reads as "…:e5:f6". Stripping the separators first gives a clean run of hex.
 */
export function formatTagSerial(serialNumber: string, chars = 6): string {
  const hex = serialNumber.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
  return hex.slice(-chars) || serialNumber;
}

export type TagReadOutcome =
  /** Known tag, normal play: record the swing. */
  | { kind: "log"; clubId: string }
  /** Needs a club chosen before it means anything. */
  | { kind: "pair"; currentClubId: string | null; defaultLogShot: boolean }
  /** Nothing to do — no round, or a pair prompt is already waiting on this. */
  | { kind: "ignore" };

export function resolveTagRead(params: {
  /** The club this serial is paired to, or null if the tag is unknown. */
  clubId: string | null;
  /** "The next read is a pairing, not a shot" is armed. */
  pairingMode: boolean;
  /** A pair prompt is already open. */
  pairPending: boolean;
  hasRound: boolean;
}): TagReadOutcome {
  if (!params.hasRound) return { kind: "ignore" };
  // A second read must not swap the sheet out from under a finger already reaching for a tile.
  if (params.pairPending) return { kind: "ignore" };

  if (params.pairingMode || params.clubId === null) {
    return {
      kind: "pair",
      currentClubId: params.clubId,
      // A tag that surprised you mid-swing is a shot you just played. Deliberately catching up
      // on pairing, in the cart or on the tee, is not — defaulting that to "log" would sprinkle
      // phantom strokes through the round.
      defaultLogShot: !params.pairingMode
    };
  }

  return { kind: "log", clubId: params.clubId };
}
