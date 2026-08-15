import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import { bearingDegrees, distanceMeters, distanceYards, fromDownrangeOffline, nearestPointOnSegment } from "../lib/geo";
import { applyTouchDragOffset } from "../lib/mapTouch";
import type { FeatureType, LatLng } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const LINE_SOURCE_ID = "target-line";
const BUNKER_SOURCE_ID = "bunkers";
const DISPERSION_SOURCE_ID = "dispersion-ellipse";
const ON_LINE_TOLERANCE_METERS = 8;
// Live GPS substitutes for the tee-box origin only when the device is within this many meters of
// the hole's tee (2000 yards ≈ 1828.8 m). Beyond that — browsing a hole you're nowhere near — the
// line/camera anchor to the saved tee instead, so a stray faraway GPS fix can't yank the whole
// hole layout to your couch. (Was a much tighter 300m; widened per the "use my real position
// whenever I'm anywhere on/near the course" request.)
const GPS_ACTIVE_MAX_METERS = 1828.8;
const MAX_MEASURE_DOTS = 5;
// Once the origin is this close to the target, intermediate layup dots are behind you and the
// camera (which frames origin->target) pushes them off-screen, where they can't be tapped or
// dragged back. At that range they've served their purpose, so they're cleared. See the
// clearedNearTargetRef effect for why this fires once per approach rather than continuously.
const CLEAR_DOTS_WITHIN_YARDS = 200;
// Two measure dots whose on-screen centers land within this many pixels of each other are treated
// as the same point — the later one is auto-removed so dragging dots on top of each other (or
// tapping to add one right where another sits) collapses to a single dot rather than a pile.
const DEDUPE_PX = 26;
// Camera framing for the tee->target fit. ONE set of paddings for both the initial mount and
// every later re-centre: they used to differ (the re-fit was tighter), so the hole visibly
// zoomed in the first time the target moved. Asymmetric top/bottom biases the fit so the tee
// sits low and the green high, and the generous bottom clears the HUD and action bar.
const FIT_PADDING = { top: 120, bottom: 180, left: 60, right: 60 };
const FIT_PITCH = 55;
// Hold a measure dot this long to pin the line to the hole. Long enough not to fire on a tap,
// short enough not to feel stuck.
const LONG_PRESS_MS = 550;
// Any pointer travel past this cancels the hold — that's what makes "drag into place, then hold"
// work as one continuous gesture.
const LONG_PRESS_MOVE_PX = 12;
const SAVED_DOT_CLASS = "map-touch-dot--saved";
export const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";


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
  /** This hole's features — used for water-crossing warnings and bunker F/M/B distance
   * cards. Still never rendered visually (see the file-level doc comment). May now include
   * LineString centerlines (featureType "centerline"); all polygon consumers narrow on
   * geometry.type before using coordinates. */
  holeFeatures?: { featureType: FeatureType; geometry: GeoJSON.Polygon | GeoJSON.LineString }[];
  /** Fires on every GPS fix — lets the parent (e.g. shot recording) know where the player is
   * and how good the fix is (GeolocationPosition.coords.accuracy, metres). */
  onPositionChange?: (p: LatLng, accuracyM: number | null) => void;
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
  /** When false, live GPS is ignored entirely — the blue-dot watch never starts and the
   * line/camera always anchor to the saved tee (fallbackOrigin), matching the Settings "use
   * saved tees instead of GPS" toggle. Defaults to true. */
  gpsEnabled?: boolean;
  /** Saved course-editor waypoints, seeded once on mount as measure dots. When present they take
   * the place of the automatic layup suggestion (autoLayupPoint) — these are the user's own
   * considered layup line for the hole. Still fully draggable/deletable afterward. */
  initialWaypoints?: LatLng[] | null;
  /** Fires when a measure dot is long-pressed: the parent persists these points as the hole's
   * waypoints so they reload every time this hole is played. Receives ALL current dots, since
   * waypoints are stored as a set per hole. */
  onSaveWaypoints?: (points: LatLng[]) => void;
  /** Simulation ("couch") mode: real GPS is ignored and the blue dot is driven by
   * simulatedPosition instead, so a round can be rehearsed indoors. */
  simulationMode?: boolean;
  simulatedPosition?: LatLng | null;
  /** While true, the next map tap sets the simulated position rather than a target/measure dot. */
  placingSimPosition?: boolean;
  onSimPositionPlaced?: (p: LatLng) => void;
  /** While true, the next map tap marks where a penalty stroke was incurred. */
  placingPenalty?: boolean;
  onPenaltyPlaced?: (p: LatLng) => void;
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
  hideInternalHud,
  dispersionEllipse,
  autoLayupPoint,
  currentShotNumber,
  gpsEnabled = true,
  initialWaypoints,
  onSaveWaypoints,
  simulationMode = false,
  simulatedPosition,
  placingSimPosition = false,
  onSimPositionPlaced,
  placingPenalty = false,
  onPenaltyPlaced
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

  const [gpsMe, setGpsMe] = useState<LatLng | null>(null);
  // In simulation mode the "device position" is whatever the player dropped on the map, so the
  // whole round can be rehearsed from the couch with real distances and lie detection.
  const me = simulationMode ? (simulatedPosition ?? null) : gpsMe;
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
  // A simulated position is always "live" — it was placed deliberately, so the proximity sanity
  // check that guards against a stray faraway real GPS fix doesn't apply.
  const usingLiveGps = simulationMode
    ? !!me
    : gpsEnabled && !!me && (!fallbackOrigin || distanceMeters(me, fallbackOrigin) <= GPS_ACTIVE_MAX_METERS);
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
    currentShotNumber,
    onSaveWaypoints,
    placingSimPosition,
    onSimPositionPlaced,
    placingPenalty,
    onPenaltyPlaced
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
    currentShotNumber,
    onSaveWaypoints,
    placingSimPosition,
    onSimPositionPlaced,
    placingPenalty,
    onPenaltyPlaced
  };

  // --- Geolocation: watch position for the blue dot ---
  // Skipped entirely when gpsEnabled is false (Settings toggle) — no watch, no blue dot, and `me`
  // stays null so `origin` falls back to the saved tee. Clearing `me` on disable also makes the
  // change take effect live if the toggle flips while a hole is open.
  useEffect(() => {
    // Simulation mode never touches the real receiver — the position comes from the map tap.
    if (simulationMode) {
      setGpsMe(null);
      setGeoError(null);
      return;
    }
    if (!gpsEnabled) {
      setGpsMe(null);
      return;
    }
    if (!navigator.geolocation) {
      setGeoError("Geolocation not supported in this browser.");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setGpsMe(p);
        setGeoError(null);
        stateRef.current.onPositionChange?.(p, pos.coords.accuracy ?? null);
      },
      (err) => setGeoError(err.message),
      { enableHighAccuracy: true, maximumAge: 1000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [gpsEnabled, simulationMode]);

  // A dropped simulated position feeds the same callback a real fix would, so shot recording,
  // lie detection and distances all behave exactly as they do on the course.
  useEffect(() => {
    if (simulationMode && simulatedPosition) {
      stateRef.current.onPositionChange?.(simulatedPosition, 3);
    }
  }, [simulationMode, simulatedPosition?.lat, simulatedPosition?.lng]);

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
    const initialPitch = fallbackOrigin && initialTarget ? FIT_PITCH : 0;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
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
        padding: FIT_PADDING,
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
        onTargetChange: curOnTargetChange,
        placingSimPosition: curPlacingSim,
        onSimPositionPlaced: curOnSimPlaced,
        placingPenalty: curPlacingPenalty,
        onPenaltyPlaced: curOnPenaltyPlaced
      } = stateRef.current;

      // Simulation: dropping your position wins over every other tap meaning while armed.
      if (curPlacingSim) {
        curOnSimPlaced?.(clicked);
        return;
      }

      // Marking where a penalty stroke happened — armed from the round page's tool rail.
      if (curPlacingPenalty) {
        curOnPenaltyPlaced?.(clicked);
        return;
      }

      if (curSetting) {
        setTarget(clicked);
        curSetSettingTarget(false);
        curOnTargetChange?.(clicked);
        return;
      }

      // Bunker tap: check hit-testable (invisible) bunker polygons before falling through to the
      // settingTarget/measure-dot logic below, so tapping a bunker always shows its F/M/B card
      // rather than being swallowed by a nearby measure-dot placement.
      //
      // Guarded on the layer existing: queryRenderedFeatures THROWS for an unknown layer, and the
      // layer isn't added until the style's "load"/"style.load" fires. A tap in that window (slow
      // connection on the course, or right after a map-style switch) would otherwise throw out of
      // the handler and silently eat the tap — no target set, no measure dot.
      const bunkerHits = map.getLayer(BUNKER_SOURCE_ID)
        ? map.queryRenderedFeatures(e.point, { layers: [BUNKER_SOURCE_ID] })
        : [];
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
      // Reset alongside autoLayupPlacedRef: without this, StrictMode's throwaway first mount sets
      // waypointsSeededRef true and adds the seeded dots to the map it then tears down, and the real
      // remount skips re-seeding — so saved waypoints silently never appear (the auto-layup dot does
      // instead). Same class of bug the marker refs above guard against.
      waypointsSeededRef.current = false;
      clearedNearTargetRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


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
        paint: { "line-color": "#ffc043", "line-width": 3, "line-dasharray": [2, 1] }
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
      (f) =>
        (f.featureType === "bunker_greenside" || f.featureType === "bunker_fairway") &&
        f.geometry.type === "Polygon"
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
    const hazards = (holeFeatures ?? []).filter(
      (f): f is { featureType: FeatureType; geometry: GeoJSON.Polygon } =>
        f.featureType === "hazard" && f.geometry.type === "Polygon"
    );

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
        "width:22px;height:22px;border-radius:50%;background:#ff5a5a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;border:2px solid #fff;box-shadow:0 0 0 5px rgba(255,90,90,.18),0 2px 6px rgba(0,0,0,.5);";
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

  /** Flags every measure dot as saved-to-this-hole (mint), the visual counterpart of the
   * long-press gesture. Re-applied when saved waypoints are seeded on mount. */
  function markDotsSaved(saved = true) {
    measureMarkersRef.current.forEach(({ marker }) => {
      marker.getElement().querySelector(".map-touch-dot")?.classList.toggle(SAVED_DOT_CLASS, saved);
    });
  }

  // dedupe defaults on for user taps/drags; seeding (saved waypoints, auto-layup) passes false —
  // those points are already known-distinct, and running the pixel-based dedupe during early mount
  // (before the map canvas has its final size, so map.project is unreliable) can falsely collapse
  // two genuinely separate seeded dots into one.
  function addMeasureMarker(point: LatLng, dedupe = true) {
    const map = mapRef.current;
    if (!map) return;
    const id = crypto.randomUUID();

    // Outer 44px element is the actual drag handle Mapbox positions/tracks — invisible, just a
    // bigger touch target than the 16px visual dot so a thumb doesn't block its own view of it.
    const el = document.createElement("div");
    el.className = "map-touch-target";

    const dot = document.createElement("div");
    dot.className = "map-touch-dot";
    dot.style.cssText =
      "width:16px;height:16px;border-radius:50%;background:#ffffff;border:2px solid rgba(0,0,0,.7);box-shadow:0 2px 6px rgba(0,0,0,.5);cursor:grab;";
    el.appendChild(dot);

    // Segment yardages are sized for arm's-length reading in sunlight (see .measure-label).
    const label = document.createElement("div");
    label.className = "measure-label";
    el.appendChild(label);

    const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
      .setLngLat([point.lng, point.lat])
      .addTo(map);

    // --- Long-press to pin this line to the hole ---
    // Holding a dot saves every current dot as the hole's waypoints, so the layup line reloads
    // the next time this hole is played. Discriminated from a drag by movement: any meaningful
    // pointer travel cancels the timer, so dragging a dot into place and THEN holding it is the
    // natural gesture. The saved state is shown by turning the dots mint.
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdStart: { x: number; y: number } | null = null;
    const cancelHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      holdStart = null;
    };
    el.addEventListener("pointerdown", (evt) => {
      holdStart = { x: evt.clientX, y: evt.clientY };
      holdTimer = setTimeout(() => {
        holdTimer = null;
        // Bail if the map went away while the press was in flight (navigating a hole mid-hold) —
        // otherwise this writes waypoints and toasts against an unmounted screen.
        if (!mapRef.current) return;
        const points = Array.from(measureMarkersRef.current.values()).map(({ marker: m }) => {
          const pos = m.getLngLat();
          return { lat: pos.lat, lng: pos.lng } as LatLng;
        });
        stateRef.current.onSaveWaypoints?.(points);
        markDotsSaved();
      }, LONG_PRESS_MS);
    });
    el.addEventListener("pointermove", (evt) => {
      if (!holdStart) return;
      if (Math.hypot(evt.clientX - holdStart.x, evt.clientY - holdStart.y) > LONG_PRESS_MOVE_PX) cancelHold();
    });
    el.addEventListener("pointerup", cancelHold);
    el.addEventListener("pointercancel", cancelHold);
    // Touch long-press otherwise raises the OS context menu over the gesture.
    el.addEventListener("contextmenu", (evt) => evt.preventDefault());

    marker.on("dragstart", () => {
      cancelHold();
      // Moving a dot means it no longer matches what's stored, so it drops out of the saved
      // state until it's long-pressed again.
      dot.classList.remove(SAVED_DOT_CLASS);
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
      label.style.top = "40px";
      label.style.left = "50%";
      label.style.transform = "translateX(-50%)";
      // A dot dragged on top of another collapses the two into one (keeps the earlier dot).
      dedupeMeasureDots();
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
    // If this new dot landed right on top of an existing one, drop it back to a single dot.
    if (dedupe) dedupeMeasureDots();
  }

  // Removes any measure dot whose on-screen position sits within DEDUPE_PX of an earlier dot, so
  // near-overlapping dots collapse to one instead of stacking up. Pixel-based (via map.project)
  // rather than yard-based so "overlapping" tracks what the eye sees at the current zoom. Keeps
  // the earlier dot in insertion order (the Map preserves it), removing the later duplicate.
  function dedupeMeasureDots() {
    const map = mapRef.current;
    if (!map) return;
    const entries = Array.from(measureMarkersRef.current.entries());
    const removed = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const [idA, a] = entries[i];
      if (removed.has(idA)) continue;
      const pa = map.project(a.marker.getLngLat());
      for (let j = i + 1; j < entries.length; j++) {
        const [idB, b] = entries[j];
        if (removed.has(idB)) continue;
        const pb = map.project(b.marker.getLngLat());
        if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < DEDUPE_PX) {
          b.marker.remove();
          measureMarkersRef.current.delete(idB);
          removed.add(idB);
        }
      }
    }
    if (removed.size > 0) {
      updateLineAndLabels();
      updateDispersionEllipse();
    }
  }

  // --- Blue dot marker: always shows real GPS, regardless of the fallback used for the line/camera ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !me) return;

    if (!meMarkerRef.current) {
      const el = document.createElement("div");
      // Simulated positions get a distinct amber dot so a rehearsal is never mistaken for a real fix.
      const fill = simulationMode ? "#ffc043" : "#3d8bff";
      const halo = simulationMode ? "rgba(255,192,67,.22)" : "rgba(61,139,255,.22)";
      el.style.cssText = `width:18px;height:18px;border-radius:50%;background:${fill};border:3px solid #fff;box-shadow:0 0 0 6px ${halo},0 2px 8px rgba(0,0,0,.6);`;
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

      const dot = document.createElement("div");
      dot.className = "map-touch-dot";
      dot.style.cssText =
        "width:13px;height:13px;border-radius:50%;background:#ffffff;border:3px solid rgba(0,0,0,.55);box-shadow:0 2px 6px rgba(0,0,0,.45);cursor:grab;";
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

        const dot = document.createElement("div");
        dot.className = "map-touch-dot";
        dot.style.cssText =
          "width:15px;height:15px;border-radius:50%;background:#ff5a5a;border:2px solid #fff;box-shadow:0 0 0 5px rgba(255,90,90,.2);cursor:grab;";
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
        pitch: FIT_PITCH,
        padding: FIT_PADDING,
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

  const autoLayupPlacedRef = useRef(false);

  // Seeds the hole's saved course-editor waypoints as measure dots once on mount, and marks the
  // auto-layup suggestion as already-placed so it doesn't also drop a dot — the user's saved layup
  // line wins over the automatic guess. Declared before the auto-layup effect so it runs first.
  const waypointsSeededRef = useRef(false);
  useEffect(() => {
    if (waypointsSeededRef.current || !initialWaypoints || initialWaypoints.length === 0) return;
    waypointsSeededRef.current = true;
    autoLayupPlacedRef.current = true;
    if (measureMarkersRef.current.size === 0) {
      for (const wp of initialWaypoints) addMeasureMarker(wp, false);
      // These came from storage, so show them in the saved state straight away.
      markDotsSaved();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWaypoints]);

  // Places one suggested layup dot at autoLayupPoint the first time it's available this mount —
  // guarded by a ref (not just "no dots yet") so it fires exactly once per hole and never fights
  // a dot the user has since dragged away or deleted. autoLayupPoint depends on stable per-hole
  // values (tee/green), not live GPS, so this doesn't re-fire on every position tick. Skipped
  // entirely when saved waypoints already seeded the line (above).
  useEffect(() => {
    if (autoLayupPlacedRef.current || !autoLayupPoint) return;
    autoLayupPlacedRef.current = true;
    if (measureMarkersRef.current.size === 0) addMeasureMarker(autoLayupPoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLayupPoint]);

  // Clears the intermediate layup dots (auto-placed or hand-placed) once you get within
  // CLEAR_DOTS_WITHIN_YARDS of the target. Walking up the hole leaves those dots *behind* the
  // origin, and since the camera fits origin->target they end up off-screen — unreachable to tap or
  // drag, and no longer useful now that you're playing the approach.
  //
  // Fires once per approach, not on every GPS tick: the ref latches when you cross inside the
  // threshold and only resets when you're back outside it. Without that latch, any dot you
  // deliberately placed while already inside 200y (e.g. measuring to a greenside bunker) would be
  // deleted the instant the next position update landed.
  const clearedNearTargetRef = useRef(false);
  useEffect(() => {
    if (!origin || !target) return;
    if (distanceYards(origin, target) > CLEAR_DOTS_WITHIN_YARDS) {
      clearedNearTargetRef.current = false;
      return;
    }
    if (clearedNearTargetRef.current) return;
    clearedNearTargetRef.current = true;
    if (measureMarkersRef.current.size === 0) return;
    measureMarkersRef.current.forEach(({ marker }) => marker.remove());
    measureMarkersRef.current.clear();
    updateLineAndLabels();
    updateDispersionEllipse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, target]);

  if (!TOKEN) {
    return (
      <div className="page">
        <div className="note note--danger">
          No Mapbox token configured. Add <code>VITE_MAPBOX_TOKEN</code> to <code>.env.local</code> to
          enable the map (see .env.example).
        </div>
      </div>
    );
  }

  return (
    <div className="map-root">
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Only rendered when a caller doesn't supply its own chrome — i.e. demo mode. */}
      {!hideInternalHud && (
        <div className="glass" style={{ position: "absolute", left: 12, bottom: 16, zIndex: 2, borderRadius: 16, padding: 12 }}>
          {geoError && <div className="small danger mb-1">GPS: {geoError}</div>}
          {distanceToTarget !== null && (
            <div className="mb-2">
              <span className="hud__value" style={{ fontSize: 30 }}>
                {distanceToTarget}
              </span>
              <span className="hud__unit">yd to target</span>
              {!usingLiveGps && <div className="tiny faint">from tee — not near this hole</div>}
            </div>
          )}
          <button className={`btn btn--sm${settingTarget ? " btn--primary" : ""}`} onClick={() => setSettingTarget(!settingTarget)}>
            {settingTarget ? "Tap map to set…" : target ? "Move target" : "Set target"}
          </button>
        </div>
      )}

      {bunkerCard && (
        <div
          className="glass"
          style={{
            position: "absolute",
            bottom: 96,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 3,
            borderRadius: 14,
            padding: "10px 16px",
            textAlign: "center",
            borderColor: "var(--warn)"
          }}
        >
          <div className="tiny warn bold mb-1" style={{ letterSpacing: "0.12em", textTransform: "uppercase" }}>
            Bunker
          </div>
          <div className="row num" style={{ gap: 14, fontWeight: 700 }}>
            <span>{bunkerCard.front}</span>
            <span className="dim">{bunkerCard.middle}</span>
            <span>{bunkerCard.back}</span>
          </div>
          <div className="row tiny faint" style={{ gap: 14, justifyContent: "space-between" }}>
            <span>front</span>
            <span>mid</span>
            <span>back</span>
          </div>
        </div>
      )}
    </div>
  );
}
