// Where things go on the map, in scene pixels. Pure maths, no Owlbear import.
//
// Owlbear turns an item about its `position`, and a rectangle-shaped item (an effect, a
// RECTANGLE shape) is drawn from (0, 0) to (width, height) in its own coordinates, so its
// position is its top-left corner before turning. placeRect() works out that corner for a
// rectangle that should sit with a given point of it (its centre, a strip's start...) on a
// given spot. CIRCLE shapes are the exception: their position is the centre.

export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;

export function rotate(v, degrees) {
  const a = rad(degrees || 0);
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const angleOf = (a, b) => deg(Math.atan2(b.y - a.y, b.x - a.x));

// The top-left `position` for a w x h rectangle turned `rot` degrees, so that its own point
// `anchor` (pixels from its top-left; the centre by default) lands on `at`.
export function placeRect(w, h, at, rot = 0, anchor = null) {
  const a = rotate(anchor || { x: w / 2, y: h / 2 }, rot);
  return { x: at.x - a.x, y: at.y - a.y };
}

// A token's footprint: its centre and width/height on the map, from its image, its grid
// settings and its scale, the way background.js's tokenBox does (width and height kept
// apart). A turn that isn't a multiple of 90 degrees gives the turned rectangle's bounding box.
// null when the item isn't an image with grid settings (the caller falls back to bounds).
export function footprint(item, dpi) {
  if (!item || !item.image || !item.grid?.dpi || !item.position) return null;
  const k = dpi / item.grid.dpi;
  const sx = Math.abs(item.scale?.x ?? 1), sy = Math.abs(item.scale?.y ?? 1);
  const iw = item.image.width, ih = item.image.height;
  if (!finite(k, sx, sy, iw, ih) || iw <= 0 || ih <= 0) return null;
  const off = item.grid.offset || { x: iw / 2, y: ih / 2 };
  const rot = item.rotation || 0;
  const c = rotate({ x: (iw / 2 - off.x) * k * sx, y: (ih / 2 - off.y) * k * sy }, rot);
  let w = iw * k * sx, h = ih * k * sy;
  const turns = ((rot % 360) + 360) % 360;
  if (turns % 90 !== 0) {
    const a = rad(turns);
    const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    w = bw; h = bh;
  } else if (turns === 90 || turns === 270) {
    [w, h] = [h, w];
  }
  const fp = { x: item.position.x + c.x, y: item.position.y + c.y, w, h };
  return finite(fp.x, fp.y, fp.w, fp.h) ? fp : null;
}

// A footprint from Owlbear's getItemBounds() ({min, max, center, width, height}).
export function fromBounds(b) {
  if (!b) return null;
  const w = b.width ?? (b.max?.x - b.min?.x), h = b.height ?? (b.max?.y - b.min?.y);
  const x = b.center?.x ?? (b.min?.x + w / 2), y = b.center?.y ?? (b.min?.y + h / 2);
  return finite(x, y, w, h) ? { x, y, w, h } : null;
}

// The grid as the fx code wants it: pixels per cell, feet per cell, pixels per foot.
export function gridOf(dpi, multiplier) {
  const d = finite(dpi) && dpi > 0 ? dpi : 150;
  const ft = finite(multiplier) && multiplier > 0 ? multiplier : 5;
  return { dpi: d, ftPerCell: ft, pxPerFt: d / ft };
}

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
