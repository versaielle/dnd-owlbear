// The 2024 vision rules' one shared reader (docs/vision-layer-2024.md, the builders' contract): the
// scene's seven 2024 switches, its weather, the obscured marks on shapes and spell clouds, a light's
// cone, and a PC's four senses. Pure: no Owlbear import and no DOM (keys.js only), so every screen,
// the bridge and the offline checks load it the same way.
//
//   RULE_NAMES               the seven switches, in the 🔥 Lighting list's order
//   RULE_LABELS              {name: "💡 Dim light", ...}: the words the switch row shows
//   DEFAULT_RULES            all seven false, frozen. A missing RULES_KEY, or a missing or junk field,
//                            reads as this: exactly the Phase 1 look. Fixed now: never changed after a
//                            live check (Thursday's ON set is tapped into the scene instead)
//   rulesOf(sceneMeta)       RULES_KEY made safe: {dim, cones, darkvision, zones, weather, senses,
//                            pierce}, each true only when stored as true
//   effectiveRules(rules)    what the drawing obeys: cones only while dim is on too, pierce only while
//                            senses is on too (the rest as they are)
//   rulesValue(sceneMeta, patch)  the whole RULES_KEY value a tap writes: {v: 1, ...the seven}, the
//                            scene's now with `patch`'s true/false fields over them
//   ALL_RULES_OFF            {v: 1, all seven false}: what "All 2024 off" writes
//   ALL_RULES_ON             {v: 1, all seven true}: what "All 2024 on" writes (V2: the game's setup taps it
//                            once per scene; DEFAULT_RULES stay off)
//   WEATHER_KINDS, FOG_FT, WEATHER_LIMIT_FT, WEATHER_CHOICES (the chips: {kind, fog_ft, label})
//   weatherOf(sceneMeta)     WEATHER_KEY made safe: {kind, fog_ft, limitFt, obscured}. limitFt: how far
//                            anyone sees outdoors in it; obscured: "light" (heavy rain, heavy snow, fog)
//                            or null. The reader applies both on maps marked outdoor only
//   weatherValue(kind, fogFt)  the whole WEATHER_KEY value for a chip (fog_ft 0 unless kind is fog)
//   SPELL_OBSCURE            {spell slug: {level, magic}}: the spell clouds that obscure, by name
//   spellSlug(name)          "Fog Cloud" -> "fog_cloud" (as the panel names a zone's spell)
//   spellObscureOf(item)     a spell's zone outline (ZONE_KEY): {level, magic, spell} when its spell is
//                            in SPELL_OBSCURE and it isn't stamped `ending`; hidden ones count; else null
//   OBSCURE_LEVELS, OBSCURE_WHATS, OBSCURE_SRCS
//   obscureValue(x)          the whole OBSCURE_KEY value from anything: {v: 1, level, magic, what, src},
//                            a junk field as its default ("none", false, "other", "drawn")
//   obscureOf(item)          the item's mark (obscureValue of it), or null when it has none (missing,
//                            null or not an object). level "none" is a cleared mark: no effect
//   CONE_HALF_DEG            26.57: half the angle of a cone as wide as it is long
//   coneOf(rotation)         {facing, half} for a carrier turned `rotation` degrees (Owlbear's: 0 points
//                            up the screen, growing clockwise); null for junk
//   MAX_CONES                4: the most lights that shine in a cone in one scene (the darkness
//                            overlay's cone copy has that many cone slots, fx/lights.js DKC_CONES)
//   capCones(lights, {rank, max})   the same lights, the cone kept on at most `max` of them (a PC's own
//                            first, then by id) and every further cone made one of no width, which
//                            lights nothing; the list itself when there are no more than `max`
//   inCone(light, p)         is scene point p inside light {x, y, cone}'s cone (true when cone is null;
//                            its apex counts as inside; a cone of no width holds nothing)
//   reachDist(light, p)      how far p is from the light as its reach measures it: straight out for a
//                            circle, along the axis for a cone (the 2024 Cone's flat end), Infinity
//                            outside the cone or for junk
//   discLit(light, c, r, reach)   does some part of the disc (middle c, radius r) lie strictly within
//                            the ground the light lights out to `reach` (c's unit): its circle, or its
//                            cone's (the 2024 Cone, a triangle with its flat end); false for junk
//   farReach(light)          the farthest a light reaches anywhere, in its reach's unit: its reach, or a
//                            2024 Cone's flat-end corners, reach / cos(half) (1.118 x for coneOf's)
//   SENSES, MAX_SENSE_FT
//   sensesOf(raw)            one PC's senses: {dark, blind, truesight, tremor}, whole feet 0-1000, 0 for
//                            anything missing or junk (numbers, or numeric strings)
//   senseMapOf(raw, {keyOf, max})  PARTY_SENSES_KEY made safe: {keyOf(name): sensesOf(entry)}, at most
//                            `max` names; a key keyOf makes empty is dropped
//
// Written values are always whole, with every field present; nothing here deletes a key.

import { OBSCURE_KEY, RULES_KEY, WEATHER_KEY, ZONE_KEY } from "./keys.js?v=9a30147";

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));

// ---- the seven switches (RULES_KEY, on the scene) ----

export const RULE_NAMES = Object.freeze(["dim", "cones", "darkvision", "zones", "weather", "senses", "pierce"]);
export const RULE_LABELS = Object.freeze({
  dim: "💡 Dim light", cones: "🔦 Cones", darkvision: "👓 Darkvision", zones: "☁ Obscured",
  weather: "🌦 Weather", senses: "🦇 Senses", pierce: "🧱 Senses through fog",
});
export const DEFAULT_RULES = Object.freeze(Object.fromEntries(RULE_NAMES.map((n) => [n, false])));

export function rulesOf(sceneMeta) {
  const raw = isObj(sceneMeta) ? sceneMeta[RULES_KEY] : null;
  const v = isObj(raw) ? raw : {};
  return Object.fromEntries(RULE_NAMES.map((n) => [n, v[n] === true]));
}

export function effectiveRules(rules) {
  const r = isObj(rules) ? rules : {};
  const out = Object.fromEntries(RULE_NAMES.map((n) => [n, r[n] === true]));
  out.cones = out.cones && out.dim;
  out.pierce = out.pierce && out.senses;
  return out;
}

export function rulesValue(sceneMeta, patch = {}) {
  const now = rulesOf(sceneMeta);
  const p = isObj(patch) ? patch : {};
  for (const n of RULE_NAMES) if (typeof p[n] === "boolean") now[n] = p[n];
  return { v: 1, ...now };
}

export const ALL_RULES_OFF = Object.freeze({ v: 1, ...DEFAULT_RULES });
export const ALL_RULES_ON = Object.freeze({ v: 1, ...Object.fromEntries(RULE_NAMES.map((n) => [n, true])) });

// ---- the weather (WEATHER_KEY, on the scene) ----

export const WEATHER_KINDS = Object.freeze(["clear", "rain", "heavy_rain", "snow", "heavy_snow", "fog"]);
export const FOG_FT = Object.freeze([100, 200, 300]);
const FOG_JUNK_FT = 300; // a "fog" whose fog_ft isn't one of FOG_FT reads as the lightest fog
// How far anyone sees outdoors, in feet (fog: its fog_ft). Clear is 2 miles; rain and snow 1 mile.
export const WEATHER_LIMIT_FT = Object.freeze({ clear: 10560, rain: 5280, heavy_rain: 5280, snow: 5280, heavy_snow: 5280 });
const LIGHTLY_OBSCURED = new Set(["heavy_rain", "heavy_snow", "fog"]);
export const WEATHER_CHOICES = Object.freeze([
  { kind: "clear", fog_ft: 0, label: "Clear" }, { kind: "rain", fog_ft: 0, label: "Rain" },
  { kind: "heavy_rain", fog_ft: 0, label: "Heavy rain" }, { kind: "snow", fog_ft: 0, label: "Snow" },
  { kind: "heavy_snow", fog_ft: 0, label: "Heavy snow" }, { kind: "fog", fog_ft: 300, label: "Fog 300" },
  { kind: "fog", fog_ft: 200, label: "Fog 200" }, { kind: "fog", fog_ft: 100, label: "Fog 100" },
].map((c) => Object.freeze(c)));

export function weatherOf(sceneMeta) {
  const raw = isObj(sceneMeta) ? sceneMeta[WEATHER_KEY] : null;
  const v = isObj(raw) ? raw : {};
  const kind = WEATHER_KINDS.includes(v.kind) ? v.kind : "clear";
  const fog_ft = kind === "fog" ? (FOG_FT.includes(v.fog_ft) ? v.fog_ft : FOG_JUNK_FT) : 0;
  return { kind, fog_ft, limitFt: kind === "fog" ? fog_ft : WEATHER_LIMIT_FT[kind], obscured: LIGHTLY_OBSCURED.has(kind) ? "light" : null };
}

export function weatherValue(kind, fogFt = 0) {
  const k = WEATHER_KINDS.includes(kind) ? kind : "clear";
  return { v: 1, kind: k, fog_ft: k === "fog" ? (FOG_FT.includes(fogFt) ? fogFt : FOG_JUNK_FT) : 0 };
}

// ---- obscured areas: spell clouds (by name) and marked shapes (OBSCURE_KEY) ----

export const SPELL_OBSCURE = Object.freeze({
  fog_cloud: { level: "heavy", magic: false }, stinking_cloud: { level: "heavy", magic: false },
  cloudkill: { level: "heavy", magic: false }, incendiary_cloud: { level: "heavy", magic: false },
  sleet_storm: { level: "heavy", magic: false },
  darkness: { level: "heavy", magic: true }, hunger_of_hadar: { level: "heavy", magic: true },
  web: { level: "light", magic: false }, insect_plague: { level: "light", magic: false },
});
for (const v of Object.values(SPELL_OBSCURE)) Object.freeze(v);

export const spellSlug = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export function spellObscureOf(item) {
  const m = item?.metadata?.[ZONE_KEY];
  if (!isObj(m) || m.ending) return null;
  const spell = spellSlug(m.spell);
  const s = Object.hasOwn(SPELL_OBSCURE, spell) ? SPELL_OBSCURE[spell] : null;
  return s ? { level: s.level, magic: s.magic, spell } : null;
}

export const OBSCURE_LEVELS = Object.freeze(["none", "light", "heavy"]);
export const OBSCURE_WHATS = Object.freeze(["fog", "foliage", "smoke", "dark", "dust", "other"]);
export const OBSCURE_SRCS = Object.freeze(["drawn", "map"]);

export function obscureValue(x) {
  const o = isObj(x) ? x : {};
  return {
    v: 1,
    level: OBSCURE_LEVELS.includes(o.level) ? o.level : "none",
    magic: o.magic === true,
    what: OBSCURE_WHATS.includes(o.what) ? o.what : "other",
    src: OBSCURE_SRCS.includes(o.src) ? o.src : "drawn",
  };
}

export function obscureOf(item) {
  const raw = item?.metadata?.[OBSCURE_KEY];
  return isObj(raw) ? obscureValue(raw) : null;
}

// ---- a light's cone ----

export const CONE_HALF_DEG = Math.round((Math.atan(0.5) * 180 / Math.PI) * 100) / 100; // 26.57

export function coneOf(rotation) {
  if (!finite(rotation)) return null;
  const f = ((rotation % 360) + 360) % 360;
  return { facing: Math.round(f * 100) / 100 + 0, half: CONE_HALF_DEG };
}

// How many lights may shine in a cone in one scene: the darkness overlay's cone copy has this many
// cone slots (fx/lights.js DKC_CONES is this number), and every other layer keeps to the same ones.
export const MAX_CONES = 4;

// A cone that lights part of its circle: an object with a finite facing and a half above 0 and under
// 180 (fx/lights.js coneSlot's vector). A half of 180 or more is the whole circle; junk or no width
// lights nothing.
const shines = (cone) => isObj(cone) && finite(cone.facing, cone.half) && cone.half > 0 && cone.half < 180;

// The cone kept on at most `max` lights (MAX_CONES) of a scene's list (fx/darkness.js lightShape's
// {id, ..., cone}), in one stable order: the lowest rank(light) first (the callers give a PC's own
// light 0), then by id, then by place in the list, so the item order never changes which. Every
// further light in a cone keeps its facing but its half becomes 0: a cone of no width, which lights
// nothing in any layer (inCone and reachDist here, fx/lights.js coneSlot "none" for the overlay and
// the flames, fog/shapes.js lightPath for the memory), as any cone that lights nothing already does.
// Every layer that reads a scene's lights calls this (fx/darkness.js darknessCtx for the fog, the
// badge and the seen test; fx/lighting.js for the overlay and the flames), so they all agree which
// bullseye is dark. Returns the same list when no more than `max` shine in a cone (so with 🔦 or 💡
// off, when no light has a cone, nothing changes at all); else a new one, the lights in the same order.
export function capCones(lights, { rank = () => 0, max = MAX_CONES } = {}) {
  const list = Array.isArray(lights) ? lights : [];
  const coned = [];
  list.forEach((l, n) => {
    if (!shines(l?.cone)) return;
    let k = 0;
    try { k = +rank(l); } catch { k = 0; }
    coned.push({ l, n, k: Number.isFinite(k) ? k : 0, id: String(l.id ?? "") });
  });
  const keep = Math.max(0, finite(max) ? Math.floor(max) : MAX_CONES);
  if (coned.length <= keep) return list;
  coned.sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.n - b.n);
  const dark = new Set(coned.slice(keep).map((c) => c.l));
  return list.map((l) => (dark.has(l) ? { ...l, cone: { facing: l.cone.facing, half: 0 } } : l));
}

export function inCone(light, p) {
  const cone = light?.cone;
  if (cone == null) return true;
  if (!finite(light?.x, light?.y, p?.x, p?.y, cone.facing, cone.half)) return false;
  if (!(cone.half > 0)) return false; // a cone of no width holds nothing, not even its apex (capCones)
  const dx = p.x - light.x, dy = p.y - light.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return true; // the apex
  const t = (cone.facing * Math.PI) / 180;
  const cos = (dx * Math.sin(t) - dy * Math.cos(t)) / len; // facing 0 = up the screen (-y), clockwise
  return cos >= Math.cos((cone.half * Math.PI) / 180) - 1e-9;
}

// The 2024 Cone (the DM's D8, 2026-10-19: "Flat, the 2024 Cone"): its length is measured along its
// axis, so its end is flat and its far corners (up to 1.118 x its reach out) are as lit as its
// middle. Every layer that draws or tests a coned light uses this: the darkness overlay (fx/lights.js
// light2k), the fog's sight and memory (fog/shapes.js lightPath, a triangle), the badge
// (fog/perceive.js lightAt) and the seen test (fog/inview.js, through discLit below, the same
// triangle). A half of 90 degrees or more has no flat end (coneOf never makes one): straight out, as
// a sector.
export function reachDist(light, p) {
  if (!finite(light?.x, light?.y, p?.x, p?.y)) return Infinity;
  const dx = p.x - light.x, dy = p.y - light.y;
  const cone = light.cone;
  if (cone == null) return Math.hypot(dx, dy);
  if (!inCone(light, p)) return Infinity;
  if (!(cone.half < 90)) return Math.hypot(dx, dy);
  const t = (cone.facing * Math.PI) / 180;
  return Math.max(0, dx * Math.sin(t) - dy * Math.cos(t)) + 0; // facing 0 = up the screen (-y), clockwise
}

// How far point (x, y) is from the segment (ax, ay) to (bx, by).
function segDist(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
  return Math.hypot(x - ax - t * vx, y - ay - t * vy);
}

// A creature as a disc (middle c, radius r: fog/inview.js's half its smaller side) is lit by a light
// when some part of it lies strictly within the ground the light lights, out to `reach` (in c's unit,
// scene px: the light's reach in feet times pxPerFt). A round light: its middle within reach + r, as
// the seen test always had it. A light in a cone: the disc meets the cone's ground, the same "any part"
// rule, so a creature straddling the beam's side is lit as the overlay lights its near half (reachDist
// alone needs the middle inside the cone). That ground is the 2024 Cone (reachDist's): a triangle, its
// apex at the light and its flat end `reach` out along the axis, the end's corners reach / cos(half)
// out along the edges; a half of 90 to 180 degrees has no flat end (a sector of radius `reach`), and
// 180 or more is the whole circle. A cone that lights nothing (junk, or no width: capCones) lights no
// part of anything. Junk anywhere: false.
export function discLit(light, c, r, reach) {
  if (!finite(light?.x, light?.y, c?.x, c?.y, r, reach) || !(reach > 0) || r < 0) return false;
  const dx = c.x - light.x, dy = c.y - light.y;
  const cone = light.cone;
  if (cone == null) return Math.hypot(dx, dy) - r < reach;
  if (!finite(cone?.facing, cone?.half) || !(cone.half > 0)) return false;
  if (cone.half >= 180) return Math.hypot(dx, dy) - r < reach;
  // in the cone's own frame, folded onto one side: x along the axis, y out to the side (>= 0)
  const t = (cone.facing * Math.PI) / 180, h = (cone.half * Math.PI) / 180;
  const ux = Math.sin(t), uy = -Math.cos(t); // facing 0 = up the screen (-y), clockwise
  const x = dx * ux + dy * uy, y = Math.abs(dx * uy - dy * ux);
  // the signed distance from the middle to the ground: <= 0 inside (minus how deep), else how far out;
  // the near side is the one it's folded onto, so the other one never counts
  let gap;
  if (cone.half < 90) {
    const w = reach * Math.tan(h); // half the flat end
    const side = segDist(x, y, 0, 0, reach, w);
    const end = y <= w ? Math.abs(x - reach) : Math.hypot(x - reach, y - w);
    const inside = x <= reach && y <= x * Math.tan(h);
    gap = inside ? -Math.min(side, end) : Math.min(side, end);
  } else {
    const d = Math.hypot(x, y);
    const ex = reach * Math.cos(h), ey = reach * Math.sin(h);
    if (Math.atan2(y, x) <= h) gap = d <= reach ? -Math.min(reach - d, segDist(x, y, 0, 0, ex, ey)) : d - reach;
    else gap = segDist(x, y, 0, 0, ex, ey);
  }
  return gap < r;
}

// For bounds (how far a PC can see a light, what a light's line of sight must cover): the corners of
// a 2024 Cone's flat end are reach / cos(half) out, past its reach.
export function farReach(light) {
  const r = light?.reach, c = light?.cone;
  if (c == null || !finite(r, c.half) || !(c.half > 0) || !(c.half < 90)) return r;
  return r / Math.cos((c.half * Math.PI) / 180);
}

// ---- a PC's senses (PARTY_SENSES_KEY on the room, the panel's catalog) ----

export const SENSES = Object.freeze(["dark", "blind", "truesight", "tremor"]);
export const MAX_SENSE_FT = 1000;

const feet = (x) => {
  if (typeof x !== "number" && !(typeof x === "string" && x.trim() !== "")) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_SENSE_FT, Math.round(n))) + 0 : 0;
};

export function sensesOf(raw) {
  const o = isObj(raw) ? raw : {};
  return { dark: feet(o.dark), blind: feet(o.blind), truesight: feet(o.truesight), tremor: feet(o.tremor) };
}

export function senseMapOf(raw, { keyOf = (k) => String(k), max = 64 } = {}) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= max) break;
    let key = "";
    try { key = String(keyOf(k) ?? ""); } catch { key = ""; }
    if (!key || !isObj(v)) continue;
    out[key] = sensesOf(v);
  }
  return out;
}
