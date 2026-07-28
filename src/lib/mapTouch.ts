import type { Map as MapboxMap, Marker as MapboxMarker } from "mapbox-gl";
import type { LatLng } from "../types/domain";

// ~1cm on a typical phone screen — how far above the actual touch point a dragged marker's REAL
// coordinate sits, not just a visual nudge, so a thumb never obscures the spot it's about to drop
// a dot/pin on.
export const TOUCH_DRAG_OFFSET_PX = 50;

/**
 * Mathematically offsets a dragged marker's REAL geographic position 50px up the screen from
 * wherever the pointer actually is: project the marker's current (pointer-driven) LngLat to
 * screen pixels, subtract TOUCH_DRAG_OFFSET_PX from Y, unproject back, and snap the marker there.
 * Unlike a CSS transform (which only nudges the rendered position, leaving the marker's actual
 * coordinate under the thumb), this changes what the marker IS — lines/labels/ellipses and the
 * eventual drop point all follow the offset position, not the raw touch point. Safe to call on
 * every "drag" tick: Mapbox's own marker-drag math bases each tick's raw position on the
 * pointer's cumulative delta from drag-start, not on wherever this last snapped the marker to,
 * so repeated calls don't compound/drift.
 *
 * THE canonical implementation (REVISION-SPEC constraint 2) — every draggable marker in the app
 * must use this, never a reimplementation, and never a CSS transform stacked on top (that
 * doubles the offset; that bug has shipped before).
 */
export function applyTouchDragOffset(map: MapboxMap, marker: MapboxMarker): LatLng {
  const raw = marker.getLngLat();
  const px = map.project(raw);
  const offset = map.unproject([px.x, px.y - TOUCH_DRAG_OFFSET_PX]);
  marker.setLngLat(offset);
  return { lat: offset.lat, lng: offset.lng };
}
