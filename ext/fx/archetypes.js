// What each archetype is on the map: which rectangle it draws in (size, turn, which point of
// it sits where), which layer, and the uniforms its shader gets. Python (fx_events.py) decides
// WHAT plays and WHEN; this file only turns one part of an FxEvent into an effect's geometry.
// Pure, no Owlbear import: engine.js, the compile gate and the dev page all use it.
import { angleOf, clamp, dist, finite, placeRect, rotate } from "./place.js?v=07c06cc";

// The archetype names (section 11.3 of the spec; fx_events.ARCHETYPES must match).
export const ARCHETYPES = ["bolt", "ray", "arrow", "burst", "cone", "line", "cube", "glow", "smite", "sparkle",
  "slash", "thrust", "smash", "bite", "impact", "resist", "death", "flash", "shake", "number"];
// Looks an event may use that are drawn by another archetype.
export const ALIASES = { claw: "slash" };
export const ZONE_LOOKS = ["motes", "light", "cloud", "strands", "flame"];

// Built-in copies of palette.json and timing.json, used when the JSON can't be fetched.
// check_fx.mjs fails if they ever differ from the files.
export const PALETTE = {
  fire: ["#ff6a1a", "#fff0a0"], cold: ["#7fd4ff", "#ffffff"], lightning: ["#8fb8ff", "#ffffff"],
  thunder: ["#b9c8ff", "#ffffff"], acid: ["#7ddc1f", "#f2ffb0"], poison: ["#5fbf3a", "#c8ff9a"],
  necrotic: ["#6b2fa0", "#c9a3ff"], radiant: ["#ffd34d", "#fffbe6"], force: ["#b06cff", "#f4e6ff"],
  psychic: ["#ff5fd2", "#ffe0f6"], steel: ["#cfd8e3", "#ffffff"], heal: ["#5cff9d", "#fff6c2"],
  buff: ["#ffd76a", "#ffffff"], curse: ["#8a2be2", "#ff7bd5"], charm: ["#ff7bd5", "#ffe3f3"],
  earth: ["#a0743c", "#e8c48a"], plant: ["#4caf3a", "#c8f59a"], shadow: ["#3a2f4a", "#9a8cff"],
  faerie: ["#9f7bff", "#e9ddff"], shillelagh: ["#6fdc5a", "#e6ffd9"], down: ["#ff4d4d", "#ffd0d0"],
  arcane: ["#9a7bff", "#efe6ff"],
};
// The timing table is flat and all numbers, the same shape as fx_events.BUILTIN_TIMING (Python
// lays timing.json's numbers over its own copy, and T9's contract test asserts they're equal).
// A bolt's or an arrow's length depends on how far it flies: travel = per_cell × cells, clamped
// to travel_min..travel_max; a bolt then lingers `tail` ms, an arrow's travel is `hit` of it.
// `after` is how long after its impact a death or a number starts (Python uses it).
export const TIMING = {
  bolt: { per_cell: 45, travel_min: 250, travel_max: 500, tail: 300 },
  ray: { dur: 900, hit: 0.18, stagger: 120 },
  arrow: { per_cell: 35, travel_min: 250, travel_max: 550, hit: 0.75, thrown: 1.1 },
  burst: { dur: 1400, hit: 0.02, small_dur: 900 },
  cone: { dur: 1100, hit: 0.25 },
  line: { dur: 800, hit: 0.05 },
  cube: { dur: 1000, hit: 0.1 },
  glow: { dur: 1100, hit: 0.2 },
  smite: { dur: 750, hit: 0.03 },
  sparkle: { dur: 1000, hit: 0.15 },
  slash: { dur: 450, hit: 0.25 },
  thrust: { dur: 450, hit: 0.3 },
  smash: { dur: 450, hit: 0.25 },
  bite: { dur: 500, hit: 0.3 },
  impact: { dur: 350, hit: 0 },
  resist: { dur: 600, hit: 0.1 },
  death: { dur: 1200, hit: 0.5, after: 150 },
  number: { dur: 900, after: 50 },
  flash: { dur: 250 },
  shake: { dur: 350 },
  zone: { fade_in: 500, fade_out: 600 },
};

// The longest a part may run on a screen, whatever the event says: the screen-wide effects stay
// short (spec 11.1 and 11.6: shake 0.4 s at most), everything else 10 s.
export const MAX_DUR = { flash: 400, shake: 400 };
export const maxDur = (arch) => MAX_DUR[arch] ?? 10000;

// A travel part's flight time over `cells` cells, or null for an archetype that doesn't travel.
function travelMs(t, cells) {
  const per = Number(t.per_cell), lo = Number(t.travel_min), hi = Number(t.travel_max);
  if (!finite(per, lo, hi) || per <= 0) return null;
  return clamp(per * cells, lo, Math.max(lo, hi));
}

// A part's duration when the event leaves it out (Python normally sets it). Travel parts
// assume a 6-cell shot.
export function defaultDur(arch, timing = TIMING, cells = 6) {
  const t = timing[arch] || {};
  if (finite(t.dur) && t.dur > 0) return t.dur;
  const travel = travelMs(t, cells);
  if (travel != null) {
    if (finite(t.tail)) return travel + t.tail;
    return Math.round(travel / (finite(t.hit) && t.hit > 0 ? t.hit : 0.75));
  }
  return 1000;
}

export function defaultHit(arch, timing = TIMING, cells = 6) {
  const t = timing[arch] || {};
  if (finite(t.hit)) return t.hit;
  const travel = travelMs(t, cells);
  if (travel != null && finite(t.tail)) return travel / (travel + t.tail);
  return 0.25;
}

// "#ff6a1a" -> {x, y, z} in 0..1.
export function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { x: ((n >> 16) & 255) / 255, y: ((n >> 8) & 255) / 255, z: (n & 255) / 255 };
}

// A palette word or "#rrggbb" -> {colA, colB, hexA, hexB}. A plain hex gets a light partner.
export function colors(color, palette = PALETTE, fallback = "arcane") {
  let pair = palette[color];
  if (!pair && rgb(color)) {
    const a = rgb(color);
    const b = { x: a.x + (1 - a.x) * 0.7, y: a.y + (1 - a.y) * 0.7, z: a.z + (1 - a.z) * 0.7 };
    const hex = (c) => "#" + [c.x, c.y, c.z].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    pair = [hex(a), hex(b)];
  }
  if (!pair) pair = palette[fallback] || PALETTE[fallback] || PALETTE.arcane;
  return { colA: rgb(pair[0]), colB: rgb(pair[1]), hexA: pair[0], hexB: pair[1] };
}

// Per archetype: the colour when the part names none, the layer and effect type, the default
// for every shader uniform it declares beyond the shared ones, and how expendable it is when a
// screen is over its live-effect budget (lower goes first: sparkle, then resist, then impacts).
export const SPEC = {
  bolt: { color: "fire", params: { hit: 0.6, wobble: 0, miss: 0 }, rank: 5 },
  ray: { color: "force", params: { hit: 0.18, crackle: 0.6, miss: 0 }, rank: 5 },
  arrow: { color: "steel", params: { hit: 0.75, spin: 0, miss: 0 }, rank: 5 },
  burst: { color: "fire", params: { smoke: 0.6, shock: 0.5, ring_only: 0 }, rank: 6 },
  cone: { color: "fire", params: { jet: 0.3 }, rank: 6 },
  line: { color: "lightning", params: { jag: 1, strobes: 3 }, rank: 6 },
  cube: { color: "arcane", params: { shock: 0.5, sparkle: 0 }, rank: 6 },
  glow: { color: "heal", params: { ring_dir: 1, motes: 0.6 }, rank: 4 },
  smite: { color: "radiant", params: { rays: 8, flare: 0.6 }, rank: 5 },
  sparkle: { color: "arcane", params: { dens: 1 }, rank: 0 },
  slash: { color: "steel", params: { claws: 1 }, rank: 5 },
  thrust: { color: "steel", params: {}, rank: 5 },
  smash: { color: "steel", params: {}, rank: 5 },
  bite: { color: "steel", params: {}, rank: 5 },
  impact: { color: "steel", params: { dirv: { x: 0, y: 0 }, strength: 1 }, rank: 2 },
  resist: { color: "arcane", params: { dirv: { x: 0, y: 0 } }, rank: 1 },
  death: { color: "down", params: { beats: 0, smoke: 1 }, rank: 7 },
  flash: { color: "fire", params: { amt: 0.25 }, rank: 3, viewport: true, layer: "RULER" },
  shake: { color: "steel", params: { amp: 10 }, rank: 3, viewport: true, layer: "POST_PROCESS" },
};

const sizeOf = (fp) => (fp ? Math.max(fp.w || 0, fp.h || 0) : 0);
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "boolean" ? (v ? 1 : 0) : d);

// The pixels a burst's radius covers: an explicit radius in the part, else the template it sits
// on, else a token-sized puff. An emanation (a template shape "emanation", or a part marked
// grow_by_caster, which is how fx_events sends one with its radius) reaches from the caster's
// edge, so it grows by the caster's half-size: the caster's footprint from the template, else
// the token the burst sits on.
function burstRadiusPx(part, a, G) {
  const p = part.params || {};
  const t = a.template;
  const onTemplate = !!(part.at?.template && t);
  const grows = num(p.grow_by_caster, 0) > 0 || (onTemplate && t.shape === "emanation");
  const casterHalf = () => (grows ? sizeOf(t?.casterFp || (part.at?.token != null ? a.at : null)) / 2 : 0);
  const ft = num(p.r_ft, num(p.radius_ft, num(p.ping_ft, num(p.size_ft, null))));
  if (ft != null && ft > 0) return ft * G.pxPerFt + casterHalf();
  if (onTemplate && finite(t.size_ft)) {
    if (t.shape === "cube" || t.shape === "square") return (t.size_ft * G.pxPerFt) / 2;
    if (t.shape === "cone" || t.shape === "line") return (t.size_ft * G.pxPerFt) / 2;
    return t.size_ft * G.pxPerFt + casterHalf();
  }
  if (a.at && a.at.w) return Math.max(sizeOf(a.at) * 0.75, G.dpi * 0.5);
  return G.dpi;
}

// A travel strip from one footprint to another: starts at the caster's edge, ends at the
// target's middle (a template point exactly), `extra` cells further on for a miss.
function strip(from, to, H, G, extra = 0) {
  if (!from || !to) return null;
  const d = dist(from, to);
  if (!(d > G.dpi * 0.25)) return null;
  const ux = (to.x - from.x) / d, uy = (to.y - from.y) / d;
  const startOff = Math.min(sizeOf(from) * 0.35, d * 0.4);
  const endOff = to.w ? Math.min(sizeOf(to) * 0.15, d * 0.2) : 0;
  const start = { x: from.x + ux * startOff, y: from.y + uy * startOff };
  const end = { x: to.x - ux * endOff + ux * extra * G.dpi, y: to.y - uy * endOff + uy * extra * G.dpi };
  const L = dist(start, end);
  const rot = angleOf(start, end);
  const w = L + H;
  return { w, h: H, rot, position: placeRect(w, H, start, rot, { x: H / 2, y: H / 2 }), cells: L / G.dpi };
}

// Does this part sit on the event's template? (Anchored on it, or not anchored at all.)
const usesTemplate = (part) => !!part.at?.template || (!part.at && !part.from);

function centred(c, S, rot = 0) {
  if (!c) return null;
  return { w: S, h: S, rot, position: placeRect(S, S, c, rot) };
}

// The direction a blow or a spell came from, for impact (travel direction) and resist (facing).
function sourceOf(part, a) {
  const p = part.params || {};
  if (p.from && finite(p.from.x, p.from.y)) return p.from;
  if (a.from) return a.from;
  return null;
}

// One part -> {w, h, rot, position, uniforms} for a STANDALONE effect, {viewport: true, ...}
// for a full-screen one, or null to skip it. `a` holds the resolved anchors ({at, from, to}
// as footprints {x, y, w, h}, plus `template` with its origin and the caster's footprint).
export function hostFor(arch, part, a, G) {
  const p = part.params || {};
  const u = {};
  switch (arch) {
    case "bolt": case "ray": case "arrow": {
      const miss = num(p.miss, 0) > 0 || num(p.over, 0) > 0 ? 1 : 0;
      const extra = miss ? Math.max(num(p.over, 0), 1.2) : 0;
      const H = G.dpi * (arch === "arrow" ? 0.6 : 1.0);
      const s = strip(a.from, a.to, H, G, extra);
      if (!s) return null;
      u.miss = miss;
      if (arch === "arrow") u.spin = num(p.spin, num(p.thrown, 0)) > 0 ? 1 : 0;
      return { ...s, uniforms: u };
    }
    case "burst": {
      const c = a.at;
      if (!c) return null;
      const R = burstRadiusPx(part, a, G);
      return { ...centred(c, 2.4 * R), uniforms: u };
    }
    // cone, line and cube take the event's template when they sit on it (at: {template: true},
    // or no anchor at all). Anchored anywhere else (fx_events draws a mob's second area at its
    // own origin as a point, while the event's template is the first one's), they use their
    // own params: length_ft / side_ft, width_ft and rot.
    case "cone": {
      const t = usesTemplate(part) ? a.template : null;
      let apex = t?.origin, rot = t?.rot ?? num(p.rot, 0);
      let L = finite(t?.size_ft) ? t.size_ft * G.pxPerFt : null;
      if (!apex && a.from && (a.to || a.at)) { apex = a.from; rot = angleOf(a.from, a.to || a.at); }
      if (!apex) apex = a.at;
      if (!apex) return null;
      if (!L) L = num(p.length_ft, num(p.len_ft, 15)) * G.pxPerFt;
      const S = 1.05 * L;
      return { w: S, h: S, rot, position: placeRect(S, S, apex, rot, { x: 0, y: S / 2 }), uniforms: u };
    }
    case "line": {
      const t = usesTemplate(part) ? a.template : null;
      let start = t?.origin, rot = t?.rot ?? num(p.rot, 0);
      let L = finite(t?.size_ft) ? t.size_ft * G.pxPerFt : null;
      if (!start && a.from && (a.to || a.at)) { start = a.from; rot = angleOf(a.from, a.to || a.at); L = L || dist(a.from, a.to || a.at); }
      if (!start) start = a.at;
      if (!start) return null;
      if (!L) L = num(p.length_ft, num(p.len_ft, 30)) * G.pxPerFt;
      const W = num(t?.width_ft, num(p.width_ft, 5)) * G.pxPerFt;
      const h = 2.2 * W;
      return { w: L, h, rot, position: placeRect(L, h, start, rot, { x: 0, y: h / 2 }), uniforms: u };
    }
    case "cube": {
      const t = usesTemplate(part) ? a.template : null;
      const c = t?.origin || a.at;
      if (!c) return null;
      const side = (finite(t?.size_ft) ? t.size_ft : num(p.side_ft, num(p.size_ft, 15))) * G.pxPerFt;
      return { ...centred(c, 1.15 * side, t?.rot ?? num(p.rot, 0)), uniforms: u };
    }
    case "glow": case "sparkle": case "death": case "resist": {
      const c = a.at;
      if (!c) return null;
      const k = { glow: 2.2, sparkle: 2.6, death: 2.6, resist: 2.4 }[arch];
      const S = k * Math.max(sizeOf(c), G.dpi * 0.8);
      if (arch === "resist") {
        const src = sourceOf(part, a);
        if (src && dist(src, c) > 1) u.dirv = { x: (src.x - c.x) / dist(src, c), y: (src.y - c.y) / dist(src, c) };
      }
      if (arch === "glow" && typeof p.ring_dir === "string") u.ring_dir = p.ring_dir === "in" ? -1 : 1;
      return { ...centred(c, S), uniforms: u };
    }
    case "smite": {
      const c = a.at;
      if (!c) return null;
      return { ...centred(c, Math.max(3 * G.dpi, 1.6 * sizeOf(c))), uniforms: u };
    }
    case "slash": case "thrust": case "smash": case "bite": {
      const c = a.at;
      if (!c) return null;
      const S = Math.max(1.8 * G.dpi, 1.25 * sizeOf(c));
      let rot = num(p.dir, null);
      const src = sourceOf(part, a);
      if (rot == null && src && dist(src, c) > 1) rot = angleOf(src, c);
      if (rot == null) rot = ((num(part._seed, 0) * 137) % 360) - 180;
      if (part.arch === "claw" || part._look === "claw") u.claws = 3;
      return { ...centred(c, S, rot), uniforms: u };
    }
    case "impact": {
      const c = a.at;
      if (!c) return null;
      const S = Math.max(2 * G.dpi, 1.3 * sizeOf(c));
      if (finite(p.dir)) u.dirv = rotate({ x: 1, y: 0 }, p.dir);
      else {
        const src = sourceOf(part, a);
        if (src && dist(src, c) > 1) u.dirv = { x: (c.x - src.x) / dist(src, c), y: (c.y - src.y) / dist(src, c) };
      }
      return { ...centred(c, S), uniforms: u };
    }
    case "flash": case "shake":
      return { viewport: true, uniforms: u };
    default:
      return null;
  }
}

// The uniform values for one effect at one moment: the shared ones, the archetype's defaults,
// the part's own params (numbers and booleans), then what the geometry worked out.
export function uniformValues(arch, part, hostUniforms, extra) {
  const spec = SPEC[arch] || { params: {} };
  const v = { ...spec.params };
  for (const [k, val] of Object.entries(part.params || {})) {
    if (typeof val === "number" || typeof val === "boolean") v[k] = val === true ? 1 : val === false ? 0 : val;
  }
  if (typeof part.hit === "number" && Number.isFinite(part.hit)) v.hit = part.hit;
  Object.assign(v, hostUniforms || {}, extra || {});
  return v;
}

// Preview sizes (in cells) and settings for the compile gate and the dev page.
export const PREVIEW = {
  bolt: { cells: [8, 1], color: "fire", params: { hit: 0.45, wobble: 0.3 }, power: 1.0 },
  ray: { cells: [8, 1], color: "force", params: { hit: 0.18, crackle: 0.6 } },
  arrow: { cells: [8, 0.6], color: "steel", params: { hit: 0.75 } },
  burst: { cells: [4.8, 4.8], color: "fire", params: { smoke: 0.7, shock: 0.5 }, power: 1.4 },
  cone: { cells: [6.3, 6.3], color: "cold", params: { jet: 0.4 } },
  line: { cells: [8, 2.2], color: "lightning", params: { jag: 1, strobes: 3 } },
  cube: { cells: [4.6, 4.6], color: "faerie", params: { shock: 0.5, sparkle: 1 } },
  glow: { cells: [2.2, 2.2], color: "heal", params: { ring_dir: 1, motes: 0.7 } },
  smite: { cells: [3, 3], color: "radiant", params: { rays: 8, flare: 0.6 } },
  sparkle: { cells: [2.6, 2.6], color: "arcane", params: { dens: 1 } },
  slash: { cells: [1.8, 1.8], color: "steel", params: { claws: 1 } },
  thrust: { cells: [1.8, 1.8], color: "steel", params: {} },
  smash: { cells: [1.8, 1.8], color: "shillelagh", params: {} },
  bite: { cells: [1.8, 1.8], color: "steel", params: {} },
  impact: { cells: [2, 2], color: "fire", params: { dirv: { x: 1, y: 0 }, strength: 1 } },
  resist: { cells: [2.4, 2.4], color: "radiant", params: { dirv: { x: -1, y: 0 } } },
  death: { cells: [2.6, 2.6], color: "down", params: { beats: 0, smoke: 1 } },
  flash: { cells: [4, 3], color: "fire", params: { amt: 0.25 } },
  shake: { cells: [4, 3], color: "steel", params: { amp: 10 } },
  "zone:motes": { cells: [6, 6], color: "radiant", params: { shape: 0, density: 0.8 } },
  "zone:light": { cells: [4, 4], color: "faerie", params: { shape: 1, density: 1 } },
  "zone:cloud": { cells: [6, 6], color: "poison", params: { shape: 0, density: 1 } },
  "zone:strands": { cells: [4, 4], color: "plant", params: { shape: 1, density: 1 } },
  "zone:flame": { cells: [3, 3], color: "fire", params: { shape: 1, density: 1 } },
};
