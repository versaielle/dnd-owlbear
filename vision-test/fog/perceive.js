// 👁 Sight hints: which PCs' sight-based Perception suffers where they stand (docs/vision-layer-2024.md section 7,
// "The badge"; the plan's Area 3c). The bridge adds sightReport()'s answer to its map report, and the panel turns
// each PC with a penalty into a chip on its status bar ("👁 <name> −5 (passive 9)"). Advice for the DM only: no
// screen draws anything from it, and nothing here writes. Pure: no Owlbear import and no DOM, so the offline check
// (check_perceive.mjs) loads it directly.
//
// Every PC is judged at its CENTRE POINT, never by squares (decision 28): the light there, the zone whose outline
// contains it, the outdoor weather of the map under it, and its own senses. The 2024 switches are ignored (decision
// 33): the badge follows the rules even while a drawing switch is off; only the panel's 👁 switch turns it off.
//
//   LIGHT_LEVELS             ["dark", "dim", "bright"], darkest first
//   BADGE_WEATHER            the weather kinds that matter here: {heavy_rain, heavy_snow, fog} -> their words
//   brightOf(light)          a light's bright radius (feet): its own `bright`, else half its reach (a light with no
//                            bright/dim split: an adopted Smoke torch, a hidden ambient torch, a typed reach)
//   lightAt(p, ctx)          "bright" | "dim" | "dark" at scene point p: the map's own darkness under it (lit -> bright,
//                            dim -> dim), raised by any light whose bright radius (bright) or reach (dim) holds it,
//                            inside the light's cone when it has one, measured along its axis (rules2024.js
//                            reachDist: the 2024 Cone's flat end); a light with no bright
//                            part (bright 0: hood down, Dancing Lights) is dim to its reach, its centre too. Only
//                            the lights on the map under p count (ctx.maps: fx/darkness.js lightsOnMap), as the
//                            fog's sight: a light on another map is behind that map's edge wall
//   zonesAt(p, zones)        the zones whose ring holds p: {level: null | "light" | "heavy", magicOnly, list}
//                            (level: the heaviest; magicOnly: every heavy one there is magic darkness)
//   sensedAs(light, senses)  what that light comes to for these senses (rules sheet 11.3): darkvision turns dim
//                            into bright and dark into dim, truesight turns dark into bright (dim stays dim), and
//                            nothing sees in the dark without one ("none")
//   judge(item, ctx)         one PC's entry: {name, light, seen, zone, weather, blinded, dis, cant_see, why}, or null
//                            when it has no centre or stands on no map (decision 30)
//   sightReport(pcs, ctx)    {v: 1, pcs: {<token id>: judge(...)}}
//   pcsOf(items, isPc)       the CHARACTER-layer items isPc calls player characters (hidden ones too: a PC is public)
//   sightCtxOf(items, sceneMeta, opts)  the ctx sightReport reads, worked out from the scene's items alone (the
//                            bridge copy runs no fog of its own). opts: {grid ({dpi, multiplier}), isPc(item),
//                            senses(item) (the party file's: rules2024.js sensesOf shape, or null), nameOf(item),
//                            zones (snap.zones's shape) or zonesOf(items, {rects, dpi})}. Given neither, the
//                            zones are read from the items with fog/zoneread.js zonesOf, as the fog engine reads
//                            them (drawn marks, 🏘's zones, spell clouds; hidden ones count, ending ones don't)
//
// ctx (sightReport, judge): {lights: [{id, x, y, reach, bright, cone, mapId}] (the PUBLIC ones and the DM's ambient
// ones, scene px, feet), maps (views.js mapRects, topmost first: which map each light and each PC is on), zones: [{id, level, magic, src, points, mapId}] (rings in scene px), weather (rules2024.js
// weatherOf), outdoorAt(p), darknessAt(p) ("lit" | "dim" | "dark"), onMap(p) (false: the PC is on no map),
// senses(item) -> {dark, blind, truesight, tremor} in feet (the DM's override first, then the party file), pxPerFt,
// dpi, nameOf(item)}.
//
// An entry, per the contract:
//   light     the light at the PC's centre
//   seen      that light after the PC's senses and any heavy zone it stands in: "bright" | "dim" | "none"
//             (blindsight perceives without eyes: no sight penalty at all, "bright"; Blinded without it: "none")
//   zone      null | "light" | "heavy": the heaviest zone holding the centre
//   weather   null | "heavy_rain" | "heavy_snow" | "fog": the scene's weather, on an outdoor map only
//   blinded   the token carries the Blinded condition (COND_KEY)
//   dis       null | "sight" (seen dim, or lightly obscured: sight-based Perception at Disadvantage) | "all"
//             (heavy rain or snow: every Perception check, so blindsight doesn't lift it)
//   cant_see  seen is "none": darkness without a sense, inside a heavy zone, or Blinded
//   why       plain words for the panel's hover ("dim light", "heavy rain", ...)
// The panel takes 5 off the passive once for any `dis` (never stacked; advantage isn't tracked, decision 31).

import { COND_KEY } from "../keys.js?v=9a30147";
import { reachDist, weatherOf } from "../rules2024.js?v=9a30147";
import { darknessCtx, lightsOnMap, regionAt } from "../fx/darkness.js?v=9a30147";
import { visionOf } from "../fx/lightmeta.js?v=9a30147";
import { mapFogOf, paintedKind } from "./maps.js?v=9a30147";
import { zonesOf as readZones } from "./zoneread.js?v=9a30147";
import { centreOf, mapAt, mapRects } from "../views.js?v=9a30147";

export const LIGHT_LEVELS = Object.freeze(["dark", "dim", "bright"]);
export const BADGE_WEATHER = Object.freeze({ heavy_rain: "heavy rain", heavy_snow: "heavy snow", fog: "fog" });
const ALL_PERCEPTION = new Set(["heavy_rain", "heavy_snow"]); // disadvantage on every Perception check, not only sight
const MAX_PCS = 32;

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };
const ft = (x) => (finite(x) && x > 0 ? x : 0);
const rank = (level) => LIGHT_LEVELS.indexOf(level);
const brighter = (a, b) => (rank(a) >= rank(b) ? a : b);

// ---- the light at a point ----

export function brightOf(light) {
  const reach = ft(light?.reach);
  return finite(light?.bright) && light.bright >= 0 ? Math.min(light.bright, reach) : reach / 2;
}

const MAP_LIGHT = { lit: "bright", dim: "dim", dark: "dark" };

export function lightAt(p, ctx = {}) {
  let level = MAP_LIGHT[safe(() => ctx.darknessAt?.(p))] ?? "bright"; // unmarked = lit, as the overlay
  if (level === "bright" || !p || !finite(p.x, p.y)) return level;
  const pxPerFt = finite(ctx.pxPerFt) && ctx.pxPerFt > 0 ? ctx.pxPerFt : 30;
  // Only the lights on the map under p count (fx/darkness.js lightsOnMap over ctx.maps, as the fog's sight
  // and the explored memory: a light on another map is behind that map's edge wall, 2026-10-14), with the
  // 2024 switches on or off and a cone or not; no ctx.maps (or no map at all): every light, as before.
  const maps = Array.isArray(ctx.maps) ? ctx.maps : [];
  const lights = maps.length ? safe(() => lightsOnMap(ctx.lights, mapAt(p, maps), maps), []) : ctx.lights;
  for (const l of Array.isArray(lights) ? lights : []) {
    if (!isObj(l) || !finite(l.x, l.y) || !(ft(l.reach) > 0)) continue;
    // (a cone's along its axis, Infinity outside it: rules2024.js reachDist)
    const d = safe(() => reachDist(l, p), Infinity) / pxPerFt;
    if (!(d < Infinity)) continue;
    // A light with no bright part (a hooded lantern with its hood down 0 + 5, Dancing Lights 0 + 10) is dim even
    // at its own centre, as the 2024 overlay draws it (fx/lights.js light2: bright radius 0 = none).
    const b = brightOf(l);
    if (b > 0 && d <= b) return "bright";
    if (d <= l.reach) level = brighter(level, "dim");
  }
  return level;
}

// ---- the zones at a point ----

// A ring as [{x, y}] (it may come as [[x, y], ...]); points that aren't numbers are dropped.
function ringOf(points) {
  const out = [];
  for (const q of Array.isArray(points) ? points : []) {
    const x = Array.isArray(q) ? q[0] : q?.x, y = Array.isArray(q) ? q[1] : q?.y;
    if (finite(x, y)) out.push({ x, y });
  }
  return out;
}

// Even-odd, as fog/los.js pointInPolygon (the contract's test); a point on the very edge may fall either way.
function inRing(p, ring) {
  if (ring.length < 3) return false;
  let inside = false;
  for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
    const a = ring[k], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function zonesAt(p, zones) {
  const list = [];
  if (p && finite(p.x, p.y)) {
    for (const z of Array.isArray(zones) ? zones : []) {
      if (!isObj(z) || (z.level !== "light" && z.level !== "heavy")) continue;
      if (inRing(p, ringOf(z.points))) list.push(z);
    }
  }
  const heavy = list.filter((z) => z.level === "heavy");
  return {
    level: heavy.length ? "heavy" : list.length ? "light" : null,
    magicOnly: heavy.length > 0 && heavy.every((z) => z.magic === true),
    list,
  };
}

// ---- senses ----

export function sensedAs(light, senses = {}) {
  const dark = ft(senses?.dark) > 0, ts = ft(senses?.truesight) > 0;
  if (light === "bright") return "bright";
  if (light === "dim") return dark ? "bright" : "dim";
  return ts ? "bright" : dark ? "dim" : "none";
}

const SENSE_ZERO = Object.freeze({ dark: 0, blind: 0, truesight: 0, tremor: 0 });
function sensesFor(item, ctx) {
  const s = safe(() => ctx.senses?.(item));
  return isObj(s) ? { dark: ft(s.dark), blind: ft(s.blind), truesight: ft(s.truesight), tremor: ft(s.tremor) } : { ...SENSE_ZERO };
}

const isBlinded = (item) => Array.isArray(item?.metadata?.[COND_KEY]) && item.metadata[COND_KEY].includes("blinded");

// ---- one PC ----

export function judge(item, ctx = {}) {
  if (!isObj(item)) return null;
  const c = safe(() => centreOf(item, ctx.dpi));
  if (!c || !finite(c.x, c.y)) return null;
  if (typeof ctx.onMap === "function" && !safe(() => ctx.onMap(c), false)) return null; // parked off every map
  const senses = sensesFor(item, ctx);
  const blinded = isBlinded(item);
  const light = lightAt(c, ctx);
  const zone = zonesAt(c, ctx.zones);
  const outdoor = !!safe(() => ctx.outdoorAt?.(c), false);
  const kind = isObj(ctx.weather) ? ctx.weather.kind : null;
  const weather = outdoor && Object.hasOwn(BADGE_WEATHER, kind) ? kind : null;
  const why = [];
  let seen;
  if (senses.blind > 0) {
    seen = "bright"; // blindsight: perceived without eyes, in darkness, fog or Blinded alike
  } else if (blinded) {
    seen = "none";
    why.push("Blinded");
  } else if (zone.level === "heavy") {
    // Inside a heavy zone a PC sees only within 5 ft of its centre. Truesight sees through magic darkness
    // (not through fog or smoke); darkvision through neither.
    seen = zone.magicOnly && senses.truesight > 0 ? "bright" : "none";
    why.push(zone.magicOnly ? "in magical darkness" : "in a heavily obscured area");
  } else {
    seen = sensedAs(light, senses);
    if (seen === "dim") why.push(light === "dim" ? "dim light" : "darkness, seen as dim by darkvision");
    else if (seen === "none") why.push("darkness");
  }
  const cantSee = seen === "none";
  // Lightly obscured: a light zone, or fog, heavy rain or heavy snow outdoors. Blindsight lifts it.
  const lightly = senses.blind <= 0 && (zone.level === "light" || weather != null);
  if (zone.level === "light" && senses.blind <= 0) why.push("in a lightly obscured area");
  if (weather) why.push(BADGE_WEATHER[weather]);
  const dis = weather && ALL_PERCEPTION.has(weather) ? "all"
    : !cantSee && (seen === "dim" || lightly) ? "sight" : null;
  return {
    name: String(safe(() => ctx.nameOf?.(item)) ?? item.name ?? "").slice(0, 60),
    light, seen, zone: zone.level, weather, blinded, dis, cant_see: cantSee, why,
  };
}

export function sightReport(pcs, ctx = {}) {
  const out = {};
  let n = 0;
  for (const item of Array.isArray(pcs) ? pcs : []) {
    if (n >= MAX_PCS) break;
    const id = item?.id;
    if (typeof id !== "string" || !id || Object.hasOwn(out, id)) continue;
    const e = judge(item, ctx);
    if (!e) continue;
    out[id] = e;
    n++;
  }
  return { v: 1, pcs: out };
}

export function pcsOf(items, isPc) {
  return (Array.isArray(items) ? items : []).filter((i) => i?.layer === "CHARACTER" && !!safe(() => isPc?.(i), false));
}

// ---- the ctx, from the scene's items ----

// The map image's kind, as fog/maps.js mapStates reads it: the DM's chip, else what 🏘 laid out, else outdoor.
const kindOf = (item) => mapFogOf(item?.metadata).kind ?? paintedKind(item) ?? "outdoor";

export function sightCtxOf(items, sceneMeta = {}, options = {}) {
  const opts = isObj(options) ? options : {};
  const list = (Array.isArray(items) ? items : []).filter((i) => isObj(i) && i.id != null);
  const isPc = (i) => !!safe(() => opts.isPc?.(i), false);
  const dctx = darknessCtx(list, sceneMeta, { isPc, grid: opts.grid });
  const dpi = finite(opts.grid?.dpi) && opts.grid.dpi > 0 ? opts.grid.dpi : 150;
  const rects = mapRects(list, dpi);
  const byId = new Map(list.map((i) => [i.id, i]));
  const mapItemAt = (p) => { const id = mapAt(p, rects); return id == null ? null : byId.get(id) || null; };
  let zones = Array.isArray(opts.zones) ? opts.zones : [];
  if (!Array.isArray(opts.zones)) {
    const reader = typeof opts.zonesOf === "function" ? opts.zonesOf : readZones;
    const z = safe(() => reader(list, { rects, dpi }), []);
    zones = Array.isArray(z) ? z : [];
  }
  // Each PC's senses as the lights read them (fx/lightmeta.js visionOf: the DM's override first, then the party
  // file), with the party file's for any sense visionOf doesn't give.
  const senses = (item) => {
    const party = safe(() => opts.senses?.(item));
    const p = isObj(party) ? party : {};
    const v = safe(() => visionOf(item, { isPc, senses: opts.senses, regions: dctx.regions })) || {};
    const pick = (k) => (finite(v[k]) ? v[k] : ft(Number(p[k])));
    return { dark: pick("dark"), blind: pick("blind"), truesight: pick("truesight"), tremor: pick("tremor") };
  };
  return {
    lights: dctx.lights,
    maps: dctx.maps, // (topmost first: lightAt counts only the lights on the map under the PC)
    zones,
    weather: weatherOf(sceneMeta),
    darknessAt: (p) => regionAt(p, dctx.regions),
    outdoorAt: (p) => { const m = mapItemAt(p); return !!m && kindOf(m) === "outdoor"; },
    onMap: (p) => !rects.length || mapAt(p, rects) != null, // a scene with no map at all: nothing to be off
    senses,
    pxPerFt: dctx.pxPerFt,
    dpi,
    nameOf: (item) => safe(() => opts.nameOf?.(item)) || String(item?.name ?? ""),
  };
}
