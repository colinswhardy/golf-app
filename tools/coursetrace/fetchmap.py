#!/usr/bin/env python3
"""Fetch + stitch Mapbox satellite tiles for a bbox, with an optional labelled lat/lon grid.

Writes <out>.png and <out>.json (the affine transform, so pixel coords can be read back
to lat/lng). Usage:
  python3 fetchmap.py OUT ZOOM MINLAT MINLON MAXLAT MAXLON [gridstep_deg]
"""
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import urllib.request
from PIL import Image, ImageDraw

TOKEN = open(os.path.join(os.path.dirname(__file__), "token.txt")).read().strip()
TILE = 512  # @2x tiles
CACHE = os.path.join(os.path.dirname(__file__), "tilecache")
os.makedirs(CACHE, exist_ok=True)


def lon2x(lon, z):
    return (lon + 180.0) / 360.0 * (2 ** z)


def lat2y(lat, z):
    r = math.radians(lat)
    return (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * (2 ** z)


def x2lon(x, z):
    return x / (2 ** z) * 360.0 - 180.0


def y2lat(y, z):
    n = math.pi - 2.0 * math.pi * y / (2 ** z)
    return math.degrees(math.atan(math.sinh(n)))


def fetch_tile(z, x, y):
    path = os.path.join(CACHE, f"{z}_{x}_{y}.jpg")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return Image.open(path).convert("RGB")
    url = f"https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token={TOKEN}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                data = r.read()
            with open(path, "wb") as f:
                f.write(data)
            return Image.open(BytesIO(data)).convert("RGB")
        except Exception as e:
            if attempt == 3:
                print(f"  !! tile {z}/{x}/{y} failed: {e}", file=sys.stderr)
                return Image.new("RGB", (TILE, TILE), (40, 40, 40))
    return None


def build(out, z, minlat, minlon, maxlat, maxlon, gridstep=None):
    x0f, x1f = lon2x(minlon, z), lon2x(maxlon, z)
    y0f, y1f = lat2y(maxlat, z), lat2y(minlat, z)  # y grows southward
    tx0, tx1 = int(math.floor(x0f)), int(math.floor(x1f))
    ty0, ty1 = int(math.floor(y0f)), int(math.floor(y1f))
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    print(f"z{z}: {nx}x{ny} = {nx*ny} tiles")

    canvas = Image.new("RGB", (nx * TILE, ny * TILE))
    jobs = [(z, tx0 + i, ty0 + j, i, j) for j in range(ny) for i in range(nx)]
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda a: (a[3], a[4], fetch_tile(a[0], a[1], a[2])), jobs))
    for i, j, img in results:
        canvas.paste(img, (i * TILE, j * TILE))

    # Crop to the exact bbox
    left = int(round((x0f - tx0) * TILE))
    top = int(round((y0f - ty0) * TILE))
    right = int(round((x1f - tx0) * TILE))
    bottom = int(round((y1f - ty0) * TILE))
    canvas = canvas.crop((left, top, right, bottom))
    w, h = canvas.size

    meta = {
        "zoom": z, "minlat": minlat, "minlon": minlon, "maxlat": maxlat, "maxlon": maxlon,
        "width": w, "height": h,
        "note": "lon = minlon + (px/width)*(maxlon-minlon); lat = maxlat - (py/height)*(maxlat-minlat)",
    }

    if gridstep:
        d = ImageDraw.Draw(canvas)
        lon = math.ceil(minlon / gridstep) * gridstep
        while lon <= maxlon:
            px = int((lon - minlon) / (maxlon - minlon) * w)
            d.line([(px, 0), (px, h)], fill=(255, 255, 0), width=1)
            d.text((px + 3, 4), f"{lon:.4f}", fill=(255, 255, 0))
            d.text((px + 3, h - 14), f"{lon:.4f}", fill=(255, 255, 0))
            lon += gridstep
        lat = math.ceil(minlat / gridstep) * gridstep
        while lat <= maxlat:
            py = int((maxlat - lat) / (maxlat - minlat) * h)
            d.line([(0, py), (w, py)], fill=(255, 255, 0), width=1)
            d.text((4, py + 3), f"{lat:.4f}", fill=(255, 255, 0))
            d.text((w - 60, py + 3), f"{lat:.4f}", fill=(255, 255, 0))
            lat += gridstep
        meta["gridstep"] = gridstep

    canvas.save(f"{out}.png")
    json.dump(meta, open(f"{out}.json", "w"), indent=2)
    print(f"wrote {out}.png  {w}x{h}px")
    # metres per pixel at this latitude
    mpp = 156543.03392 * math.cos(math.radians((minlat + maxlat) / 2)) / (2 ** z) / 2
    print(f"~{mpp:.2f} m/px")


if __name__ == "__main__":
    a = sys.argv[1:]
    build(a[0], int(a[1]), float(a[2]), float(a[3]), float(a[4]), float(a[5]),
          float(a[6]) if len(a) > 6 else None)
