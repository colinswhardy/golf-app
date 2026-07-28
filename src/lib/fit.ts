import FitParser from "fit-file-parser";
import { encodeTrack, trackLookup, type TrackSample } from "./track";
import type { RoundTrack, WatchLap } from "../types/domain";

/**
 * COROS FIT-file ingest (REVISION-SPEC 2.4). The COROS API needs server-side OAuth a static PWA
 * can't do, so ingest is a manual file upload: parse `lap` messages (one per lap-button press —
 * the shot markers) and `record` messages (the 1 Hz track). All timestamps are the WATCH clock;
 * Round.clockOffsetMs aligns them with phone events later.
 */

const uuid = () => crypto.randomUUID();

export interface ParsedFit {
  laps: WatchLap[];
  track: RoundTrack;
  /** Identifier for Round.fitActivityId — session start time when present, else the filename. */
  activityId: string;
  /** Watch-clock time range covered by the track (epoch ms). */
  range: { start: number; end: number } | null;
}

export async function parseFit(file: File, roundId: string): Promise<ParsedFit> {
  const buffer = await file.arrayBuffer();
  const parser = new FitParser({ force: true, lengthUnit: "m", speedUnit: "m/s", mode: "list" });

  const data = await new Promise<import("fit-file-parser").FitData>((resolve, reject) => {
    parser.parse(buffer, (error, parsed) => {
      if (error) reject(new Error(`FIT parse failed: ${error}`));
      else resolve(parsed);
    });
  });

  const samples: TrackSample[] = [];
  for (const r of data.records ?? []) {
    if (!r.timestamp || r.position_lat === undefined || r.position_long === undefined) continue;
    samples.push({
      t: r.timestamp.getTime(),
      point: { lat: r.position_lat, lng: r.position_long },
      elevationM: r.enhanced_altitude ?? r.altitude ?? null
    });
  }
  if (samples.length === 0) {
    throw new Error("No positional records in this FIT file — is GPS enabled on the watch activity?");
  }
  const track = encodeTrack(roundId, samples);

  // Lap press point = the lap's END position (where the watch was at the button press). Some
  // devices omit end_position — fall back to the nearest track sample at the lap end time.
  const laps: WatchLap[] = [];
  const fitLaps = [...(data.laps ?? [])].sort(
    (a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0)
  );
  let lapIndex = 0;
  for (const lap of fitLaps) {
    const tWatchMs = lap.timestamp?.getTime();
    if (tWatchMs === undefined) continue;
    const fromTrack = trackLookup(track, tWatchMs);
    const point =
      lap.end_position_lat !== undefined && lap.end_position_long !== undefined
        ? { lat: lap.end_position_lat, lng: lap.end_position_long }
        : fromTrack?.point;
    if (!point) continue;
    laps.push({
      id: uuid(),
      roundId,
      lapIndex: lapIndex++,
      tWatch: new Date(tWatchMs).toISOString(),
      point,
      elevationM: fromTrack?.elevationM ?? null,
      matchedShotId: null
    });
  }

  const sessionStart = data.sessions?.[0]?.start_time;
  const first = samples[0].t;
  const last = samples[samples.length - 1].t;

  return {
    laps,
    track,
    activityId: sessionStart ? sessionStart.toISOString() : file.name,
    range: { start: first, end: last }
  };
}
