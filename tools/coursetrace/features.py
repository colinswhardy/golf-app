#!/usr/bin/env python3
"""Detect putting greens AND tee pads, then render a labelled map for routing analysis.

Greens and tees are both smooth mown turf; they differ in size and shape. Thresholds were
calibrated against sampled pixels (greens: greenness>42 tex<8; fairway: 34/20; scrub: 26/9).
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

BASE = sys.argv[1] if len(sys.argv) > 1 else "full18"
DS = 2

meta = json.load(open(f"{BASE}.json"))
img = Image.open(f"{BASE}.png").convert("RGB")
W0, H0 = img.size
img = img.resize((W0 // DS, H0 // DS), Image.LANCZOS)
a = np.asarray(img).astype(np.float32)
H, W, _ = a.shape

R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
greenness = G - (R + B) / 2.0
brightness = a.mean(axis=2)


def local_std(x, size):
    m = ndimage.uniform_filter(x, size)
    m2 = ndimage.uniform_filter(x * x, size)
    return np.sqrt(np.maximum(m2 - m * m, 0))


tex = local_std(brightness, 9)
mpp = 156543.03392 * np.cos(np.radians((meta["minlat"] + meta["maxlat"]) / 2)) / (2 ** meta["zoom"]) / 2 * DS

sand = (brightness > 128) & (greenness < 27) & (R > B + 22)
sand = ndimage.binary_opening(sand, np.ones((3, 3)))
sand = ndimage.binary_closing(sand, np.ones((5, 5)))

smooth = (greenness > 42) & (brightness > 78) & (tex < 8.0)
smooth = ndimage.binary_opening(smooth, np.ones((3, 3)))
smooth = ndimage.binary_closing(smooth, np.ones((7, 7)))

# Course footprint: keep everything inside the mown envelope, to reject outlying scrub.
turf = (greenness > 28) & (brightness > 62)
env = ndimage.binary_closing(turf, np.ones((61, 61)))
env = ndimage.binary_opening(env, np.ones((13, 13)))
elab, en = ndimage.label(env)
if en:
    sizes = ndimage.sum(env, elab, range(1, en + 1))
    env = elab == (int(np.argmax(sizes)) + 1)
env = ndimage.binary_dilation(env, np.ones((45, 45)))
print(f"course envelope: {env.sum() * mpp * mpp / 10000:.1f} ha")


def px2ll(cx, cy):
    lon = meta["minlon"] + (cx / W) * (meta["maxlon"] - meta["minlon"])
    lat = meta["maxlat"] - (cy / H) * (meta["maxlat"] - meta["minlat"])
    return round(float(lat), 6), round(float(lon), 6)


def blobs(mask, amin, amax, fill_min, elong_max):
    lab, n = ndimage.label(mask)
    objs = ndimage.find_objects(lab)
    areas = ndimage.sum(mask, lab, range(1, n + 1))
    out = []
    for i in range(n):
        am2 = areas[i] * mpp * mpp
        if not (amin <= am2 <= amax):
            continue
        sl = objs[i]
        hpx, wpx = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        fill = areas[i] / max(hpx * wpx, 1)
        elong = max(hpx, wpx) / max(min(hpx, wpx), 1)
        if fill < fill_min or elong > elong_max:
            continue
        cy, cx = ndimage.center_of_mass(lab == (i + 1))
        if not env[int(cy), int(cx)]:
            continue
        lat, lon = px2ll(cx, cy)
        out.append({"lat": lat, "lon": lon, "area_m2": round(float(am2)),
                    "px": [float(cx), float(cy)], "elong": round(float(elong), 2)})
    return out


greens = blobs(smooth, 150, 1400, 0.50, 2.8)
tees = blobs(smooth, 35, 150, 0.45, 4.5)

blab, bn = ndimage.label(sand)
bareas = ndimage.sum(sand, blab, range(1, bn + 1))
bunkers = []
for i in range(bn):
    am2 = bareas[i] * mpp * mpp
    if not (20 <= am2 <= 900):
        continue
    cy, cx = ndimage.center_of_mass(blab == (i + 1))
    if not env[int(cy), int(cx)]:
        continue
    lat, lon = px2ll(cx, cy)
    bunkers.append({"lat": lat, "lon": lon, "area_m2": round(float(am2)), "px": [float(cx), float(cy)]})

greens.sort(key=lambda c: (-c["lat"], c["lon"]))
tees.sort(key=lambda c: (-c["lat"], c["lon"]))
json.dump({"greens": greens, "tees": tees, "bunkers": bunkers, "mpp": mpp, "meta": meta},
          open(f"{BASE}_feat2.json", "w"), indent=1)
print(f"{len(greens)} greens, {len(tees)} tee pads, {len(bunkers)} bunkers")

ov = img.copy()
d = ImageDraw.Draw(ov)
for b in bunkers:
    x, y = b["px"]
    d.ellipse([x - 4, y - 4, x + 4, y + 4], outline=(255, 165, 0), width=2)
for i, t in enumerate(tees):
    x, y = t["px"]
    d.rectangle([x - 13, y - 13, x + 13, y + 13], outline=(0, 210, 255), width=3)
    d.text((x + 16, y - 6), f"t{i}", fill=(0, 210, 255))
for i, g in enumerate(greens):
    x, y = g["px"]
    d.ellipse([x - 30, y - 30, x + 30, y + 30], outline=(255, 0, 255), width=5)
    d.text((x + 34, y - 10), f"G{i}", fill=(255, 0, 255))
ov.save(f"{BASE}_map.png")
print(f"wrote {BASE}_map.png")
