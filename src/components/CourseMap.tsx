import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { bearingDegrees, distanceMeters, distanceYards, nearestPointOnSegment } from "../lib/geo";
import type { LatLng } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const LINE_SOURCE_ID = "target-line";
const ON_LINE_TOLERANCE_METERS = 8;
const FAR_FROM_HOLE_METERS = 300;
const MAX_MEASURE_DOTS = 5;
export const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";
export const OUTDOORS_STYLE = "mapbox://styles/mapbox/outdoors-v12";

interface CourseMapProps {
  /** Default target (usually the green centroid) set once on mount; still user-overridable via "Set target". */
  initialTarget?: LatLng | null;
  /** Tee box (or similar) used as the line/camera origin when live GPS is missing or far from this hole. */
  fallbackOrigin?: LatLng | null;
  /** Fires on every GPS fix — lets the parent (e.g. shot recording) know where the player is. */
  onPositionChange?: (p: LatLng) => void;
  /** Fires whenever the origin->target distance changes (yards), so a parent HUD can show it. */
  onDistanceUpdate?: (distanceYards: number | null) => void;
  /** Controlled "tap map to set target" mode. Omit to let CourseMap manage this internally
   * (e.g. demo mode, which renders its own trigger button). */
  settingTarget?: boolean;
  onSettingTargetChange?: (v: boolean) => void;
  /** Mapbox style URL; defaults to satellite. Switching this preserves the line/markers. */
  mapStyle?: string;
  /** Hides CourseMap's own built-in distance/set-target HUD box, for parents (e.g. the Grint-style
   * round page) that render their own controls and drive settingTarget externally instead. */
  hideInternalHud?: boolean;
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
  onPositionChange,
  onDistanceUpdate,
  settingTarget: settingTargetProp,
  onSettingTargetChange,
  mapStyle,
  hideInternalHud
}: CourseMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const meMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const targetMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const teeMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const measureMarkersRef = useRef<Map<string, { marker: mapboxgl.Marker; label: HTMLDivElement }>>(new Map());

  const [me, setMe] = useState<LatLng | null>(null);
  const [target, setTarget] = useState<LatLng | null>(initialTarget ?? null);
  // Controlled if the parent passes settingTarget/onSettingTargetChange (Grint-style round page
  // drives this from its own right-side pill button); otherwise CourseMap manages it itself
  // (demo mode, which renders its own internal "Set target" trigger).
  const [internalSettingTarget, setInternalSettingTarget] = useState(false);
  const settingTarget = settingTargetProp ?? internalSettingTarget;
  const setSettingTarget = onSettingTargetChange ?? setInternalSettingTarget;
  const [geoError, setGeoError] = useState<string | null>(null);

  // Live GPS if it's actually near this hole; otherwise fall back to the tee box (or
  // whatever fallbackOrigin was supplied) so the map/camera/line still make sense when
  // you're browsing a hole you're not standing on (DESIGN.md's >300m rule).
  const usingLiveGps = !!me && (!fallbackOrigin || distanceMeters(me, fallbackOrigin) <= FAR_FROM_HOLE_METERS);
  const origin = usingLiveGps ? me : (fallbackOrigin ?? me);

  const stateRef = useRef({ origin, target, settingTarget, onPositionChange, setSettingTarget });
  stateRef.current = { origin, target, settingTarget, onPositionChange, setSettingTarget };

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

    map.on("load", () => ensureLineSource(map));

    map.on("click", (e) => {
      const clicked = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const { origin: curOrigin, target: curTarget, settingTarget: curSetting, setSettingTarget: curSetSettingTarget } = stateRef.current;

      if (curSetting) {
        setTarget(clicked);
        curSetSettingTarget(false);
        return;
      }
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
      measureMarkersRef.current.clear();
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
    map.once("style.load", () => ensureLineSource(map));
  }, [mapStyle]);

  // Adds the target-line source/layer if missing. Called on initial "load" and again after
  // every style change ("style.load") — Mapbox GL JS generally tries to carry sources/layers
  // across setStyle(), but a style-specific source is never guaranteed to survive, so this
  // re-adds it defensively rather than relying on that.
  function ensureLineSource(map: mapboxgl.Map) {
    if (map.getSource(LINE_SOURCE_ID)) return;
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
    updateLineAndLabels();
  }

  // Redraws the target line so it routes origin -> each placed dot (nearest-to-origin
  // first) -> target, and relabels every dot "<distance from origin> / <distance to the
  // next dot, or target if it's the last one>". Recomputes ALL dots' labels every time
  // since moving/adding/removing any one dot can change every other dot's sort position
  // and neighbors. Call after any marker drag, add, or delete.
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
      const toOrigin = curOrigin ? Math.round(distanceYards(curOrigin, d.point)) : null;
      const next = i < dots.length - 1 ? dots[i + 1].point : curTarget;
      const toNext = next ? Math.round(distanceYards(d.point, next)) : null;
      d.label.textContent = `${toOrigin ?? "?"}y / ${toNext ?? "?"}y`;
    });
  }

  function addMeasureMarker(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    const id = crypto.randomUUID();

    const el = document.createElement("div");
    el.style.cssText =
      "width:16px;height:16px;border-radius:50%;background:#ffffff;border:2px solid #222;box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab;";

    const label = document.createElement("div");
    label.style.cssText =
      "position:absolute;top:20px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(0,0,0,.8);color:#fff;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;box-shadow:0 1px 3px rgba(0,0,0,.4);";
    el.appendChild(label);

    const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
      .setLngLat([point.lng, point.lat])
      .addTo(map);

    marker.on("drag", updateLineAndLabels);

    el.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
      marker.remove();
      measureMarkersRef.current.delete(id);
      updateLineAndLabels();
    });

    measureMarkersRef.current.set(id, { marker, label });
    updateLineAndLabels();
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

  // --- Tee box marker: a fixed dot at fallbackOrigin so the line has a visible start point
  // even when origin is live GPS (which moves) instead of the tee itself ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fallbackOrigin) return;

    if (!teeMarkerRef.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:12px;height:12px;border-radius:50%;background:#ffffff;border:3px solid #2f5c3d;box-shadow:0 0 4px rgba(0,0,0,.4);";
      teeMarkerRef.current = new mapboxgl.Marker({ element: el }).setLngLat([fallbackOrigin.lng, fallbackOrigin.lat]).addTo(map);
    } else {
      teeMarkerRef.current.setLngLat([fallbackOrigin.lng, fallbackOrigin.lat]);
    }
  }, [fallbackOrigin]);

  // --- Target marker + line + camera (tee-at-bottom, tilted view) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (target) {
      if (!targetMarkerRef.current) {
        const el = document.createElement("div");
        el.style.cssText =
          "width:14px;height:14px;border-radius:50%;background:#e63946;border:2px solid #fff;";
        targetMarkerRef.current = new mapboxgl.Marker({ element: el }).setLngLat([target.lng, target.lat]).addTo(map);
      } else {
        targetMarkerRef.current.setLngLat([target.lng, target.lat]);
      }
    }

    updateLineAndLabels();

    if (origin && target) {
      // Orient camera tee-at-bottom / green-at-top with a tilt, so the hole fits a smaller
      // vertical footprint than a flat top-down view would need. Only re-orients when the
      // target/origin change (not every GPS tick) to avoid a constantly spinning map.
      map.easeTo({ center: [origin.lng, origin.lat], bearing: bearingDegrees(origin, target), pitch: 55, duration: 600 });
    }
  }, [target, origin]);

  const distanceToTarget = origin && target ? Math.round(distanceYards(origin, target)) : null;

  useEffect(() => {
    onDistanceUpdate?.(distanceToTarget);
  }, [distanceToTarget, onDistanceUpdate]);

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
    </div>
  );
}

const hudStyle: React.CSSProperties = {
  position: "absolute",
  top: 76,
  left: 12,
  background: "rgba(11,15,12,0.75)",
  color: "#eef2ef",
  padding: "8px 10px",
  borderRadius: 8,
  fontSize: 14,
  zIndex: 1
};
