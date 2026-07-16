import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { bearingDegrees, distanceMeters, distanceYards, nearestPointOnSegment } from "../lib/geo";
import type { LatLng } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const LINE_SOURCE_ID = "target-line";
const ON_LINE_TOLERANCE_METERS = 8;
const FAR_FROM_HOLE_METERS = 300;

interface CourseMapProps {
  /** Default target (usually the green centroid) set once on mount; still user-overridable via "Set target". */
  initialTarget?: LatLng | null;
  /** Tee box (or similar) used as the line/camera origin when live GPS is missing or far from this hole. */
  fallbackOrigin?: LatLng | null;
  /** Fires on every GPS fix — lets the parent (e.g. shot recording) know where the player is. */
  onPositionChange?: (p: LatLng) => void;
}

/**
 * In-round / hole-preview map, satellite imagery only. Course polygons are
 * deliberately NOT rendered — they live in Dexie purely for lie detection
 * (see lib/lie.ts); the player just sees the overhead photo. Blue dot (device
 * GPS), a target (green center by default, tap-to-override), a live distance
 * line, draggable multi-point measuring tool, tee-at-bottom tilted camera.
 */
export function CourseMap({ initialTarget, fallbackOrigin, onPositionChange }: CourseMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const meMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const targetMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const measureMarkersRef = useRef<Map<string, mapboxgl.Marker>>(new Map());

  const [me, setMe] = useState<LatLng | null>(null);
  const [target, setTarget] = useState<LatLng | null>(initialTarget ?? null);
  const [settingTarget, setSettingTarget] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  // Live GPS if it's actually near this hole; otherwise fall back to the tee box (or
  // whatever fallbackOrigin was supplied) so the map/camera/line still make sense when
  // you're browsing a hole you're not standing on (DESIGN.md's >300m rule).
  const usingLiveGps = !!me && (!fallbackOrigin || distanceMeters(me, fallbackOrigin) <= FAR_FROM_HOLE_METERS);
  const origin = usingLiveGps ? me : (fallbackOrigin ?? me);

  const stateRef = useRef({ origin, target, settingTarget, onPositionChange });
  stateRef.current = { origin, target, settingTarget, onPositionChange };

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

    const startCenter = initialTarget ?? fallbackOrigin ?? { lat: 43.55, lng: -80.2 };

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [startCenter.lng, startCenter.lat],
      zoom: 17,
      pitch: 0,
      bearing: 0
    });
    mapRef.current = map;

    map.on("load", () => {
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
    });

    map.on("click", (e) => {
      const clicked = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const { origin: curOrigin, target: curTarget, settingTarget: curSetting } = stateRef.current;

      if (curSetting) {
        setTarget(clicked);
        setSettingTarget(false);
        return;
      }
      if (curOrigin && curTarget) {
        const { point, distanceMeters: d } = nearestPointOnSegment(curOrigin, curTarget, clicked);
        if (d <= ON_LINE_TOLERANCE_METERS) {
          addMeasureMarker(point);
        }
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addMeasureMarker(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    const id = crypto.randomUUID();

    const el = document.createElement("div");
    el.style.cssText =
      "width:16px;height:16px;border-radius:50%;background:#ffffff;border:2px solid #222;box-shadow:0 0 4px rgba(0,0,0,.5);cursor:grab;";

    const label = document.createElement("div");
    label.style.cssText =
      "position:absolute;top:20px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(0,0,0,.75);color:#fff;font-size:11px;padding:2px 5px;border-radius:4px;";
    el.appendChild(label);

    const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
      .setLngLat([point.lng, point.lat])
      .addTo(map);

    const updateLabel = () => {
      const pos = marker.getLngLat();
      const here = { lat: pos.lat, lng: pos.lng };
      const { origin: curOrigin, target: curTarget } = stateRef.current;
      const toMe = curOrigin ? Math.round(distanceYards(here, curOrigin)) : null;
      const toTarget = curTarget ? Math.round(distanceYards(here, curTarget)) : null;
      label.textContent = `${toMe ?? "?"}y from you · ${toTarget ?? "?"}y to target`;
    };

    marker.on("drag", updateLabel);
    updateLabel();

    el.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
      marker.remove();
      measureMarkersRef.current.delete(id);
    });

    measureMarkersRef.current.set(id, marker);
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

    const source = map.getSource(LINE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (source && origin && target) {
      source.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [[origin.lng, origin.lat], [target.lng, target.lat]] }
      });
      // Orient camera tee-at-bottom / green-at-top with a tilt, so the hole fits a smaller
      // vertical footprint than a flat top-down view would need. Only re-orients when the
      // target/origin change (not every GPS tick) to avoid a constantly spinning map.
      map.easeTo({ center: [origin.lng, origin.lat], bearing: bearingDegrees(origin, target), pitch: 55, duration: 600 });
    }
  }, [target, origin]);

  const distanceToTarget = origin && target ? Math.round(distanceYards(origin, target)) : null;

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

      <div style={hudStyle}>
        {geoError && <div style={{ color: "#ffb3b3" }}>GPS: {geoError}</div>}
        {distanceToTarget !== null && (
          <div>
            {distanceToTarget}y to target
            {!usingLiveGps && <span style={{ opacity: 0.7 }}> (from tee — not near this hole)</span>}
          </div>
        )}
        <button
          onClick={() => setSettingTarget((s) => !s)}
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
    </div>
  );
}

const hudStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: 12,
  background: "rgba(11,15,12,0.75)",
  color: "#eef2ef",
  padding: "8px 10px",
  borderRadius: 8,
  fontSize: 14,
  zIndex: 1
};
