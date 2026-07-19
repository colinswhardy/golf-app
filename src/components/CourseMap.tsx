import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import { bearingDegrees, distanceMeters, distanceYards, fromDownrangeOffline, nearestPointOnSegment } from "../lib/geo";
import type { FeatureType, LatLng } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const LINE_SOURCE_ID = "target-line";
const BUNKER_SOURCE_ID = "bunkers";
const DISPERSION_SOURCE_ID = "dispersion-ellipse";
const ON_LINE_TOLERANCE_METERS = 8;
const FAR_FROM_HOLE_METERS = 300;
const MAX_MEASURE_DOTS = 5;
// ~1cm on a typical phone screen — how far above the actual touch point a dragged marker's REAL
// coordinate sits, not just a visual nudge, so a thumb never obscures the spot it's about to drop
// a dot/pin on. See applyTouchDragOffset below.
const TOUCH_DRAG_OFFSET_PX = 50;
export const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";
export const OUTDOORS_STYLE = "mapbox://styles/mapbox/outdoors-v12";

// Mathematically offsets a dragged marker's REAL geographic position 50px up the screen from
// wherever the pointer actually is: project the marker's current (pointer-driven) LngLat to
// screen pixels, subtract TOUCH_DRAG_OFFSET_PX from Y, unproject back, and snap the marker there.
// Unlike a CSS transform (which only nudges the rendered position, leaving the marker's actual
// coordinate under the thumb), this changes what the marker IS — the line/labels/dispersion
// ellipse and the eventual drop point all follow the offset position, not the raw touch point.
// Safe to call on every "drag" tick: Mapbox's own marker-drag math bases each tick's raw position
// on the pointer's cumulative delta from drag-start, not on wherever this last snapped the marker
// to, so repeated calls don't compound/drift.
function applyTouchDragOffset(map: mapboxgl.Map, marker: mapboxgl.Marker): LatLng {
  const raw = marker.getLngLat();
  const px = map.project(raw);
  const offset = map.unproject([px.x, px.y - TOUCH_DRAG_OFFSET_PX]);
  marker.setLngLat(offset);
  return { lat: offset.lat, lng: offset.lng };
}

export interface BunkerYardages {
  front: number;
  middle: number;
  back: number;
}

export interface DispersionEllipseSpec {
  /** Downrange (long/short) and offline (left/right) semi-axes, in yards. */
  semiMajorYards: number;
  semiMinorYards: number;
  /** Rotation of the ellipse within the shot's own (downrange, offline) frame, radians. */
  rotationRad: number;
}

interface CourseMapProps {
  /** Default target (usually the green centroid) set once on mount; still user-overridable via "Set target". */
  initialTarget?: LatLng | null;
  /** Tee box (or similar) used as the line/camera origin when live GPS is missing or far from this hole. */
  fallbackOrigin?: LatLng | null;
  /** This hole's polygon features — used for water-crossing warnings and bunker F/M/B distance
   * cards. Still never rendered visually (see the file-level doc comment). */
  holeFeatures?: { featureType: FeatureType; geometry: GeoJSON.Polygon }[];
  /** Fires on every GPS fix — lets the parent (e.g. shot recording) know where the player is. */
  onPositionChange?: (p: LatLng) => void;
  /** Fires whenever the origin->target distance changes (yards), so a parent HUD can show it. */
  onDistanceUpdate?: (distanceYards: number | null) => void;
  /** Fires whenever the current aim line's closest water-hazard crossing changes (yards from
   * origin), so a parent HUD can surface the same "Water: XXXy" warning shown on the map. */
  onWaterWarning?: (distanceYards: number | null) => void;
  /** Fires once a new target position is finalized — tapping while "set target" is armed, or
   * releasing a drag of the target marker itself — so a parent can persist it (e.g. a custom
   * pin location). Not fired on every intermediate drag tick, only the settled result. */
  onTargetChange?: (p: LatLng) => void;
  /** Controlled "tap map to set target" mode. Omit to let CourseMap manage this internally
   * (e.g. demo mode, which renders its own trigger button). */
  settingTarget?: boolean;
  onSettingTargetChange?: (v: boolean) => void;
  /** Mapbox style URL; defaults to satellite. Switching this preserves the line/markers. */
  mapStyle?: string;
  /** Hides CourseMap's own built-in distance/set-target HUD box, for parents (e.g. the Grint-style
   * round page) that render their own controls and drive settingTarget externally instead. */
  hideInternalHud?: boolean;
  /** The active club's shot dispersion, rendered as a shaded ellipse. Centered on the current
   * shot's target — see currentShotNumber below and getDispersionCenter() in the implementation
   * — and oriented along the origin->center bearing. Omit/null to hide. */
  dispersionEllipse?: DispersionEllipseSpec | null;
  /** A one-time suggested layup dot (e.g. the fairway midpoint projected onto the tee->green
   * line) placed automatically on mount if no measure dots exist yet. Still draggable/deletable
   * like any other measure dot afterward — this only seeds its initial position. Parent is
   * responsible for stale-hole-data guarding (same pattern as fallbackOrigin/initialTarget)
   * before passing this, since CourseMap only acts on it once per mount. */
  autoLayupPoint?: LatLng | null;
  /** The shot number about to be recorded (1 = tee shot), used to decide what the dispersion
   * ellipse centers on: the nearest-to-origin measure dot for shot 1, the second-nearest for
   * shot 2, the green/pin target for shot 3+. Omit/1 if unknown. */
  currentShotNumber?: number;
}

/**
 * In-round / hole-preview map, satellite imagery only. Course polygons are
 * deliberately NOT rendered — they live in Dexie purely for lie detection
 * (see lib/lie.ts); the player just sees the overhead photo. Blue dot (device
 * GPS), a target (green center by default, tap-to-override), a live distance
 * line, draggable multi-point measuring tool, tee-at-bottom tilted camera.
 */
export function CourseMap({
  initialTarget,
  fallbackOrigin,
  holeFeatures,
  onPositionChange,
  onDistanceUpdate,
  onWaterWarning,
  onTargetChange,
  settingTarget: settingTargetProp,
  onSettingTargetChange,
  mapStyle,
  hideInternalHud,
  dispersionEllipse,
  autoLayupPoint,
  currentShotNumber
}: CourseMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const meMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const targetMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const teeMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const waterMarkerRef = useRef<mapboxgl.Marker | null>(null);
  // True while the target marker is actively being dragged — suppresses camera easeTo (which
  // would otherwise spin/re-tilt the map on every drag tick) without affecting the live
  // line/label/distance updates, which stay driven by `target` state as normal.
  const isDraggingTargetRef = useRef(false);
  const isDraggingTeeRef = useRef(false);
  const measureMarkersRef = useRef<Map<string, { marker: mapboxgl.Marker; label: HTMLDivElement }>>(new Map());
  const [bunkerCard, setBunkerCard] = useState<BunkerYardages | null>(null);

  const [me, setMe] = useState<LatLng | null>(null);
  const [target, setTarget] = useState<LatLng | null>(initialTarget ?? null);
  // Dragging the tee marker (§ below) updates this local-only override — never written to
  // IndexedDB, and reset whenever fallbackOrigin itself changes (new hole, or a different tee set
  // picked from the dropdown) so a stale drag from a previous tee never lingers.
  const [teeOverride, setTeeOverride] = useState<LatLng | null>(null);
  useEffect(() => {
    setTeeOverride(null);
  }, [fallbackOrigin]);
  // Controlled if the parent passes settingTarget/onSettingTargetChange (Grint-style round page
  // drives this from its own right-side pill button); otherwise CourseMap manages it itself
  // (demo mode, which renders its own internal "Set target" trigger).
  const [internalSettingTarget, setInternalSettingTarget] = useState(false);
  const settingTarget = settingTargetProp ?? internalSettingTarget;
  const setSettingTarget = onSettingTargetChange ?? setInternalSettingTarget;
  const [geoError, setGeoError] = useState<string | null>(null);

  // Live GPS if it's actually near this hole; otherwise fall back to the tee box (or
  // whatever fallbackOrigin was supplied) so the map/camera/line still make sense when
  // you're browsing a hole you're not standing on (DESIGN.md's >300m rule). The >300m proximity
  // check itself stays against the REAL fallbackOrigin (not a dragged one) since it's about
  // real-world position validity; teeOverride only substitutes for the line/camera origin once
  // we've already decided live GPS isn't in play.
  const usingLiveGps = !!me && (!fallbackOrigin || distanceMeters(me, fallbackOrigin) <= FAR_FROM_HOLE_METERS);
  const origin = usingLiveGps ? me : (teeOverride ?? fallbackOrigin ?? me);

  const stateRef = useRef({
    origin,
    target,
    settingTarget,
    onPositionChange,
    setSettingTarget,
    onTargetChange,
    holeFeatures,
    onWaterWarning,
    dispersionEllipse,
    currentShotNumber
  });
  stateRef.current = {
    origin,
    target,
    settingTarget,
    onPositionChange,
    setSettingTarget,
    onTargetChange,
    holeFeatures,
    onWaterWarning,
    dispersionEllipse,
    currentShotNumber
  };

  // --- Geolocation: watch position for the blue dot ---
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoError("Geolocation not supported in this browser.");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setMe(p);
        setGeoError(null);
        stateRef.current.onPositionChange?.(p);
      },
      (err) => setGeoError(err.message),
      { enableHighAccuracy: true, maximumAge: 1000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // --- Map init ---
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = TOKEN;

    // Tee-at-bottom from the first frame: center on the tee (not the green), pre-rotated
    // and tilted toward the green, so there's no visible spin/tilt once the second effect
    // (target/origin) below computes the same camera and calls easeTo with matching values.
    // Demo mode (no real tee box yet) degrades to a flat, unrotated default view.
    const initialCenter = fallbackOrigin ?? initialTarget ?? { lat: 43.55, lng: -80.2 };
    const initialBearing = fallbackOrigin && initialTarget ? bearingDegrees(fallbackOrigin, initialTarget) : 0;
    const initialPitch = fallbackOrigin && initialTarget ? 55 : 0;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: mapStyle ?? SATELLITE_STYLE,
      center: [initialCenter.lng, initialCenter.lat],
      zoom: 17,
      pitch: initialPitch,
      bearing: initialBearing
    });
    mapRef.current = map;

    // Auto-fit the tee->green bounds instead of a fixed zoom, so short Par 3s and long Par 5s
    // both frame sensibly. Asymmetric top/bottom padding biases the fit so the tee sits near the
    // bottom of the screen and the green near the top, matching the tilted-camera convention
    // above. duration: 0 makes this instant, not an animated fly-in, since it's the initial
    // camera setup (same "no visible spin/tilt on first frame" goal as the constructor options).
    if (fallbackOrigin && initialTarget) {
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend([fallbackOrigin.lng, fallbackOrigin.lat]);
      bounds.extend([initialTarget.lng, initialTarget.lat]);
      map.fitBounds(bounds, {
        bearing: initialBearing,
        pitch: initialPitch,
        padding: { top: 120, bottom: 180, left: 60, right: 60 },
        duration: 0
      });
    }

    map.on("load", () => ensureSources(map));

    map.on("click", (e) => {
      const clicked = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const {
        origin: curOrigin,
        target: curTarget,
        settingTarget: curSetting,
        setSettingTarget: curSetSettingTarget,
        onTargetChange: curOnTargetChange
      } = stateRef.current;

      if (curSetting) {
        setTarget(clicked);
        curSetSettingTarget(false);
        curOnTargetChange?.(clicked);
        return;
      }

      // Bunker tap: check hit-testable (invisible) bunker polygons before falling through to the
      // settingTarget/measure-dot logic below, so tapping a bunker always shows its F/M/B card
      // rather than being swallowed by a nearby measure-dot placement.
      const bunkerHits = map.queryRenderedFeatures(e.point, { layers: [BUNKER_SOURCE_ID] });
      if (bunkerHits.length > 0 && curOrigin) {
        const geometry = bunkerHits[0].geometry as GeoJSON.Polygon;
        setBunkerCard(computeBunkerYardages(curOrigin, geometry));
        return;
      }
      setBunkerCard(null);

      if (!curOrigin || !curTarget) return;
      if (measureMarkersRef.current.size >= MAX_MEASURE_DOTS) return;

      // Scan every segment of the actual (possibly already-bent) path, not just the straight
      // origin->target line, so tapping a segment created by an earlier dot spawns another one
      // right there instead of only ever working on the original undragged line.
      const sortedDots = Array.from(measureMarkersRef.current.values())
        .map(({ marker }) => {
          const pos = marker.getLngLat();
          return { lat: pos.lat, lng: pos.lng } as LatLng;
        })
        .sort((a, b) => distanceYards(curOrigin, a) - distanceYards(curOrigin, b));
      const path = [curOrigin, ...sortedDots, curTarget];

      for (let i = 0; i < path.length - 1; i++) {
        const { point, distanceMeters: d } = nearestPointOnSegment(path[i], path[i + 1], clicked);
        if (d <= ON_LINE_TOLERANCE_METERS) {
          addMeasureMarker(point);
          break;
        }
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
      // Every marker below is .addTo(map)'d and dies with it — reset their refs too, or the
      // marker effects (which only create when ref.current is null) would see a stale ref
      // pointing at a marker orphaned from the now-destroyed map and just reposition it
      // instead of creating a fresh one attached to whatever map comes next. Matters because
      // React StrictMode mounts every component twice in dev (mount -> cleanup -> mount
      // again) to surface exactly this kind of bug — and unlike `me` (null on first mount,
      // so nothing's created yet to go stale), fallbackOrigin/target are already real data
      // by the time CourseMap first mounts, so tee/target markers hit it immediately.
      meMarkerRef.current = null;
      teeMarkerRef.current = null;
      targetMarkerRef.current = null;
      waterMarkerRef.current = null;
      measureMarkersRef.current.clear();
      isDraggingTargetRef.current = false;
      autoLayupPlacedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Map style switching (satellite <-> outdoors), triggered externally via the mapStyle prop ---
  const isFirstStyleRender = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || isFirstStyleRender.current) {
      isFirstStyleRender.current = false;
      return; // the constructor already set the initial style; nothing to do on first mount
    }
    map.setStyle(mapStyle ?? SATELLITE_STYLE);
    map.once("style.load", () => ensureSources(map));
  }, [mapStyle]);

  // Adds the target-line, bunker (invisible, hit-test only), and dispersion-ellipse sources/layers
  // if missing. Called on initial "load" and again after every style change ("style.load") —
  // Mapbox GL JS generally tries to carry sources/layers across setStyle(), but a style-specific
  // source is never guaranteed to survive, so this re-adds them defensively rather than relying
  // on that.
  function ensureSources(map: mapboxgl.Map) {
    if (!map.getSource(LINE_SOURCE_ID)) {
      map.addSource(LINE_SOURCE_ID, {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } }
      });
      map.addLayer({
        id: LINE_SOURCE_ID,
        type: "line",
        source: LINE_SOURCE_ID,
        paint: { "line-color": "#f5d90a", "line-width": 3, "line-dasharray": [2, 1] }
      });
    }
    if (!map.getSource(BUNKER_SOURCE_ID)) {
      // fill-opacity 0: never drawn (course polygons are deliberately never rendered — see the
      // file-level doc comment) but still hit-testable via queryRenderedFeatures for the click
      // handler above.
      map.addSource(BUNKER_SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: BUNKER_SOURCE_ID,
        type: "fill",
        source: BUNKER_SOURCE_ID,
        paint: { "fill-color": "#000000", "fill-opacity": 0 }
      });
    }
    if (!map.getSource(DISPERSION_SOURCE_ID)) {
      map.addSource(DISPERSION_SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: DISPERSION_SOURCE_ID,
        type: "fill",
        source: DISPERSION_SOURCE_ID,
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.22 }
      });
      map.addLayer({
        id: `${DISPERSION_SOURCE_ID}-outline`,
        type: "line",
        source: DISPERSION_SOURCE_ID,
        paint: { "line-color": "#3b82f6", "line-width": 2, "line-opacity": 0.6 }
      });
    }
    updateLineAndLabels();
    updateBunkerSource();
    updateDispersionEllipse();
    updateWaterWarning();
  }

  // Populates the (invisible) bunker source from holeFeatures whenever it changes — a separate
  // function from ensureSources so the [holeFeatures] effect below can refresh it without
  // re-adding sources/layers every time.
  function updateBunkerSource() {
    const map = mapRef.current;
    const source = map?.getSource(BUNKER_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;
    const bunkers = (stateRef.current.holeFeatures ?? []).filter(
      (f) => f.featureType === "bunker_greenside" || f.featureType === "bunker_fairway"
    );
    source.setData({
      type: "FeatureCollection",
      features: bunkers.map((b) => ({ type: "Feature" as const, properties: {}, geometry: b.geometry }))
    });
  }

  // Front/back = closest/farthest polygon-ring vertex from origin (a reasonable proxy for a
  // bunker's near/far edge along the shot line without needing true line-polygon clipping);
  // middle = the polygon's centroid. Good enough for a quick yardage card, not survey-precise.
  function computeBunkerYardages(origin: LatLng, geometry: GeoJSON.Polygon): BunkerYardages {
    const ring = geometry.coordinates[0];
    const distances = ring.map(([lng, lat]) => distanceYards(origin, { lat, lng }));
    const center = turf.centroid(turf.polygon(geometry.coordinates)).geometry.coordinates;
    return {
      front: Math.round(Math.min(...distances)),
      middle: Math.round(distanceYards(origin, { lat: center[1], lng: center[0] })),
      back: Math.round(Math.max(...distances))
    };
  }

  // Finds the closest point on the boundary of any "hazard" (water) feature to the current
  // origin (tee/GPS), regardless of where the aim line/dots currently point — a proximity
  // warning ("is there water near me"), not a crossing check. Reports it via onWaterWarning and a
  // floating map marker. Called whenever origin changes (target/origin camera effect).
  function updateWaterWarning() {
    const map = mapRef.current;
    if (!map) return;
    const { origin: curOrigin, holeFeatures, onWaterWarning: curOnWaterWarning } = stateRef.current;
    const hazards = (holeFeatures ?? []).filter((f) => f.featureType === "hazard");

    let closest: { yards: number; point: LatLng } | null = null;
    if (curOrigin && hazards.length > 0) {
      const originPt = turf.point([curOrigin.lng, curOrigin.lat]);
      for (const h of hazards) {
        const boundary = turf.polygonToLine(turf.polygon(h.geometry.coordinates)) as GeoJSON.Feature<
          GeoJSON.LineString | GeoJSON.MultiLineString
        >;
        const nearest = turf.nearestPointOnLine(boundary, originPt, { units: "yards" });
        const yards = nearest.properties.dist as number;
        const [lng, lat] = nearest.geometry.coordinates;
        if (!closest || yards < closest.yards) closest = { yards: Math.round(yards), point: { lat, lng } };
      }
    }

    curOnWaterWarning?.(closest?.yards ?? null);

    if (!closest) {
      waterMarkerRef.current?.remove();
      waterMarkerRef.current = null;
      return;
    }

    // Minimalist marker only — no yardage text on the line itself; the distance is exposed via
    // onWaterWarning above for a parent HUD to render instead.
    if (!waterMarkerRef.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:22px;height:22px;border-radius:50%;background:#dc2626;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);";
      el.textContent = "!";
      waterMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
        .setLngLat([closest.point.lng, closest.point.lat])
        .addTo(map);
    } else {
      waterMarkerRef.current.setLngLat([closest.point.lng, closest.point.lat]);
    }
  }

  // The dispersion ellipse centers on the target of the shot currently being played, not always
  // the green/pin: the nearest-to-origin measure dot for shot 1 (e.g. laying up short of a
  // hazard off the tee), the second-nearest for shot 2, and the green/pin target for shot 3+ (by
  // then you're generally playing to the green, not a further layup spot). Falls back to target
  // if the relevant dot doesn't exist (e.g. shot 1 requested but no dots placed at all). Dots
  // live in a ref (imperative Mapbox markers), not React state, so callers that add/drag/delete a
  // dot must call updateDispersionEllipse() themselves alongside updateLineAndLabels() — it won't
  // re-run on its own from a dot change.
  function getDispersionCenter(): LatLng | null {
    const { origin: curOrigin, target: curTarget, currentShotNumber: shotNumber } = stateRef.current;
    const dots = Array.from(measureMarkersRef.current.values()).map(({ marker }) => {
      const pos = marker.getLngLat();
      return { lat: pos.lat, lng: pos.lng } as LatLng;
    });
    if (curOrigin) dots.sort((a, b) => distanceYards(curOrigin, a) - distanceYards(curOrigin, b));

    if ((shotNumber ?? 1) === 1) return dots[0] ?? curTarget;
    if (shotNumber === 2) return dots[1] ?? curTarget;
    return curTarget;
  }

  // Draws dispersionEllipse (already computed in the shot's own downrange/offline frame by the
  // caller) centered on getDispersionCenter(), oriented along the origin->center bearing —
  // reusing fromDownrangeOffline (the inverse of the projection used to compute dispersion from
  // history) to turn ellipse-boundary sample points back into map coordinates.
  function updateDispersionEllipse() {
    const map = mapRef.current;
    const source = map?.getSource(DISPERSION_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    const { origin: curOrigin, dispersionEllipse: ellipse } = stateRef.current;
    const center = getDispersionCenter();
    if (!curOrigin || !center || !ellipse) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const bearing = bearingDegrees(curOrigin, center);
    const steps = 40;
    const coordinates: number[][] = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 2 * Math.PI;
      const u = ellipse.semiMajorYards * Math.cos(t);
      const v = ellipse.semiMinorYards * Math.sin(t);
      const downrange = u * Math.cos(ellipse.rotationRad) - v * Math.sin(ellipse.rotationRad);
      const offline = u * Math.sin(ellipse.rotationRad) + v * Math.cos(ellipse.rotationRad);
      const p = fromDownrangeOffline(center, bearing, downrange, offline);
      coordinates.push([p.lng, p.lat]);
    }
    source.setData({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coordinates] } });
  }

  // Redraws the target line so it routes origin -> each placed dot (nearest-to-origin
  // first) -> target, and relabels every dot "<distance from the previous point on the
  // path> / <distance to the next dot, or target if it's the last one>" — i.e. true
  // segment-to-segment yardages (tee-to-dot-1, dot-1-to-dot-2, ...), not always measured
  // from the tee. Recomputes ALL dots' labels every time since moving/adding/removing any
  // one dot can change every other dot's sort position and neighbors on both sides. Call
  // after any marker drag, add, or delete.
  function updateLineAndLabels() {
    const map = mapRef.current;
    if (!map) return;
    const { origin: curOrigin, target: curTarget } = stateRef.current;

    const dots = Array.from(measureMarkersRef.current.values()).map(({ marker, label }) => {
      const pos = marker.getLngLat();
      return { point: { lat: pos.lat, lng: pos.lng } as LatLng, label };
    });
    if (curOrigin) {
      dots.sort((a, b) => distanceYards(curOrigin, a.point) - distanceYards(curOrigin, b.point));
    }

    const source = map.getSource(LINE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (source && curOrigin && curTarget) {
      const coordinates = [
        [curOrigin.lng, curOrigin.lat],
        ...dots.map((d) => [d.point.lng, d.point.lat]),
        [curTarget.lng, curTarget.lat]
      ];
      source.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } });
    }

    dots.forEach((d, i) => {
      const prev = i === 0 ? curOrigin : dots[i - 1].point;
      const fromPrev = prev ? Math.round(distanceYards(prev, d.point)) : null;
      const next = i < dots.length - 1 ? dots[i + 1].point : curTarget;
      const toNext = next ? Math.round(distanceYards(d.point, next)) : null;
      d.label.textContent = `${fromPrev ?? "?"}y / ${toNext ?? "?"}y`;
    });
  }

  function addMeasureMarker(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    const id = crypto.randomUUID();

    // Outer 44px element is the actual drag handle Mapbox positions/tracks — invisible, just a
    // bigger touch target than the 16px visual dot so a thumb doesn't block its own view of it.
    const el = document.createElement("div");
    el.className = "map-touch-target";
    el.style.cssText = "width:44px;height:44px;display:flex;align-items:center;justify-content:center;";

    const dot = document.createElement("div");
    dot.className = "map-touch-dot";
    dot.style.cssText =
      "width:16px;height:16px;border-radius:50%;background:#ffffff;border:2px solid #222;box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab;transition:transform .1s,background .1s,border-color .1s;";
    el.appendChild(dot);

    const label = document.createElement("div");
    label.style.cssText =
      "position:absolute;top:36px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(0,0,0,.8);color:#fff;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;box-shadow:0 1px 3px rgba(0,0,0,.4);";
    el.appendChild(label);

    const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
      .setLngLat([point.lng, point.lat])
      .addTo(map);

    marker.on("dragstart", () => {
      label.style.top = "10px";
      label.style.left = "44px";
      label.style.transform = "translateY(-50%)";
    });

    marker.on("drag", () => {
      const dragMap = mapRef.current;
      if (dragMap) applyTouchDragOffset(dragMap, marker);
      updateLineAndLabels();
      updateDispersionEllipse();
    });

    marker.on("dragend", () => {
      label.style.top = "36px";
      label.style.left = "50%";
      label.style.transform = "translateX(-50%)";
    });

    el.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
      marker.remove();
      measureMarkersRef.current.delete(id);
      updateLineAndLabels();
      updateDispersionEllipse();
    });

    measureMarkersRef.current.set(id, { marker, label });
    updateLineAndLabels();
    updateDispersionEllipse();
  }

  // --- Blue dot marker: always shows real GPS, regardless of the fallback used for the line/camera ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !me) return;

    if (!meMarkerRef.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:18px;height:18px;border-radius:50%;background:#1a73e8;border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.6);";
      meMarkerRef.current = new mapboxgl.Marker({ element: el }).setLngLat([me.lng, me.lat]).addTo(map);
    } else {
      meMarkerRef.current.setLngLat([me.lng, me.lat]);
    }
  }, [me]);

  // --- Tee box marker: draggable to temporarily nudge the line/yardages/camera (e.g. playing
  // from a spot slightly off the mapped tee box), but never persisted — dragging only updates
  // teeOverride (local state, reset whenever fallbackOrigin changes), never IndexedDB. ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fallbackOrigin) return;
    const displayPoint = teeOverride ?? fallbackOrigin;

    if (!teeMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "map-touch-target";
      el.style.cssText = "width:44px;height:44px;display:flex;align-items:center;justify-content:center;";

      const dot = document.createElement("div");
      dot.className = "map-touch-dot";
      dot.style.cssText =
        "width:12px;height:12px;border-radius:50%;background:#ffffff;border:3px solid #2f5c3d;box-shadow:0 0 4px rgba(0,0,0,.4);cursor:grab;transition:transform .1s,background .1s,border-color .1s;";
      el.appendChild(dot);

      const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat([displayPoint.lng, displayPoint.lat])
        .addTo(map);

      marker.on("dragstart", () => {
        isDraggingTeeRef.current = true;
      });

      marker.on("drag", () => {
        const dragMap = mapRef.current;
        if (!dragMap) return;
        setTeeOverride(applyTouchDragOffset(dragMap, marker));
      });

      marker.on("dragend", () => {
        isDraggingTeeRef.current = false;
        const pos = marker.getLngLat();
        setTeeOverride({ lat: pos.lat, lng: pos.lng });
      });

      teeMarkerRef.current = marker;
    } else {
      teeMarkerRef.current.setLngLat([displayPoint.lng, displayPoint.lat]);
    }
  }, [fallbackOrigin, teeOverride]);

  // --- Target marker + line + camera (tee-at-bottom, tilted view) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (target) {
      if (!targetMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "map-touch-target";
        el.style.cssText = "width:44px;height:44px;display:flex;align-items:center;justify-content:center;";

        const dot = document.createElement("div");
        dot.className = "map-touch-dot";
        dot.style.cssText =
          "width:14px;height:14px;border-radius:50%;background:#e63946;border:2px solid #fff;cursor:grab;transition:transform .1s,background .1s,border-color .1s;";
        el.appendChild(dot);

        const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
          .setLngLat([target.lng, target.lat])
          .addTo(map);

        // Drag updates `target` state on every tick (so the line/labels/HUD-distance all track
        // live via their normal render path), but the camera easeTo below is suppressed for the
        // duration via isDraggingTargetRef — otherwise the map would spin/re-tilt continuously
        // as you drag instead of just following the pin. dragend settles the camera once and
        // reports the final point upstream for persistence (a custom pin location).
        marker.on("dragstart", () => {
          isDraggingTargetRef.current = true;
        });
        marker.on("drag", () => {
          const dragMap = mapRef.current;
          if (!dragMap) return;
          setTarget(applyTouchDragOffset(dragMap, marker));
        });
        marker.on("dragend", () => {
          isDraggingTargetRef.current = false;
          // Already offset by the last "drag" tick's applyTouchDragOffset call above — dragend
          // just reads and finalizes that same settled position, no need to recompute it.
          const pos = marker.getLngLat();
          const point = { lat: pos.lat, lng: pos.lng };
          setTarget(point);
          stateRef.current.onTargetChange?.(point);
        });

        targetMarkerRef.current = marker;
      } else {
        targetMarkerRef.current.setLngLat([target.lng, target.lat]);
      }
    }

    updateLineAndLabels();
    updateWaterWarning();

    if (origin && target && !isDraggingTargetRef.current && !isDraggingTeeRef.current) {
      // Orient camera tee-at-bottom / green-at-top with a tilt, so the hole fits a smaller
      // vertical footprint than a flat top-down view would need. Only re-orients when the
      // target/origin change (not every GPS tick) to avoid a constantly spinning map.
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend([origin.lng, origin.lat]);
      bounds.extend([target.lng, target.lat]);
      map.fitBounds(bounds, {
        bearing: bearingDegrees(origin, target),
        pitch: 55,
        padding: { top: 104, bottom: 122, left: 60, right: 60 },
        duration: 600
      });
    }
  }, [target, origin]);

  const distanceToTarget = origin && target ? Math.round(distanceYards(origin, target)) : null;

  useEffect(() => {
    onDistanceUpdate?.(distanceToTarget);
  }, [distanceToTarget, onDistanceUpdate]);

  // Refreshes the (invisible) bunker hit-test source and the water-proximity check whenever the
  // hole's features change, and clears any stale bunker card left over from the previous hole.
  useEffect(() => {
    updateBunkerSource();
    updateWaterWarning();
    setBunkerCard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holeFeatures]);

  // Redraws the dispersion ellipse whenever the active club's dispersion spec changes, the
  // pin/origin moves, or the shot number advances (which can change what it's centered on — see
  // getDispersionCenter). A no-op before the map's initial "load" fires and creates
  // DISPERSION_SOURCE_ID — ensureSources calls this itself once that source exists.
  useEffect(() => {
    updateDispersionEllipse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispersionEllipse, target, origin, currentShotNumber]);

  // Places one suggested layup dot at autoLayupPoint the first time it's available this mount —
  // guarded by a ref (not just "no dots yet") so it fires exactly once per hole and never fights
  // a dot the user has since dragged away or deleted. autoLayupPoint depends on stable per-hole
  // values (tee/green), not live GPS, so this doesn't re-fire on every position tick.
  const autoLayupPlacedRef = useRef(false);
  useEffect(() => {
    if (autoLayupPlacedRef.current || !autoLayupPoint) return;
    autoLayupPlacedRef.current = true;
    if (measureMarkersRef.current.size === 0) addMeasureMarker(autoLayupPoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLayupPoint]);

  if (!TOKEN) {
    return (
      <div style={{ padding: 24, color: "#eef2ef" }}>
        No Mapbox token configured. Add <code>VITE_MAPBOX_TOKEN</code> to <code>.env.local</code> to
        enable the map (see .env.example).
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {!hideInternalHud && (
        <div style={hudStyle}>
          {geoError && <div style={{ color: "#ffb3b3" }}>GPS: {geoError}</div>}
          {distanceToTarget !== null && (
            <div>
              {distanceToTarget}y to target
              {!usingLiveGps && <span style={{ opacity: 0.7 }}> (from tee — not near this hole)</span>}
            </div>
          )}
          <button
            onClick={() => setSettingTarget(!settingTarget)}
            style={{
              marginTop: 6,
              padding: "6px 10px",
              background: settingTarget ? "#f5d90a" : "#1a3a24",
              color: settingTarget ? "#111" : "#eef2ef",
              border: "1px solid #2f5c3d",
              borderRadius: 6
            }}
          >
            {settingTarget ? "Tap map to set target…" : target ? "Move target" : "Set target"}
          </button>
        </div>
      )}

      {bunkerCard && (
        <div style={bunkerCardStyle}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Bunker</div>
          <div style={{ display: "flex", gap: 12 }}>
            <span>Front {bunkerCard.front}y</span>
            <span>Mid {bunkerCard.middle}y</span>
            <span>Back {bunkerCard.back}y</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Bottom-left (not top) so it never competes with the header/HUD chrome real callers (e.g.
// RoundMapPage) render at the top — matches where those callers put their own equivalent cards.
// Only ever visible when hideInternalHud is omitted, i.e. demo mode.
const hudStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: 12,
  background: "rgba(11,15,12,0.75)",
  color: "#eef2ef",
  padding: "8px 10px",
  borderRadius: 8,
  fontSize: 14,
  zIndex: 1
};

const bunkerCardStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 96,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(11,15,12,0.9)",
  color: "#eef2ef",
  padding: "8px 14px",
  borderRadius: 10,
  fontSize: 13,
  border: "1px solid #d4a017",
  zIndex: 2,
  textAlign: "center"
};
