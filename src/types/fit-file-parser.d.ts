// fit-file-parser ships no TypeScript types. Declare just the surface lib/fit.ts uses.
declare module "fit-file-parser" {
  export interface FitParserOptions {
    force?: boolean;
    speedUnit?: string;
    lengthUnit?: string;
    temperatureUnit?: string;
    elapsedRecordField?: boolean;
    mode?: "cascade" | "list" | "both";
  }

  export interface FitRecord {
    timestamp?: Date;
    position_lat?: number; // degrees
    position_long?: number; // degrees
    altitude?: number; // metres
    enhanced_altitude?: number; // metres
  }

  export interface FitLap {
    timestamp?: Date; // lap END time
    start_time?: Date;
    end_position_lat?: number;
    end_position_long?: number;
  }

  export interface FitSession {
    start_time?: Date;
    timestamp?: Date;
    sport?: string;
  }

  export interface FitData {
    records?: FitRecord[];
    laps?: FitLap[];
    sessions?: FitSession[];
  }

  export default class FitParser {
    constructor(options?: FitParserOptions);
    parse(content: ArrayBuffer | Uint8Array, callback: (error: string | null, data: FitData) => void): void;
  }
}
