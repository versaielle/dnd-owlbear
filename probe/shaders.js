// SkSL for the Stage-0 probe. Same uniform layout as the real FX engine (spec 11.4):
// size and time come from Owlbear; progress fade colA colB seed power come from us.
// Owlbear's renderer: STANDALONE effects draw the rect (0,0,width,height) from the item's
// position (so position = top-left), `time` = performance.now()/1000, and a uniform value is
// flattened as number -> float, {x,y,z} -> vec3, {x,y} -> vec2, array -> as-is (vec4/mat3).

const PRELUDE = `
uniform vec2 size;
uniform float time;
uniform float progress;
uniform float fade;
uniform vec3 colA;
uniform vec3 colB;
uniform float seed;
uniform float power;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm3(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int k = 0; k < 3; k++) {
    v += amp * vnoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    amp *= 0.5;
  }
  return v / 0.875;
}

float sfbm(vec2 p) {
  return sin(p.x * 1.7 + sin(p.y * 1.3)) * cos(p.y * 1.9 - p.x * 0.6);
}

half4 outp(vec3 c, float a) {
  float al = clamp(a, 0.0, 1.0);
  return half4(half3(c * al), half(al));
}
`;

// A radial fire burst: an expanding noisy front with a bright rim, fading out after 60%.
const BURST_BODY = `
half4 main(float2 coord) {
  vec2 uv = coord / size * 2.0 - 1.0;
  float r = length(uv);
  float t = mod(time, 600.0);
  float pr = clamp(progress, 0.0, 1.0);
  float grow = 1.0 - (1.0 - pr) * (1.0 - pr);
  float front = 0.12 + 0.83 * grow;
  float n = fbm3(uv * (3.0 + __SALT__) + vec2(seed, seed * 0.37 - t * 1.4));
  float edge = front * (0.82 + 0.3 * n);
  float body = 1.0 - smoothstep(edge - 0.3, edge, r);
  float rim = smoothstep(edge - 0.1, edge, r) * (1.0 - smoothstep(edge, edge + 0.05, r));
  float heat = clamp(body * (0.45 + 0.7 * n) + rim, 0.0, 1.0);
  vec3 col = mix(colB, colA, heat);
  col = mix(col, vec3(1.0, 0.96, 0.85), smoothstep(0.8, 1.0, heat) * (1.0 - pr));
  float life = 1.0 - smoothstep(0.6, 1.0, pr);
  return outp(col, (body * (0.3 + 0.7 * n) + rim) * life * fade * power);
}
`;

// salt: a number baked into the SkSL text, so the GPU program is new (a real cold compile, P13).
export function burst({ lite = false, salt = 0 } = {}) {
  let body = BURST_BODY.replace("__SALT__", Number(salt).toFixed(6));
  if (lite) body = body.replaceAll("fbm3(", "0.5+0.5*sfbm(");
  return PRELUDE + body;
}

export const BURST = burst();
export const BURST_LITE = burst({ lite: true });

// Deliberately broken: an undeclared name and a missing semicolon.
export const BROKEN = `
uniform vec2 size;
half4 main(float2 coord) {
  vec2 p = coord / size
  return half4(notDeclared, p.x, 0.0, 1.0);
}
`;

// A vec4 uniform, sent as a plain array [r, g, b, a].
export const VEC4 = `
uniform vec2 size;
uniform float time;
uniform vec4 tint;
half4 main(float2 coord) {
  vec2 uv = coord / size * 2.0 - 1.0;
  float d = length(uv);
  float pulse = 0.7 + 0.3 * sin(mod(time, 600.0) * 4.0);
  float a = (1.0 - smoothstep(0.75, 1.0, d)) * tint.a * pulse;
  return half4(half3(tint.rgb * a), half(a));
}
`;

// P7: moving diagonal stripes in world pixels (an ATTACHMENT effect's coord origin is the
// attached item's own, which may be its centre, so nothing here depends on where 0,0 is).
export const ZONE = `
uniform vec2 size;
uniform float time;
half4 main(float2 coord) {
  float t = mod(time, 600.0);
  float s = 0.5 + 0.5 * sin((coord.x + coord.y) * 0.08 - t * 4.0);
  float a = 0.25 + 0.35 * s;
  vec3 c = mix(vec3(0.2, 0.6, 1.0), vec3(1.0, 0.9, 0.3), s);
  return half4(half3(c * a), half(a));
}
`;

// P8: a pulsing disc in one colour.
export const DISC = `
uniform vec2 size;
uniform float time;
uniform vec3 colA;
half4 main(float2 coord) {
  vec2 uv = coord / size * 2.0 - 1.0;
  float d = length(uv);
  float pulse = 0.75 + 0.25 * sin(mod(time, 600.0) * 5.0);
  float a = (1.0 - smoothstep(0.8, 1.0, d)) * pulse;
  return half4(half3(colA * a), half(a));
}
`;

const BUILT_IN = new Set(["size", "position", "scale", "rotation", "model", "view", "modelView", "time", "scene"]);

// The custom uniforms a shader declares (the uniform contract: send every one, every update).
export function declared(sksl) {
  return [...sksl.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]).filter((n) => !BUILT_IN.has(n));
}

export const v3 = ([x, y, z]) => ({ x, y, z });
export const FIRE = { colA: [1.0, 0.62, 0.15], colB: [0.6, 0.07, 0.02] };

export function burstUniforms(progress, { fade = 1, power = 1, seed = 1.37, colA = FIRE.colA, colB = FIRE.colB } = {}) {
  return [
    { name: "progress", value: progress },
    { name: "fade", value: fade },
    { name: "colA", value: v3(colA) },
    { name: "colB", value: v3(colB) },
    { name: "seed", value: seed },
    { name: "power", value: power },
  ];
}
