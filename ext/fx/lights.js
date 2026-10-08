// Flickering flames and a darkvision that leaves other people's light in colour.
// Pure strings and tables, no Owlbear import, so the dev bench (owlbear/dev/lights.html) and
// the offline checks load it too. The shaders keep fx/shaders.js's rules (lint() there).
//
// A flame is one STANDALONE effect, a square two reaches wide centred on the light, drawn with
// blend mode FLAME_BLEND: its colour is a light map where 0.5 grey leaves the map as painted,
// brighter warms and lifts it, darker dims it. Smoke & Spectre still decides what's revealed;
// the flame only changes how the revealed part looks. Owlbear supplies size and time; the rest
// come from LOOKS below (one SkSL string for every look, so it's built once). A flame stops at
// walls: up to WALL_SLOTS segments in its uniforms, and no light in their shadows.
//
// Darkvision is ours on every screen (Smoke draws no ring for a token we manage): one grey pass
// and one dim pass over every public seer's band, leaving every public light and every seer's
// own sight in colour (darkvisionPlan, darkvisionShader below).

import { CLOCK, CLOCK_STATIC, HELPERS } from "./shaders.js?v=585985a-dc1dbb6";

// D&D light sources: bright and dim reach in feet, and the look that draws them (5e PHB/SRD
// numbers; the brazier is a house number, like a torch).
export const SOURCES = {
  candle:          { label: "Candle",            bright: 5,  dim: 5,  look: "candle" },
  torch:           { label: "Torch",             bright: 20, dim: 20, look: "torch" },
  lamp:            { label: "Lamp",              bright: 15, dim: 30, look: "lantern" },
  hooded_lantern:  { label: "Hooded lantern",    bright: 30, dim: 30, look: "lantern" },
  brazier:         { label: "Campfire / brazier", bright: 20, dim: 20, look: "brazier" },
  light:           { label: "Light (cantrip)",   bright: 20, dim: 20, look: "magic" },
  continual_flame: { label: "Continual Flame",   bright: 20, dim: 20, look: "torch" },
  dancing_lights:  { label: "Dancing Lights",    bright: 0,  dim: 10, look: "magic" },
  produce_flame:   { label: "Produce Flame",     bright: 20, dim: 20, look: "torch" },
};

// How each look moves. colA is the light's colour, colB the flame's hot core.
//   amp    how hard it flickers (0 steady .. 0.15 restless)
//   rate   how fast (roughly flickers per second)
//   jitter how far the flame itself licks about, at most, in feet (0.2 at most). Only the flame
//          drawn at the light: the light it casts and its wall shadows never move, they're
//          always centred on the token (a light that wandered read as "a dancing light", not
//          a torch; there's no sway any more)
//   core   the flame's own size in squares
//   sparks 0 none, 1 embers that drift off and die, 2 slow glowing motes
//   gutter 0..1: a candle's now-and-then dip
//   warm   how strongly the light tints the map
export const LOOKS = {
  candle:  { label: "Candle",  colA: [1.0, 0.80, 0.48], colB: [1.0, 0.95, 0.78], amp: 0.06, rate: 2.6, jitter: 0.06, core: 0.10, sparks: 0, gutter: 1.0, warm: 0.40 },
  torch:   { label: "Torch",   colA: [1.0, 0.72, 0.36], colB: [1.0, 0.86, 0.52], amp: 0.10, rate: 6.0, jitter: 0.15, core: 0.20, sparks: 0, gutter: 0.3, warm: 0.36 },
  lantern: { label: "Lantern", colA: [1.0, 0.76, 0.42], colB: [1.0, 0.93, 0.72], amp: 0.03, rate: 3.2, jitter: 0.0,  core: 0.14, sparks: 0, gutter: 0.0, warm: 0.34 },
  brazier: { label: "Brazier", colA: [1.0, 0.68, 0.26], colB: [1.0, 0.84, 0.44], amp: 0.11, rate: 4.2, jitter: 0.2,  core: 0.45, sparks: 1, gutter: 0.0, warm: 0.40 },
  magic:   { label: "Magic",   colA: [0.80, 0.92, 1.0], colB: [0.94, 0.98, 1.0], amp: 0.025, rate: 0.7, jitter: 0.0, core: 0.12, sparks: 2, gutter: 0.0, warm: 0.16 },
};

// The blend mode a flame is drawn with. OVERLAY multiplies the dark half of the map and
// screens the bright half, so black stays black (HARD_LIGHT lit up the empty void around a map).
export const FLAME_BLEND = "OVERLAY";

// Walls a flame stops at, each a segment in the flame's own square (see flameUniforms). Each is
// two float2 uniforms, one per end (wNa, wNb): Owlbear takes no float4 uniforms (a vec4 is refused
// by its validator, docs/spell-fx-probe-results.md P3).
export const WALL_SLOTS = 16;
const WALL_BLOCK = 4; // slots tested together in the shader (see wallBlocks)
// Overlapping lights don't add up (D&D: bright light is bright light; the user, 2026-10-08: "5
// torches together would not increase brightness, only spread coverage"). Each flame knows up to
// NEIGHBOUR_SLOTS other lights drawn on this screen whose reach overlaps its own (nbrN = their
// centre and reach in its own square's units, nbfN their bright fraction) and draws only where
// it's the strongest light (strength(): its base level, no flicker, the nearer one on a tie in
// the dim light), so each pixel gets exactly one light and one flicker. A neighbour behind one
// of this flame's walls doesn't count there. The hand-over is a narrow cross-fade (STRENGTH_EDGE).
export const NEIGHBOUR_SLOTS = 8;
const NB_BLOCK = 4;
// The cross-fade's half-width in strength: out in the dim light (where the strength only falls
// 0.02 across the reach) about 3 ft of a torch's light, inside the bright light a few pixels.
const STRENGTH_EDGE = "0.0015";

const FLAME_HEAD = `uniform float2 size;
uniform float time;
uniform float fade;
uniform float3 colA;
uniform float3 colB;
uniform float seed;
uniform float bright;
uniform float cell;
uniform float core;
uniform float amp;
uniform float rate;
uniform float jitter;
uniform float sparks;
uniform float gutter;
uniform float warm;
` + Array.from({ length: WALL_SLOTS }, (_, i) => `uniform float2 w${i}a;\nuniform float2 w${i}b;\n`).join("")
  + Array.from({ length: NEIGHBOUR_SLOTS }, (_, i) => `uniform float3 nbr${i};\nuniform float nbf${i};\n`).join("");

// p runs -1..1 across the square: length(p) = 1 is the end of the dim light.
//
// The flicker noise n1 is the same for every pixel (it only follows time and the seed), so it's
// kept cheap: smooth steps between random values along x, 2 hashes a call (a 2D value noise
// took 4). The 2D noise it replaces also blended two rows of values by where seed * 13.7 fell
// between them, which calmed each light's flicker by a factor from 0.71 to 1 (its root mean
// square); calm is that same factor, so every light flickers as hard as it did (the spread of a
// light's brightness over a minute, averaged over 12 seeds, moved by 2% at most for every look).
//
// wall() is one wall's shadow: 0 behind the wall and inside the lines from the flame through its
// two ends, 1 elsewhere. r is the pixel and a, b the wall's ends, all measured from the flame c,
// the light's centre, which never moves (so neither do the shadows). Its sides are soft by pen at
// the wall and softer further out (pen * the pixel's distance / the wall end's), the way a real
// flame's are; they grow outward from the shadow, so where two walls meet no light slips through
// the joint; ir is 1 / the pixel's distance from c. A wall of no length (an empty slot, all 0)
// blocks nothing: k is worked out from the wall's own length (wb - wa, exactly 0 there), so k, ea
// and eb are exactly 0 and nothing is past it. (Worked out as a.x * b.y - a.y * b.x, with a = b,
// it isn't always 0 on a GPU: one that fuses the multiply and subtract rounds only one of them,
// leaves a speck of a number, and the empty slots beside a real wall blacked out streaks of light.)
const FLAME_BODY = `float n1(float x, float k, float calm) {
  float i = floor(x);
  float f = fract(x);
  float s = seed * 13.7 + k;
  float v = mix(hash12(float2(i, s)), hash12(float2(i + 1.0, s)), f * f * (3.0 - 2.0 * f));
  return 0.5 + (v - 0.5) * calm;
}
float wall(float2 r, float2 c, float2 wa, float2 wb, float pen, float ir) {
  float2 a = wa - c;
  float2 b = wb - c;
  float2 e = wb - wa;
  // which way round the wall runs, seen from the flame (a x b, the same as a x e); then how far
  // the pixel is inside the line through each end (> 0 on the wall's side of both: in line with it)
  float k = a.x * e.y - a.y * e.x;
  float sk = sign(k);
  float ea = sk * (a.x * r.y - a.y * r.x);
  float eb = sk * (r.x * b.y - r.y * b.x);
  float inside = smoothstep(-pen, 0.0, min(ea, eb) * ir);
  // ...and past the wall's line, on the far side from the flame
  float past = 1.0 - step(ea + eb - abs(k), 0.0);
  return 1.0 - inside * past;
}
// A light's level as painted (no flicker) at d (its own reach = 1) with bright fraction bf, and
// how strong it is there: the level, then the nearer (relatively) on a tie, out in the dim light.
float baseLevel(float d, float bf) {
  float b = max(bf, 0.001);
  return 0.5 + 0.09 * (1.0 - smoothstep(b * 0.75, b * 1.1, d)) + 0.07 * (1.0 - smoothstep(0.0, b, d));
}
float strength(float d, float bf) { return baseLevel(d, bf) + 0.02 * (1.0 - d); }
// 1 where a light at cn reaches p past this flame's walls, 0 behind one of them.
float seen(float2 p, float2 cn, float pen) {
  float2 r = p - cn;
  float ir = 1.0 / max(length(r), 0.0001);
  float v = 1.0;
` + wallBlocks((i) => `v *= wall(r, cn, w${i}a, w${i}b, pen, ir);`) + `  return v;
}
// A neighbour's strength at p (-1: out of its reach, an empty slot, or weaker than self by more
// than the cross-fade), less 1 behind a wall (so it never wins there).
float rival(float2 p, float3 n, float nbright, float self, float pen) {
  if (n.z <= 0.0) { return -1.0; }
  float dn = length(p - n.xy) / n.z;
  if (dn >= 1.0) { return -1.0; }
  float s = strength(dn, nbright);
  if (s < self - ${STRENGTH_EDGE}) { return -1.0; }
  return s - (1.0 - seen(p, n.xy, pen));
}
half4 main(float2 coord) {
  float2 p = (coord - size * 0.5) / (size.x * 0.5);
  float lp = length(p);
  // the square's corners, past the end of the dim light: nothing to draw
  if (lp >= 1.0) { return outp(float3(0.0), 0.0); }
  float t = tnow();
  float sf = fract(seed * 13.7);
  float su = sf * sf * (3.0 - 2.0 * sf);
  float calm = sqrt(1.0 - 2.0 * su * (1.0 - su));
  // the flicker: two octaves of noise and a fast shiver, about -1..1
  float f = (n1(t * rate, 0.0, calm) - 0.5) * 1.4 + (n1(t * rate * 2.7, 17.0, calm) - 0.5) * 0.7
          + 0.25 * sin(t * rate * 5.3 + seed * 3.0);
  // now and then a candle gutters: a short dip
  float g = gutter * ramp(n1(t * 0.31, 40.0, calm), 0.70, 0.86);
  float fl = clamp(f * amp - g * 0.22, -0.5, 0.5);
  // the light's centre is the token's, always: the light and its wall shadows never move (a fire
  // that wandered read as "a dancing light"); only its edge breathes a little with the flicker
  float2 c = float2(0.0);
  float2 pc = p - c;
  float dc = length(pc);
  float d = dc / (1.0 + fl * 0.1);
  // brightness: lifted inside the bright light, the map as painted from its edge out to the end
  // of the dim light, and never darker than that (0.5, the map as painted under OVERLAY): a
  // flame's dim light would otherwise dim whatever another light lit there, and a light that
  // flickers down, or gutters, only shrinks back to the map as painted
  float b = max(bright, 0.001);
  float level = 0.5 + 0.09 * (1.0 - smoothstep(b * 0.75, b * 1.1, d))
                    + 0.07 * (1.0 - smoothstep(0.0, b, d));
  // (gentle across the room: the light covers the whole table on the projector, so its
  // brightness stays well inside the 10% swing that counts as a flash; the flame itself
  // flickers harder)
  level = max(level + fl * (0.45 - 0.25 * clamp(d, 0.0, 1.0)), 0.5);
  // the light's colour, strongest near the flame
  float3 tint = colA - float3(dot(colA, float3(0.3333)));
  float3 src = float3(level) + tint * warm * (1.15 - 0.6 * clamp(d, 0.0, 1.0));
  // the flame itself, pulsing with the flicker and licking about a little: jitter (at most 0.2
  // ft) moves this flame only, never the light around it or its shadows
  float cr = max(core * cell, 0.002);
  float2 lick = jitter * 1.4142 * float2(n1(t * rate * 0.8, 5.0, calm) - 0.5, n1(t * rate * 0.8, 9.0, calm) - 0.5);
  float cd = length(p - lick) / cr;
  float flame = exp(-cd * cd * 1.6) * (0.8 + 0.2 * clamp(f, -1.0, 1.0));
  src = mix(src, colB, clamp(flame, 0.0, 1.0) * 0.95);
  // embers (sparks = 1) drift away from the fire and die; motes (sparks = 2) circle slowly
  // (only for looks that have them, and only near the flame: an ember never gets further from
  // it than 3.9 times the flame's own size, a mote 3.65 squares, and a pixel 3 glow-widths past
  // that would get less than e^-9 of any of them, so the loop is skipped there)
  float sp = 0.0;
  float sparkR = mix(cr * 3.9 + cell * 0.11, cell * 3.85, step(1.5, sparks));
  if (sparks > 0.5 && dc < sparkR) {
    float ember = 1.0 - step(1.5, sparks);
    float mote = step(1.5, sparks);
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      float h = hash12(float2(fi * 1.7, seed + 2.0));
      float ph = fract(t * (0.22 + 0.3 * h) + h * 7.0);
      float a0 = 6.2832 * hash12(float2(fi + 3.1, seed + 1.0));
      float re = cr * (0.7 + ph * 3.2);
      float rm = cell * (1.0 + 2.5 * h) + 0.15 * cell * sin(t * 0.9 + fi);
      float r = ember * re + mote * rm;
      float a = a0 + ember * 0.6 * sin(ph * 3.0 + fi) + mote * t * (0.12 + 0.1 * h);
      float2 q = c + r * float2(cos(a), sin(a));
      float life = ember * (1.0 - ph) * ramp(ph, 0.0, 0.06) + mote * (0.55 + 0.45 * sin(t * (1.1 + h) + fi * 2.0));
      float dd = length(p - q) / (cell * (0.035 + 0.03 * mote));
      sp += exp(-dd * dd) * life;
    }
  }
  src = mix(src, colB, clamp(sp, 0.0, 1.0));
  // (gone by the edge of the square whatever the flicker does: Owlbear cuts the effect off
  // there, and a light that breathed past it would end in a straight line)
  float alpha = (1.0 - smoothstep(0.9, 1.0, d)) * (1.0 - smoothstep(0.94, 1.0, lp));
  // no light in a wall's shadow (the flame's own glow and sparks included)
  float ir = 1.0 / max(dc, 0.0001);
  float pen = cr * 0.35;
  float lit = 1.0;
` + wallBlocks((i) => `lit *= wall(pc, c, w${i}a, w${i}b, pen, ir);`) + `  // only where this light is the strongest one here (overlapping lights never add up)
  float self = strength(dc, bright);
  float best = -1.0;
` + neighbourBlocks() + `  float mine = smoothstep(-${STRENGTH_EDGE}, ${STRENGTH_EDGE}, self - best);
  return outp(clamp(src, float3(0.0), float3(1.0)), alpha * lit * mine);
}
`;

// The wall tests, WALL_BLOCK slots at a time, each block only when its first slot holds a wall
// (flameUniforms fills the slots in order, so an empty one means none after it either), nested.
// A GPU skips a whole block on that test: with an "if" per wall it may work out every wall
// anyway (ANGLE on Direct3D did: 16 empty slots cost as much as the rest of the flame), and
// SkSL can't nest 16 deep.
function wallBlocks(stmt) {
  let s = "", close = "";
  for (let j = 0; j < WALL_SLOTS; j += WALL_BLOCK) {
    const pad = "  ".repeat(1 + j / WALL_BLOCK);
    s += `${pad}if (w${j}a.x != w${j}b.x || w${j}a.y != w${j}b.y) {\n`;
    for (let i = j; i < Math.min(j + WALL_BLOCK, WALL_SLOTS); i++) s += `${pad}  ${stmt(i)}\n`;
    close = `${pad}}\n` + close;
  }
  return s + close;
}
// The neighbour tests the same way (slots fill in order: an empty one means none after it).
function neighbourBlocks() {
  let s = "", close = "";
  for (let j = 0; j < NEIGHBOUR_SLOTS; j += NB_BLOCK) {
    const pad = "  ".repeat(1 + j / NB_BLOCK);
    s += `${pad}if (nbr${j}.z > 0.0) {\n`;
    for (let i = j; i < Math.min(j + NB_BLOCK, NEIGHBOUR_SLOTS); i++) s += `${pad}  best = max(best, rival(p, nbr${i}, nbf${i}, self, pen));\n`;
    close = `${pad}}\n` + close;
  }
  return s + close;
}

// "full" flickers (Owlbear redraws it every frame while it's on the map); "lite" is a still
// picture of the same light (no time uniform, so Owlbear only draws it when something moves),
// for phones and slow screens.
const flameSrc = {};
export function flameShader(tier = "full") {
  const lite = tier === "lite";
  const key = lite ? "lite" : "full";
  if (!flameSrc[key]) {
    flameSrc[key] = lite
      ? FLAME_HEAD.replace("uniform float time;\n", "") + CLOCK_STATIC + HELPERS + FLAME_BODY
      : FLAME_HEAD + CLOCK + HELPERS + FLAME_BODY;
  }
  return flameSrc[key];
}

// The uniform values for one light: a source ("torch") or a look name, and how many feet one
// square is. The effect is (bright + dim) * 2 feet wide. ampScale scales how hard it flickers
// (1 = the look's own; less where flames overlap, so their flicker doesn't add up). walls are
// the segments it stops at, [x1, y1, x2, y2] each in the flame's own square: p = (point - light)
// / (half the square's width), so -1..1 across it with the light at 0, 0 (see wallSlots).
//
// jitter goes in the flame's own square too (feet / the reach), at most 0.2 ft. It moves only
// the flame drawn at the light, and that is in the walls' shadows like everything else, so even a
// torch right against a wall (a sconce) can't lick past it, and the walls stay exactly where they
// are. (Moving a wall back instead opened a gap where two walls meet, a torch in a room's corner,
// and its light shone out through it.)
const MAX_JITTER_FT = 0.2;
//
// neighbours: the other lights drawn on this screen whose reach overlaps this one's, as
// [{dx, dy, kind}] (feet from this light, a SOURCES kind); the nearest NEIGHBOUR_SLOTS (by how far
// their light's edge is) are kept. This flame draws only where it's the strongest of them.
export function flameUniforms(kind, { seed = 1.3, ftPerCell = 5, fade = 1, ampScale = 1, walls = [], neighbours = [] } = {}) {
  const s = SOURCES[kind] || { bright: 20, dim: 20, look: kind };
  const L = LOOKS[s.look] || LOOKS.torch;
  const reach = s.bright + s.dim;
  const scale = Number.isFinite(ampScale) ? Math.max(0, ampScale) : 1;
  const jitterFt = Math.min(Math.max(0, L.jitter || 0), MAX_JITTER_FT);
  return {
    fade, seed, colA: L.colA, colB: L.colB,
    bright: reach > 0 ? s.bright / reach : 0,
    cell: reach > 0 ? ftPerCell / reach : 1,
    core: L.core, amp: L.amp * scale, rate: L.rate, jitter: reach > 0 ? jitterFt / reach : 0,
    sparks: L.sparks, gutter: L.gutter, warm: L.warm,
    ...wallSlots(walls),
    ...neighbourSlots(reach, neighbours),
  };
}

// The neighbour slots' values: nbrN = (dx, dy, its reach) in this flame's square (this reach = 1),
// nbfN = its bright fraction; the rest 0 (none). Only lights whose reach overlaps this one's.
function neighbourSlots(reach, list) {
  const near = [];
  for (const n of Array.isArray(list) ? list : []) {
    const src = n && SOURCES[n.kind];
    if (!src || !(reach > 0) || !Number.isFinite(n.dx) || !Number.isFinite(n.dy)) continue;
    const r = src.bright + src.dim;
    const d = Math.hypot(n.dx, n.dy);
    if (!(r > 0) || d >= reach + r) continue;
    near.push({ x: n.dx / reach, y: n.dy / reach, r: r / reach, bf: src.bright / r, gap: d - r });
  }
  near.sort((a, b) => a.gap - b.gap);
  const out = {};
  for (let i = 0; i < NEIGHBOUR_SLOTS; i++) {
    const n = near[i];
    out[`nbr${i}`] = n ? [n.x, n.y, n.r] : [0, 0, 0];
    out[`nbf${i}`] = n ? n.bf : 0;
  }
  return out;
}

// The wall slots' values: w0a, w0b (the two ends) ... for WALL_SLOTS walls, the rest 0, 0 (no
// wall). Only a wall that comes into the lit disc counts (one further out can't shade anything
// the flame lights), the nearest first when there are more than the slots, each as given. A wall
// right through the light's centre has no far side and blocks nothing; anything that isn't four
// finite numbers, or has no length, is left out too.
function wallSlots(walls) {
  const near = [];
  for (const w of Array.isArray(walls) ? walls : []) {
    if (!w || typeof w.length !== "number" || w.length < 4) continue;
    const [x1, y1, x2, y2] = [w[0], w[1], w[2], w[3]];
    if (![x1, y1, x2, y2].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    if (!(len2 > 0)) continue;
    // how far the wall's nearest point is from the light
    const t = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2));
    const d = Math.hypot(x1 + t * dx, y1 + t * dy);
    if (d >= 1 || d < 1e-6) continue;
    near.push({ w: [x1, y1, x2, y2], d });
  }
  near.sort((a, b) => a.d - b.d);
  const uniforms = {};
  for (let i = 0; i < WALL_SLOTS; i++) {
    const w = near[i]?.w || [0, 0, 0, 0];
    uniforms[`w${i}a`] = [w[0], w[1]];
    uniforms[`w${i}b`] = [w[2], w[3]];
  }
  return uniforms;
}

// ---- darkvision (drawn by us on every screen; Smoke draws no ring for a token we manage) ----
//
// One shader, drawn twice per screen over the box around every public seer's darkvision: once
// with blend SATURATION and tone 0.5 (grey: the map keeps its brightness, loses its colour),
// once with blend MULTIPLY and tone = the screen's dim (darker). Both read the same mask, the
// max over every band, so where two bands overlap nothing is greyed or dimmed twice.
// A pixel is darkvision (grey and dim) when it's inside some seer's band (clear < d <= dark,
// clear = max(its sight, its own light's reach)) and inside no colour circle (a public light's
// whole reach, a public seer's own sight). No wall test (accepted: a torch's colour shows
// through a wall inside a band).
//
// Uniforms, in scene pixels from the box's top-left corner (Owlbear takes no float4):
//   box       the box's width and height (coord is scaled from `size` to it)
//   soft      the edge's width: grey fades in over `soft` OUTSIDE each lit circle and outside
//             a seer's clear disc, and out over `soft` past its darkvision (a lit pixel is
//             never grey, not even a little)
//   tone      the colour drawn: 0.5 for the grey pass, the dim for the multiply pass
//   sNp sNr   seer N's centre, and (clear, dark); an empty slot is (0, 0)
//   cN        colour circle N (x, y, radius); radius 0 is an empty slot, and slots fill in order
export const DV_SEERS = 8;
export const DV_CIRCLES = 32;
const DV_BLOCK = 8; // circle slots tested together (see darkvisionShader)
export const DV_SOFT_FT = 1;
// How dark the band is on each kind of screen (MULTIPLY: 1 = as painted). The user, 2026-10-08:
// "grey AND dim; the table about 0.55, GM screens grey but only a little dim (about 0.8)".
export const DV_DIM = { gm: 0.8, table: 0.55, touch: 0.55, other: 0.55 };
export const dimFor = (kind) => DV_DIM[kind] ?? DV_DIM.other;
export const DV_GREY = { blend: "SATURATION", tone: 0.5 };
export const DV_DARK_BLEND = "MULTIPLY";

const DV_HEAD = `uniform float2 size;
uniform float2 box;
uniform float soft;
uniform float tone;
` + Array.from({ length: DV_SEERS }, (_, i) => `uniform float2 s${i}p;\nuniform float2 s${i}r;\n`).join("")
  + Array.from({ length: DV_CIRCLES }, (_, i) => `uniform float3 c${i};\n`).join("");

// Circle tests DV_BLOCK at a time, each block only when its first slot holds a circle (slots
// fill in order), nested: a GPU then skips the empty ones for real (as the flame's walls).
function circleBlocks() {
  let s = "", close = "";
  for (let j = 0; j < DV_CIRCLES; j += DV_BLOCK) {
    const pad = "  ".repeat(1 + j / DV_BLOCK);
    s += `${pad}if (c${j}.z > 0.0) {\n`;
    for (let i = j; i < Math.min(j + DV_BLOCK, DV_CIRCLES); i++) s += `${pad}  a *= unlit(q, c${i});\n`;
    close = `${pad}}\n` + close;
  }
  return s + close;
}

const DV_BODY = `float band(float2 q, float2 sp, float2 sr) {
  if (sr.y <= sr.x) { return 0.0; }
  float d = length(q - sp);
  return smoothstep(sr.x, sr.x + soft, d) * (1.0 - smoothstep(sr.y, sr.y + soft, d));
}
float unlit(float2 q, float3 c) {
  if (c.z <= 0.0) { return 1.0; }
  return smoothstep(c.z, c.z + soft, length(q - c.xy));
}
half4 main(float2 coord) {
  float2 q = coord * (box / max(size, float2(1.0)));
  float a = 0.0;
` + Array.from({ length: DV_SEERS }, (_, i) => `  a = max(a, band(q, s${i}p, s${i}r));\n`).join("") + `  if (a <= 0.0) { return half4(0.0); }
` + circleBlocks() + `  a = clamp(a, 0.0, 1.0);
  return half4(half3(tone * a), half(a));
}
`;

const DV_SRC = DV_HEAD + DV_BODY;
// The first redo's band (a seer's own sight in colour, grey to its darkvision): what Smoke's own
// grey ring looks like, kept for the bench's "before" view (darkvisionPlan, greyLevel below).
export function ringShader() {
  return DV_SRC;
}

// ---- darkness comes from light (docs/lights-darkness-spec.md): the overlay every screen draws ----
//
// Each POINT is ☀ lit, 🌒 dim or 🌑 dark by the map under it (fx/darkness.js: the topmost marked
// map, else the scene's). One shader, drawn twice over the box around every dim/dark area: a grey
// pass (blend SATURATION) and a dim pass (blend MULTIPLY; its alpha is how much darker, its colour
// black, so the map ends up multiplied by `mult`). Per point:
//   lit: nothing.
//   dim: outside every light's reach, mult = lv.x (0.8 table, 0.9 GM); no grey.
//   dark: inside a light's reach, nothing (the flame's colour); else grey, and mult = lv.y (0.55
//     table, 0.8 GM) within some public seer's darkvision, else lv.z (black: 0 table, 0.35 GM).
//   a PC's own mini (a "self" disc, its drawn size): nothing, whatever the darkness (the players
//     always see their own minis; a monster or NPC in the dark stays in the black).
// Overlapping lights or seers never add up: one grey pass, one dim pass, each the max/min over all.
// Uniforms, in scene pixels from the box's top-left (Owlbear takes no float4):
//   box, soft (the fade OUTSIDE a light's reach and past a darkvision's), pass (0 grey, 1 dim),
//   lv (dim, darkvision, black multipliers), sdef (the scene's code: 0 lit, 1 dim, 2 dark),
//   rNa (x0, y0, code) rNb (x1, y1): a marked map, bottom first (the last one containing the point
//   wins); sN (x, y, darkvision radius): a public seer; cN (x, y, reach): a light; pcN (x, y,
//   radius): a PC's own mini. Empty slots are all 0; every list fills its slots in order.
export const DK_REGIONS = 12;
export const DK_SELVES = 8; // PCs' own minis kept clear (a party is 6 or so)
const DK_BLOCK = 4;
export const DK_LEVELS = { gm: { dim: 0.9, dv: 0.8, black: 0.35 }, other: { dim: 0.8, dv: 0.55, black: 0 } };
export const levelsFor = (kind) => (kind === "gm" ? DK_LEVELS.gm : DK_LEVELS.other);
export const CODE_NUM = { lit: 0, dim: 1, dark: 2 };

const DK_HEAD = `uniform float2 size;
uniform float2 box;
uniform float soft;
uniform float pass;
uniform float3 lv;
uniform float sdef;
` + Array.from({ length: DK_REGIONS }, (_, i) => `uniform float3 r${i}a;\nuniform float2 r${i}b;\n`).join("")
  + Array.from({ length: DV_SEERS }, (_, i) => `uniform float3 s${i};\n`).join("")
  + Array.from({ length: DV_CIRCLES }, (_, i) => `uniform float3 c${i};\n`).join("")
  + Array.from({ length: DK_SELVES }, (_, i) => `uniform float3 pc${i};\n`).join("");

// n slots, `per` at a time, each block only when its first slot is in use (slots fill in order).
function slotBlocks(n, per, used, stmt) {
  let s = "", close = "";
  for (let j = 0; j < n; j += per) {
    const pad = "  ".repeat(1 + j / per);
    s += `${pad}if (${used(j)}) {\n`;
    for (let i = j; i < Math.min(j + per, n); i++) s += `${pad}  ${stmt(i)}\n`;
    close = `${pad}}\n` + close;
  }
  return s + close;
}

const DK_BODY = `float inside(float2 q, float3 a, float2 b) {
  return step(a.x, q.x) * step(a.y, q.y) * (1.0 - step(b.x, q.x)) * (1.0 - step(b.y, q.y));
}
float unlit(float2 q, float3 c) {
  if (c.z <= 0.0) { return 1.0; }
  return smoothstep(c.z, c.z + soft, length(q - c.xy));
}
float sees(float2 q, float3 s) {
  if (s.z <= 0.0) { return 0.0; }
  return 1.0 - smoothstep(s.z, s.z + soft, length(q - s.xy));
}
half4 main(float2 coord) {
  float2 q = coord * (box / max(size, float2(1.0)));
  float code = sdef;
` + slotBlocks(DK_REGIONS, DK_BLOCK, (j) => `r${j}b.x > r${j}a.x`, (i) => `code = mix(code, r${i}a.z, inside(q, r${i}a, r${i}b));`)
  + `  if (code < 0.5) { return half4(0.0); }
  float u = 1.0;
` + slotBlocks(DV_CIRCLES, DV_BLOCK, (j) => `c${j}.z > 0.0`, (i) => `u *= unlit(q, c${i});`)
  + slotBlocks(DK_SELVES, DK_SELVES, (j) => `pc${j}.z > 0.0`, (i) => `u *= unlit(q, pc${i});`)
  + `  if (u <= 0.0) { return half4(0.0); }
  float g = 0.0;
  float m = lv.x;
  if (code > 1.5) {
    float v = 0.0;
` + slotBlocks(DV_SEERS, DV_SEERS, (j) => `s${j}.z > 0.0`, (i) => `v = max(v, sees(q, s${i}));`).replace(/^/gm, "  ")
  + `    g = u;
    m = mix(lv.z, lv.y, v);
  }
  if (pass < 0.5) { return half4(half3(0.5 * g), half(g)); }
  return half4(half3(0.0), half(clamp(u * (1.0 - m), 0.0, 1.0)));
}
`;
const DK_SRC = DK_HEAD + DK_BODY;
export function darknessShader() {
  return DK_SRC;
}
// Every screen's overlay (fx/lighting.js), and what the compile gate builds as "darkvision".
export const darkvisionShader = darknessShader;

// The shader in JS (the checks, the bench): at q (box pixels) -> {code, grey (0..1), mult (what
// the map is multiplied by), alpha (the dim pass's alpha = 1 - mult)}.
export function darknessLevel(q, values) {
  const soft = values.soft || 0;
  let code = +values.sdef || 0;
  for (let i = 0; i < DK_REGIONS; i++) {
    const [ax, ay, ac] = v2(values[`r${i}a`]);
    const [bx, by] = v2(values[`r${i}b`]);
    if (!(bx > ax)) {
      if (i % DK_BLOCK === 0) break;
      continue;
    }
    if (q.x >= ax && q.y >= ay && q.x < bx && q.y < by) code = ac;
  }
  const none = { code, grey: 0, mult: 1, alpha: 0 };
  if (code < 0.5) return none;
  let u = 1;
  for (let i = 0; i < DV_CIRCLES; i++) {
    const [x, y, r] = v2(values[`c${i}`]);
    if (!(r > 0)) {
      if (i % DV_BLOCK === 0) break;
      continue;
    }
    u *= sstep(r, r + soft, Math.hypot(q.x - x, q.y - y));
  }
  for (let i = 0; i < DK_SELVES; i++) {
    const [x, y, r] = v2(values[`pc${i}`]);
    if (!(r > 0)) {
      if (i === 0) break;
      continue;
    }
    u *= sstep(r, r + soft, Math.hypot(q.x - x, q.y - y));
  }
  if (u <= 0) return none;
  const [ld, lv, lb] = v2(values.lv);
  let g = 0, m = ld;
  if (code > 1.5) {
    let v = 0;
    for (let i = 0; i < DV_SEERS; i++) {
      const [x, y, r] = v2(values[`s${i}`]);
      if (!(r > 0)) {
        if (i === 0) break;
        continue;
      }
      v = Math.max(v, 1 - sstep(r, r + soft, Math.hypot(q.x - x, q.y - y)));
    }
    g = u;
    m = lb + (lv - lb) * v;
  }
  const alpha = Math.min(1, Math.max(0, u * (1 - m)));
  return { code, grey: g, mult: 1 - alpha, alpha };
}

// What one screen draws, from fx/darkness.js's regions and the lights and seers that count there:
//   regions {scene: "lit"|"dim"|"dark", rects: [{x0, y0, x1, y1, code}]} (scene px, bottom first)
//   extent  {x0, y0, x1, y1} | null: what a dim/dark SCENE's overlay covers (every map; else the tokens)
//   lights  [{id, x, y, reach}]  (reach in feet): every light that colours the dark on this screen
//   seers   [{id, x, y, dark, pc}] (dark in feet): every public seer with darkvision
//   selves  [{id, x, y, r}]   (r in scene px): every PC's own mini at its drawn size, kept clear
// opts {pxPerFt, softFt, quant, kind}. Returns null (nothing dim or dark anywhere), or
//   {box: {x, y, w, h}, values (every uniform but pass), regions, seers: [ids], circles,
//    selves: [ids], dropped: {regions, seers, circles, selves}}.
// Culled: a marked map that changes nothing (the scene's own code with nothing marked under it),
// lights that touch no dim/dark area (or sit inside another light), seers whose darkvision
// touches no dark area. Over the slots: the topmost maps; the PCs first, then the widest
// darkvision; the widest lights.
export function darknessPlan({ regions = {}, extent = null, lights = [], seers = [], selves = [] } = {}, { pxPerFt = 1, softFt = DV_SOFT_FT, quant = 1, kind = "other" } = {}) {
  const Q = (v) => Math.round(v / quant) * quant;
  const ok = (...v) => v.every((n) => typeof n === "number" && Number.isFinite(n));
  const soft = Math.max(0, softFt * pxPerFt);
  const sdef = CODE_NUM[regions.scene] ?? 0;
  const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  // the marked maps that change something, bottom first
  const all = (Array.isArray(regions.rects) ? regions.rects : [])
    .filter((r) => r && ok(r.x0, r.y0, r.x1, r.y1) && r.x1 > r.x0 && r.y1 > r.y0 && r.code in CODE_NUM);
  const useful = [];
  for (const r of all) {
    if (CODE_NUM[r.code] === sdef && !useful.some((o) => overlaps(o, r))) continue;
    useful.push(r);
  }
  const rects = useful.slice(-DK_REGIONS);
  // the box: every dim/dark map, and the whole extent in a dim/dark scene
  let b = null;
  const grow = (r) => { b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : { ...r }; };
  for (const r of rects) if (r.code !== "lit") grow(r);
  if (sdef > 0 && extent && ok(extent.x0, extent.y0, extent.x1, extent.y1)) grow(extent);
  if (!b || !(b.x1 > b.x0) || !(b.y1 > b.y0)) return null;
  const x0 = Math.floor(b.x0) - 1, y0 = Math.floor(b.y0) - 1, x1 = Math.ceil(b.x1) + 1, y1 = Math.ceil(b.y1) + 1;
  const boxR = { x0, y0, x1, y1 };
  // the dim/dark areas a light or a seer must touch to count
  const darkAreas = sdef === 2 ? [boxR] : rects.filter((r) => r.code === "dark");
  const anyAreas = sdef > 0 ? [boxR] : rects.filter((r) => r.code !== "lit");
  const touches = (x, y, r, areas) => areas.some((a) => x + r > a.x0 && x - r < a.x1 && y + r > a.y0 && y - r < a.y1);
  // lights: a pixel wider (a lit point stays lit however its centre was rounded)
  const cand = [];
  for (const l of lights) {
    if (!l || !ok(l.x, l.y) || !(+l.reach > 0)) continue;
    const c = { x: Q(l.x), y: Q(l.y), r: +l.reach * pxPerFt + quant };
    if (touches(c.x, c.y, c.r + soft, anyAreas)) cand.push(c);
  }
  const circles = cand.filter((c, i) => !cand.some((o, j) => j !== i
    && Math.hypot(c.x - o.x, c.y - o.y) + c.r <= o.r && (o.r > c.r || Math.hypot(c.x - o.x, c.y - o.y) > 0 || j < i)));
  const used = [...circles].sort((a, c) => c.r - a.r).slice(0, DV_CIRCLES);
  // seers with darkvision that reaches a dark area
  const sc = [];
  for (const s of seers) {
    if (!s || !ok(s.x, s.y) || !(+s.dark > 0)) continue;
    const r = +s.dark * pxPerFt;
    const x = Q(s.x), y = Q(s.y);
    if (touches(x, y, r + soft, darkAreas)) sc.push({ id: s.id, x, y, r, pc: !!s.pc });
  }
  sc.sort((a, c) => (a.pc !== c.pc ? (a.pc ? -1 : 1) : c.r - a.r));
  const kept = sc.slice(0, DV_SEERS);
  // PCs' own minis on a dim/dark area, a pixel wider (like a light); over the slots, by id (the
  // same ones whatever order the scene lists its items in)
  const own = [];
  for (const p of Array.isArray(selves) ? selves : []) {
    if (!p || !ok(p.x, p.y) || !(+p.r > 0)) continue;
    const c = { id: p.id, x: Q(p.x), y: Q(p.y), r: +p.r + quant };
    if (touches(c.x, c.y, c.r + soft, anyAreas)) own.push(c);
  }
  own.sort((a, c) => (String(a.id) < String(c.id) ? -1 : String(a.id) > String(c.id) ? 1 : 0));
  const selfKept = own.slice(0, DK_SELVES);
  const L = levelsFor(kind);
  const values = { box: [x1 - x0, y1 - y0], soft, lv: [L.dim, L.dv, L.black], sdef };
  for (let i = 0; i < DK_REGIONS; i++) {
    const r = rects[i];
    values[`r${i}a`] = r ? [r.x0 - x0, r.y0 - y0, CODE_NUM[r.code]] : [0, 0, 0];
    values[`r${i}b`] = r ? [r.x1 - x0, r.y1 - y0] : [0, 0];
  }
  for (let i = 0; i < DV_SEERS; i++) {
    const s = kept[i];
    values[`s${i}`] = s ? [s.x - x0, s.y - y0, s.r] : [0, 0, 0];
  }
  for (let i = 0; i < DV_CIRCLES; i++) {
    const c = used[i];
    values[`c${i}`] = c ? [c.x - x0, c.y - y0, c.r] : [0, 0, 0];
  }
  for (let i = 0; i < DK_SELVES; i++) {
    const p = selfKept[i];
    values[`pc${i}`] = p ? [p.x - x0, p.y - y0, p.r] : [0, 0, 0];
  }
  return {
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, values, regions: rects.length, seers: kept.map((s) => s.id), circles: used.length,
    selves: selfKept.map((p) => p.id),
    dropped: { regions: useful.length - rects.length, seers: sc.length - kept.length, circles: circles.length - used.length,
               selves: own.length - selfKept.length },
  };
}

const sstep = (e0, e1, x) => {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const v2 = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v.x, v.y, v.z] : [0, 0, 0]);

// The shader's mask in JS (for the checks and the bench): 0..1 grey at q, in the box's pixels.
// `values` as darkvisionPlan() gives them (or an Owlbear uniform list's values by name).
export function greyLevel(q, values) {
  const soft = values.soft || 0;
  let a = 0;
  for (let i = 0; i < DV_SEERS; i++) {
    const [px, py] = v2(values[`s${i}p`]);
    const [c, d] = v2(values[`s${i}r`]);
    if (!(d > c)) continue;
    const dist = Math.hypot(q.x - px, q.y - py);
    a = Math.max(a, sstep(c, c + soft, dist) * (1 - sstep(d, d + soft, dist)));
  }
  if (a <= 0) return 0;
  for (let i = 0; i < DV_CIRCLES; i++) {
    const [x, y, r] = v2(values[`c${i}`]);
    if (!(r > 0)) {
      if (i % DV_BLOCK === 0) break; // the shader skips the rest of the slots here too
      continue;
    }
    a *= sstep(r, r + soft, Math.hypot(q.x - x, q.y - y));
  }
  return Math.min(1, Math.max(0, a));
}

// What one screen draws for darkvision, from the public seers and lights in scene pixels:
//   seers  [{id, x, y, sight, dark, reach, pc}]  (sight, dark, reach: feet; reach = its own light)
//   lights [{id, x, y, reach}]                    (every public light, a seer's own included)
// Returns null (nothing to draw: no band anywhere), or
//   {box: {x, y, w, h}, values (every uniform but tone), seers: [ids drawn], circles: n,
//    dropped: {seers, circles}}
// Seers whose band is empty draw nothing; over DV_SEERS, the PCs first, then the biggest bands.
// Colour circles: every light's reach and every seer's sight; one that doesn't reach any drawn
// band, or sits inside another, is left out; over DV_CIRCLES, the ones that cover the most band
// first. `quant`: positions are rounded to it (px), so a token nudged by a hair writes nothing.
export function darkvisionPlan(seers = [], lights = [], { pxPerFt = 1, softFt = DV_SOFT_FT, quant = 1 } = {}) {
  const Q = (v) => Math.round(v / quant) * quant;
  const ok = (...v) => v.every((n) => typeof n === "number" && Number.isFinite(n));
  const soft = Math.max(0, softFt * pxPerFt);
  // (a seer's clear disc and every colour circle are drawn `quant` wider: a point the scene
  // calls lit stays in colour however its centre was rounded)
  const bands = [];
  for (const s of seers) {
    if (!s || !ok(s.x, s.y)) continue;
    const clear = Math.max(0, +s.sight || 0, +s.reach || 0) * pxPerFt + quant;
    const dark = Math.max(0, +s.dark || 0) * pxPerFt;
    if (!(dark > clear)) continue;
    bands.push({ id: s.id, x: Q(s.x), y: Q(s.y), clear, dark, pc: !!s.pc, area: dark * dark - clear * clear });
  }
  if (!bands.length) return null;
  bands.sort((a, b) => (a.pc !== b.pc ? (a.pc ? -1 : 1) : b.area - a.area));
  const kept = bands.slice(0, DV_SEERS);

  // the colour circles that reach a drawn band
  const cand = [];
  const add = (x, y, rFt) => {
    const r0 = Math.max(0, +rFt || 0) * pxPerFt;
    if (!(r0 > 0) || !ok(x, y)) return;
    const r = r0 + quant;
    const c = { x: Q(x), y: Q(y), r };
    if (kept.some((b) => {
      const d = Math.hypot(c.x - b.x, c.y - b.y);
      return d - c.r < b.dark + soft && d + c.r > b.clear;
    })) cand.push(c);
  };
  for (const l of lights) if (l) add(l.x, l.y, l.reach);
  for (const s of seers) if (s) add(s.x, s.y, s.sight);
  // ...not inside another (of two the same, the first stays)
  const circles = cand.filter((c, i) => !cand.some((o, j) => j !== i
    && Math.hypot(c.x - o.x, c.y - o.y) + c.r <= o.r && (o.r > c.r || Math.hypot(c.x - o.x, c.y - o.y) > 0 || j < i)));
  // the box: every drawn band, and the soft edge past it
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of kept) {
    x0 = Math.min(x0, b.x - b.dark - soft); y0 = Math.min(y0, b.y - b.dark - soft);
    x1 = Math.max(x1, b.x + b.dark + soft); y1 = Math.max(y1, b.y + b.dark + soft);
  }
  x0 = Math.floor(x0) - 1; y0 = Math.floor(y0) - 1; x1 = Math.ceil(x1) + 1; y1 = Math.ceil(y1) + 1;
  // over the slots: rank by how much band each covers (a 12 x 12 sample over where it meets
  // the box), the bigger circle first on a tie
  let ranked = circles;
  if (circles.length > DV_CIRCLES) {
    const inBand = (x, y) => kept.some((b) => { const d = Math.hypot(x - b.x, y - b.y); return d > b.clear && d <= b.dark; });
    const N = 12;
    for (const c of circles) {
      const ax = Math.max(x0, c.x - c.r), bx = Math.min(x1, c.x + c.r);
      const ay = Math.max(y0, c.y - c.r), by = Math.min(y1, c.y + c.r);
      let n = 0;
      if (bx > ax && by > ay) {
        const sx = (bx - ax) / N, sy = (by - ay) / N;
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            const x = ax + (i + 0.5) * sx, y = ay + (j + 0.5) * sy;
            if (Math.hypot(x - c.x, y - c.y) <= c.r && inBand(x, y)) n++;
          }
        }
        c.cover = n * sx * sy;
      } else c.cover = 0;
    }
    ranked = [...circles].sort((a, b) => b.cover - a.cover || b.r - a.r);
  }
  const used = ranked.slice(0, DV_CIRCLES);
  const values = { box: [x1 - x0, y1 - y0], soft };
  for (let i = 0; i < DV_SEERS; i++) {
    const b = kept[i];
    values[`s${i}p`] = b ? [b.x - x0, b.y - y0] : [0, 0];
    values[`s${i}r`] = b ? [b.clear, b.dark] : [0, 0];
  }
  for (let i = 0; i < DV_CIRCLES; i++) {
    const c = used[i];
    values[`c${i}`] = c ? [c.x - x0, c.y - y0, c.r] : [0, 0, 0];
  }
  return {
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, values, seers: kept.map((b) => b.id), circles: used.length,
    dropped: { seers: bands.length - kept.length, circles: circles.length - used.length },
  };
}
