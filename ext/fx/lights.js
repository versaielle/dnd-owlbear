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
// The darkvision ring replaces Smoke's own grey ring (an effect with blend mode SATURATION and
// a grey colour, so everything under it loses its colour). Smoke greys the whole ring from the
// token's own sight out to its darkvision range, even where another token's sight or a torch
// lights it. Ours takes up to 8 lit circles and leaves them in colour.

import { CLOCK, CLOCK_STATIC, HELPERS } from "./shaders.js?v=b6b85c2-d73ac97";

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
//   sway   how far the flame wanders, as a fraction of the reach (moves the shadows)
//   core   the flame's own size in squares
//   sparks 0 none, 1 embers that drift off and die, 2 slow glowing motes
//   gutter 0..1: a candle's now-and-then dip
//   warm   how strongly the light tints the map
export const LOOKS = {
  candle:  { label: "Candle",  colA: [1.0, 0.80, 0.48], colB: [1.0, 0.95, 0.78], amp: 0.06, rate: 2.6, sway: 0.012, core: 0.10, sparks: 0, gutter: 1.0, warm: 0.40 },
  torch:   { label: "Torch",   colA: [1.0, 0.80, 0.60], colB: [1.0, 0.90, 0.66], amp: 0.10, rate: 6.0, sway: 0.020, core: 0.20, sparks: 0, gutter: 0.3, warm: 0.36 },
  lantern: { label: "Lantern", colA: [1.0, 0.76, 0.42], colB: [1.0, 0.93, 0.72], amp: 0.03, rate: 3.2, sway: 0.004, core: 0.14, sparks: 0, gutter: 0.0, warm: 0.34 },
  brazier: { label: "Brazier", colA: [1.0, 0.68, 0.26], colB: [1.0, 0.84, 0.44], amp: 0.11, rate: 4.2, sway: 0.016, core: 0.45, sparks: 1, gutter: 0.0, warm: 0.40 },
  magic:   { label: "Magic",   colA: [0.80, 0.92, 1.0], colB: [0.94, 0.98, 1.0], amp: 0.025, rate: 0.7, sway: 0.0, core: 0.12, sparks: 2, gutter: 0.0, warm: 0.16 },
};

// The blend mode a flame is drawn with. OVERLAY multiplies the dark half of the map and
// screens the bright half, so black stays black (HARD_LIGHT lit up the empty void around a map).
export const FLAME_BLEND = "OVERLAY";

// Walls a flame stops at, each a segment in the flame's own square (see flameUniforms). Each is
// two float2 uniforms, one per end (wNa, wNb): Owlbear takes no float4 uniforms (a vec4 is refused
// by its validator, docs/spell-fx-probe-results.md P3).
export const WALL_SLOTS = 16;
const WALL_BLOCK = 4; // slots tested together in the shader (see wallBlocks)

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
uniform float sway;
uniform float sparks;
uniform float gutter;
uniform float warm;
` + Array.from({ length: WALL_SLOTS }, (_, i) => `uniform float2 w${i}a;\nuniform float2 w${i}b;\n`).join("");

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
// so the shadows sway a little with the flame (flameUniforms calms the sway of a light close to a
// wall, so it never swings across one and flips its shadow over). Its sides are soft by pen at
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
  // the flame wanders a little, and the light's edge breathes with it
  float2 c = sway * 2.0 * float2(n1(t * rate * 0.5, 5.0, calm) - 0.5, n1(t * rate * 0.5, 9.0, calm) - 0.5);
  float2 pc = p - c;
  float dc = length(pc);
  float d = dc / (1.0 + fl * 0.3);
  // brightness: lifted inside the bright light, the map as painted at its edge, dimmer out to
  // the end of the dim light
  float b = max(bright, 0.001);
  float level = 0.5 + 0.09 * (1.0 - smoothstep(b * 0.75, b * 1.1, d))
                    + 0.07 * (1.0 - smoothstep(0.0, b, d))
                    - 0.16 * smoothstep(b, 1.0, d);
  // (gentle across the room: the light covers the whole table on the projector, so its
  // brightness stays well inside the 10% swing that counts as a flash; the flame itself
  // flickers harder)
  level += fl * (0.45 - 0.25 * clamp(d, 0.0, 1.0));
  // the light's colour, strongest near the flame
  float3 tint = colA - float3(dot(colA, float3(0.3333)));
  float3 src = float3(level) + tint * warm * (1.15 - 0.6 * clamp(d, 0.0, 1.0));
  // the flame itself, pulsing with the flicker
  float cr = max(core * cell, 0.002);
  float cd = length(p - c * 1.5) / cr;
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
` + wallBlocks() + `  return outp(clamp(src, float3(0.0), float3(1.0)), alpha * lit);
}
`;

// The wall tests, WALL_BLOCK slots at a time, each block only when its first slot holds a wall
// (flameUniforms fills the slots in order, so an empty one means none after it either), nested.
// A GPU skips a whole block on that test: with an "if" per wall it may work out every wall
// anyway (ANGLE on Direct3D did: 16 empty slots cost as much as the rest of the flame), and
// SkSL can't nest 16 deep.
function wallBlocks() {
  let s = "", close = "";
  for (let j = 0; j < WALL_SLOTS; j += WALL_BLOCK) {
    const pad = "  ".repeat(1 + j / WALL_BLOCK);
    s += `${pad}if (w${j}a.x != w${j}b.x || w${j}a.y != w${j}b.y) {\n`;
    for (let i = j; i < Math.min(j + WALL_BLOCK, WALL_SLOTS); i++) s += `${pad}  lit *= wall(pc, c, w${i}a, w${i}b, pen, ir);\n`;
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
// Near a wall (a torch on a wall, a sconce) the flame sways less. Its centre swings up to about
// 1.4 * sway from the light and its core is drawn half as far again, so a sway of at most a
// third of the way to the nearest wall keeps both on the light's side: the light never swings
// across a wall and flips its shadow over with the flicker, and the walls stay exactly where
// they are. (Moving a wall back instead opened a gap where two walls meet, a torch in a room's
// corner, and its light shone out through it.)
const SWAY_ROOM = 3;
export function flameUniforms(kind, { seed = 1.3, ftPerCell = 5, fade = 1, ampScale = 1, walls = [] } = {}) {
  const s = SOURCES[kind] || { bright: 20, dim: 20, look: kind };
  const L = LOOKS[s.look] || LOOKS.torch;
  const reach = s.bright + s.dim;
  const scale = Number.isFinite(ampScale) ? Math.max(0, ampScale) : 1;
  const slots = wallSlots(walls);
  return {
    fade, seed, colA: L.colA, colB: L.colB,
    bright: reach > 0 ? s.bright / reach : 0,
    cell: reach > 0 ? ftPerCell / reach : 1,
    core: L.core, amp: L.amp * scale, rate: L.rate, sway: Math.min(L.sway, slots.nearest / SWAY_ROOM),
    sparks: L.sparks, gutter: L.gutter, warm: L.warm,
    ...slots.uniforms,
  };
}

// The wall slots' values: w0a, w0b (the two ends) ... for WALL_SLOTS walls, the rest 0, 0 (no
// wall), and how far the nearest is (Infinity for none). Only a wall that comes into the lit
// disc counts (one further out can't shade anything the flame lights), the nearest first when
// there are more than the slots, each as given. A wall right through the light's centre has no
// far side and blocks nothing; anything that isn't four finite numbers, or has no length, is
// left out too.
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
  return { uniforms, nearest: near.length ? near[0].d : Infinity };
}

// ---- darkvision ----

export const LIT_SLOTS = 8;

const DARK_HEAD = `uniform float2 size;
uniform float clear;
uniform float soft;
` + Array.from({ length: LIT_SLOTS }, (_, i) => `uniform float3 lit${i};\n`).join("");

// p runs -1..1 across the square: length(p) = 1 is the end of the darkvision. Each lit circle
// is (x, y, radius) in the same units; radius 0 is an empty slot.
const DARK_BODY = `float unlit(float2 p, float3 l) {
  if (l.z <= 0.0) { return 1.0; }
  return smoothstep(l.z - soft, l.z + soft, length(p - l.xy));
}
half4 main(float2 coord) {
  float2 p = (coord - size * 0.5) / (size.x * 0.5);
  float d = length(p);
  float a = smoothstep(clear, clear + soft, d) * (1.0 - step(1.0, d));
` + Array.from({ length: LIT_SLOTS }, (_, i) => `  a *= unlit(p, lit${i});\n`).join("") + `  return half4(half3(0.5 * a), half(a));
}
`;

export function darkvisionShader() {
  return DARK_HEAD + DARK_BODY;
}

// The uniforms for one token's ring: its own sight and darkvision in feet, and the lit circles
// near it as {dx, dy, r} in feet from the token (another token's sight, a flame's whole reach).
// The nearest LIT_SLOTS that touch the ring are kept.
export function darkvisionUniforms(sight, dark, lits = [], { softFt = 1.5 } = {}) {
  const R = Math.max(dark, 0.001);
  const touching = lits
    .map((l) => ({ ...l, gap: Math.hypot(l.dx, l.dy) - l.r }))
    .filter((l) => l.r > 0 && l.gap < R)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, LIT_SLOTS);
  const out = { clear: Math.max(0, sight) / R, soft: softFt / R };
  for (let i = 0; i < LIT_SLOTS; i++) {
    const l = touching[i];
    out[`lit${i}`] = l ? [l.dx / R, l.dy / R, l.r / R] : [0, 0, 0];
  }
  return out;
}
