// What a wall line is, with no map in it: the leaf of fog/lines.js. It imports keys.js and nothing
// else, so gather.js (a static import of background.js, menu.html and popover.html) and
// fx/lighting.js can read lines without pulling views.js or any other fog code into their load:
// a broken fog file can't stop background.js, the GM's popover or the menus from loading.
// fog/lines.js re-exports all of it and adds the map a line belongs to.
//
//   KINDS, SMOKE_LINE        our kinds, Smoke & Spectre's line keys (its 5.0.4 MetadataKeys)
//   toWorld(item, p) / worldPoints(item)   a CURVE's points on the scene (its position, turn and
//                        scale; a closed one ends where it starts), as the SDK's MathM gives them
//   ourState(v) / smokeState(meta)   a line's state in each format, or null
//   knownOf(meta)        has the party found this door's lock (WALL_KEY.knownLocked, in either
//                        format: on a Smoke-only line our key holds only that)
//   readLine(item)       one line: {id, mapId: null, kind, open, locked, knownLocked, disabled,
//                        blocking, doubleSided, src: "ours" | "smoke", points}, or null when it isn't one
//
// Every state is read by truthiness or `=== true`, so a key written as an explicit false (our door
// writes never delete one, fog/lines.js doorEdit) reads as missing: shut, unlocked, not known.

import { SMOKE, WALL_KEY } from "../keys.js?v=c5ec1d6";

export const KINDS = ["wall", "door", "window"];
const SK = (k) => `${SMOKE}/${k}`;
// Smoke & Spectre's line keys (its 5.0.4 MetadataKeys).
export const SMOKE_LINE = {
  line: SK("isVisionLine"), door: SK("isDoor"), window: SK("isWindow"), open: SK("doorOpen"),
  disabled: SK("disabled"), locked: SK("isDoorLocked"), blocking: SK("blocking"), doubleSided: SK("doubleSided"),
};

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const isPt = (p) => !!p && finite(p.x, p.y);
const rad = (d) => (d * Math.PI) / 180;
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0

// ---- where a line is ----

// A point of an item (in its own coordinates) on the scene: scaled, turned (degrees), moved. The
// same as MathM.fromItem(item) x MathM.fromPosition(p), decomposed (check_fog_lines.mjs).
export function toWorld(item, p) {
  const pos = isPt(item?.position) ? item.position : { x: 0, y: 0 };
  const sx = finite(item?.scale?.x) ? item.scale.x : 1, sy = finite(item?.scale?.y) ? item.scale.y : 1;
  const a = rad(finite(item?.rotation) ? item.rotation : 0);
  const x = p.x * sx, y = p.y * sy;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: pos.x + x * c - y * s, y: pos.y + x * s + y * c };
}

// A CURVE's points on the scene, to 0.01 px (so the same line always reads the same); a closed
// one ends where it starts. [] when a point is broken.
export function worldPoints(item) {
  if (!Array.isArray(item?.points) || !item.points.length || !item.points.every(isPt)) return [];
  const pts = item.points.map((p) => toWorld(item, p)).map((p) => ({ x: r2(p.x), y: r2(p.y) }));
  if (!pts.every(isPt)) return [];
  if (item.style?.closed && pts.length > 2) pts.push({ ...pts[0] });
  return pts;
}

// ---- what a line is ----

// Our key's value as {kind, open, locked, knownLocked}, or null when it isn't one (no kind we know:
// on a Smoke-only line it may hold only {knownLocked}).
export function ourState(v) {
  if (!isObj(v) || !KINDS.includes(v.kind)) return null;
  const door = v.kind === "door";
  const open = door && v.open === true;
  const locked = door && !open && v.locked === true;
  return { kind: v.kind, open, locked, knownLocked: locked && v.knownLocked === true };
}

// Has the party found this door's lock? Our key's knownLocked, whichever format holds the door's state.
export const knownOf = (meta) => isObj(meta) && isObj(meta[WALL_KEY]) && meta[WALL_KEY].knownLocked === true;

// Smoke & Spectre's keys on a line as {kind, open, locked, disabled, blocking, doubleSided}, or
// null when it isn't one of Smoke's lines.
export function smokeState(meta) {
  const m = isObj(meta) ? meta : {};
  if (!m[SMOKE_LINE.line]) return null;
  const kind = m[SMOKE_LINE.window] ? "window" : m[SMOKE_LINE.door] ? "door" : "wall";
  const door = kind === "door";
  const open = door && (m[SMOKE_LINE.open] === true || m[SMOKE_LINE.disabled] === true);
  return { kind, open, locked: door && !open && m[SMOKE_LINE.locked] === true, disabled: !door && m[SMOKE_LINE.disabled] === true,
           blocking: m[SMOKE_LINE.blocking] === true, doubleSided: m[SMOKE_LINE.doubleSided] === true };
}

// One wall line with no map (mapId null: fog/lines.js readLine finds it), or null when the item
// isn't one (not a CURVE, no key we know, under two points).
export function readLine(item) {
  if (!item || item.type !== "CURVE") return null;
  const meta = isObj(item.metadata) ? item.metadata : {};
  const ours = ourState(meta[WALL_KEY]);
  const smoke = smokeState(meta);
  if (!ours && !smoke) return null;
  const points = worldPoints(item);
  if (points.length < 2) return null;
  const s = ours || smoke;
  return {
    id: item.id, mapId: null, kind: s.kind, open: s.open, locked: s.locked,
    knownLocked: s.locked && knownOf(meta), // the party found the lock (players see it only then)
    disabled: !ours && smoke.disabled, // a line the DM switched off in Smoke (never a door: that's open)
    blocking: ours ? true : smoke.blocking, // drags stop at it (ours always; Smoke's as the DM set it)
    doubleSided: ours ? true : smoke.doubleSided,
    src: ours ? "ours" : "smoke", points,
  };
}
