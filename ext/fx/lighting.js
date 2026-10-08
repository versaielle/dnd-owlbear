// Lights on the map: a flickering flame for every token or item that carries a light, on every
// screen that draws (the GM tabs, the laptop, the projector's Cast receiver, the phones), and on
// the table screen only, a darkvision ring that leaves other light in colour in place of Smoke &
// Spectre's grey one. The looks and the SkSL are in fx/lights.js; which light a token carries is
// in its metadata (fx/lightmeta.js lightOf()), written by the 🔥 Light menu and the spell lights.
//
//   const lights = createLights(api, ctx);   every copy, at boot (background.js)
//   lights.setSettings(next)   the panel's settings + {kind, tier, quality_override} (may come
//                              before start(); tier is "off" on a copy that only relays)
//   lights.start()             this copy draws here: draw, and keep drawing as the scene changes
//   lights.stop()              step aside: everything we drew comes off, Smoke's rings come back
//   lights.pcTokensChanged()   ctx.pcTokens was refreshed (a hidden PC's light may show now)
//   lights.status()            {on, tier, table, flames, rings, hidden, dropped, error, leader}
//
// Everything drawn here is LOCAL (OBR.scene.local): nothing is saved in the room, and no write of
// ours fires scene.items.onChange (which would start Smoke's full run on every client). The one
// exception is the torch guard at the end (GM screens, one GM at a time).
//
// A flame is one STANDALONE effect, two reaches wide, centred on the item and attached to it, so
// Owlbear moves it with the item and deletes it with the item; it's only updated to put it back
// on its item (one added just as the item moved), and for its uniforms below (a "full" flame's
// flicker is Owlbear's own time uniform). Its VISIBLE behaviour is off, so a hidden PC's torch
// still shows on the projector; that makes the R1 check below (ctx.isPublic, and what the item is
// attached to) the only thing keeping a hidden monster's torch off a player's screen: anything of
// ours that nothing tracks any more (a write that failed) is swept up, and a failed write is tried
// again. It sits on the ATTACHMENT layer with a small fixed z-index: above the tokens, under the
// fog, so the fog hides it wherever nobody sees.
//
// A flame stops at walls: the Smoke & Spectre lines that block (walls, closed doors; not windows,
// not open doors) within its reach go into its uniforms (WALL_SLOTS of them, the nearest), as
// segments in the flame's own square, so its glow doesn't spill into the next room. They're
// measured from where the light stands, so a carried torch gets them again (one uniforms update)
// once it has moved a quarter of a square, or when a wall near it changes (a door opens).
// Flames that overlap flicker less, each by 1/sqrt(how many reach it), so a crowd of torches
// doesn't add up to a flicker past the projector's 10% budget.
//
// The darkvision ring (table screen only): Smoke keeps a LOCAL grey ring (an effect with blend
// SATURATION) on each token whose darkvision reaches past its sight, and greys the whole ring,
// even where another token's sight or a torch lights it. We draw ours with the same size, place
// and layer, attached to the same token, with up to 8 lit circles left in colour, and hide
// Smoke's (visible = false sticks: Smoke never writes `visible` on its rings, it only re-creates
// them with new ids, so every local change is checked). Only ever a ring we draw a replacement
// for: one whose token this screen can't show yet (a hidden PC before the heartbeat names it)
// keeps Smoke's grey ring, and one we hid earlier that loses its replacement is shown again.
// Smoke's rings are never deleted (it would just make them again) and its LIGHT items are never
// touched (it rewrites their visible). Only the table listens to local changes (each one hands
// this page every local item, shaders and all), and only while it draws.
import { LIGHT_FX_KEY, SMOKE } from "../keys.js?v=b6b85c2-d73ac97";
import { FLAME_BLEND, WALL_SLOTS, darkvisionShader, darkvisionUniforms, flameShader, flameUniforms } from "./lights.js?v=b6b85c2-d73ac97";
import { applyLight, lightChanges, lightOf } from "./lightmeta.js?v=b6b85c2-d73ac97";
import { finite, gridOf, rotate } from "./place.js?v=b6b85c2-d73ac97";
import { customUniforms, fillUniforms } from "./shaders.js?v=b6b85c2-d73ac97";

export const MAX_FLAMES = 12; // flames per screen: each full one makes Owlbear redraw every frame
export const LIGHT_Z = 1; // on ATTACHMENT: above the tokens, under rings and badges (auto z-indexes are timestamps)
const SETTLE_MS = 150; // scene changes: reconcile once they've settled (a drag fires many)
const RETRY_MS = 2000; // a local write that failed is tried again after this (then longer)
const MAX_PX = 40000;
const WALL_MOVE = 0.05; // squares a carried light moves before its walls are measured again (shadows stay within 3 in.)
const TIERS = ["full", "lite", "off"];
const RING_KEY = `${SMOKE}/isDarkVision`; // on Smoke's local darkvision ring
const VISION_LIGHT_KEY = `${SMOKE}/isVisionLight`; // on Smoke's local light for a vision token
const SK = (name) => `${SMOKE}/${name}`;
const LINE_KEY = SK("isVisionLine"); // on a Smoke & Spectre line (wall, door, window) in the scene
// Our ring follows the token; nothing of the token's own visibility, size or turn carries over.
const DETACHED = ["VISIBLE", "SCALE", "ROTATION", "COPY"];

const isSmokeRing = (i) => i?.metadata?.[RING_KEY] === true;
const isSmokeLight = (i) => i?.metadata?.[VISION_LIGHT_KEY] === true;
const toInt = (v) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : null;
};
// One uniform's value on an effect item ([{name, value}]), or null.
function uniformOf(item, name) {
  for (const u of item?.uniforms || []) if (u?.name === name) return typeof u.value === "number" ? u.value : null;
  return null;
}
// The middle of Smoke's ring on the map. Owlbear turns (and scales) an effect about its
// `position`, its top-left corner, so a ring that turned with its token has its position swung
// round while its middle stays on the token.
function ringCentre(r) {
  const sx = finite(r.scale?.x) ? r.scale.x : 1, sy = finite(r.scale?.y) ? r.scale.y : 1;
  const c = rotate({ x: (r.width / 2) * sx, y: (r.height / 2) * sy }, finite(r.rotation) ? r.rotation : 0);
  return { x: r.position.x + c.x, y: r.position.y + c.y };
}
// A uniform list as a string, to tell whether it changed (numbers to 4 places).
const uniformSig = (u) => JSON.stringify(u, (k, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v));

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
    const sdk = await import("../obr-sdk.js?v=b6b85c2-d73ac97");
    return { OBR: sdk.default, buildEffect: sdk.buildEffect, MathM: sdk.MathM, ...api };
  })().then((a) => {
    full = a;
    return a;
  });
  const getApi = () => loading;

  // ---- settings: the same precedence as the FX engine's tier() ----
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
  const mode = () => `${tier()}|${kind() === "table"}`;

  // R1: on a screen that isn't a GM's, a hidden item that isn't a PC is never drawn and never
  // gives away where it is. The item itself is passed, so its own `visible` decides. An item
  // attached to a hidden one (a torch prop on a hidden monster) is hidden with it on a player's
  // screen unless it doesn't take its parent's visibility, so with the scene's items (`byId`)
  // its parents decide too; a PC is always public, whatever it's attached to.
  function isPublicItem(item) {
    if (ctx.pcTokens?.has?.(item.id)) return true;
    try {
      if (typeof ctx.isPublic === "function") return !!ctx.isPublic(item.id, item);
    } catch (e) { return false; }
    return item.visible !== false;
  }
  const shows = (item, byId = null) => role() === "GM" || isPublicChain(item, byId);
  // Would a player's screen show this item? (Whoever's screen this is: the torch guard asks it
  // on a GM's.)
  function isPublicChain(item, byId) {
    let i = item;
    for (let n = 0; n < 8; n++) {
      if (!i || !isPublicItem(i)) return false;
      if (ctx.pcTokens?.has?.(i.id)) return true;
      const up = i.attachedTo;
      const own = Array.isArray(i.disableAttachmentBehavior) && i.disableAttachmentBehavior.includes("VISIBLE");
      if (up == null || own || !byId) return true;
      i = byId.get(up);
      if (!i) return true; // the parent is gone (Owlbear deletes its attachments with it)
    }
    return false; // attached that deep (or in a loop): fail closed
  }
  const pcSignature = () => [...(ctx.pcTokens || [])].map(String).sort().join(",");

  // ---- what's drawn ----
  // source item id -> {id, sig, at (where the light stood when its walls were measured), wkey
  // (which walls), amp, usig (its uniforms as last written)}
  const flames = new Map();
  const rings = new Map(); // Smoke ring id -> {id, src (its token), key, geo, usig}
  const hid = new Set(); // Smoke rings hidden while this screen is the table (ours to show again)
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
  let smokeSeen = ""; // Smoke's local items as last seen (the table's short-circuit)
  let pcSig = pcSignature();
  let unsubs = [];
  let offLocal = null; // the table's scene.local.onChange subscription, while it draws
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
      { seed: seedOf(w.item.id), ftPerCell: G.ftPerCell, ampScale: w.amp, walls: w.walls }), warn);
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

  const DARK = darkvisionShader();
  const DARK_DECL = customUniforms(DARK);

  function ringItem(a, w) {
    const r = w.r;
    return a.buildEffect()
      .effectType("STANDALONE")
      .sksl(DARK)
      .uniforms(w.uniforms)
      .blendMode("SATURATION")
      .width(w.w).height(w.h)
      .position({ ...w.at }) // unturned, around the middle of Smoke's ring
      .attachedTo(r.attachedTo)
      .disableAttachmentBehavior(DETACHED)
      .layer(r.layer || "POPOVER").zIndex(finite(r.zIndex) ? r.zIndex : clock.wall()).disableAutoZIndex(true)
      .locked(true).disableHit(true)
      .name("dnd-npc darkvision")
      .metadata({ [LIGHT_FX_KEY]: { source: r.attachedTo, host, part: "ring", ring: r.id } })
      .build();
  }

  // Make what's on this screen match the scene: the flames, and on the table the rings. Writes
  // only what differs (at most one local update, one delete and one add), so a change that comes
  // back to us through scene.local.onChange finds nothing to do.
  async function doReconcile() {
    const t = tier();
    const draw = active && sceneReady && t !== "off";
    const table = draw && kind() === "table";
    if (!draw && !flames.size && !rings.size && !hid.size && !orphans) {
      noteDropped([]);
      return { added: 0, removed: 0, updated: 0 };
    }
    const a = await getApi();
    const OBR = a.OBR;
    let all = [];
    if (draw) {
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
    // Smoke's rings and lights on this client, and what of ours is still there (a flame goes
    // with its item when the item is deleted)
    const local = await OBR.scene.local.getItems((i) => isSmokeRing(i) || isSmokeLight(i)
      || i?.metadata?.[LIGHT_FX_KEY]?.host === host);
    const here = new Set(local.map((i) => i.id));
    const byId = new Map(all.map((i) => [i.id, i]));
    const pcs = ctx.pcTokens || new Set();

    // ---- flames: every light this screen may see, the PCs' first, at most MAX_FLAMES ----
    const shown = [];
    const want = new Map(); // source id -> {item, light, S, sig, amp, walls, wkey}
    if (draw) {
      all.forEach((item, n) => {
        const light = lightOf(item?.metadata);
        if (!light || !(light.reach > 0) || !finite(item.position?.x, item.position?.y)) return;
        if (!shows(item, byId)) return;
        shown.push({ item, light, pc: pcs.has(item.id), n });
      });
      const order = [...shown].sort((x, y) => (x.pc === y.pc ? x.n - y.n : x.pc ? -1 : 1));
      for (const c of order.slice(0, MAX_FLAMES)) {
        const S = Math.min(c.light.reach * 2 * G.pxPerFt, MAX_PX);
        if (!finite(S) || S <= 0) continue;
        want.set(c.item.id, { ...c, S, sig: `${c.light.kind}|${t}|${Math.round(S)}|${G.ftPerCell}` });
      }
      noteDropped(order.slice(MAX_FLAMES));
      // Overlapping flames add their flicker up: each flickers by 1/sqrt(n), n = itself and every
      // other flame here whose centre is within its reach
      const drawn = [...want.values()];
      for (const w of drawn) {
        let n = 1;
        for (const o of drawn) {
          if (o !== w && Math.hypot(o.item.position.x - w.item.position.x, o.item.position.y - w.item.position.y) <= w.S / 2) n++;
        }
        w.amp = 1 / Math.sqrt(n);
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
    const del = [], add = [], addedFlames = [], addedRings = [];
    // item id -> [(draft) => void]: every change to one of ours (or to Smoke's ring) in one update
    const upd = new Map();
    const change = (id, f) => {
      const l = upd.get(id);
      if (l) l.push(f);
      else upd.set(id, [f]);
    };
    const localById = new Map(local.map((i) => [i.id, i]));
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
        if (moved || w.wkey !== f.wkey || w.amp !== f.amp) {
          const uniforms = flameValues(w, t);
          const usig = uniformSig(uniforms);
          f.at = pos;
          f.wkey = w.wkey;
          f.amp = w.amp;
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
        flames.set(sid, { id: item.id, sig: w.sig, at: { ...w.item.position }, wkey: w.wkey, amp: w.amp, usig: uniformSig(w.uniforms) });
        add.push(item);
        addedFlames.push(sid);
      } catch (e) {
        warn("lights: a flame could not be built", e);
      }
    }

    // ---- the table's darkvision rings ----
    const smokeRings = local.filter(isSmokeRing);
    if (table) {
      // hidden already (by us, before a reload): ours to show again unless ours replaces it
      for (const r of smokeRings) if (r.visible === false) hid.add(r.id);
    }
    const wantRings = new Map(); // Smoke ring id -> {r, w, h, key, geo, uniforms, usig}
    if (table) {
      for (const r of smokeRings) {
        const tok = byId.get(r.attachedTo);
        if (!tok || !shows(tok, byId)) continue;
        const w = Number(r.width), h = Number(r.height);
        if (!finite(w, h, r.position?.x, r.position?.y) || w <= 0 || h <= 0) continue;
        const c = ringCentre(r);
        if (!finite(c.x, c.y)) continue;
        wantRings.set(r.id, { r, tok, w, h, c, at: { x: c.x - w / 2, y: c.y - h / 2 },
          key: `${r.layer}|${r.zIndex}|${r.attachedTo}`, geo: `${w}x${h}` });
      }
    }
    if (wantRings.size) {
      // The lit circles: every Smoke light on another public token (its sight), and every public
      // light's whole reach; one per token, the bigger. Positions in steps of half a foot, so a
      // token nudged by a pixel writes nothing.
      const q = Math.max(0.5 * G.pxPerFt, 1);
      const Q = (v) => Math.round(v / q) * q;
      const circles = new Map(); // token id -> {x, y, r}
      const put = (tok, r) => {
        if (!(r > 0) || !finite(tok.position?.x, tok.position?.y)) return;
        const had = circles.get(tok.id);
        if (!had || had.r < r) circles.set(tok.id, { x: Q(tok.position.x), y: Q(tok.position.y), r });
      };
      for (const l of local) {
        if (!isSmokeLight(l) || l.attachedTo == null) continue;
        const tok = byId.get(l.attachedTo);
        if (!tok || !shows(tok, byId)) continue;
        const m = l.metadata;
        const ft = m[SK("visionBlind")] === true ? 0 : toInt(m[SK("visionRange")]);
        put(tok, (ft || 0) * G.pxPerFt);
      }
      for (const c of shown) put(c.item, c.light.reach * G.pxPerFt);
      for (const [, w] of wantRings) {
        // the lit circles are measured from the ring's own middle (what the shader draws about),
        // wherever Smoke put it on the token
        const cx = Q(w.c.x);
        const cy = Q(w.c.y);
        const darkPx = w.w / 2;
        const clear = uniformOf(w.r, "clear");
        const sightPx = clear != null ? clear * w.w : (toInt(w.tok.metadata?.[SK("visionRange")]) || 0) * G.pxPerFt;
        const lits = [];
        for (const [id, c] of circles) {
          // inside its own sight anyway (give or take Smoke's rounding: clear * width comes back
          // a hair under the range, and the token's own sight would take the first lit slot)
          if (id === w.tok.id && c.r <= sightPx + 1) continue;
          lits.push({ dx: c.x - cx, dy: c.y - cy, r: c.r });
        }
        w.uniforms = fillUniforms(DARK_DECL, darkvisionUniforms(sightPx, darkPx, lits, { softFt: 1.5 * G.pxPerFt }), warn);
        w.usig = uniformSig(w.uniforms);
      }
    }
    for (const [sid, rec] of rings) {
      const w = wantRings.get(sid);
      if (w && w.key === rec.key && here.has(rec.id)) continue;
      if (here.has(rec.id)) del.push(rec.id);
      rings.delete(sid);
    }
    for (const [sid, w] of wantRings) {
      const rec = rings.get(sid);
      if (!rec) {
        try {
          const item = ringItem(a, w);
          rings.set(sid, { id: item.id, src: w.tok.id, key: w.key, geo: w.geo, usig: w.usig });
          add.push(item);
          addedRings.push(sid);
        } catch (e) {
          warn("lights: a darkvision ring could not be built", e);
        }
        continue;
      }
      // Smoke resized its ring (the darkvision changed), or ours isn't on it (added just as the
      // token moved: both follow the token, so they're compared in the same look at the map)
      const mine = localById.get(rec.id)?.position;
      const off = !mine || !finite(mine.x, mine.y) || Math.hypot(mine.x - w.at.x, mine.y - w.at.y) > 1;
      if (rec.geo !== w.geo || off) {
        const pos = { ...w.at };
        change(rec.id, (d) => { d.width = w.w; d.height = w.h; d.position = pos; d.uniforms = w.uniforms; });
      } else if (rec.usig !== w.usig) {
        change(rec.id, (d) => { d.uniforms = w.uniforms; });
      } else continue;
      rec.geo = w.geo;
      rec.usig = w.usig;
    }
    // Smoke's grey ring is hidden only where ours replaces it (drawn already, or added in this
    // same pass); one we hid that has no replacement any more (its token can't be shown here, or
    // this screen stopped being the table) is shown again. One that's gone, or that something
    // else showed already, is simply forgotten.
    let hide = [];
    const unhide = [];
    for (const r of smokeRings) if (rings.has(r.id) && r.visible !== false) hide.push(r.id);
    for (const id of [...hid]) {
      if (localById.get(id)?.visible !== false) hid.delete(id);
      else if (!rings.has(id)) unhide.push(id);
    }
    for (const id of hide) change(id, (d) => { d.visible = false; });
    for (const id of unhide) change(id, (d) => { d.visible = true; });

    // Anything of ours (this host's) on the map that nothing here tracks any more: a delete or
    // an add that failed, a scene that kept its local items. It comes off too, so no flame is
    // ever left on a token nobody keeps an eye on (a monster hidden since, for one).
    const kept = new Set();
    for (const f of flames.values()) kept.add(f.id);
    for (const rec of rings.values()) kept.add(rec.id);
    const going = new Set(del);
    for (const i of local) {
      if (i?.metadata?.[LIGHT_FX_KEY]?.host !== host || kept.has(i.id) || going.has(i.id)) continue;
      del.push(i.id);
      going.add(i.id);
    }

    // ---- the writes: what goes first, then what's new, then one update (so Smoke's grey ring
    // is only hidden once ours is on the map) ----
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
        for (const sid of addedRings) {
          rings.delete(sid);
          upd.delete(sid); // no ring of ours for it: Smoke's isn't hidden...
          // ...and one we hid before (ours was being made again: Smoke moved its ring to another
          // z-index, say) is shown again until ours is back, never left hidden with nothing on it
          if (hid.has(sid) && localById.get(sid)?.visible === false) {
            change(sid, (d) => { d.visible = true; });
            unhide.push(sid);
          }
        }
        hide = hide.filter((id) => upd.has(id));
        fail("add", e);
      }
    }
    if (upd.size) {
      try {
        await OBR.scene.local.updateItems([...upd.keys()], (drafts) => {
          for (const d of drafts) for (const f of upd.get(d.id) || []) f(d);
        });
        for (const id of hide) hid.add(id);
        for (const id of unhide) hid.delete(id);
      } catch (e) {
        for (const rec of rings.values()) if (upd.has(rec.id)) { rec.usig = ""; rec.geo = ""; }
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
  // request while one is already waiting is the same request.
  let chain = Promise.resolve();
  let waiting = null;
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

  // The items this screen may show, out of the scene's items.
  function shownNow(items) {
    const byId = new Map();
    for (const i of items || []) if (i?.id != null) byId.set(i.id, i);
    const ids = new Set();
    for (const i of byId.values()) if (shows(i, byId)) ids.add(i.id);
    return { byId, ids };
  }

  // Something this screen showed just turned secret (the DM hid it, or what it's attached to):
  // its light, its ring and its lit circle come off now, not after the settle, even while a
  // reconcile that still saw it shown is on its way (this one queues behind it). Compared with
  // the last scene change seen, so it costs one pass and only a hide sets it off.
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
    for (const rec of rings.values()) if (gone(rec.src)) return true;
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
    debounce = clock.setTimeout(() => {
      debounce = null;
      reconcile();
      guardTorches();
    }, SETTLE_MS);
  }

  // Smoke's rings and lights as a string, without positions (they follow the tokens). Called on
  // every local change, ~30 times a second while an effect plays: one pass, and a no-op unless
  // something of Smoke's came, went or changed.
  function smokeSig(items) {
    let s = "";
    for (const i of items || []) {
      const m = i?.metadata;
      if (!m) continue;
      if (m[RING_KEY] === true) {
        s += `R${i.id}:${i.visible === false ? 0 : 1}:${i.width}x${i.height}:${i.layer}:${i.zIndex}:${i.attachedTo}:${uniformOf(i, "clear")};`;
      } else if (m[VISION_LIGHT_KEY] === true) {
        s += `L${i.id}:${i.attachedTo}:${m[SK("visionRange")]}:${m[SK("visionBlind")] === true ? 1 : 0};`;
      }
    }
    return s;
  }

  function onLocal(items) {
    if (!active || !sceneReady || kind() !== "table" || tier() === "off") return;
    const sig = smokeSig(items);
    if (sig === smokeSeen) return;
    smokeSeen = sig;
    reconcile();
  }

  // Only the table listens to local changes (Smoke's rings are made, re-made and resized there),
  // and only while it draws: every local change hands each listener the whole local list,
  // shaders and all, ~30 times a second while an effect plays.
  function watchLocal() {
    const on = active && !!full && kind() === "table" && tier() !== "off";
    if (on && !offLocal) {
      smokeSeen = "";
      try {
        offLocal = full.OBR.scene.local.onChange(onLocal);
      } catch (e) {
        warn("lights: can't follow Smoke's rings", e);
      }
    } else if (!on && offLocal) {
      try { offLocal(); } catch (e) { /* already gone */ }
      offLocal = null;
    }
  }

  function onReady(ready) {
    sceneReady = !!ready;
    latest = null;
    seen = null;
    gridStale = true;
    smokeSeen = "";
    if (!ready) {
      // the scene's local items go with it (and any that stay are swept up when it's back)
      flames.clear();
      rings.clear();
      hid.clear();
      return;
    }
    reconcile();
    guardTorches();
  }

  // ---- the torch guard (GM screens, one GM at a time) ----
  // Smoke & Spectre lights the fog around every torch a GM made on every player's screen, hidden
  // or not, so a hidden goblin with a torch (or a sconce the DM hid) would show where it stands.
  // lightmeta.js gives a SECRET token (hidden, and not a PC) no Smoke torch keys, but only when
  // something writes its light, and hiding a token writes nothing of ours. So one GM screen
  // watches: when the scene's items settle, every lit token whose keys aren't what applyLight()
  // would write now (hidden since, or shown again) is put right, all of them in one write. The
  // one that watches leads: the GM connection with the lowest id (on the Dell both copies share
  // one connection, and only the one that draws runs this), so two GM tabs never write the same
  // change twice. It watches whatever the lights tier is: it keeps a secret, it draws nothing.
  let myConn = null;
  let otherGms = new Set(); // the other GM connections in the room
  let leader = false;
  let guardWaiting = null;
  let guardRetry = null;
  let guardAt = 0; // when the guard last wrote (clock.now())
  let guardIds = new Set(); // ...which tokens
  let guardGap = 0; // how long after that they may be written again: 0 once a look found everything in line

  function leads() {
    if (!active || role() !== "GM" || !myConn) return false;
    for (const c of otherGms) if (c < myConn) return false;
    return true;
  }

  function onParty(players) {
    otherGms = new Set();
    for (const p of players || []) {
      const c = p?.connectionId == null ? "" : String(p.connectionId);
      if (p?.role === "GM" && c && c !== myConn) otherGms.add(c);
    }
    const was = leader;
    leader = leads();
    if (leader === was) return;
    log(leader ? "lights: this GM screen keeps hidden torches dark" : "lights: another GM screen keeps hidden torches dark");
    if (leader) guardTorches();
  }

  // A token's light options as applyLight() takes them: a PC carries its light whatever; any
  // other token is secret while a player's screen wouldn't show it (hidden itself, or through
  // what it's attached to).
  function guardOpts(item, byId) {
    const pc = !!ctx.pcTokens?.has?.(item.id);
    return { pc, secret: !pc && !isPublicChain(item, byId) };
  }

  // Look again after `ms`.
  function guardLater(ms) {
    if (guardRetry || !sceneReady) return;
    guardRetry = clock.setTimeout(() => {
      guardRetry = null;
      guardTorches();
    }, ms);
  }

  async function doGuard() {
    if (!active || !leader || !sceneReady) return { wrote: 0 };
    try {
      const { OBR } = await getApi();
      // the items the last change handed us (a write of ours comes back as one, so it's seen)
      const items = latest || await OBR.scene.items.getItems();
      const byId = new Map(items.map((i) => [i.id, i]));
      const due = new Map(); // token id -> options
      for (const i of items) {
        if (!lightOf(i?.metadata)) continue;
        const o = guardOpts(i, byId);
        if (lightChanges(i.metadata, {}, o)) due.set(i.id, o);
      }
      if (!due.size) {
        guardGap = 0;
        return { wrote: 0 };
      }
      // A token written a moment ago that no look since found in line (our write isn't back yet,
      // or something keeps putting it back): it waits, and is looked at again once the wait is
      // over, a wait that doubles each time, so it's never a write -> change -> write loop. A
      // token that wasn't in that write (a second goblin hidden just after the first) doesn't
      // wait behind it, even while something fights over the first: it goes now, and waits with
      // the others from then on.
      const wait = guardAt + guardGap - clock.now();
      const held = guardGap > 0 && wait > 0 ? [...due.keys()].filter((id) => guardIds.has(id)) : [];
      if (held.length) {
        guardLater(wait);
        for (const id of held) due.delete(id);
        if (!due.size) return { wrote: 0 };
      }
      const again = !held.length && guardGap > 0 && [...due.keys()].some((id) => guardIds.has(id));
      if (!active || !leader) return { wrote: 0 };
      await OBR.scene.items.updateItems([...due.keys()], (drafts) => {
        for (const d of drafts) if (due.has(d.id)) applyLight(d.metadata, {}, guardOpts(d, byId));
      });
      if (held.length) {
        for (const id of due.keys()) guardIds.add(id);
      } else {
        guardAt = clock.now();
        guardGap = again ? Math.min(guardGap * 2, 30000) : RETRY_MS / 2;
        guardIds = new Set(due.keys());
      }
      const names = [...due.keys()].map((id) => byId.get(id)?.name || id);
      log(`lights: Smoke's light brought in line (hidden or shown since): ${names.join(", ")}`);
      return { wrote: due.size };
    } catch (e) {
      lastError = String(e?.message || e);
      warn("lights: hidden torches couldn't be put right", e);
      guardLater(RETRY_MS);
      return { wrote: 0, error: true };
    }
  }

  function guardTorches() {
    if (!active || !leader || !sceneReady) return Promise.resolve({ wrote: 0 });
    if (guardWaiting) return guardWaiting;
    guardWaiting = queue(() => {
      guardWaiting = null;
      return doGuard();
    });
    return guardWaiting;
  }

  function unsubscribe() {
    for (const u of unsubs) { try { u(); } catch (e) { /* already gone */ } }
    unsubs = [];
    if (offLocal) {
      try { offLocal(); } catch (e) { /* already gone */ }
      offLocal = null;
    }
    if (debounce) clock.clearTimeout(debounce);
    debounce = null;
    if (guardRetry) clock.clearTimeout(guardRetry);
    guardRetry = null;
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
      leader = false;
      latest = null;
      seen = null;
      gridStale = true;
      smokeSeen = "";
      // Everything is drawn afresh: forget what an earlier start drew, and delete it and anything
      // an earlier copy of this page left, of this host only (on the Dell the other copy's are
      // its own business).
      await queue(async () => {
        flames.clear();
        rings.clear();
        try {
          const old = await OBR.scene.local.getItems((i) => i?.metadata?.[LIGHT_FX_KEY]?.host === host);
          if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id));
        } catch (e) { /* the scene isn't ready yet */ }
      });
      if (run !== starts) return;
      unsubs.push(OBR.scene.items.onChange(onItems));
      watchLocal();
      if (typeof OBR.scene.grid?.onChange === "function") {
        unsubs.push(OBR.scene.grid.onChange(() => {
          gridStale = true;
          reconcile();
        }));
      }
      unsubs.push(OBR.scene.onReadyChange(onReady));
      try { sceneReady = !!(await OBR.scene.isReady()); } catch (e) { sceneReady = false; }
      if (run !== starts) return;
      if (role() === "GM") {
        // which GM screen keeps hidden torches dark (the lowest connection id)
        try {
          myConn = String((await OBR.player.getConnectionId()) || ctx.conn || "") || null;
        } catch (e) {
          myConn = ctx.conn ? String(ctx.conn) : null;
        }
        let players = [];
        try {
          if (typeof OBR.party?.onChange === "function") unsubs.push(OBR.party.onChange(onParty));
          players = (await OBR.party?.getPlayers?.()) || [];
        } catch (e) { /* no party list: this screen is the only GM it knows of */ }
        if (run !== starts) return;
        onParty(players);
      }
      if (sceneReady) {
        await reconcile();
        await guardTorches();
      }
    } catch (e) {
      lastError = String(e?.message || e);
      warn("lights: start failed", e);
    }
  }

  // Step aside: no more subscriptions, everything we drew comes off and Smoke's rings come back.
  // Nothing comes back (a change, new settings) until start() runs again.
  function stop() {
    starts++;
    active = false;
    leader = false;
    unsubscribe();
    return reconcile();
  }

  function setSettings(next) {
    if (!next || typeof next !== "object") return;
    const before = mode();
    // tier and quality_override are worked out afresh for each call, never kept from an older one
    settings = { ...settings, ...next, quality: { ...(settings.quality || {}), ...(next.quality || {}) },
      tier: next.tier, quality_override: next.quality_override };
    if (mode() !== before) {
      smokeSeen = "";
      watchLocal();
      if (active || flames.size || rings.size || hid.size || orphans) reconcile();
    }
  }

  function pcTokensChanged() {
    const s = pcSignature();
    if (s === pcSig) return;
    pcSig = s;
    if (role() !== "GM" && latest) seen = shownNow(latest).ids; // a PC let go of isn't a hide
    if (active) {
      reconcile();
      guardTorches();
    }
  }

  function status() {
    const t = tier();
    const on = active && t !== "off";
    return { on, tier: t, table: on && kind() === "table", flames: flames.size, rings: rings.size,
      hidden: hid.size, dropped, error: lastError, leader };
  }

  return { start, stop, setSettings, pcTokensChanged, status, reconcile, idle: () => chain };
}
