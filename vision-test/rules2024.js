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
//   inCone(light, p)         is scene point p inside light {x, y, cone}'s cone (true when cone is null;
//                            its apex counts as inside)
//   SENSES, MAX_SENSE_FT
//   sensesOf(raw)            one PC's senses: {dark, blind, truesight, tremor}, whole feet 0-1000, 0 for
//                            anything missing or junk (numbers, or numeric strings)
//   senseMapOf(raw, {keyOf, max})  PARTY_SENSES_KEY made safe: {keyOf(name): sensesOf(entry)}, at most
//                            `max` names; a key keyOf makes empty is dropped
//
// Written values are always whole, with every field present; nothing here deletes a key.

import { OBSCURE_KEY, RULES_KEY, WEATHER_KEY, ZONE_KEY } from "./keys.js?v=c5ec1d6";

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

export function inCone(light, p) {
  const cone = light?.cone;
  if (cone == null) return true;
  if (!finite(light?.x, light?.y, p?.x, p?.y, cone.facing, cone.half)) return false;
  const dx = p.x - light.x, dy = p.y - light.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return true; // the apex
  const t = (cone.facing * Math.PI) / 180;
  const cos = (dx * Math.sin(t) - dy * Math.cos(t)) / len; // facing 0 = up the screen (-y), clockwise
  return cos >= Math.cos((cone.half * Math.PI) / 180) - 1e-9;
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
