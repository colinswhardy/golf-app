import type { Map as MapboxMap } from "mapbox-gl";
import type { LatLng } from "../types/domain";

/**
 * Mapbox terrain DEM elevation (REVISION-SPEC Appendix B). Two access paths:
 *
 * 1. LIVE MAP — add the raster-dem source with exaggeration 0 (invisible; no visual change) and
 *    read map.queryTerrainElevation. Only valid while the map is mounted with tiles loaded.
 * 2. BATCH (canonical, used post-round) — fetch the Terrain-RGB tile containing a coordinate at
 *    z14, decode the pixel, cache.
 *
 * Decode formula verified against docs.mapbox.com/data/tilesets/guides/access-elevation-data
 * (2026-07): elevation = -10000 + ((R·256·256 + G·256 + B) · 0.1), documented for the
 * `mapbox.terrain-rgb` tileset at /v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw. The batch path
 * deliberately uses that CLASSIC tileset, not mapbox-terrain-dem-v1 — the docs only guarantee
 * the pngraw endpoint + formula for terrain-rgb, and the spec's own warning about the newer
 * tileset's encoding is exactly why. (The live path's setTerrain uses terrain-dem-v1, where
 * Mapbox GL does its own decoding.)
 *
 * Absolute accuracy is a few metres but CONSISTENT per coordinate, so differences between two
 * points on one hole — all this feeds (5.2 elevation normalisation) — are reliable. Reads ground
 * level; slightly understates built-up green complexes.
 *
 * Offline: tile requests hit /v4/, which the service worker's existing "mapbox-tiles"
 * CacheFirst runtime cache (vite.config.ts) matches — once a course's DEM tiles have been
 * fetched once, post-round processing works offline.
 */

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const DEM_ZOOM = 14;
const TILE_SIZE = 256;

const TERRAIN_SOURCE_ID = "terrain-dem";

/** Live-map path: attach the DEM source (invisible, exaggeration 0) so queryTerrainElevation works. */
export function ensureTerrain(map: MapboxMap): void {
  if (!map.getSource(TERRAIN_SOURCE_ID)) {
    map.addSource(TERRAIN_SOURCE_ID, {
      type: "raster-dem",
      url: "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: 512,
      maxzoom: 14
    });
  }
  map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 0 });
}

export function queryLiveElevation(map: MapboxMap, p: LatLng): number | null {
  const e = map.queryTerrainElevation([p.lng, p.lat], { exaggerated: false });
  return e ?? null;
}

// --- Batch path ---

function tileXY(p: LatLng, z: number): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z;
  const xF = ((p.lng + 180) / 360) * n;
  const latRad = (p.lat * Math.PI) / 180;
  const yF = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xF);
  const y = Math.floor(yF);
  return {
    x,
    y,
    px: Math.min(TILE_SIZE - 1, Math.floor((xF - x) * TILE_SIZE)),
    py: Math.min(TILE_SIZE - 1, Math.floor((yF - y) * TILE_SIZE))
  };
}

// Tile pixels decoded once, read many times; a round touches only a handful of tiles.
const tileCache = new Map<string, Promise<ImageData | null>>();
// Per-coordinate memo (rounded ~1m) so repeated lookups skip even the pixel math.
const pointCache = new Map<string, number | null>();

async function fetchTile(x: number, y: number): Promise<ImageData | null> {
  const key = `${DEM_ZOOM}/${x}/${y}`;
  let cached = tileCache.get(key);
  if (!cached) {
    cached = (async () => {
      try {
        const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${DEM_ZOOM}/${x}/${y}.pngraw?access_token=${TOKEN}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const bitmap = await createImageBitmap(await res.blob());
        const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bitmap.width, bitmap.height) : null;
        if (!canvas) return null;
        const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      } catch {
        return null;
      }
    })();
    tileCache.set(key, cached);
  }
  return cached;
}

/** DEM elevation (metres) at a coordinate, or null when offline with no cached tile / no token. */
export async function demElevation(p: LatLng): Promise<number | null> {
  if (!TOKEN) return null;
  const pointKey = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  if (pointCache.has(pointKey)) return pointCache.get(pointKey)!;

  const { x, y, px, py } = tileXY(p, DEM_ZOOM);
  const image = await fetchTile(x, y);
  let elevation: number | null = null;
  if (image) {
    // Tiles can come back at 256 or 512px; scale the pixel index to the actual size.
    const scale = image.width / TILE_SIZE;
    const sx = Math.min(image.width - 1, Math.floor(px * scale));
    const sy = Math.min(image.height - 1, Math.floor(py * scale));
    const i = (sy * image.width + sx) * 4;
    const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
    elevation = -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
  }
  pointCache.set(pointKey, elevation);
  return elevation;
}

/** Batch helper: resolves every point, returning a sync lookup keyed the same way stats uses. */
export async function demElevationMap(points: LatLng[]): Promise<(p: LatLng) => number | null> {
  const results = new Map<string, number | null>();
  await Promise.all(
    points.map(async (p) => {
      results.set(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, await demElevation(p));
    })
  );
  return (p: LatLng) => results.get(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`) ?? null;
}
