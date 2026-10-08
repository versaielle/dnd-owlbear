// Lights on the map, on every screen that draws (the GM tabs, the laptop, the projector's Cast
// receiver, the phones): a flickering flame for every token or item that carries a light, and
// the darkvision band (grey AND dim) of every public seer, which leaves every lit area in
// colour. The looks and the SkSL are in fx/lights.js; which light an item has and how a token
// sees come from its metadata (fx/lightmeta.js effectiveLight() and visionOf(), the lights redo
// contract in docs/lights-redo-spec.md). Smoke & Spectre only reveals the fog: the writer
// (fx/lightwriter.js) gives every token we manage `visionDark: "0"`, so Smoke draws no grey
// ring of its own, and this file draws ours.
//
//   const lights = createLights(api, ctx);   every copy, at boot (background.js)
//   lights.setSettings(next)   the panel's settings + {kind, tier, quality_override} (may come
//                              before start(); tier is "off" on a copy that only relays)
//   lights.start()             this copy draws here: draw, and keep drawing as the scene changes
//   lights.stop()              step aside: everything we drew comes off
//   lights.pcTokensChanged()   ctx.pcTokens or ctx.party was refreshed (who's a PC may differ)
//   lights.status()            {on, tier, table, flames, rings, darkvision, dropped, error}
//
// ctx (background.js): role, kind, host, isPc(idOrItem, item), isPublic(idOrItem, item),
// pcTokens and party (only to notice a change), relayOnly, log; optionally senses(item) ->
// {dark} (else the room's PARTY_SENSES_KEY by the PC's name).
//
// Everything drawn here is LOCAL (OBR.scene.local): nothing is saved in the room, and no write of
// ours fires scene.items.onChange (which would start Smoke's full run on every client).
//
// A flame is one STANDALONE effect, two reaches wide, centred on the item and attached to it, so
// Owlbear moves it with the item and deletes it with the item; it's only updated to put it back
// on its item (one added just as the item moved), and for its uniforms below (a "full" flame's
// flicker is Owlbear's own time uniform). Its VISIBLE behaviour is off, so a hidden PC's torch
// still shows on the projector; that makes the R1 check below (ctx.isPublic, and what the item is
// attached to) the only thing keeping a hidden monster's torch off a player's screen: anything of
// ours that nothing tracks any more (a write that failed) is swept up, and a failed write is tried
// again. It sits on the ATTACHMENT layer with a small fixed z-index: above the tokens, under the
// fog, so the fog hides it wherever nobody sees. A flame is never drawn for the invisible child
// item that carries a lit NPC's torchlight for Smoke (CARRIER_KEY): the NPC's own light is.
//
// A flame stops at walls: the Smoke & Spectre lines that block (walls, closed doors; not windows,
// not open doors) within its reach go into its uniforms (WALL_SLOTS of them, the nearest), as
// segments in the flame's own square, so its glow doesn't spill into the next room. They're
// measured from where the light stands, so a carried torch gets them again (one uniforms update)
// once it has moved a quarter of a square, or when a wall near it changes (a door opens).
// Flames that overlap never add up (brighter, or a stacked flicker): each draws only where it's
// the strongest light (its neighbours are in its uniforms), so five torches together light more
// of the map, never more brightly, and each pixel flickers with one light only.
//
// Darkness comes from light (docs/lights-darkness-spec.md): two LOCAL effects per screen, not
// attached to anything, over the box around every dim and dark area (fx/darkness.js: a marked
// map, else the scene's darkness; unmarked = lit): one grey pass (blend SATURATION), one dim pass
// (blend MULTIPLY). Per point (fx/lights.js darknessPlan): lit as painted; dim a little darker
// outside every light; dark in colour within a light's reach, grey and dim within a public seer's
// darkvision, else black (0.35 on a GM's screen, so the DM can still read the map); never on a
// PC's own mini (the overlay sits above the tokens: the players always see their own minis, a
// monster in the dark stays in the black; selfDisc below). The lights
// that count: every light this screen shows (R1) and the DM's own ambient lights (a hidden Smoke
// torch we never wrote, fx/darkness.js isAmbientLight: no flame on a player's screen). Both passes
// read the same mask, so nothing is greyed or dimmed twice where things overlap. They're drawn on EVERY
// kind of screen whatever the flame tier, the 🔥 Lights switch, ✨ Effects or DND_FX=0: once
// Smoke draws no ring, a screen without ours would show every band in full colour. They sit on
// ATTACHMENT at z-index DV_Z, under the flames and every attachment (Colored Rings, condition
// badges: auto z-indexes are timestamps), so the tokens grey and the target rings keep their
// colour; and under the FOG layer: on a player's screen the fog covers them wherever nobody
// sees, and on a GM's screen the translucent fog tints over them the same way it tints the map.
// Their uniforms are worked out again on EVERY item change, at once (cheap arithmetic, one
// local update): a carried torch's colour moves with the drag; the flames and walls wait for the
// scene to settle.
import { CARRIER_KEY, LIGHT_FX_KEY, PARTY_SENSES_KEY, SCENE_LIGHTING_KEY, SMOKE } from "../keys.js?v=585985a-dc1dbb6";
import { DV_DARK_BLEND, DV_GREY, DV_SOFT_FT, FLAME_BLEND, WALL_SLOTS, darknessPlan, darkvisionShader, dimFor,
  flameShader, flameUniforms } from "./lights.js?v=585985a-dc1dbb6";
import { ambientReach, darkRegions, isAmbientLight, mapsExtent, sceneDarkness } from "./darkness.js?v=585985a-dc1dbb6";
import { DEFAULT_LIGHTING, effectiveLight, lightingOf, rangeDefaultOf, visionOf } from "./lightmeta.js?v=585985a-dc1dbb6";
import { nameKey, pcName, tokenLabel } from "./pcs.js?v=585985a-dc1dbb6";
import { finite, footprint, gridOf } from "./place.js?v=585985a-dc1dbb6";
import { customUniforms, fillUniforms } from "./shaders.js?v=585985a-dc1dbb6";

export const MAX_FLAMES = 12; // flames per screen: each full one makes Owlbear redraw every frame
export const LIGHT_Z = 1; // on ATTACHMENT: above the tokens, under rings and badges (auto z-indexes are timestamps)
export const DV_Z = 0; // the darkvision passes: on ATTACHMENT under the flames (a lit pixel is never grey anyway)
const SETTLE_MS = 150; // scene changes: the flames are reconciled once they've settled (a drag fires many)
const RETRY_MS = 2000; // a local write that failed is tried again after this (then longer)
const MAX_PX = 40000;
const WALL_MOVE = 0.05; // squares a carried light moves before its walls are measured again (shadows stay within 3 in.)
const TIERS = ["full", "lite", "off"];
const SK = (name) => `${SMOKE}/${name}`;
const LINE_KEY = SK("isVisionLine"); // on a Smoke & Spectre line (wall, door, window) in the scene
// A flame follows its item; nothing of the item's own visibility, size or turn carries over.
const DETACHED = ["VISIBLE", "SCALE", "ROTATION", "COPY"];

// A uniform list as a string, to tell whether it changed (numbers to 4 places).
const uniformSig = (u) => JSON.stringify(u, (k, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v));
const isCarrier = (i) => !!i?.metadata?.[CARRIER_KEY];

// The contract's pure functions (fx/lightmeta.js): which light an item gives, how a token sees,
// the scene's lighting (SCENE_LIGHTING_KEY, defaults filled in) and Smoke's default sight.
export { effectiveLight, visionOf };
const sceneLighting = (sceneMeta) => lightingOf(sceneMeta?.[SCENE_LIGHTING_KEY]);

// ---- walls ----

// Every Smoke & Spectre line that stops light right now, as scene segments [x1, y1, x2, y2]:
// walls, and doors unless they're open. Never a window (light goes through it) or a line the
// DM switched off. The points are turned, scaled and moved with their line the way gather.js
// wallSegments() does it (not imported: gather.js brings the panel's interiors code with it).
export function lightWalls(items, MathM) {
  const out = [];
  if (!MathM) return out;
  for (const i of items || []) {
    const m = i?.metadata;
    if (!m || !m[LINE_KEY] || m[SK("disabled")] || m[SK("isWindow")] || (m[SK("isDoor")] && m[SK("doorOpen")])) continue;
    if (i.type !== "CURVE" || !Array.isArray(i.points) || !i.points.length) continue;
    let pts;
    try {
      const mx = MathM.fromItem(i);
      pts = i.points.map((p) => MathM.decompose(MathM.multiply(mx, MathM.fromPosition(p))).position);
    } catch (e) {
      continue; // a line with no usable place: it blocks nothing here
    }
    if (i.style?.closed && pts.length > 2) pts.push(pts[0]);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      // (a point drawn twice is no wall: it would only take a slot from one that is)
      if (finite(a?.x, a?.y, b?.x, b?.y) && (a.x !== b.x || a.y !== b.y)) out.push([a.x, a.y, b.x, b.y]);
    }
  }
  return out;
}

// How far a segment comes to (0, 0), the light.
function reachOfSegment(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len)) : 0;
  return Math.hypot(x1 + t * dx, y1 + t * dy);
}

// A segment cut to the square -1..1 (the flame's own square), or null when it misses it
// (Liang-Barsky). Nothing past the square is drawn, and the numbers stay small.
function clipToSquare(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 + 1], [dx, 1 - x1], [-dy, y1 + 1], [dy, 1 - y1]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

// The walls one flame stops at: the segments that come into its lit disc (one that only crosses
// a corner of its square can't shade anything it lights), the nearest WALL_SLOTS, in its own
// space: p = (point - light) / (S / 2), -1..1 across the square. `key` names the walls chosen
// (scene pixels, in no particular order) to tell when they change; `over` is how many were left out.
export function flameWalls(at, half, segs) {
  const near = [];
  for (const s of segs) {
    const x1 = (s[0] - at.x) / half, y1 = (s[1] - at.y) / half;
    const x2 = (s[2] - at.x) / half, y2 = (s[3] - at.y) / half;
    if (Math.min(x1, x2) >= 1 || Math.max(x1, x2) <= -1 || Math.min(y1, y2) >= 1 || Math.max(y1, y2) <= -1) continue;
    const d = reachOfSegment(x1, y1, x2, y2);
    if (d < 1) near.push({ s, p: [x1, y1, x2, y2], d });
  }
  near.sort((a, b) => a.d - b.d);
  const kept = near.slice(0, WALL_SLOTS);
  const walls = [];
  for (const k of kept) {
    const c = clipToSquare(...k.p);
    if (c) walls.push(c);
  }
  const key = kept.map((k) => k.s.map((v) => Math.round(v)).join(",")).sort().join(";");
  return { walls, key, over: near.length - kept.length };
}

// A stable number for a flame's seed from the item's id (FNV-1a), small enough for the shader's
// floats: the same token flickers the same way on every screen and after every reload.
export function seedOf(id) {
  const s = String(id ?? "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 1 + ((h >>> 0) % 6400) / 100;
}

// ---- who's public, and what darkvision a screen draws ----

// R1, as every screen asks it: would a player's screen show this item? Hidden itself, or through
// what it's attached to (unless it doesn't take its parent's visibility); a PC is always public,
// whatever it's attached to. `byId`: the scene's items (its parents); attached deeper than 8, or
// in a loop: not public (fail closed).
export function publicChain(item, byId, { isPc, isPublic } = {}) {
  let i = item;
  for (let n = 0; n < 8; n++) {
    if (!i) return false;
    if (isPc?.(i)) return true;
    let pub;
    try {
      pub = typeof isPublic === "function" ? !!isPublic(i.id, i) : i.visible !== false;
    } catch (e) {
      return false;
    }
    if (!pub) return false;
    const up = i.attachedTo;
    const own = Array.isArray(i.disableAttachmentBehavior) && i.disableAttachmentBehavior.includes("VISIBLE");
    if (up == null || own || !byId) return true;
    i = byId.get(up);
    if (!i) return true; // the parent is gone (Owlbear deletes its attachments with it)
  }
  return false;
}

// Where a dim or dark SCENE's overlay goes: every map, else 120 ft around every token.
export function extentOf(items, grid) {
  const maps = mapsExtent(items, grid);
  if (maps) return maps;
  let e = null;
  const pad = 120 * (grid?.pxPerFt || 30); // (no map: 120 ft around every token)
  for (const i of items || []) {
    const p = i?.position && { x: Math.round(i.position.x), y: Math.round(i.position.y) }; // (a nudge under a pixel moves nothing)
    if (!p || !finite(p.x, p.y)) continue;
    e = e ? { x0: Math.min(e.x0, p.x - pad), y0: Math.min(e.y0, p.y - pad), x1: Math.max(e.x1, p.x + pad), y1: Math.max(e.y1, p.y + pad) }
      : { x0: p.x - pad, y0: p.y - pad, x1: p.x + pad, y1: p.y + pad };
  }
  return e;
}

// The overlay's inputs on one screen (scene pixels, feet), for fx/lights.js darknessPlan():
//   regions (fx/darkness.js darkRegions), extent, lights: every light this screen shows (`show`:
//   its R1; a GM's shows all) and every ambient light of the DM's (its Smoke range), never a
//   carrier child (its NPC's own light counts); seers: every PUBLIC seer with darkvision (the same
//   on every screen); selves: every PC's own mini (selfDisc), which the darkness never covers.
//   opts: {sceneMeta, lighting, grid {dpi, ftPerCell}, vctx (visionOf's ctx), pub (publicChain's),
//   show(item, byId)}.
// A scene released to Smoke (SCENE_LIGHTING_KEY managed false): null (Smoke draws its own there).
export function darkInputs(items, { sceneMeta = {}, lighting, grid, vctx, pub, show } = {}) {
  if (lightingOf(lighting ?? sceneMeta?.[SCENE_LIGHTING_KEY]).managed === false) return null;
  const byId = new Map();
  for (const i of items || []) if (i?.id != null) byId.set(i.id, i);
  const list = [...byId.values()];
  const seers = [], lights = [], selves = [];
  const dpi = gridOf(grid?.dpi, grid?.ftPerCell).dpi;
  const pcOf = (i) => { try { return !!pub?.isPc?.(i); } catch { return false; } };
  for (const item of list) {
    if (isCarrier(item) || !finite(item.position?.x, item.position?.y)) continue;
    const at = { id: item.id, x: item.position.x, y: item.position.y };
    // a PC's own mini (not a ring or a badge hanging from it): the players always see it
    if (pcOf(item) && !(item.attachedTo != null && pcOf(byId.get(item.attachedTo)))) {
      const d = selfDisc(item, dpi);
      if (d) selves.push({ id: item.id, ...d });
    }
    if (isAmbientLight(item, { lighting, byId, isPc: pub?.isPc, isSecret: (i) => !publicChain(i, byId, pub) })) {
      const reach = ambientReach(item, lighting);
      if (reach) lights.push({ ...at, reach });
      continue;
    }
    const l = effectiveLight(item, lighting);
    if (l && l.reach > 0 && (show ? show(item, byId) : publicChain(item, byId, pub))) lights.push({ ...at, reach: l.reach });
    if (!publicChain(item, byId, pub)) continue;
    const v = visionOf(item, vctx);
    if (v?.seer && +v.dark > 0) seers.push({ ...at, dark: +v.dark, pc: !!v.pc });
  }
  return { regions: darkRegions(list, sceneMeta, grid), extent: extentOf(list, grid), seers, lights, selves };
}

// A token's mini as drawn, in scene px: {x, y, r}, its image's centre and half its smaller side
// (its image over its own grid dpi times the scene's, times its scale: place.js footprint, as
// background.js sizes its condition badges); a token with no image: half a square times its scale.
export function selfDisc(item, dpi = 150) {
  const p = item?.position;
  if (!p || !finite(p.x, p.y)) return null;
  const sx = Math.abs(item.scale?.x ?? 1), sy = Math.abs(item.scale?.y ?? 1);
  const fp = footprint(item, dpi);
  const img = item.image, k = item.grid?.dpi > 0 ? dpi / item.grid.dpi : 0;
  const r = fp && img?.width > 0 && img?.height > 0 && k > 0 ? Math.min(img.width * sx, img.height * sy) * k / 2
    : (dpi / 2) * Math.min(finite(sx) ? sx : 1, finite(sy) ? sy : 1);
  const c = fp || p;
  return finite(c.x, c.y, r) && r > 0 ? { x: c.x, y: c.y, r } : null;
}

function defaultClock() {
  const perf = globalThis.performance;
  return {
    now: () => (perf ? perf.now() : Date.now()),
    wall: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h),
  };
}

export function createLights(api = {}, ctx = {}) {
  const clock = api.clock || defaultClock();
  const host = ctx.host ?? "";
  const log = typeof ctx.log === "function" ? ctx.log : (...a) => console.log(...a);
  // each message at most once every 10 s
  const warned = new Map();
  const warn = (msg, err) => {
    const key = String(msg);
    const t = clock.now();
    if (warned.has(key) && t - warned.get(key) < 10000) return;
    warned.set(key, t);
    try { console.warn(msg, err || ""); } catch (e) { /* no console */ }
    try { log(err ? `${msg}: ${err?.message || err}` : msg); } catch (e) { /* ignore */ }
  };

  // The Owlbear API: injected (background.js passes its SDK), or loaded here. A literal path, so
  // the Pages publisher stamps it with the same ?v= as everyone else's import of the SDK.
  let full = null;
  const loading = (async () => {
    if (api.OBR && typeof api.buildEffect === "function") return api;
    const sdk = await import("../obr-sdk.js?v=585985a-dc1dbb6");
    return { OBR: sdk.default, buildEffect: sdk.buildEffect, MathM: sdk.MathM, ...api };
  })().then((a) => {
    full = a;
    return a;
  });
  const getApi = () => loading;

  // ---- settings: the same precedence as the FX engine's tier() (flames only) ----
  let settings = { ...(ctx.settings || {}) };
  const role = () => ctx.role || "PLAYER";
  const kind = () => settings.kind || ctx.kind || (role() === "GM" ? "gm" : "other");
  function tier() {
    if (settings.fx === false || settings.lights === false) return "off";
    if ((settings.style || "shader") !== "shader") return "off";
    if (TIERS.includes(settings.quality_override)) return settings.quality_override;
    if (TIERS.includes(settings.tier)) return settings.tier;
    const q = settings.quality?.[kind()];
    return TIERS.includes(q) ? q : "full";
  }
  const mode = () => `${tier()}|${kind()}`;

  // Is this item a PC? The one rule (ctx.isPc, fx/pcs.js); a ctx without it knows the heartbeat's list.
  const isPc = (item) => {
    try {
      if (typeof ctx.isPc === "function") return !!ctx.isPc(item?.id, item);
    } catch (e) { return false; }
    return !!ctx.pcTokens?.has?.(item?.id);
  };
  const pub = { isPc, isPublic: typeof ctx.isPublic === "function" ? (...a) => ctx.isPublic(...a) : null };
  // R1: on a screen that isn't a GM's, a hidden item that isn't a PC is never drawn and never
  // gives away where it is.
  const isPublicChain = (item, byId) => publicChain(item, byId, pub);
  const shows = (item, byId = null) => role() === "GM" || isPublicChain(item, byId);
  const pcSignature = () => `${[...(ctx.pcTokens || [])].map(String).sort().join(",")}|${(ctx.party || []).join(",")}`;

  // ---- the scene's lighting and the party's senses ----
  let lighting = { ...DEFAULT_LIGHTING };
  let sceneMeta = {};
  let rangeDefault = 30;
  let roomSenses = {};
  const sensesOf = (item) => {
    if (typeof ctx.senses === "function") {
      try { return ctx.senses(item) || null; } catch (e) { return null; }
    }
    if (!isPc(item)) return null;
    const s = roomSenses[nameKey(pcName(item, ctx.party || []) || tokenLabel(item))];
    return s && typeof s === "object" ? s : null;
  };
  const vctx = { isPc, senses: sensesOf, get lighting() { return lighting; }, get rangeDefault() { return rangeDefault; } };
  const metaSig = () => JSON.stringify([lighting, sceneDarkness(sceneMeta), rangeDefault, roomSenses]);
  function takeScene(meta) {
    const before = metaSig();
    sceneMeta = meta && typeof meta === "object" ? meta : {};
    lighting = sceneLighting(meta);
    rangeDefault = rangeDefaultOf(meta);
    return metaSig() !== before;
  }
  function takeRoom(meta) {
    const before = metaSig();
    const s = meta?.[PARTY_SENSES_KEY];
    roomSenses = s && typeof s === "object" ? s : {};
    return metaSig() !== before;
  }

  // ---- what's drawn ----
  // source item id -> {id, sig, at (where the light stood when its walls were measured), wkey
  // (which walls), nkey (which neighbours, where), usig (its uniforms as last written)}
  const flames = new Map();
  // the darkvision passes: part ("grey" | "dim") -> {id, geo, usig}
  const dv = new Map();
  let dvInfo = { seers: 0, circles: 0, regions: 0, selves: 0, dropped: { regions: 0, seers: 0, circles: 0, selves: 0 } };
  let dvSaid = "";
  const wallsSaid = new Set(); // flames whose walls past WALL_SLOTS were logged already
  // The items this screen showed at the last scene change it looked at (null: none yet, or a
  // GM's screen): one that was shown and isn't now has its light taken off at once.
  let seen = null;
  let orphans = false; // a write failed: items of ours may be on the map that nothing tracks
  let retry = null;
  let retryMs = RETRY_MS / 2;
  let dropped = 0;
  let droppedSig = "";
  let lastError = null;

  let active = false; // drawing: from start() until stop()
  let sceneReady = false;
  let G = null; // the grid: {dpi, ftPerCell, pxPerFt}
  let gridStale = true;
  let latest = null; // the newest scene items scene.items.onChange gave us
  let pcSig = pcSignature();
  let unsubs = [];
  let debounce = null;

  async function gridNow(OBR) {
    const dpi = await OBR.scene.grid.getDpi();
    let mult = null;
    try { mult = (await OBR.scene.grid.getScale())?.parsed?.multiplier; } catch (e) { /* default 5 ft */ }
    return gridOf(dpi, mult);
  }

  function noteDropped(list) {
    dropped = list.length;
    const sig = list.map((c) => c.item.id).join(",");
    if (sig === droppedSig) return;
    droppedSig = sig;
    if (list.length) {
      log(`lights: ${list.length} over the cap of ${MAX_FLAMES} flames, not drawn here: `
        + list.map((c) => c.item.name || c.item.id).join(", "));
    }
  }

  // A flame's uniforms: its light, its seed, how hard it may flicker here, and its walls.
  const flameDecl = {};
  function flameValues(w, t) {
    const sksl = flameShader(t);
    if (!flameDecl[t]) flameDecl[t] = customUniforms(sksl);
    return fillUniforms(flameDecl[t], flameUniforms(w.light.kind,
      { seed: seedOf(w.item.id), ftPerCell: G.ftPerCell, walls: w.walls, neighbours: w.neighbours }), warn);
  }

  function flameItem(a, w, t) {
    const sksl = flameShader(t);
    const S = w.S;
    const { x, y } = w.item.position;
    return a.buildEffect()
      .effectType("STANDALONE")
      .sksl(sksl)
      .uniforms(w.uniforms)
      .blendMode(FLAME_BLEND)
      .width(S).height(S)
      .position({ x: x - S / 2, y: y - S / 2 })
      .attachedTo(w.item.id)
      .disableAttachmentBehavior(DETACHED)
      .layer("ATTACHMENT").zIndex(LIGHT_Z).disableAutoZIndex(true)
      .locked(true).disableHit(true)
      .name("dnd-npc flame")
      .metadata({ [LIGHT_FX_KEY]: { source: w.item.id, host, part: "flame" } })
      .build();
  }

  const DV = darkvisionShader();
  const DV_DECL = customUniforms(DV);
  const DV_PARTS = { grey: { blend: DV_GREY.blend, pass: 0 }, dim: { blend: DV_DARK_BLEND, pass: 1 } };

  function dvItem(a, part, plan, uniforms) {
    const b = plan.box;
    return a.buildEffect()
      .effectType("STANDALONE")
      .sksl(DV)
      .uniforms(uniforms)
      .blendMode(DV_PARTS[part].blend)
      .width(b.w).height(b.h)
      .position({ x: b.x, y: b.y })
      .layer("ATTACHMENT").zIndex(DV_Z).disableAutoZIndex(true)
      .locked(true).disableHit(true)
      .name(`dnd-npc darkvision ${part}`)
      .metadata({ [LIGHT_FX_KEY]: { source: "darkvision", host, part } })
      .build();
  }

  // What darkness this screen draws now (docs/lights-darkness-spec.md): null, or {plan, uniforms:
  // {grey, dim}}. Released to Smoke: nothing of ours (Smoke's own ring; the flames stay).
  const noDv = () => ({ seers: 0, circles: 0, regions: 0, selves: 0, dropped: { regions: 0, seers: 0, circles: 0, selves: 0 } });
  function dvWant(all) {
    const inp = darkInputs(all, { sceneMeta, lighting, grid: G, vctx, pub, show: shows });
    const plan = inp && darknessPlan(inp, { pxPerFt: G.pxPerFt, softFt: DV_SOFT_FT, quant: 1, kind: kind() });
    dvInfo = plan ? { seers: plan.seers.length, circles: plan.circles, regions: plan.regions, selves: plan.selves.length, dropped: plan.dropped } : noDv();
    const d = dvInfo.dropped;
    const said = `${d.regions}|${d.seers}|${d.circles}|${d.selves}`;
    if (said !== dvSaid) {
      dvSaid = said;
      if (d.regions || d.seers || d.circles || d.selves) {
        log(`lights: the darkness has room for 12 marked maps, 8 darkvisions, 32 lights and 8 PC minis; left out here: ${d.regions} maps, ${d.seers} darkvisions, ${d.circles} lights, ${d.selves} PC minis`);
      }
    }
    if (!plan) return null;
    const uniforms = {};
    for (const part of Object.keys(DV_PARTS)) uniforms[part] = fillUniforms(DV_DECL, { ...plan.values, pass: DV_PARTS[part].pass }, warn);
    return { plan, uniforms };
  }

  // Make what's on this screen match the scene: the flames (unless `dark` only) and the
  // darkvision. Writes only what differs (at most one local delete, one add and one update).
  async function doReconcile({ darkOnly = false } = {}) {
    const t = tier();
    const live = active && sceneReady && !ctx.relayOnly;
    const draw = live && t !== "off"; // the flames
    if (!live && !flames.size && !dv.size && !orphans) {
      noteDropped([]);
      return { added: 0, removed: 0, updated: 0 };
    }
    const a = await getApi();
    const OBR = a.OBR;
    let all = [];
    if (live) {
      if (!latest) {
        latest = await OBR.scene.items.getItems();
        if (role() !== "GM" && !seen) seen = shownNow(latest).ids;
      }
      all = latest;
      if (!G || gridStale) {
        G = await gridNow(OBR);
        gridStale = false;
      }
    }
    // what of ours is still there (a flame goes with its item when the item is deleted)
    const local = await OBR.scene.local.getItems((i) => i?.metadata?.[LIGHT_FX_KEY]?.host === host);
    const here = new Set(local.map((i) => i.id));
    const localById = new Map(local.map((i) => [i.id, i]));
    const byId = new Map(all.map((i) => [i.id, i]));

    const del = [], add = [], addedFlames = [], addedDv = [];
    // item id -> [(draft) => void]: every change to one of ours in one update
    const upd = new Map();
    const change = (id, f) => {
      const l = upd.get(id);
      if (l) l.push(f);
      else upd.set(id, [f]);
    };

    // ---- flames: every light this screen may see, the PCs' first, at most MAX_FLAMES ----
    if (!darkOnly) {
      const shown = [];
      const want = new Map(); // source id -> {item, light, S, sig, walls, wkey, neighbours, nkey}
      if (draw) {
        all.forEach((item, n) => {
          if (isCarrier(item) || !finite(item?.position?.x, item?.position?.y)) return;
          const light = effectiveLight(item, lighting);
          if (!light || !(light.reach > 0)) return;
          if (!shows(item, byId)) return;
          shown.push({ item, light, pc: isPc(item), n });
        });
        const order = [...shown].sort((x, y) => (x.pc === y.pc ? x.n - y.n : x.pc ? -1 : 1));
        for (const c of order.slice(0, MAX_FLAMES)) {
          const S = Math.min(c.light.reach * 2 * G.pxPerFt, MAX_PX);
          if (!finite(S) || S <= 0) continue;
          want.set(c.item.id, { ...c, S, sig: `${c.light.kind}|${t}|${Math.round(S)}|${G.ftPerCell}` });
        }
        noteDropped(order.slice(MAX_FLAMES));
        // Overlapping lights never add up: each flame knows the others drawn here whose reach
        // overlaps its own, and draws only where it's the strongest (fx/lights.js), so every pixel
        // has one light and one flicker. Their places in steps of WALL_MOVE squares (a carried
        // torch rewrites its neighbours' uniforms as it goes, like its walls).
        const drawn = [...want.values()];
        const step = Math.max(WALL_MOVE * G.dpi, 1);
        for (const w of drawn) {
          const nb = [];
          for (const o of drawn) {
            if (o === w) continue;
            const dx = Math.round((o.item.position.x - w.item.position.x) / step) * step;
            const dy = Math.round((o.item.position.y - w.item.position.y) / step) * step;
            if (Math.hypot(dx, dy) >= (w.S + o.S) / 2) continue;
            nb.push({ dx: dx / G.pxPerFt, dy: dy / G.pxPerFt, kind: o.light.kind, id: o.item.id });
          }
          w.neighbours = nb;
          w.nkey = nb.map((n) => `${n.id}:${n.kind}:${Math.round(n.dx * 10)},${Math.round(n.dy * 10)}`).sort().join(";");
        }
        // ...and each stops at the walls within its reach
        if (drawn.length && !a.MathM) warn("lights: no MathM here, so flames ignore walls");
        const segs = drawn.length ? lightWalls(all, a.MathM) : [];
        for (const w of drawn) {
          const fw = flameWalls(w.item.position, w.S / 2, segs);
          w.walls = fw.walls;
          w.wkey = fw.key;
          if (fw.over > 0 && !wallsSaid.has(w.item.id)) {
            wallsSaid.add(w.item.id);
            log(`lights: ${w.item.name || w.item.id} has ${fw.over + WALL_SLOTS} walls within reach; only the nearest ${WALL_SLOTS} stop its light`);
          }
        }
      } else {
        noteDropped([]);
      }
      for (const [sid, f] of flames) {
        const w = want.get(sid);
        if (w && w.sig === f.sig && here.has(f.id)) {
          // Owlbear moves a flame with its item, but one added just as the item moved (built from
          // where it was) would stay off it for good: put it back on its item
          const cur = localById.get(f.id)?.position;
          const at = { x: w.item.position.x - w.S / 2, y: w.item.position.y - w.S / 2 };
          if (cur && finite(cur.x, cur.y) && Math.hypot(cur.x - at.x, cur.y - at.y) > 1) change(f.id, (d) => { d.position = at; });
          // Its walls are measured again once it has moved a quarter of a square (a carried torch)
          // or a wall near it changed (a door opened), and its flicker when a flame came or went
          // near it; written only when that changes its uniforms (a torch carried down an empty
          // hall writes nothing).
          const pos = { ...w.item.position };
          const moved = !f.at || Math.hypot(pos.x - f.at.x, pos.y - f.at.y) > WALL_MOVE * G.dpi;
          if (moved || w.wkey !== f.wkey || w.nkey !== f.nkey) {
            const uniforms = flameValues(w, t);
            const usig = uniformSig(uniforms);
            f.at = pos;
            f.wkey = w.wkey;
            f.nkey = w.nkey;
            if (usig !== f.usig) {
              f.usig = usig;
              change(f.id, (d) => { d.uniforms = uniforms; });
            }
          }
          continue;
        }
        if (here.has(f.id)) del.push(f.id);
        flames.delete(sid);
      }
      for (const [sid, w] of want) {
        if (flames.has(sid)) continue;
        try {
          w.uniforms = flameValues(w, t);
          const item = flameItem(a, w, t);
          flames.set(sid, { id: item.id, sig: w.sig, at: { ...w.item.position }, wkey: w.wkey, nkey: w.nkey, usig: uniformSig(w.uniforms) });
          add.push(item);
          addedFlames.push(sid);
        } catch (e) {
          warn("lights: a flame could not be built", e);
        }
      }
    }

    // ---- darkvision: whatever the flame tier ----
    const dw = live ? dvWant(all) : null;
    for (const part of Object.keys(DV_PARTS)) {
      const rec = dv.get(part);
      if (!dw) {
        if (rec) {
          if (here.has(rec.id)) del.push(rec.id);
          dv.delete(part);
        }
        continue;
      }
      const uniforms = dw.uniforms[part];
      const usig = uniformSig(uniforms);
      const b = dw.plan.box;
      const geo = `${b.x},${b.y},${b.w},${b.h}`;
      if (!rec || !here.has(rec.id)) {
        if (rec) dv.delete(part);
        try {
          const item = dvItem(a, part, dw.plan, uniforms);
          dv.set(part, { id: item.id, geo, usig });
          add.push(item);
          addedDv.push(part);
        } catch (e) {
          warn("lights: darkvision could not be built", e);
        }
        continue;
      }
      const cur = localById.get(rec.id);
      const off = !cur || cur.position?.x !== b.x || cur.position?.y !== b.y || cur.width !== b.w || cur.height !== b.h;
      if (rec.geo !== geo || off) {
        change(rec.id, (d) => { d.width = b.w; d.height = b.h; d.position = { x: b.x, y: b.y }; d.uniforms = uniforms; });
      } else if (rec.usig !== usig) {
        change(rec.id, (d) => { d.uniforms = uniforms; });
      } else continue;
      rec.geo = geo;
      rec.usig = usig;
    }

    // Anything of ours (this host's) on the map that nothing here tracks any more: a delete or
    // an add that failed, a scene that kept its local items. It comes off too, so no flame is
    // ever left on a token nobody keeps an eye on (a monster hidden since, for one).
    const kept = new Set();
    for (const f of flames.values()) kept.add(f.id);
    for (const rec of dv.values()) kept.add(rec.id);
    const going = new Set(del);
    for (const i of local) {
      if (kept.has(i.id) || going.has(i.id)) continue;
      del.push(i.id);
      going.add(i.id);
    }

    // ---- the writes: what goes first, then what's new, then one update ----
    let failed = false;
    const fail = (what, e) => {
      failed = true;
      lastError = String(e?.message || e);
      warn(`lights: ${what} failed`, e);
    };
    if (del.length) {
      try {
        await OBR.scene.local.deleteItems(del);
      } catch (e) {
        fail("delete", e);
      }
    }
    if (add.length) {
      try {
        await OBR.scene.local.addItems(add);
      } catch (e) {
        for (const sid of addedFlames) flames.delete(sid);
        for (const part of addedDv) dv.delete(part);
        fail("add", e);
      }
    }
    if (upd.size) {
      try {
        await OBR.scene.local.updateItems([...upd.keys()], (drafts) => {
          for (const d of drafts) for (const f of upd.get(d.id) || []) f(d);
        });
      } catch (e) {
        for (const rec of dv.values()) if (upd.has(rec.id)) { rec.usig = ""; rec.geo = ""; }
        for (const f of flames.values()) if (upd.has(f.id)) { f.usig = ""; f.at = null; }
        fail("update", e);
      }
    }
    // A failed write is tried again shortly (not only on the next change: a flame left on a
    // monster hidden since mustn't wait for the DM's next move), while the scene is open.
    // (Twice as long each time it fails again, up to half a minute: a write Owlbear always refuses
    // costs one message now and then, never a stream.)
    orphans = failed;
    if (failed) tryAgain();
    else retryMs = RETRY_MS / 2;
    return { added: add.length, removed: del.length, updated: upd.size };
  }

  function tryAgain() {
    retryMs = Math.min(retryMs * 2, 30000);
    if (!sceneReady || retry) return;
    retry = clock.setTimeout(() => {
      retry = null;
      reconcile();
    }, retryMs);
  }

  // Reconciles run one at a time (a stop can't slip in while an add is on its way), and a
  // request while one is already waiting is the same request (a full one covers a dark one).
  let chain = Promise.resolve();
  let waiting = null;
  let waitingDark = null;
  function queue(job) {
    const run = chain.then(job);
    chain = run.catch((e) => {
      lastError = String(e?.message || e);
      warn("lights: reconcile failed", e);
    });
    return run.catch(() => ({ added: 0, removed: 0, updated: 0, error: true }));
  }
  function reconcile() {
    if (waiting) return waiting;
    waiting = queue(() => {
      waiting = null;
      return doReconcile().catch((e) => {
        tryAgain(); // (a read failed: nothing was written)
        throw e;
      });
    });
    return waiting;
  }
  function reconcileDark() {
    if (waiting) return waiting;
    if (waitingDark) return waitingDark;
    waitingDark = queue(() => {
      waitingDark = null;
      return doReconcile({ darkOnly: true }).catch((e) => {
        tryAgain();
        throw e;
      });
    });
    return waitingDark;
  }

  // The items this screen may show, out of the scene's items.
  function shownNow(items) {
    const byId = new Map();
    for (const i of items || []) if (i?.id != null) byId.set(i.id, i);
    const ids = new Set();
    for (const i of byId.values()) if (shows(i, byId)) ids.add(i.id);
    return { byId, ids };
  }

  // Something this screen showed just turned secret (the DM hid it, or what it's attached to):
  // its light comes off now, not after the settle, even while a reconcile that still saw it
  // shown is on its way (this one queues behind it). Compared with the last scene change seen,
  // so it costs one pass and only a hide sets it off.
  function turnedSecret(items) {
    if (role() === "GM") return false;
    const before = seen;
    const now = shownNow(items);
    seen = now.ids;
    const gone = (id) => now.byId.has(id) && !now.ids.has(id);
    if (before) {
      for (const id of before) if (gone(id)) return true;
      return false;
    }
    // nothing seen yet: what's drawn here
    for (const id of flames.keys()) if (gone(id)) return true;
    return false;
  }

  function onItems(items) {
    latest = Array.isArray(items) ? items : null;
    if (debounce) clock.clearTimeout(debounce);
    debounce = null;
    if (latest && turnedSecret(latest)) {
      reconcile();
      return;
    }
    // darkvision at once (a carried torch's colour moves with it), the flames once it settles
    reconcileDark();
    debounce = clock.setTimeout(() => {
      debounce = null;
      reconcile();
    }, SETTLE_MS);
  }

  function onReady(ready) {
    sceneReady = !!ready;
    latest = null;
    seen = null;
    gridStale = true;
    if (!ready) {
      // the scene's local items go with it (and any that stay are swept up when it's back)
      flames.clear();
      dv.clear();
      return;
    }
    readMeta().then(() => reconcile());
  }

  // The scene's lighting and the room's party senses, read now (and on every change, below).
  async function readMeta() {
    const { OBR } = await getApi();
    try { if (typeof OBR.scene?.getMetadata === "function") takeScene(await OBR.scene.getMetadata()); } catch (e) { /* not ready */ }
    try { if (typeof OBR.room?.getMetadata === "function") takeRoom(await OBR.room.getMetadata()); } catch (e) { /* an older Owlbear */ }
  }

  function unsubscribe() {
    for (const u of unsubs) { try { u(); } catch (e) { /* already gone */ } }
    unsubs = [];
    if (debounce) clock.clearTimeout(debounce);
    debounce = null;
  }

  let starts = 0; // a stop() during a start() that's still loading wins
  // Never rejects (background.js doesn't wait for it): a failure is kept for status().
  async function start() {
    const run = ++starts;
    try {
      const a = await getApi();
      if (run !== starts) return;
      const OBR = a.OBR;
      unsubscribe();
      active = true;
      latest = null;
      seen = null;
      gridStale = true;
      // Everything is drawn afresh: forget what an earlier start drew, and delete it and anything
      // an earlier copy of this page left, of this host only (on the Dell the other copy's are
      // its own business).
      await queue(async () => {
        flames.clear();
        dv.clear();
        try {
          const old = await OBR.scene.local.getItems((i) => i?.metadata?.[LIGHT_FX_KEY]?.host === host);
          if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id));
        } catch (e) { /* the scene isn't ready yet */ }
      });
      if (run !== starts) return;
      unsubs.push(OBR.scene.items.onChange(onItems));
      if (typeof OBR.scene.grid?.onChange === "function") {
        unsubs.push(OBR.scene.grid.onChange(() => {
          gridStale = true;
          reconcile();
        }));
      }
      // 🌑/☀ and auto-lights live on the scene, the party's darkvision on the room
      if (typeof OBR.scene.onMetadataChange === "function") {
        unsubs.push(OBR.scene.onMetadataChange((m) => { if (takeScene(m)) reconcile(); }));
      }
      if (typeof OBR.room?.onMetadataChange === "function") {
        unsubs.push(OBR.room.onMetadataChange((m) => { if (takeRoom(m)) reconcile(); }));
      }
      unsubs.push(OBR.scene.onReadyChange(onReady));
      try { sceneReady = !!(await OBR.scene.isReady()); } catch (e) { sceneReady = false; }
      if (run !== starts) return;
      if (sceneReady) {
        await readMeta();
        if (run !== starts) return;
        await reconcile();
      }
    } catch (e) {
      lastError = String(e?.message || e);
      warn("lights: start failed", e);
    }
  }

  // Step aside: no more subscriptions, everything we drew comes off. Nothing comes back (a
  // change, new settings) until start() runs again.
  function stop() {
    starts++;
    active = false;
    unsubscribe();
    return reconcile();
  }

  function setSettings(next) {
    if (!next || typeof next !== "object") return;
    const before = mode();
    // tier and quality_override are worked out afresh for each call, never kept from an older one
    settings = { ...settings, ...next, quality: { ...(settings.quality || {}), ...(next.quality || {}) },
      tier: next.tier, quality_override: next.quality_override };
    if (mode() !== before && (active || flames.size || dv.size || orphans)) reconcile();
  }

  function pcTokensChanged() {
    const s = pcSignature();
    if (s === pcSig) return;
    pcSig = s;
    if (role() !== "GM" && latest) seen = shownNow(latest).ids; // a PC let go of isn't a hide
    if (active) reconcile();
  }

  function status() {
    const t = tier();
    const on = active && t !== "off";
    return { on, tier: t, table: active && kind() === "table", flames: flames.size, rings: dv.size ? dvInfo.seers : 0,
      darkvision: { ...dvInfo, drawn: dv.size === 2, dim: dimFor(kind()) }, dropped, error: lastError };
  }

  return { start, stop, setSettings, pcTokensChanged, status, reconcile, idle: () => chain };
}
