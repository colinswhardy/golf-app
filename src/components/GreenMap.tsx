import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import { applyTouchDragOffset } from "../lib/mapTouch";
import type { LatLng } from "../types/domain";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";
const GREEN_BUFFER_YARDS = 25;

interface GreenMapProps {
  /** The hole's green polygon, used to frame the camera (buffered 25y so fringe/collar/apron
   * lies are placeable). Null = no mapped green; camera centers on fallbackCenter instead. */
  greenPolygon: GeoJSON.Polygon | null;
  /** Camera fallback + initial pin suggestion — the green centroid / current target. */
  fallbackCenter: LatLng;
  /** Existing pin for this hole/round, when re-marking. */
  initialPin: LatLng | null;
  holeNumber: number;
  onFinish: (pin: LatLng, puttStarts: LatLng[]) => void;
  onClose: () => void;
}

/**
 * Green-marking screen (REVISION-SPEC 2.3): pin first, then each putt's start position in
 * order, then Finish. A separate full-screen map component — deliberately NOT an extension of
 * CourseMap (different interaction model; that component is the most battle-tested code in the
 * app and stays untouched). Top-down camera: precision tapping wants no pitch. Course polygons
 * remain invisible, as everywhere.
 */
export function GreenMap({ greenPolygon, fallbackCenter, initialPin, holeNumber, onFinish, onClose }: GreenMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const puttMarkersRef = useRef<mapboxgl.Marker[]>([]);

  const [mode, setMode] = useState<"pin" | "putts">("pin");
  const [pin, setPin] = useState<LatLng | null>(initialPin);
  const [puttCount, setPuttCount] = useState(0);

  const stateRef = useRef({ mode, pin });
  stateRef.current = { mode, pin };

  function makeMarkerElement(label: string, background: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "map-touch-target";
    el.style.cssText = "width:44px;height:44px;display:flex;align-items:center;justify-content:center;";
    const dot = document.createElement("div");
    dot.className = "map-touch-dot";
    dot.style.cssText = `width:26px;height:26px;border-radius:50%;background:${background};border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;cursor:grab;`;
    dot.textContent = label;
    el.appendChild(dot);
    return el;
  }

  function placePin(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    if (!pinMarkerRef.current) {
      const marker = new mapboxgl.Marker({ element: makeMarkerElement("⛳", "#dc2626"), draggable: true, anchor: "center" })
        .setLngLat([point.lng, point.lat])
        .addTo(map);
      marker.on("drag", () => {
        const dragMap = mapRef.current;
        if (dragMap) setPin(applyTouchDragOffset(dragMap, marker));
      });
      marker.on("dragend", () => {
        const pos = marker.getLngLat();
        setPin({ lat: pos.lat, lng: pos.lng });
      });
      pinMarkerRef.current = marker;
    } else {
      pinMarkerRef.current.setLngLat([point.lng, point.lat]);
    }
    setPin(point);
  }

  function addPuttMarker(point: LatLng) {
    const map = mapRef.current;
    if (!map) return;
    const index = puttMarkersRef.current.length + 1;
    const marker = new mapboxgl.Marker({ element: makeMarkerElement(String(index), "#1a73e8"), draggable: true, anchor: "center" })
      .setLngLat([point.lng, point.lat])
      .addTo(map);
    marker.on("drag", () => {
      const dragMap = mapRef.current;
      if (dragMap) applyTouchDragOffset(dragMap, marker);
    });
    puttMarkersRef.current.push(marker);
    setPuttCount(puttMarkersRef.current.length);
  }

  function removeLastPutt() {
    const last = puttMarkersRef.current.pop();
    last?.remove();
    setPuttCount(puttMarkersRef.current.length);
  }

  function handleFinish() {
    const curPin = stateRef.current.pin;
    if (!curPin) return;
    const putts = puttMarkersRef.current.map((m) => {
      const pos = m.getLngLat();
      return { lat: pos.lat, lng: pos.lng } as LatLng;
    });
    onFinish(curPin, putts);
  }

  // --- Map init (once). All marker refs nulled in cleanup — StrictMode double-mounts in dev,
  // and a ref left pointing at a marker orphaned from the destroyed map means the feature
  // silently never renders on the real mount (REVISION-SPEC constraint 3). ---
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = TOKEN;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
      center: [fallbackCenter.lng, fallbackCenter.lat],
      zoom: 18
    });
    mapRef.current = map;

    // Frame the green buffered by 25 yards so fringe/collar/apron putts are placeable.
    if (greenPolygon) {
      try {
        const buffered = turf.buffer(turf.feature(greenPolygon), GREEN_BUFFER_YARDS, { units: "yards" });
        if (buffered) {
          const [minX, minY, maxX, maxY] = turf.bbox(buffered);
          map.fitBounds(
            [
              [minX, minY],
              [maxX, maxY]
            ],
            { padding: 30, duration: 0 }
          );
        }
      } catch {
        // Degenerate polygon: stay on the fallback center/zoom.
      }
    }

    map.on("click", (e) => {
      const clicked = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      if (stateRef.current.mode === "pin") {
        placePin(clicked);
      } else {
        addPuttMarker(clicked);
      }
    });

    // Re-marking an already-marked hole: show the existing pin immediately.
    if (initialPin) placePin(initialPin);

    return () => {
      map.remove();
      mapRef.current = null;
      pinMarkerRef.current = null;
      puttMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!TOKEN) {
    return (
      <div style={overlayStyle}>
        <div style={{ padding: 24, color: "#eef2ef" }}>No Mapbox token configured.</div>
      </div>
    );
  }

  return (
    <div style={overlayStyle}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      <div style={stepIndicatorStyle}>
        <span style={{ fontWeight: 800 }}>Hole {holeNumber} — Green</span>
        <span style={{ opacity: 0.85 }}>
          {mode === "pin"
            ? pin
              ? "Pin placed — drag to adjust, tap to move"
              : "Tap where the pin is"
            : `Tap each putt's start, in order (${puttCount} so far)`}
        </span>
      </div>

      <div style={bottomBarStyle}>
        {mode === "pin" ? (
          <>
            <button onClick={onClose} style={secondaryButtonStyle}>
              Cancel
            </button>
            <button
              onClick={() => setMode("putts")}
              disabled={!pin}
              style={{ ...primaryButtonStyle, opacity: pin ? 1 : 0.4 }}
            >
              Next: mark putts →
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setMode("pin")} style={secondaryButtonStyle}>
              ← Pin
            </button>
            <button onClick={removeLastPutt} disabled={puttCount === 0} style={{ ...secondaryButtonStyle, opacity: puttCount ? 1 : 0.4 }}>
              Remove last putt
            </button>
            {/* Zero putts is valid — chip-in / holed bunker shot. */}
            <button onClick={handleFinish} style={primaryButtonStyle}>
              Finish hole ({puttCount} putt{puttCount === 1 ? "" : "s"})
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 5,
  background: "#0b0f0c"
};

const stepIndicatorStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 6,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  background: "#000000",
  border: "1px solid #16a34a",
  color: "#eef2ef",
  padding: "8px 18px",
  borderRadius: 14,
  fontSize: 15,
  textAlign: "center",
  maxWidth: "90vw"
};

const bottomBarStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 6,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  background: "rgba(11,15,12,0.92)",
  borderTop: "1px solid #2f5c3d",
  padding: "12px 16px"
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "12px 18px",
  background: "#f5d90a",
  color: "#111",
  border: "none",
  borderRadius: 999,
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer"
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "12px 16px",
  background: "#1a3a24",
  color: "#eef2ef",
  border: "1px solid #2f5c3d",
  borderRadius: 999,
  fontSize: 15,
  cursor: "pointer"
};
