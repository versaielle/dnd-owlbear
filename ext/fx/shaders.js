// The SkSL for every effect on the map: one shader per archetype (a Fireball's burst, a bolt,
// a sword's slash...) and one per living-zone look, each in a "full" and a "lite" version.
// Pure strings and string helpers, no Owlbear import, so the offline checks, the compile gate
// (tools/fx_harness/compile_shaders.mjs) and the dev page (owlbear/dev/shaders.html) load it too.
//
// Owlbear draws an effect item by running its shader for every pixel of the item's rectangle.
// `coord` is the pixel inside the rectangle (0..width, 0..height), `size` its width and height,
// `time` Owlbear's clock in seconds. Everything else is ours (the "custom uniforms"):
//   progress  0..1 through the effect (the engine's ticker moves it, 30 times a second)
//   fade      0..1 overall strength (0 while prewarming; zones fade in and out with it)
//   colA      the palette's main colour, used for the darker rim so it reads on a bright map
//   colB      the palette's bright colour, for the hot core
//   seed      a per-cast number, so two Fire Bolts don't look identical
//   power     0.5..1.5, how big the moment is (cantrip 0.6, Fireball 1.4)
//
// Rules every shader keeps (lint() below checks them, and the compile gate compiles each one):
//   - output is premultiplied, through outp()/outq(); float maths, half only at the return
//   - time only through tnow() (mod 600, so noise inputs stay small; static in lite zones)
//   - constant-bound for loops only; no while, %, bit ops, dFdx, fwidth, sk_FragCoord,
//     bool uniforms, #include or pow(); nothing shadows time or size
//   - per-cast numbers go in uniforms, never into the SkSL text (each string is built once)
// A missing uniform must never reach Owlbear (it would draw a black rectangle), so the engine
// fills every declared uniform (fillUniforms below) and warns about any it had to make up.

// Uniforms Owlbear itself supplies (never ours to send). `scene` is the post-process child.
export const BUILTIN = new Set(["size", "position", "scale", "rotation", "model", "view", "modelView", "time", "scene"]);

const HEAD = `uniform float2 size;
uniform float time;
uniform float progress;
uniform float fade;
uniform float3 colA;
uniform float3 colB;
uniform float seed;
uniform float power;
`;

// Lite zones are static pictures: no time uniform, so Owlbear doesn't redraw them every frame.
const HEAD_STATIC = HEAD.replace("uniform float time;\n", "");
const CLOCK = `float tnow() { return mod(time, 600.0); }
`;
const CLOCK_STATIC = `float tnow() { return 3.0 + seed * 0.37; }
`;

const HELPERS = `float hash12(float2 p) {
  float3 p3 = fract(float3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, float3(p3.y, p3.z, p3.x) + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + float2(1.0, 0.0));
  float c = hash12(i + float2(0.0, 1.0));
  float d = hash12(i + float2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm3(float2 p) {
  float v = 0.5 * vnoise(p);
  p = float2(1.6 * p.x + 1.2 * p.y, -1.2 * p.x + 1.6 * p.y) + 7.3;
  v += 0.25 * vnoise(p);
  p = float2(1.6 * p.x + 1.2 * p.y, -1.2 * p.x + 1.6 * p.y) + 3.1;
  v += 0.125 * vnoise(p);
  return v / 0.875;
}
float sfbm(float2 p) {
  float v = sin(p.x * 1.7 + sin(p.y * 1.3 + 0.4) * 1.1);
  v += sin(p.y * 1.9 + sin(p.x * 1.1 + 1.7) * 1.2);
  v += 0.6 * sin((p.x - p.y) * 2.3 + sin(p.x * 2.9 + p.y * 0.7) * 0.9);
  return v / 2.6;
}
float lfbm(float2 p) { return 0.5 + 0.5 * sfbm(p); }
float ramp(float x, float a, float b) { return clamp((x - a) / (b - a), 0.0, 1.0); }
float env(float t, float a, float b) { return ramp(t, 0.0, a) * (1.0 - ramp(t, b, 1.0)); }
float easeout(float x) { float y = clamp(x, 0.0, 1.0); return 1.0 - (1.0 - y) * (1.0 - y); }
float flick(float s) { float t = tnow(); return 0.85 + 0.15 * sin(t * 23.0 + s * 7.0) * sin(t * 13.0 + s * 3.0); }
float sdBox(float2 p, float2 b) { float2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float angle(float2 v) { return atan(v.y, v.x + 0.00001); }
float3 heat(float h) {
  float3 c = mix(colA * 0.42, colA, ramp(h, 0.0, 0.5));
  return mix(c, colB, ramp(h, 0.5, 1.0));
}
float4 lay(float4 acc, float3 c, float a) {
  float k = clamp(a, 0.0, 1.0);
  return float4(c * k + acc.rgb * (1.0 - k), k + acc.a * (1.0 - k));
}
half4 outq(float4 acc) {
  float k = clamp(fade, 0.0, 1.0);
  float a = clamp(acc.a, 0.0, 1.0);
  float3 c = clamp(acc.rgb, float3(0.0), float3(a));
  return half4(half3(c * k), half(a * k));
}
half4 outp(float3 c, float a) { return outq(float4(c * clamp(a, 0.0, 1.0), clamp(a, 0.0, 1.0))); }
`;

// ---- one-shot archetypes (STANDALONE rectangles unless noted) ----
// Travel strips (bolt, ray, arrow): the rectangle runs from the caster (x = height/2) to the
// target (x = width - height/2), height about one cell, turned to point at the target.
// Most effects lay a darker, wider copy of their bright parts underneath first, so they still
// read on a bright parchment map, not only on a dark dungeon.

const BODIES = {};

BODIES.bolt = `uniform float hit;
uniform float wobble;
uniform float miss;

half4 main(float2 coord) {
  float H = size.y;
  float hh = H * 0.5;
  float L = max(size.x - H, 1.0);
  float x = coord.x - hh;
  float y = (coord.y - hh) / hh;
  float tm = tnow();
  float hf = max(hit, 0.05);
  float hx = L * ramp(progress, 0.0, hf);
  float gone = ramp(progress, hf, hf + 0.06);
  float wy = wobble * 0.3 * sin(x / H * 2.5 + seed * 6.0 + tm * 3.0) * ramp(x, 0.0, H);
  float dy = y - wy;
  float4 acc = float4(0.0);
  // the trail: a tapering, flickering tongue of flame behind the bead, shedding sparks
  float tl = H * (2.0 + 1.6 * power);
  float b = (hx - x) / tl;
  float n = fbm3(float2(x / H * 2.4 - tm * 8.0, dy * 1.4 + seed));
  float w = mix(0.62, 0.05, clamp(b, 0.0, 1.0)) * (0.55 + 0.9 * n);
  float tr = smoothstep(-0.06, 0.03, b) * (1.0 - ramp(b, 0.3, 1.0)) * ramp(x, -hh * 0.4, hh * 0.2);
  tr *= 1.0 - ramp(progress, hf, hf + 0.22);
  float trail = tr * (1.0 - smoothstep(w * 0.4, w, abs(dy)));
  float under = tr * (1.0 - smoothstep(w * 0.7, w * 1.4, abs(dy)));
  float2 sg = float2(x / H * 3.0 + seed, dy * 1.2);
  float2 sid = floor(sg);
  float sh = hash12(sid);
  float2 sf = fract(sg) - float2(0.5, 0.5 + (sh - 0.5) * 0.5);
  float spark = exp(-dot(sf, sf) * 90.0) * step(0.62, sh) * smoothstep(-0.05, 0.1, b) * (1.0 - ramp(b, 0.5, 1.6)) * (1.0 - ramp(progress, hf, hf + 0.3));
  acc = lay(acc, colA * 0.32, under * 0.5);
  acc = lay(acc, heat(clamp(1.0 - b * 1.3 + 0.4 * (n - 0.5), 0.0, 1.0)), trail * 0.95);
  acc = lay(acc, heat(0.9), spark);
  // the bead: a white-hot core in a soft halo
  float d = length(float2((x - hx) / hh, dy));
  float r0 = 0.4 * (0.8 + 0.25 * power);
  float live = (1.0 - gone) * step(0.0, progress);
  acc = lay(acc, colA * 0.35, exp(-d * d / (r0 * r0 * 4.0)) * live * 0.45);
  acc = lay(acc, heat(0.6), exp(-d * d / (r0 * r0 * 2.0)) * live * 0.85);
  acc = lay(acc, heat(1.0), (1.0 - smoothstep(r0 * 0.3, r0, d)) * live);
  // the splash where it lands (none on a miss)
  float ft = ramp(progress, hf, 1.0);
  float2 fp = float2((x - L) / hh, y);
  float fd = length(fp);
  float fr = mix(0.3, 1.0, easeout(ft * 1.6));
  float nn = vnoise(fp * 3.0 + float2(seed, -tm * 4.0));
  float fl = (1.0 - miss) * step(hf, progress) * (1.0 - smoothstep(fr * (0.35 + 0.45 * nn), fr, fd)) * (1.0 - ft);
  acc = lay(acc, heat(clamp(1.1 - fd / fr + 0.3 * nn - ft * 0.5, 0.0, 1.0)), fl);
  return outq(acc);
}
`;

BODIES.ray = `uniform float hit;
uniform float crackle;
uniform float miss;

half4 main(float2 coord) {
  float H = size.y;
  float hh = H * 0.5;
  float L = max(size.x - H, 1.0);
  float x = coord.x - hh;
  float y = (coord.y - hh) / hh;
  float tm = tnow();
  float hf = max(hit, 0.05);
  float front = L * ramp(progress, 0.0, hf);
  float life = 1.0 - ramp(progress, 0.5, 1.0);
  float pin = ramp(x, 0.0, H) * ramp(L - x, 0.0, H);
  float j = (vnoise(float2(x / H * 2.5, tm * 14.0 + seed * 5.0)) - 0.5) * 0.8 * crackle * pin;
  float dy = abs(y - j);
  float thick = mix(0.5, 0.2, ramp(progress, hf, 1.0)) * (0.8 + 0.25 * power);
  float on = (1.0 - smoothstep(front - hh * 0.3, front, x)) * ramp(x, -hh * 0.7, -hh * 0.2);
  float4 acc = float4(0.0);
  float glow = exp(-dy * dy / (thick * thick)) * on * life;
  float tw = sin(x / H * 4.0 - tm * 22.0 + seed);
  float s1 = exp(-abs(y - j - tw * thick * 0.8) * 14.0);
  float s2 = exp(-abs(y - j + tw * thick * 0.8) * 14.0);
  float pul = 0.75 + 0.25 * sin(x / H * 7.0 - tm * 35.0);
  acc = lay(acc, colA * 0.3, exp(-dy * dy / (thick * thick * 2.5)) * on * life * 0.4);
  acc = lay(acc, heat(0.35), glow * 0.7);
  acc = lay(acc, heat(0.75), clamp(s1 + s2, 0.0, 1.0) * 0.65 * on * life * pin);
  float core = (1.0 - smoothstep(thick * 0.1, thick * 0.38, dy)) * on * life * pul;
  acc = lay(acc, heat(1.0), core);
  float m = length(float2(x / hh, y));
  acc = lay(acc, heat(0.9), exp(-m * m * 3.0) * env(progress, 0.05, 0.35));
  float fd = length(float2((x - L) / hh, y));
  float hitf = (1.0 - miss) * step(hf, progress) * life;
  acc = lay(acc, heat(1.0 - fd * 0.5), exp(-fd * fd * 2.2) * hitf * (0.8 + 0.2 * flick(seed)));
  return outq(acc);
}
`;

BODIES.arrow = `uniform float hit;
uniform float spin;
uniform float miss;

half4 main(float2 coord) {
  float H = size.y;
  float hh = H * 0.5;
  float L = max(size.x - H, 1.0);
  float x = coord.x - hh;
  float y = coord.y - hh;
  float tm = tnow();
  float hf = max(hit, 0.05);
  float hx = L * ramp(progress, 0.0, hf);
  float len = H * 1.4;
  // the arrow's own frame: x runs back from the tip, so a landed arrow sits in the target
  float2 p = float2(hx - x, y);
  // a thrown weapon tumbles end over end about its middle
  float a = spin * (tm * 16.0 + seed * 3.0);
  float2 c = p - float2(len * 0.5, 0.0);
  float ca = cos(a);
  float sa = sin(a);
  float2 r = float2(ca * c.x - sa * c.y, sa * c.x + ca * c.y) + float2(len * 0.5, 0.0);
  p = mix(p, r, step(0.5, spin));
  // after landing it sticks for a moment, then fades; a miss flies on and fades out
  float stay = 1.0 - ramp(progress, hf + 0.1, 1.0);
  float flyoff = 1.0 - ramp(progress, hf * 0.85, hf);
  float vis = step(0.0, progress) * mix(stay, flyoff, miss);
  // the shapes, as distances in pixels: head, shaft, and two vanes widening to the nock
  float head = max(abs(p.y) - p.x * 0.42, max(-p.x, p.x - len * 0.24));
  float shaft = sdBox(p - float2(len * 0.6, 0.0), float2(len * 0.38, H * 0.035));
  float vane = max(max(len * 0.74 - p.x, p.x - len * 0.99), abs(p.y) - (H * 0.035 + (p.x - len * 0.74) * 0.45));
  vane = mix(vane, 1000.0, step(0.5, spin));
  float body = min(shaft, vane);
  float d = min(head, body);
  float px = max(H * 0.02, 1.0);
  float edge = 1.0 - smoothstep(px * 1.5, px * 3.5, d);
  float fillHead = 1.0 - smoothstep(-px, px, head);
  float fillShaft = 1.0 - smoothstep(-px, px, shaft);
  float fillVane = 1.0 - smoothstep(-px, px, vane);
  // a streak of air behind it while it flies
  float sk = step(len, p.x) * (1.0 - ramp(p.x, len, len * 3.5)) * exp(-p.y * p.y / (H * H * 0.004)) * (1.0 - ramp(progress, hf, hf + 0.08));
  // a little puff of dust where it lands
  float2 lp = float2((x - L) / hh, y / hh);
  float pd = length(lp);
  float pt = ramp(progress, hf, 1.0);
  float pr = mix(0.1, 0.9, easeout(pt));
  float puff = (1.0 - miss) * step(hf, progress) * exp(-(pd - pr) * (pd - pr) * 30.0) * (1.0 - pt);
  float4 acc = float4(0.0);
  acc = lay(acc, colB, sk * 0.5 * (1.0 - spin * 0.4));
  acc = lay(acc, mix(float3(0.5, 0.45, 0.4), colB, 0.4), puff * 0.6);
  acc = lay(acc, float3(0.07, 0.06, 0.05), edge * 0.85 * vis);
  acc = lay(acc, mix(float3(0.42, 0.27, 0.13), colA, 0.15), fillShaft * vis);
  acc = lay(acc, mix(float3(0.85, 0.82, 0.76), colB, 0.3), fillVane * vis);
  acc = lay(acc, mix(colA, colB, 0.35), fillHead * vis);
  return outq(acc);
}
`;

// Areas. A burst's rectangle is 2.4 x the radius, centred; 1.0 below is the spell's radius.
BODIES.burst = `uniform float smoke;
uniform float shock;
uniform float ring_only;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.4;
  float r = length(q);
  float a = angle(q);
  float t = progress;
  float tm = tnow();
  float4 acc = float4(0.0);
  float body = 1.0 - ring_only;
  // the fireball: swells to full size in the first fifth, burns, then cools into smoke
  float grow = easeout(ramp(t, 0.0, 0.18));
  float rad = mix(0.1, 1.0, grow);
  float2 wq = q * 1.9 + float2(seed * 3.7, seed * 1.3);
  float w1 = vnoise(wq * 0.8 + float2(tm * 0.35, -tm * 0.5));
  float w2 = vnoise(wq * 0.8 + float2(5.2 - tm * 0.4, 1.3 + tm * 0.3));
  float n = fbm3(wq * (1.6 - t * 0.8) + float2(w1, w2) * 0.9);
  float edge = rad * (0.86 + 0.3 * n);
  float inside = 1.0 - smoothstep(edge * 0.8, edge, r);
  float cool = ramp(t, 0.12, 0.75);
  float burn = 1.0 - ramp(t, 0.35, 0.8);
  float core = 1.0 - r / max(edge, 0.01);
  float h = clamp(core * 1.1 + (n - 0.5) * 1.2 + 0.2 - cool * 1.0, 0.0, 1.0);
  // the smoke: billows out a little past the fire and outlasts it
  float sn = fbm3(q * 1.5 + float2(seed - tm * 0.15, t * 1.4));
  float sedge = mix(0.35, 1.1, easeout(ramp(t, 0.05, 0.55))) * (0.7 + 0.45 * sn);
  float smk = smoke * body * (1.0 - smoothstep(sedge * 0.55, sedge, r)) * ramp(t, 0.15, 0.4) * (1.0 - ramp(t, 0.55, 1.0));
  smk *= 0.3 + 0.7 * smoothstep(0.3, 0.75, sn);
  float3 smokeCol = mix(float3(0.13, 0.12, 0.11), colA * 0.3, 0.2) * (0.8 + 0.5 * sn);
  acc = lay(acc, smokeCol, smk * 0.9);
  acc = lay(acc, colA * 0.3, (1.0 - smoothstep(edge * 0.9, edge * 1.1, r)) * burn * body * 0.5);
  acc = lay(acc, heat(h), inside * burn * body * (0.72 + 0.28 * n));
  acc = lay(acc, colB, exp(-r * r * 5.0) * env(t, 0.02, 0.2) * body);
  // a shock ring racing out to the edge of the area: a bright line with a dark edge
  float sr = mix(0.15, 1.12, easeout(ramp(t, 0.0, 0.3)));
  float rl = shock * (1.0 - ramp(t, 0.1, 0.38)) * body;
  float so = r - sr - 0.04;
  acc = lay(acc, colA * 0.3, exp(-so * so * 700.0) * rl * 0.6);
  acc = lay(acc, mix(colB, colA, 0.25), exp(-(r - sr) * (r - sr) * 500.0) * rl);
  // ring_only (Divine Sense and other pings): two rings sweeping out over the whole time
  float p1 = mix(0.1, 1.0, easeout(ramp(t, 0.0, 0.7)));
  float p2 = mix(0.1, 1.0, easeout(ramp(t, 0.22, 0.95)));
  float w1r = exp(-(r - p1) * (r - p1) * 300.0) * (1.0 - ramp(t, 0.5, 0.85)) * ramp(t, 0.0, 0.08);
  float w2r = exp(-(r - p2) * (r - p2) * 300.0) * (1.0 - ramp(t, 0.7, 1.0)) * 0.7;
  float wd1 = exp(-(r - p1 - 0.03) * (r - p1 - 0.03) * 300.0) * (1.0 - ramp(t, 0.5, 0.85)) * ramp(t, 0.0, 0.08);
  float wash = (1.0 - smoothstep(0.0, p1, r)) * 0.14 * (1.0 - ramp(t, 0.3, 0.9));
  float shimmer = 0.75 + 0.25 * sin(a * 9.0 + tm * 3.0 + seed);
  acc = lay(acc, heat(0.6), wash * ring_only);
  acc = lay(acc, colA * 0.35, wd1 * 0.6 * ring_only);
  acc = lay(acc, heat(0.85), clamp(w1r + w2r, 0.0, 1.0) * shimmer * ring_only);
  return outq(acc);
}
`;

// A cone's rectangle is 1.05 x its length, square, with the apex at the middle of the left
// edge; it ends flat at x = 1, as wide as it is long (the 2024 cone).
BODIES.cone = `uniform float jet;

half4 main(float2 coord) {
  float Lp = size.x / 1.05;
  float2 q = float2(coord.x, coord.y - size.y * 0.5) / Lp;
  float r = length(q);
  float a = angle(q);
  float tm = tnow();
  float t = progress;
  float spread = 0.4636;
  float side = 1.0 - smoothstep(spread * 0.78, spread * 1.0, abs(a));
  float front = mix(0.05, 1.15, easeout(ramp(t, 0.0, 0.3)));
  float reach = 1.0 - smoothstep(front - 0.2, front, q.x);
  float endc = 1.0 - smoothstep(0.94, 1.0, q.x);
  float m = side * reach * endc * step(0.0, q.x);
  float n = fbm3(float2(r * 4.0 - tm * 5.0 - t * 5.0, a * mix(3.5, 9.0, jet) + seed));
  float n2 = fbm3(float2(r * 9.0 - tm * 9.0, a * 15.0 - seed));
  float life = 1.0 - ramp(t, 0.45, 1.0);
  float dens = mix(0.62 + 0.38 * n, smoothstep(0.35, 0.75, n2) * 0.75 + 0.3 * n, jet);
  float h = clamp(0.5 + (1.0 - q.x) * 0.45 + 1.0 * (n - 0.4) - 0.6 * ramp(t, 0.35, 0.9), 0.0, 1.0);
  float rim = (1.0 - smoothstep(0.0, 0.08, spread - abs(a))) * step(abs(a), spread) * reach * endc * step(0.0, q.x);
  float4 acc = float4(0.0);
  acc = lay(acc, colA * 0.32, m * life * 0.2);
  acc = lay(acc, heat(h), m * life * dens);
  acc = lay(acc, colA * 0.45, rim * life * 0.5);
  acc = lay(acc, heat(1.0), exp(-r * r * 90.0) * side * env(t, 0.03, 0.35));
  return outq(acc);
}
`;

// A line's rectangle is its length x 2.2 widths, starting at the caster (left edge, middle).
BODIES.line = `uniform float jag;
uniform float strobes;

float zig(float x, float s) {
  float i = floor(x);
  return mix(hash12(float2(i, s)), hash12(float2(i + 1.0, s)), fract(x)) - 0.5;
}

half4 main(float2 coord) {
  float W = size.y / 2.2;
  float x = coord.x / W;
  float y = (coord.y - size.y * 0.5) / W;
  float Lw = size.x / W;
  float t = progress;
  float st = max(strobes, 1.0);
  float k = floor(t * st * 2.0);
  float pin = ramp(x, 0.0, 1.0) * ramp(Lw - x, -0.5, 0.8);
  float path = (zig(x * 0.9, seed + k * 3.1) * 0.9 + zig(x * 3.3, seed * 2.0 + k * 1.7) * 0.3) * jag * pin;
  float d = abs(y - path);
  // one fork splitting off part way along
  float bx = Lw * (0.3 + 0.3 * hash12(float2(seed, k)));
  float bs = hash12(float2(k, seed)) > 0.5 ? 1.0 : -1.0;
  float bpath = path + (x - bx) * 0.4 * bs + zig(x * 3.0, seed + k + 5.0) * 0.25;
  float bm = step(bx, x) * (1.0 - ramp(x, bx, bx + 2.5)) * jag;
  float db = abs(y - bpath);
  float front = Lw * ramp(t, 0.0, 0.06);
  float on = 1.0 - smoothstep(front - 0.3, front, x);
  float s = mix(1.0, 0.4 + 0.6 * step(0.45, fract(t * st * 2.0 + 0.3)), step(0.15, t));
  float life = 1.0 - ramp(t, 0.45, 1.0);
  float core = (1.0 - smoothstep(0.025, 0.07, d)) + (1.0 - smoothstep(0.015, 0.05, db)) * bm;
  float glow = exp(-d * d * 12.0) + exp(-db * db * 20.0) * bm * 0.6;
  float under = exp(-d * d * 4.0) + exp(-db * db * 8.0) * bm * 0.5;
  float band = (1.0 - smoothstep(0.42, 0.5, abs(y))) * on * life;
  float4 acc = float4(0.0);
  acc = lay(acc, heat(0.3), band * 0.18);
  acc = lay(acc, colA * 0.3, clamp(under, 0.0, 1.0) * 0.45 * on * life * s);
  acc = lay(acc, heat(0.65), clamp(glow, 0.0, 1.0) * 0.9 * on * life * s);
  acc = lay(acc, colB, clamp(core, 0.0, 1.0) * on * life * s);
  return outq(acc);
}
`;

// A cube's (or square's) rectangle is 1.15 x its side, turned with it; 1.0 is its edge.
BODIES.cube = `uniform float shock;
uniform float sparkle;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.3;
  float t = progress;
  float tm = tnow();
  float d = sdBox(q, float2(1.0));
  float inside = 1.0 - smoothstep(-0.01, 0.015, d);
  float n = fbm3(q * 2.2 + float2(seed, -tm * 0.5));
  float flood = easeout(ramp(t, 0.0, 0.18)) * (1.0 - ramp(t, 0.4, 1.0));
  float edgeLife = (1.0 - ramp(t, 0.35, 0.95)) * ramp(t, 0.0, 0.05);
  float edge = exp(-abs(d) * 40.0) * edgeLife;
  float edgeDark = exp(-abs(d - 0.02) * 22.0) * edgeLife;
  float m = max(abs(q.x), abs(q.y));
  float sw = mix(0.0, 1.05, easeout(ramp(t, 0.0, 0.3)));
  float sh = shock * exp(-abs(m - sw) * 30.0) * (1.0 - ramp(t, 0.18, 0.45)) * inside;
  // twinkles (Faerie Fire)
  float2 g = q * 3.5 + seed;
  float2 id = floor(g);
  float2 f = fract(g) - 0.5;
  float hs = hash12(id);
  float2 off = float2(hash12(id + 3.1), hash12(id + 7.7)) - 0.5;
  float2 fd = f - off * 0.6;
  float tw = sin(clamp((t - hs * 0.45) * 2.5, 0.0, 1.0) * 3.1416);
  float star = exp(-abs(fd.x) * 40.0) * exp(-abs(fd.y) * 7.0) + exp(-abs(fd.y) * 40.0) * exp(-abs(fd.x) * 7.0);
  float st = sparkle * inside * clamp(star, 0.0, 1.0) * tw * step(0.45, hs);
  float4 acc = float4(0.0);
  acc = lay(acc, heat(0.2 + 0.6 * n), inside * flood * (0.16 + 0.4 * smoothstep(0.35, 0.8, n)));
  acc = lay(acc, heat(0.85), sh * 0.75);
  acc = lay(acc, colA * 0.3, edgeDark * 0.6);
  acc = lay(acc, heat(0.95), edge);
  acc = lay(acc, colA * 0.4, st * 0.5);
  acc = lay(acc, colB, st);
  return outq(acc);
}
`;

// Token parts: the rectangle is centred on the token. glow: 2.2 x the token; 1.0 = its edge.
BODIES.glow = `uniform float ring_dir;
uniform float motes;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 4.4;
  float r = length(q);
  float a = angle(q);
  float t = progress;
  float tm = tnow();
  float outw = step(0.0, ring_dir);
  float4 acc = float4(0.0);
  float halo = exp(-(r - 1.02) * (r - 1.02) * 7.0) * env(t, 0.2, 0.55) * (0.65 + 0.35 * vnoise(float2(cos(a), sin(a)) * 2.5 + float2(seed, tm * 2.0)));
  float rr = mix(mix(2.1, 0.92, easeout(ramp(t, 0.0, 0.7))), mix(0.85, 2.1, easeout(ramp(t, 0.05, 0.85))), outw);
  float rl = env(t, 0.1, 0.6);
  float ring = exp(-(r - rr) * (r - rr) * 60.0) * rl;
  float ringU = exp(-(r - rr) * (r - rr) * 18.0) * rl;
  float wash = (1.0 - smoothstep(0.55, 1.1, r)) * env(t, 0.15, 0.5) * 0.22;
  float mo = 0.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float h1 = hash12(float2(fi * 1.31, seed));
    float h2 = hash12(float2(seed, fi * 1.73));
    float ph = fract(t * 1.25 + h1);
    float an = h2 * 6.2832 + (1.0 - outw) * ph * 3.0;
    float rad = mix(mix(1.9, 0.35, ph), 0.45 + h1 * 0.85, outw);
    float2 mp = float2(cos(an), sin(an)) * rad - float2(0.0, outw * ph * 1.3);
    float2 dd = q - mp;
    mo += exp(-dot(dd, dd) * 45.0) * sin(ph * 3.1416);
  }
  mo *= motes * env(t, 0.1, 0.7);
  acc = lay(acc, heat(0.5), wash);
  acc = lay(acc, colA * 0.3, ringU * 0.4);
  acc = lay(acc, heat(0.55), halo * 0.8);
  acc = lay(acc, heat(0.75), ring * 0.95);
  acc = lay(acc, colA * 0.35, clamp(mo * 0.6, 0.0, 1.0) * 0.6);
  acc = lay(acc, heat(1.0), clamp(mo, 0.0, 1.0));
  return outq(acc);
}
`;

// smite: about 3 cells, centred on the target; 1.0 = the rectangle's edge.
BODIES.smite = `uniform float rays;
uniform float flare;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.0;
  float r = length(q);
  float a = angle(q);
  float t = progress;
  float tm = tnow();
  float2 dir = float2(cos(a), sin(a));
  float n = fbm3(dir * 1.8 + float2(seed - r * 2.0, r * 3.5 - tm * 4.0));
  float k = max(rays, 3.0);
  float sp = abs(sin(a * k * 0.5 + seed * 3.0 + n * 0.8));
  float spokeLen = (1.0 - smoothstep(0.15, 0.9, r)) * env(t, 0.04, 0.45);
  float spokes = smoothstep(0.82, 1.0, sp) * spokeLen;
  float spokesU = smoothstep(0.6, 1.0, sp) * spokeLen;
  float flash = exp(-r * r * mix(16.0, 6.0, clamp(flare, 0.0, 1.0))) * env(t, 0.03, 0.35);
  float rr = mix(0.1, 0.95, easeout(ramp(t, 0.0, 0.45)));
  float rl = ramp(t, 0.0, 0.05) * (1.0 - ramp(t, 0.3, 0.8));
  float ring = exp(-(r - rr) * (r - rr) * 220.0) * rl;
  float ringU = exp(-(r - rr - 0.03) * (r - rr - 0.03) * 120.0) * rl;
  float fl = (1.0 - smoothstep(0.2 + 0.3 * n, 0.45 + 0.3 * n, r)) * smoothstep(0.08, 0.25, r) * env(t, 0.08, 0.6) * smoothstep(0.35, 0.8, n);
  float4 acc = float4(0.0);
  acc = lay(acc, colA * 0.3, clamp(spokesU * 0.5 + ringU * 0.5 + fl * 0.6, 0.0, 1.0));
  acc = lay(acc, heat(0.75), spokes * 0.9);
  acc = lay(acc, heat(0.25 + 0.75 * n), clamp(fl * 1.6, 0.0, 1.0));
  acc = lay(acc, heat(0.9), ring * 0.85);
  acc = lay(acc, heat(1.0), flash);
  return outq(acc);
}
`;

// sparkle: 2.6 x the token; a 3 x 3 neighbourhood of twinkling glints.
BODIES.sparkle = `uniform float dens;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.0;
  float r = length(q);
  float t = progress;
  float tm = tnow();
  float2 g = q * 3.0 + float2(seed * 1.3, seed * 0.7);
  float2 id = floor(g);
  float2 f = fract(g);
  float acc1 = 0.0;
  float accU = 0.0;
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      float2 o = float2(float(i) - 1.0, float(j) - 1.0);
      float2 cid = id + o;
      float hs = hash12(cid);
      float2 c = float2(hash12(cid + 3.7), hash12(cid + 9.1)) * 0.7 + 0.15;
      float2 d = f - o - c;
      float on = step(1.0 - clamp(dens, 0.0, 1.0) * 0.75, hs);
      float ph = clamp((t - hs * 0.4) / 0.4, 0.0, 1.0);
      float tw = sin(ph * 3.1416) * (0.8 + 0.2 * sin(tm * 20.0 + hs * 40.0));
      float sz = 0.7 + hs * 0.9;
      float star = exp(-abs(d.x) * 26.0 / sz) * exp(-abs(d.y) * 4.5 / sz) + exp(-abs(d.y) * 26.0 / sz) * exp(-abs(d.x) * 4.5 / sz);
      star += exp(-dot(d, d) * 160.0 / sz);
      acc1 += star * tw * on;
      accU += exp(-dot(d, d) * 25.0 / sz) * tw * on;
    }
  }
  float mask = 1.0 - smoothstep(0.65, 1.0, r);
  float halo = exp(-r * r * 3.5) * env(t, 0.2, 0.6) * 0.22;
  float4 acc = float4(0.0);
  acc = lay(acc, heat(0.55), halo);
  acc = lay(acc, colA * 0.35, clamp(accU, 0.0, 1.0) * mask * 0.4);
  acc = lay(acc, mix(colA, colB, 0.55), clamp(acc1, 0.0, 1.0) * mask);
  return outq(acc);
}
`;

// Weapons: about 1.8 cells (2.5 against a Large target), centred on the target and turned so
// +x points from the attacker through the target.
// slash: a crescent swept across the target round a pivot on the attacker's side (claws = 3:
// three thinner rakes).
BODIES.slash = `uniform float claws;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.0;
  float t = progress;
  float n3 = step(1.5, claws);
  float2 c = float2(-1.45, 0.0);
  float2 d = q - c;
  float r = length(d);
  float a = atan(d.y, d.x + 0.00001);
  float span = 0.72;
  float sw = easeout(ramp(t, 0.0, 0.38));
  float headA = mix(-span, span, sw);
  float u = (headA - a) / 1.1;
  float along = smoothstep(-0.04, 0.02, u) * (1.0 - smoothstep(0.5, 1.0, u)) * step(-span - 0.05, a) * ramp(t, 0.0, 0.04);
  float thickness = sin(clamp(u, 0.0, 1.0) * 3.1416 * 0.85 + 0.25) * mix(0.22, 0.09, n3);
  float life = 1.0 - ramp(t, 0.45, 1.0);
  float R0 = 1.45;
  float o0 = R0 - r;
  float o1 = mix(10.0, R0 - 0.24 - r, n3);
  float o2 = mix(10.0, R0 + 0.24 - r, n3);
  float bl = 0.0;
  float rim = 0.0;
  for (int i = 0; i < 3; i++) {
    float o = i == 0 ? o0 : (i == 1 ? o1 : o2);
    bl = max(bl, smoothstep(-0.012, 0.004, o) * (1.0 - smoothstep(thickness * 0.6, thickness, o)));
    rim = max(rim, smoothstep(-0.03, 0.0, o) * (1.0 - smoothstep(thickness, thickness * 1.4 + 0.02, o)));
  }
  float edge = exp(-o0 * o0 * 1500.0) * along;
  float tip = exp(-u * u * 300.0) * exp(-o0 * o0 * 300.0) * env(t, 0.02, 0.45);
  float sweep = smoothstep(0.0, 0.45, o0) * (1.0 - smoothstep(0.45, 0.75, o0)) * along * (1.0 - n3) * 0.18;
  float4 acc = float4(0.0);
  acc = lay(acc, mix(colA, colB, 0.5), sweep * life);
  acc = lay(acc, colA * 0.28, rim * along * life * 0.7);
  acc = lay(acc, mix(colA, colB, 0.4 + 0.6 * (1.0 - clamp(u, 0.0, 1.0))), bl * along * life);
  acc = lay(acc, colB, clamp(edge * life + tip, 0.0, 1.0));
  return outq(acc);
}
`;

BODIES.thrust = `half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.0;
  float t = progress;
  float hit = 0.3;
  float tipx = mix(-1.05, 0.12, easeout(ramp(t, 0.0, hit)));
  tipx -= 0.25 * ramp(t, 0.55, 1.0);
  float u = tipx - q.x;
  float len = 1.0;
  float wid = mix(0.0, 0.07, ramp(u, 0.0, 0.25)) + 0.02;
  float s = step(0.0, u) * (1.0 - ramp(u, len * 0.4, len)) * (1.0 - smoothstep(wid * 0.6, wid, abs(q.y)));
  float rim = step(0.0, u) * (1.0 - ramp(u, len * 0.4, len)) * (1.0 - smoothstep(wid, wid * 1.9 + 0.01, abs(q.y)));
  float life = 1.0 - ramp(t, 0.55, 1.0);
  float2 hp = q - float2(0.12, 0.0);
  float hr = length(hp);
  float ha = angle(hp);
  float sp = smoothstep(0.75, 1.0, abs(sin(ha * 3.0 + seed)));
  float spark = step(hit, t) * (exp(-hr * hr * 40.0) + sp * exp(-hr * 4.5) * 0.8) * (1.0 - ramp(t, hit, 0.85));
  float ringr = mix(0.05, 0.6, easeout(ramp(t, hit, 0.8)));
  float ring = step(hit, t) * exp(-(hr - ringr) * (hr - ringr) * 200.0) * (1.0 - ramp(t, hit, 0.85));
  float4 acc = float4(0.0);
  acc = lay(acc, colA * 0.3, rim * life * 0.7);
  acc = lay(acc, colA * 0.3, clamp(spark * 0.6, 0.0, 1.0) * 0.5);
  acc = lay(acc, mix(colA, colB, 0.6), s * life);
  acc = lay(acc, heat(0.9), clamp(ring * 0.8, 0.0, 1.0));
  acc = lay(acc, colB, clamp(spark, 0.0, 1.0));
  return outq(acc);
}
`;

BODIES.smash = `half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.0;
  float r = length(q);
  float a = angle(q);
  float t = progress;
  float hit = 0.25;
  float2 dir = float2(cos(a), sin(a));
  // the blow comes in from the attacker's side and lands
  float2 bp = q - float2(mix(-0.9, 0.0, easeout(ramp(t, 0.0, hit))), 0.0);
  float blow = exp(-dot(bp, bp) * 22.0) * (1.0 - step(hit, t)) * ramp(t, 0.0, 0.1);
  float ht = ramp(t, hit, 1.0);
  float sr = mix(0.08, 0.95, easeout(ht));
  float shock = step(hit, t) * exp(-(r - sr) * (r - sr) * 260.0) * (1.0 - ht);
  float shockU = step(hit, t) * exp(-(r - sr - 0.04) * (r - sr - 0.04) * 120.0) * (1.0 - ht);
  float n = vnoise(dir * 2.6 + seed * 3.0);
  float spikes = step(hit, t) * smoothstep(0.62, 1.0, n) * (1.0 - smoothstep(0.05, mix(0.4, 0.85, n), r)) * (1.0 - ramp(ht, 0.0, 0.5));
  float flash = step(hit, t) * exp(-r * r * 18.0) * (1.0 - ramp(ht, 0.0, 0.45));
  // cracks in the ground, dark, that linger a little
  float cn = vnoise(dir * 4.0 + seed * 7.0);
  float crack = step(hit, t) * smoothstep(0.84, 0.97, cn) * smoothstep(0.1, 0.2, r) * (1.0 - smoothstep(0.5, 0.75, r)) * (1.0 - ramp(t, 0.6, 1.0));
  // bits of grit thrown out
  float2 g = dir * mix(0.15, 0.85, easeout(ht)) ;
  float gr = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float ga = hash12(float2(fi, seed)) * 6.2832;
    float gd = mix(0.15, 0.9, easeout(ht)) * (0.6 + 0.4 * hash12(float2(seed, fi)));
    float2 gp = q - float2(cos(ga), sin(ga)) * gd;
    gr += exp(-dot(gp, gp) * 900.0);
  }
  gr *= step(hit, t) * (1.0 - ht);
  float4 acc = float4(0.0);
  acc = lay(acc, float3(0.1, 0.08, 0.06), crack * 0.7);
  acc = lay(acc, heat(0.6), blow * 0.8);
  acc = lay(acc, colA * 0.3, shockU * 0.5);
  acc = lay(acc, heat(0.8), shock * 0.95);
  acc = lay(acc, colA * 0.35, clamp(gr, 0.0, 1.0) * 0.9);
  acc = lay(acc, heat(0.95), spikes);
  acc = lay(acc, colB, flash);
  return outq(acc);
}
`;

// bite: two rows of teeth snapping shut on the target, then a spray where they met.
BODIES.bite = `half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.0;
  float t = progress;
  float hit = 0.3;
  float close = easeout(ramp(t, 0.0, hit));
  float gap = mix(0.7, 0.0, close);
  float open = 1.0 - ramp(t, 0.55, 0.9);
  float span = 0.72;
  float xr = clamp(q.x / span, -1.0, 1.0);
  float inx = 1.0 - smoothstep(span * 0.92, span, abs(q.x));
  float bow = (1.0 - xr * xr) * 0.18;
  float yu = -gap - bow;
  float yl = gap + bow;
  float tooth = abs(fract(q.x * 3.6 + 0.5) - 0.5) * 2.0;
  float th = 0.17 * (1.0 - tooth) * (1.0 - xr * xr * 0.6);
  float jw = 0.06;
  float upper = smoothstep(yu - jw - 0.01, yu - jw + 0.01, q.y) * (1.0 - smoothstep(yu + th - 0.01, yu + th + 0.01, q.y));
  float lower = smoothstep(yl - th - 0.01, yl - th + 0.01, q.y) * (1.0 - smoothstep(yl + jw - 0.01, yl + jw + 0.01, q.y));
  float jaw = clamp(upper + lower, 0.0, 1.0) * inx;
  float rimu = smoothstep(yu - jw - 0.05, yu - jw - 0.02, q.y) * (1.0 - smoothstep(yu + th + 0.01, yu + th + 0.04, q.y));
  float riml = smoothstep(yl - th - 0.04, yl - th - 0.01, q.y) * (1.0 - smoothstep(yl + jw + 0.02, yl + jw + 0.05, q.y));
  float rim = clamp(rimu + riml, 0.0, 1.0) * (1.0 - smoothstep(span, span + 0.05, abs(q.x)));
  float ht = ramp(t, hit, 1.0);
  float r = length(q);
  float a = angle(q);
  float sp = smoothstep(0.62, 1.0, vnoise(float2(cos(a), sin(a)) * 3.0 + seed));
  float spray = step(hit, t) * sp * exp(-abs(r - mix(0.1, 0.75, easeout(ht))) * 12.0) * (1.0 - ht);
  float snap = step(hit, t) * exp(-q.y * q.y * 60.0) * (1.0 - smoothstep(0.0, span, abs(q.x))) * (1.0 - ramp(ht, 0.0, 0.3));
  float4 acc = float4(0.0);
  acc = lay(acc, float3(0.6, 0.06, 0.06), spray * 0.85);
  acc = lay(acc, float3(0.08, 0.05, 0.05), rim * open * 0.9);
  acc = lay(acc, mix(colB, colA, 0.2), jaw * open);
  acc = lay(acc, colB, snap * 0.8);
  return outq(acc);
}
`;

// impact: 2 cells round the target. dirv is the way the blow travelled (0,0 = from nowhere).
BODIES.impact = `uniform float2 dirv;
uniform float strength;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 2.0;
  float t = progress;
  float s = clamp(strength, 0.2, 2.0);
  float r = length(q);
  float a = angle(q);
  float2 dir = float2(cos(a), sin(a));
  float dl = length(dirv);
  float2 dn = dl > 0.001 ? dirv / dl : float2(1.0, 0.0);
  float fwd = dl > 0.001 ? dot(dir, dn) : 0.0;
  float bias = 0.6 + 0.4 * fwd;
  float sz = mix(0.55, 1.0, ramp(s, 0.2, 1.0));
  float n = vnoise(dir * 3.0 + seed * 3.0);
  // sparks streaking outward
  float sr = mix(0.05, 0.75, easeout(t)) * bias * sz;
  float streak = smoothstep(0.55, 0.95, n) * exp(-(r - sr) * (r - sr) * 80.0) * smoothstep(0.03, 0.12, r);
  float flash = exp(-r * r * mix(30.0, 12.0, ramp(s, 0.3, 1.5))) * (1.0 - ramp(t, 0.0, 0.55));
  float rr = mix(0.05, 0.8, easeout(t)) * sz;
  float ring = exp(-(r - rr) * (r - rr) * 260.0) * (1.0 - t) * step(0.6, s);
  float ringU = exp(-(r - rr - 0.03) * (r - rr - 0.03) * 110.0) * (1.0 - t) * step(0.6, s);
  float life = 1.0 - ramp(t, 0.4, 1.0);
  float4 acc = float4(0.0);
  acc = lay(acc, colA * 0.3, clamp(ringU * 0.6 + streak * 0.4 * life + flash * 0.3, 0.0, 1.0));
  acc = lay(acc, heat(0.75), ring * 0.9);
  acc = lay(acc, heat(0.9), clamp(streak * 1.4, 0.0, 1.0) * life);
  acc = lay(acc, heat(1.0), flash);
  return outq(acc);
}
`;

// resist: 2.4 x the token; a shield arc on the side facing where the magic came from.
BODIES.resist = `uniform float2 dirv;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 4.8;
  float r = length(q);
  float t = progress;
  float tm = tnow();
  float dl = length(dirv);
  float2 dn = dl > 0.001 ? dirv / dl : float2(0.0, -1.0);
  float c = dot(q / max(r, 0.001), dn);
  float arc = smoothstep(0.15, 0.6, c) * mix(1.0, 0.25, step(dl, 0.001)) + step(dl, 0.001) * 0.6;
  float rr = 1.25 + 0.06 * sin(t * 12.0);
  float shell = exp(-(r - rr) * (r - rr) * 28.0) * arc;
  float2 h = q * 5.0;
  float hex = abs(sin(h.x + seed) * sin(h.y * 0.866 + h.x * 0.5) * sin(h.y * 0.866 - h.x * 0.5));
  float sh = 0.55 + 0.45 * smoothstep(0.25, 0.0, hex);
  float ripple = 0.75 + 0.25 * sin(r * 30.0 - tm * 14.0);
  float life = env(t, 0.1, 0.55);
  float4 acc = float4(0.0);
  acc = lay(acc, colA * 0.35, shell * life * 0.55);
  acc = lay(acc, mix(colA, colB, 0.6), clamp(shell * sh * ripple, 0.0, 1.0) * life * 0.95);
  return outq(acc);
}
`;

// death: 2.6 x the token; 1.0 = its edge. beats 0 = a foe falls: a red flash, the token
// dims, and smoke and ash drift up from it. beats 2 = a PC drops: two heartbeats, then a dim
// red glow that fades.
BODIES.death = `uniform float beats;
uniform float smoke;

half4 main(float2 coord) {
  float2 q = (coord / size - 0.5) * 5.2;
  float r = length(q);
  float a = angle(q);
  float t = progress;
  float tm = tnow();
  float pc = step(0.5, beats);
  float foe = 1.0 - pc;
  float4 acc = float4(0.0);
  float fr = mix(1.35, 0.95, easeout(ramp(t, 0.0, 0.15)));
  float flash = exp(-(r - fr) * (r - fr) * 30.0) * ramp(t, 0.0, 0.04) * (1.0 - ramp(t, 0.12, 0.35)) * foe;
  float dim = (1.0 - smoothstep(0.85, 1.05, r)) * env(t, 0.25, 0.75) * 0.5 * foe;
  float2 sq = q + float2(0.0, t * 1.6);
  float sn = fbm3(float2(sq.x * 1.4 + seed, sq.y * 0.9 + tm * 0.3));
  float col = exp(-sq.x * sq.x * 0.9) * (1.0 - smoothstep(0.4, 1.8, length(sq * float2(0.8, 0.5))));
  float smk = smoke * foe * col * ramp(t, 0.15, 0.4) * (1.0 - ramp(t, 0.6, 1.0)) * smoothstep(0.3, 0.75, sn);
  float ash = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float hx = hash12(float2(fi, seed)) * 1.6 - 0.8;
    float hy = hash12(float2(seed, fi)) * 0.6;
    float2 ap = q - float2(hx + sin(t * 6.0 + fi) * 0.1, 0.3 - hy - t * 2.2);
    ash += exp(-dot(ap, ap) * 160.0);
  }
  ash *= foe * env(t, 0.2, 0.6);
  acc = lay(acc, float3(0.05, 0.04, 0.05), dim);
  acc = lay(acc, mix(float3(0.38, 0.36, 0.36), colA * 0.3, 0.2), smk * 0.75);
  acc = lay(acc, float3(0.12, 0.08, 0.06), clamp(ash * 1.5, 0.0, 1.0) * 0.5);
  acc = lay(acc, mix(float3(1.0, 0.45, 0.15), colB, 0.2), clamp(ash, 0.0, 1.0) * 0.9);
  acc = lay(acc, heat(0.7), flash);
  // a PC: two heartbeats from the token's edge, then a dim red glow that fades
  float b1 = ramp(t, 0.05, 0.3);
  float b2 = ramp(t, 0.35, 0.6);
  float r1 = mix(1.0, 2.2, easeout(b1));
  float r2 = mix(1.0, 2.2, easeout(b2));
  float p1 = exp(-(r - r1) * (r - r1) * 40.0) * (1.0 - b1) * step(0.001, b1);
  float p2 = exp(-(r - r2) * (r - r2) * 40.0) * (1.0 - b2) * step(0.001, b2);
  float pu = exp(-(r - r1 - 0.06) * (r - r1 - 0.06) * 18.0) * (1.0 - b1) * step(0.001, b1) + exp(-(r - r2 - 0.06) * (r - r2 - 0.06) * 18.0) * (1.0 - b2) * step(0.001, b2);
  float beat = env(ramp(t, 0.03, 0.22), 0.25, 0.5) + env(ramp(t, 0.33, 0.52), 0.25, 0.5);
  float thump = exp(-(r - 1.05) * (r - 1.05) * 20.0) * beat;
  float linger = exp(-(r - 1.05) * (r - 1.05) * 14.0) * ramp(t, 0.5, 0.62) * (1.0 - ramp(t, 0.75, 1.0)) * (0.7 + 0.3 * sin(a * 3.0 + tm * 2.0));
  acc = lay(acc, colA * 0.3, clamp(pu * 0.6 + thump * 0.5, 0.0, 1.0) * pc);
  acc = lay(acc, heat(0.5), clamp(p1 + p2, 0.0, 1.0) * pc);
  acc = lay(acc, heat(0.75), clamp(thump, 0.0, 1.0) * pc);
  acc = lay(acc, heat(0.5), linger * 0.85 * pc);
  return outq(acc);
}
`;

// flash: a VIEWPORT effect on RULER, the whole screen, for big booms on the table screen only.
BODIES.flash = `uniform float amt;

half4 main(float2 coord) {
  float k = 1.0 - progress;
  return outp(mix(colA, colB, 0.7), clamp(amt, 0.0, 0.6) * k * k);
}
`;

// shake: a VIEWPORT effect on POST_PROCESS: the picture under it, nudged. Identity at fade 0.
BODIES.shake = `uniform shader scene;
uniform float3x3 view;
uniform float amp;

half4 main(float2 coord) {
  float2 v = (float3(coord, 1.0) * view).xy;
  float tm = tnow();
  float k = amp * (1.0 - progress) * (1.0 - progress) * clamp(fade, 0.0, 1.0);
  float2 off = float2(sin(tm * 71.0 + seed), cos(tm * 83.0 + seed * 2.0)) * k;
  return scene.eval(v + off);
}
`;

// ---- living zones: ATTACHMENT effects clipped to the shared outline (fx/zones.js) ----
// `ofs` is the outline's top-left in its own coordinates (a circle's path is centred on its
// position, a rectangle's starts there), `shape` 0 = circle, 1 = square, `cell` = pixels per
// grid cell so a 40-ft zone has the same grain as a 10-ft one. edge01 is 0 at the outline and
// 1 at the centre. Zones sit on the PROP layer, under the tokens.
const ZONE_HEAD = `uniform float2 ofs;
uniform float shape;
uniform float cell;
uniform float density;

float edge01(float2 c) {
  float circ = 1.0 - length(c);
  float sq = 1.0 - max(abs(c.x), abs(c.y));
  return clamp(mix(circ, sq, step(0.5, shape)), 0.0, 1.0);
}
`;

const ZONE_BODIES = {};

// motes (Spirit Guardians): spirits circling the centre, two rings turning at different speeds.
ZONE_BODIES.motes = `float moteLayer(float2 v, float turn, float sc, float s) {
  float ca = cos(turn);
  float sa = sin(turn);
  float2 p = float2(ca * v.x - sa * v.y, sa * v.x + ca * v.y) * sc;
  float2 id = floor(p);
  float h = hash12(id + s);
  float2 c = float2(hash12(id + s + 3.1), hash12(id + s + 7.3)) * 0.5 + 0.25;
  float2 f = fract(p) - c;
  float on = step(1.0 - clamp(density, 0.2, 1.0) * 0.65, h);
  return exp(-dot(f, f) * 38.0) * on * (0.55 + 0.45 * sin(tnow() * 3.0 + h * 40.0));
}

half4 main(float2 coord) {
  float2 p = (coord - ofs) / size;
  float2 c = (p - 0.5) * 2.0;
  float e = edge01(c);
  float tm = tnow();
  float2 v = (coord - ofs - size * 0.5) / max(cell, 1.0);
  float r = length(v);
  float inner = 1.0 - smoothstep(0.35, 0.55, length(c));
  float m1 = moteLayer(v, tm * 0.9, 1.3, seed);
  float m2 = moteLayer(v, -tm * 0.45 + 1.7, 1.1, seed + 11.0);
  float motes = clamp(m1 * inner + m2 * (1.0 - inner), 0.0, 1.0) * ramp(e, 0.0, 0.06);
  float swirl = fbm3(float2(angle(v) * 2.0 + tm * 0.6, r * 0.7 - tm * 0.2) + seed);
  float fill = (0.1 + 0.1 * swirl) * ramp(e, 0.0, 0.1);
  float rim = exp(-e * 22.0);
  float4 acc = float4(0.0);
  acc = lay(acc, heat(0.45), fill * power);
  acc = lay(acc, colA * 0.35, rim * 0.5);
  acc = lay(acc, heat(0.75), rim * 0.55 * power);
  acc = lay(acc, colA * 0.4, clamp(motes * 1.6, 0.0, 1.0) * 0.4);
  acc = lay(acc, heat(0.95), motes);
  return outq(acc);
}
`;

// light (Faerie Fire on a target, Daylight...): a shimmering glow with a bright rim and twinkles.
ZONE_BODIES.light = `half4 main(float2 coord) {
  float2 p = (coord - ofs) / size;
  float2 c = (p - 0.5) * 2.0;
  float e = edge01(c);
  float tm = tnow();
  float2 w = (coord - ofs) / max(cell, 1.0);
  float n = fbm3(w * 0.9 + float2(tm * 0.15, -tm * 0.1 + seed));
  float bands = 0.5 + 0.5 * sin((w.x + w.y) * 1.3 + n * 5.0 + tm * 0.8);
  float caus = 1.0 - smoothstep(0.0, 0.12, abs(sin(n * 9.0 + tm * 0.7)));
  float glow = (0.24 + 0.22 * bands + 0.25 * caus) * (0.6 + 0.4 * ramp(e, 0.0, 0.5));
  float rim = exp(-e * 12.0);
  float2 g = w * 1.6 + seed;
  float2 id = floor(g);
  float2 f = fract(g) - 0.5;
  float hs = hash12(id);
  float tw = smoothstep(0.5, 1.0, sin(tm * (1.5 + hs * 2.0) + hs * 40.0));
  float sp = exp(-dot(f, f) * 110.0) * tw * step(0.55, hs);
  float4 acc = float4(0.0);
  acc = lay(acc, colA * 0.4, rim * 0.45);
  acc = lay(acc, heat(0.6), glow * power);
  acc = lay(acc, heat(0.85), rim * 0.6 * power);
  acc = lay(acc, colB, sp * 0.95);
  return outq(acc);
}
`;

// cloud (Fog Cloud, Stinking Cloud...): slow billows, thinning towards the edge.
ZONE_BODIES.cloud = `half4 main(float2 coord) {
  float2 p = (coord - ofs) / size;
  float2 c = (p - 0.5) * 2.0;
  float e = edge01(c);
  float tm = tnow();
  float2 w = (coord - ofs) / max(cell, 1.0);
  float n1 = vnoise(w * 0.4 + float2(tm * 0.07, tm * 0.03 + seed));
  float n1b = vnoise(w * 0.4 + float2(4.1 - tm * 0.05, seed * 0.5 + 2.7));
  float n2 = fbm3(w * 0.9 + float2(-tm * 0.12, seed * 2.0) + float2(n1, n1b) * 1.6);
  float d = clamp(n2 * 1.3 - 0.15, 0.0, 1.0);
  float body = ramp(e, 0.0, 0.3) * (0.4 + 0.5 * d) * mix(0.7, 1.0, clamp(density, 0.0, 1.0));
  float3 base = mix(float3(0.45, 0.45, 0.47), colA, 0.5);
  float3 col = mix(base * 0.45, mix(base, colB, 0.3), smoothstep(0.2, 0.9, d));
  float4 acc = float4(0.0);
  acc = lay(acc, col, body * 0.85 * clamp(power, 0.5, 1.5));
  return outq(acc);
}
`;

// strands (Entangle, Web...): vines as thin ridges of noise, slowly writhing, with leaves.
ZONE_BODIES.strands = `half4 main(float2 coord) {
  float2 p = (coord - ofs) / size;
  float2 c = (p - 0.5) * 2.0;
  float e = edge01(c);
  float tm = tnow();
  float2 w = (coord - ofs) / max(cell, 1.0);
  float n1 = fbm3(w * 0.9 + float2(seed, tm * 0.12));
  float n2 = fbm3(w * 1.7 + float2(tm * -0.09, seed * 3.0));
  float v1 = 1.0 - smoothstep(0.0, 0.05, abs(n1 - 0.5));
  float v2 = 1.0 - smoothstep(0.0, 0.035, abs(n2 - 0.5));
  float o1 = 1.0 - smoothstep(0.0, 0.085, abs(n1 - 0.5));
  float o2 = 1.0 - smoothstep(0.0, 0.065, abs(n2 - 0.5));
  float2 g = w * 3.0;
  float hs = hash12(floor(g) + seed);
  float2 f = fract(g) - 0.5;
  float leaf = exp(-dot(f * float2(1.0, 2.2), f * float2(1.0, 2.2)) * 40.0) * step(0.72, hs) * max(o1, o2);
  float ground = 0.14 + 0.1 * n2;
  float m = ramp(e, 0.0, 0.06);
  float4 acc = float4(0.0);
  acc = lay(acc, colA * 0.45, ground * m * clamp(density, 0.3, 1.0));
  acc = lay(acc, colA * 0.25, clamp(o1 + o2 * 0.8, 0.0, 1.0) * 0.9 * m);
  acc = lay(acc, colA, clamp(v1 + v2 * 0.8, 0.0, 1.0) * m);
  acc = lay(acc, colB, clamp(leaf, 0.0, 1.0) * 0.85 * m);
  return outq(acc);
}
`;

// flame (Create Bonfire, Wall of Fire...): tongues of fire rising, with gaps, and embers.
ZONE_BODIES.flame = `half4 main(float2 coord) {
  float2 p = (coord - ofs) / size;
  float2 c = (p - 0.5) * 2.0;
  float e = edge01(c);
  float tm = tnow();
  float2 w = (coord - ofs) / max(cell, 1.0);
  float2 fw = float2(w.x * 2.4 + seed, w.y * 1.3 + tm * 1.8);
  float q1 = vnoise(fw * 0.7);
  float n = fbm3(fw + float2(q1 * 1.6, q1 * 0.8));
  float core = ramp(e, 0.0, 0.7);
  float h = n * 1.6 - 0.8 + core * 0.6;
  h *= 0.9 + 0.1 * flick(seed);
  float a = smoothstep(0.1, 0.45, h) * ramp(e, 0.0, 0.1);
  float2 eg = w * 2.5 + float2(seed, tm * 1.3);
  float2 eid = floor(eg);
  float2 ef = fract(eg) - 0.5;
  float emb = exp(-dot(ef, ef) * 150.0) * step(0.86, hash12(eid)) * ramp(e, 0.0, 0.15);
  float4 acc = float4(0.0);
  acc = lay(acc, colA * 0.3, ramp(e, 0.0, 0.12) * 0.3);
  acc = lay(acc, heat(clamp(h, 0.0, 1.0)), a * 0.95 * clamp(power, 0.5, 1.5));
  acc = lay(acc, colB, emb * 0.9);
  return outq(acc);
}
`;

export const ARCH_SHADERS = Object.keys(BODIES);
export const ZONE_SHADERS = Object.keys(ZONE_BODIES);
export const BODY = BODIES;
export const ZONE_BODY = ZONE_BODIES;

// Lite swaps the 3-octave value noise for a cheap sine noise (same 0..1 range). The prelude's
// own fbm3 stays defined but unused.
function liteBody(body) {
  return body.replace(/\bfbm3\(/g, "lfbm(");
}

const cache = new Map();

// The whole SkSL for an archetype ("burst") or a zone look ("zone:strands"), "full" or "lite".
// Built once per name and tier, then cached: per-cast numbers only ever travel as uniforms.
export function shaderFor(name, tier = "full") {
  const lite = tier === "lite";
  const key = `${name}|${lite ? "lite" : "full"}`;
  if (cache.has(key)) return cache.get(key);
  let src = null;
  if (name.startsWith("zone:")) {
    const body = ZONE_BODIES[name.slice(5)];
    if (body) {
      src = lite
        ? HEAD_STATIC + CLOCK_STATIC + HELPERS + ZONE_HEAD + liteBody(body)
        : HEAD + CLOCK + HELPERS + ZONE_HEAD + body;
    }
  } else if (BODIES[name]) {
    src = HEAD + CLOCK + HELPERS + (lite ? liteBody(BODIES[name]) : BODIES[name]);
  }
  if (src == null) return null;
  cache.set(key, src);
  return src;
}

// Every `uniform <type> <name>;` in a shader, in order: [{name, type}].
export function uniformsOf(sksl) {
  const out = [];
  const re = /^\s*uniform\s+(\w+)\s+(\w+)\s*;/gm;
  let m;
  while ((m = re.exec(sksl))) out.push({ type: m[1], name: m[2] });
  return out;
}

// The uniforms we must send (Owlbear's own and the post-process child left out).
export function customUniforms(sksl) {
  return uniformsOf(sksl).filter((u) => !BUILTIN.has(u.name) && u.type !== "shader");
}

const ZERO = { float: 0, float2: { x: 0, y: 0 }, float3: { x: 0, y: 0, z: 0 }, vec2: { x: 0, y: 0 }, vec3: { x: 0, y: 0, z: 0 } };

function coerce(type, v) {
  const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  if (type === "float" || type === "half") return typeof v === "number" && Number.isFinite(v) ? v : null;
  if (type === "float2" || type === "vec2" || type === "half2") {
    if (Array.isArray(v) && v.length >= 2) return { x: n(v[0]), y: n(v[1]) };
    if (v && typeof v === "object" && "x" in v) return { x: n(v.x), y: n(v.y) };
    return null;
  }
  if (type === "float3" || type === "vec3" || type === "half3") {
    if (Array.isArray(v) && v.length >= 3) return { x: n(v[0]), y: n(v[1]), z: n(v[2]) };
    if (v && typeof v === "object" && "x" in v) return { x: n(v.x), y: n(v.y), z: n(v.z) };
    return null;
  }
  return null;
}

// Owlbear's uniform list for an effect: EVERY declared custom uniform, in order, each from
// `values` when it has a usable value, else 0 (and a warning: a short list would make Owlbear
// build no shader at all and draw a black rectangle).
export function fillUniforms(decl, values = {}, warn = null) {
  const out = [];
  for (const u of decl) {
    let v = coerce(u.type, values[u.name]);
    if (v == null) {
      if (warn) warn(`fx: uniform ${u.name} (${u.type}) missing, sent as 0`);
      v = ZERO[u.type] ?? 0;
    }
    out.push({ name: u.name, value: v });
  }
  return out;
}

// What the compile gate and check_fx.mjs refuse in our SkSL: [problem, ...] (empty = clean).
export function lint(sksl, name = "") {
  const bad = [];
  const code = sksl.replace(/\/\/[^\n]*/g, "");
  const rule = (re, why) => { if (re.test(code)) bad.push(`${name}: ${why}`); };
  rule(/\bwhile\b/, "while loop");
  rule(/%/, "% operator");
  rule(/(^|[^&])&([^&]|$)|(^|[^|])\|([^|]|$)|\^|~|<<|>>/m, "bit operator");
  rule(/\bdFd[xy]\b|\bfwidth\b/, "derivatives");
  rule(/\bsk_FragCoord\b/, "sk_FragCoord");
  rule(/\buniform\s+bool\b/, "bool uniform");
  rule(/#\s*(include|define|if)/, "preprocessor");
  rule(/\bpow\s*\(/, "pow()");
  // time only inside tnow(); size and time never redeclared
  const declTime = (code.match(/\b(float\d?|half\d?|int)\s+time\b/g) || []).length;
  const declSize = (code.match(/\b(float\d?|half\d?|int)\s+size\b/g) || []).length;
  if (declTime > 1) bad.push(`${name}: time shadowed`);
  if (declSize > 1) bad.push(`${name}: size shadowed`);
  const timeUses = (code.match(/\btime\b/g) || []).length;
  const allowed = (code.match(/uniform float time;/g) || []).length + (code.match(/mod\(time, 600\.0\)/g) || []).length;
  if (timeUses > allowed) bad.push(`${name}: time used outside tnow()`);
  for (const m of code.matchAll(/\bfor\s*\(([^)]*)\)/g)) {
    if (!/^\s*int\s+\w+\s*=\s*\d+\s*;\s*\w+\s*<\s*\d+\s*;\s*\w+\s*\+\+\s*$/.test(m[1])) bad.push(`${name}: loop bound not constant (${m[1].trim()})`);
  }
  if (!/half4\s+main\s*\(\s*float2\s+coord\s*\)/.test(code)) bad.push(`${name}: no half4 main(float2 coord)`);
  return bad;
}

// Every shader we can make: [{name, tier, sksl}].
export function allShaders() {
  const out = [];
  for (const tier of ["full", "lite"]) {
    for (const a of ARCH_SHADERS) out.push({ name: a, tier, sksl: shaderFor(a, tier) });
    for (const z of ZONE_SHADERS) out.push({ name: `zone:${z}`, tier, sksl: shaderFor(`zone:${z}`, tier) });
  }
  return out;
}
