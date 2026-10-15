// Explored memory, drawn (docs/vision-layer-spec.md section 6, "Drawing it", Plan A from spike S2;
// B4's contract is docs/vision-layer-b4.md section 5, and from Phase 1 docs/vision-layer-2024.md
// section 6, the smooth memory and its look): on EVERY screen, while 🌫 Our fog is on, a few LOCAL
// items on the FOG layer per map whose mode (fog/maps.js mapStates: fog/mode.js fogMode from its
// darkness, kind, remembered building and the DM's override) keeps what the party has seen. The
// spike found FOG-layer local items opaque to players: they act as fog, hide the tokens under them,
// and the party's PRIMARY lights (zIndex 0) cut through them, so live sight shows the real map and
// its creatures while the remembered parts show only the picture, dimmed.
//
//   "fog"    nothing (the scene's own fog, cut by the party's lights)
//   "dim"    (a) the map's picture, (b) a dim layer over the map's WHOLE rectangle, in the scene's
//            fog colour at the memory shade, (c) the scene's fog colour over everything not yet
//            explored: the map's rectangle with the explored memory's rings (EXPLORED_KEY, the
//            exact sight shapes, fog/shapes.js) cut out, even-odd. The chip calls it "remembered".
//            A stored "lit" (B4's) draws exactly the same (decision 69)
//   "clear"  (a) and (b) only: the whole map shown, dimmed; no cut, no light, no edge ring
//            (decision 72): creatures show only where a PC's sight light reaches
//   a "dim" map with no explored memory yet, or a map the DM hid: nothing. Squares (SEEN_KEY) are
//   never drawn: a map explored only under B4's squares shows no memory until it's seen again
//
//   SHADES, DEFAULT_SHADE   the memory shade's three values (0.55 lighter, 0.65 medium, 0.75 darker)
//                        and the one a scene starts at
//   shadeOf(sceneMeta)   FOG_LOOK_KEY.shade when it's one of SHADES, else DEFAULT_SHADE. The shade's
//                        one reader (the 🔥 Lighting list's row reads it from here too)
//   cutPath(rect, holes) {position, commands}: rect's outline, then each hole ring's (fog/shapes.js
//                        holeRings: [{x, y}, ...] in scene px), as Path commands relative to position
//                        (MOVE 0, LINE 1, CLOSE 5), for fillRule "evenodd": a hole inside a hole
//                        fills again (an unseen pillar's shadow inside a seen room)
//   memoryInputSig(snap, {fogColor})   what the plan depends on: per map its id, mode, hidden,
//                        rectangle, transform, image and ("dim" only) its EXPLORED_KEY value; the
//                        memory shade and the fog colour. Unchanged: no plan is built, Owlbear is
//                        asked nothing
//   memoryPlan(snap, {fogColor, gm, memoryOnGm, dimOpacity})   the item specs (pure): [{key, map,
//                        part, make, sig, ...the part's own}]. key "<part>:<map id>": at most 3 per
//                        map. dimOpacity: this device's flag (a number 0-1) or nothing (the shade)
//   createMemory(api, ctx) -> {sync(snap), clear(), forget(), status()}
//
// A spec's `make` is what the item can't change without being made again (the picture's file and
// size); `sig` is everything it's drawn from. A part whose make holds and whose sig changed is one
// update (the cut's holes or colour, the picture's place, the dim layer's size, colour or shade),
// never a delete and an add. Each sync makes at most one deleteItems, one addItems and one
// updateItems, and none at all when the input or the plan is unchanged. It reads its own items back
// (tagged FOG_LOCAL_KEY {kind: "memory", key, sig, make, host, map, part}) only on its first sync,
// after clear(), forget() or a failed write; fog.js retries a failure. Local items only: nothing
// here writes the scene.
//
// ctx (fog.js partCtx): host, isGm, log(text, kind), memoryOnGm (false: this GM screen draws no
// memory, the live-check flag of b4 section 9), optionally dimOpacity (a number 0-1, or a function
// giving one, read on every sync: this device's "dnd-npc/fog-dim" flag, which beats the scene's
// shade on a GM screen only, for testing; a player's screen and the projector always follow the
// shade; anything else: the scene's shade). api: {OBR, buildImage, buildShape, buildPath}.

import { EXPLORED_KEY, FOG_LOCAL_KEY, FOG_LOOK_KEY } from "../keys.js?v=af4de9c";
import { exploredFor } from "./maps.js?v=af4de9c";
import { drawnMode } from "./mode.js?v=af4de9c";
import { holeRings } from "./shapes.js?v=af4de9c";

export const MEMORY_LAYER = "FOG";
export const MEMORY_IMAGE_Z = -3; // (a) the map's own picture
export const MEMORY_DIM_Z = -2; // (b) the dim layer over it
export const MEMORY_CUT_Z = -1; // (c) the fog over everything not yet explored ("dim" only)
export const SHADES = [0.55, 0.65, 0.75]; // the "Memory shade" row: lighter, medium, darker
export const DEFAULT_SHADE = 0.65;
export const DEFAULT_FOG_COLOR = "#000000";

const KIND = "memory";
const NAME = "dnd-npc memory";
const MOVE = 0, LINE = 1, CLOSE = 5; // Path commands (as aim/tool.js)
const SAID = { dim: "remembered", clear: "clear" }; // the chips' words, for the live log

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0
const isPt = (p) => !!p && finite(p.x, p.y);
const pt = (p) => (isPt(p) ? { x: r2(p.x), y: r2(p.y) } : { x: 0, y: 0 });
const rectOk = (r) => !!r && finite(r.x0, r.y0, r.x1, r.y1) && r.x1 > r.x0 && r.y1 > r.y0;
const flagOf = (x) => (finite(x) && x >= 0 && x <= 1 ? r2(x) : null); // the device flag, or null
const colourOf = (c) => (typeof c === "string" && c.trim() ? c.trim() : DEFAULT_FOG_COLOR);
const drawsMemory = (mode) => mode === "dim" || mode === "clear";

export function shadeOf(sceneMeta) {
  const v = isObj(sceneMeta) ? sceneMeta[FOG_LOOK_KEY] : null;
  return isObj(v) && SHADES.includes(v.shade) ? v.shade : DEFAULT_SHADE;
}

// A short fingerprint of a long string (FNV-1a, 32 bits, with the length): the cut's commands in a sig.
function hash(s) {
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(36)}.${s.length}`;
}

// ---- the cut (pure) ----

// rect's outline, then each hole ring's, relative to rect's top-left corner (the Path's position).
// With fillRule "evenodd" every hole is cut out of the fill, and a ring inside a hole fills again.
// A hole that isn't a ring of at least 3 points is skipped.
export function cutPath(rect, holes = []) {
  if (!rectOk(rect)) return null;
  const ox = r2(rect.x0), oy = r2(rect.y0);
  const w = r2(rect.x1 - ox), h = r2(rect.y1 - oy);
  const commands = [[MOVE, 0, 0], [LINE, w, 0], [LINE, w, h], [LINE, 0, h], [CLOSE]];
  for (const ring of Array.isArray(holes) ? holes : []) {
    if (!Array.isArray(ring)) continue;
    const pts = ring.filter(isPt);
    if (pts.length < 3) continue;
    pts.forEach((p, k) => commands.push([k ? LINE : MOVE, r2(p.x - ox), r2(p.y - oy)]));
    commands.push([CLOSE]);
  }
  return { position: { x: ox, y: oy }, commands };
}

// ---- the plan (pure) ----

const mapsOf = (snap) => (Array.isArray(snap?.maps) ? snap.maps : []);
const rectSig = (r) => (rectOk(r) ? `${r2(r.x0)},${r2(r.y0)},${r2(r.x1)},${r2(r.y1)}` : "-");
function itemSig(i) {
  const p = pt(i?.position), s = isPt(i?.scale) ? i.scale : { x: 1, y: 1 };
  const im = i?.image || {}, g = i?.grid || {}, off = isPt(g.offset) ? g.offset : { x: 0, y: 0 };
  return `${p.x},${p.y}|${r2(finite(i?.rotation) ? i.rotation : 0)}|${s.x},${s.y}|${im.url ?? ""}|${im.width}x${im.height}|${im.mime ?? ""}|${g.dpi}|${off.x},${off.y}`;
}
// EXPLORED_KEY's raw value, whole (the rings text too: a new union is a new sig, exactly).
function exploredSig(raw) {
  if (!isObj(raw)) return raw == null ? "" : "?";
  return `${raw.v}|${raw.w}x${raw.h}|${raw.n}|${raw.a}|${typeof raw.rings === "string" ? raw.rings : "?"}`;
}

export function memoryInputSig(snap, { fogColor = snap?.fogColor } = {}) {
  const parts = mapsOf(snap).map((m) => {
    const mode = drawnMode(m?.mode);
    const ex = mode === "dim" ? exploredSig(m?.item?.metadata?.[EXPLORED_KEY]) : "";
    return [m?.id, mode, m?.hidden ? 1 : 0, rectSig(m?.rect), itemSig(m?.item), ex].join("|");
  });
  return `shade=${shadeOf(snap?.sceneMeta)}|fog=${colourOf(fogColor)}||${parts.join(";")}`;
}

// The map image's own picture, as buildImage takes it.
function imageOf(item) {
  const im = item?.image, g = item?.grid;
  if (!im || typeof im.url !== "string" || !im.url || !finite(im.width, im.height) || im.width <= 0 || im.height <= 0) return null;
  if (!g || !finite(g.dpi) || g.dpi <= 0) return null;
  return {
    image: { width: im.width, height: im.height, url: im.url, mime: typeof im.mime === "string" && im.mime ? im.mime : "image/png" },
    grid: { dpi: g.dpi, offset: isPt(g.offset) ? { x: g.offset.x, y: g.offset.y } : { x: im.width / 2, y: im.height / 2 } },
    position: pt(item.position),
    rotation: finite(item.rotation) ? item.rotation : 0,
    scale: isPt(item.scale) ? { x: item.scale.x, y: item.scale.y } : { x: 1, y: 1 },
  };
}

function specsFor(m, { fogColor, opacity }) {
  const id = String(m.id);
  const spec = (part, own) => ({ key: `${part}:${id}`, map: id, part, ...own });
  const rect = m.rect;
  const mode = drawnMode(m.mode);
  if (!drawsMemory(mode) || !rectOk(rect)) return [];
  let holes = null;
  if (mode === "dim") {
    holes = holeRings(exploredFor(m).rings, rect);
    if (!holes.length) return []; // nothing explored yet: the scene's own fog, as "fog"
  }
  const img = imageOf(m.item);
  if (!img && mode === "clear") return []; // no picture to show
  const out = [];
  if (img) {
    const make = `${img.image.url}|${img.image.width}x${img.image.height}|${img.image.mime}|${img.grid.dpi}|${img.grid.offset.x},${img.grid.offset.y}`;
    out.push(spec("image", { ...img, make,
      sig: `${make}|${img.position.x},${img.position.y}|${r2(img.rotation)}|${img.scale.x},${img.scale.y}` }));
  }
  // The dim layer: the map's whole rectangle (decision 71: never just the explored shapes, which
  // would leave a hairline of undimmed picture where two meet; the cut hides it wherever the party
  // hasn't been), in the scene's fog colour, so a see-through margin over the fog fill reads as fog.
  const color = colourOf(fogColor);
  const position = { x: r2(rect.x0), y: r2(rect.y0) }, width = r2(rect.x1 - rect.x0), height = r2(rect.y1 - rect.y0);
  out.push(spec("dim", { position, width, height, color, opacity, make: "dim",
    sig: `${position.x},${position.y}|${width}x${height}|${color}|${opacity}` }));
  if (mode === "dim") {
    const cut = cutPath(rect, holes);
    out.push(spec("cut", { position: cut.position, commands: cut.commands, color, holes: holes.length, make: "cut",
      sig: `${cut.position.x},${cut.position.y}|${hash(JSON.stringify(cut.commands))}|${color}` }));
  }
  return out;
}

// Per map that isn't hidden, what this screen draws for it (contract section 5). A GM screen with
// memoryOnGm false draws nothing at all.
export function memoryPlan(snap, { fogColor = snap?.fogColor, gm = false, memoryOnGm = true, dimOpacity = null } = {}) {
  if (gm && memoryOnGm === false) return [];
  const opacity = flagOf(dimOpacity) ?? shadeOf(snap?.sceneMeta);
  const out = [];
  const done = new Set();
  for (const m of mapsOf(snap)) {
    if (!m || m.id == null || m.hidden || !drawsMemory(drawnMode(m.mode)) || done.has(String(m.id))) continue;
    done.add(String(m.id));
    out.push(...specsFor(m, { fogColor, opacity }));
  }
  return out;
}

export const planSig = (plan) => (plan || []).map((s) => `${s.key}=${s.make}#${s.sig}`).join(";");

// ---- drawing ----

export function createMemory(api = {}, ctx = {}) {
  const host = ctx.host ?? "";
  const log = (text) => { try { ctx.log?.(text, KIND); } catch { /* nowhere to say it */ } };
  const OBR = () => api.OBR;
  const tagOf = (i) => {
    const t = i?.metadata?.[FOG_LOCAL_KEY];
    return t && typeof t === "object" ? t : null;
  };
  const ours = (i) => tagOf(i)?.kind === KIND && tagOf(i)?.host === host;
  // This device's flag (b4 section 9, check 2): ctx.dimOpacity, a number or a function giving one,
  // read on every sync; missing or junk = null (the scene's shade).
  const flagNow = () => {
    let v = ctx.dimOpacity;
    if (typeof v === "function") { try { v = v(); } catch { v = null; } }
    return flagOf(v);
  };

  let drawn = new Map(); // key -> {id, make, sig, part, map}
  let appliedIn = null; // the input signature last drawn in full
  let applied = null; // the plan signature last drawn in full
  let sweep = true; // read our items back before the next write
  let lastError = null;
  let saidMaps = ""; // the maps (and modes) the live log last heard about
  let shade = DEFAULT_SHADE, flag = null; // the scene's shade and this device's flag, at the last sync

  const tag = (s) => ({ kind: KIND, key: s.key, sig: s.sig, make: s.make, host, map: s.map, part: s.part });
  const opt = (b, method, v) => (typeof b?.[method] === "function" ? b[method](v) : b);
  const finish = (b, s, z) => opt(b.zIndex(z), "disableAutoZIndex", true)
    .locked(true).disableHit(true).name(NAME).metadata({ [FOG_LOCAL_KEY]: tag(s) }).build();

  function build(s) {
    switch (s.part) {
      case "image":
        return finish(api.buildImage(s.image, s.grid).position(s.position).rotation(s.rotation).scale(s.scale)
          .layer(MEMORY_LAYER), s, MEMORY_IMAGE_Z);
      case "dim":
        return finish(api.buildShape().shapeType("RECTANGLE").width(s.width).height(s.height).position(s.position)
          .fillColor(s.color).fillOpacity(s.opacity).strokeColor(s.color).strokeOpacity(0).strokeWidth(0)
          .layer(MEMORY_LAYER), s, MEMORY_DIM_Z);
      case "cut":
        return finish(api.buildPath().commands(s.commands).position(s.position).fillRule("evenodd")
          .fillColor(s.color).fillOpacity(1).strokeColor(s.color).strokeOpacity(0).strokeWidth(0)
          .layer(MEMORY_LAYER), s, MEMORY_CUT_Z);
      default:
        throw new Error(`no such memory part: ${s.part}`);
    }
  }

  // A draft brought to the spec without making it again (its make is the same).
  function restyle(d, s) {
    const style = (o) => { d.style = { ...(d.style || {}), ...o }; };
    if (s.part === "image") {
      d.position = { ...s.position };
      d.rotation = s.rotation;
      d.scale = { ...s.scale };
    } else if (s.part === "dim") {
      d.position = { ...s.position };
      d.width = s.width;
      d.height = s.height;
      style({ fillColor: s.color, fillOpacity: s.opacity, strokeColor: s.color });
    } else if (s.part === "cut") {
      d.position = { ...s.position };
      d.commands = s.commands.map((c) => [...c]);
      d.fillRule = "evenodd";
      style({ fillColor: s.color, fillOpacity: 1, strokeColor: s.color });
    }
    d.metadata = { ...(d.metadata || {}), [FOG_LOCAL_KEY]: tag(s) };
  }

  async function readBack(del) {
    const local = await OBR().scene.local.getItems(ours);
    const next = new Map();
    for (const i of local || []) {
      const t = tagOf(i);
      if (typeof t.key !== "string" || next.has(t.key)) { del.push(i.id); continue; }
      next.set(t.key, { id: i.id, make: t.make, sig: t.sig, part: t.part, map: t.map });
    }
    drawn = next;
  }

  function sayMaps(snap, plan) {
    const byId = new Map(mapsOf(snap).map((m) => [String(m.id), m]));
    const ids = [...new Set(plan.map((s) => s.map))];
    const text = ids.map((id) => {
      const m = byId.get(id);
      const mode = drawnMode(m?.mode);
      const cut = plan.find((s) => s.key === `cut:${id}`);
      return `${m?.name || id} ${SAID[mode] || mode}${cut ? ` (${cut.holes} ring${cut.holes === 1 ? "" : "s"})` : ""}`;
    });
    const key = ids.map((id) => `${id}:${drawnMode(byId.get(id)?.mode)}`).join(",");
    if (key === saidMaps) return;
    saidMaps = key;
    log(text.length ? `drawing explored memory: ${text.join(", ")}` : "drawing no explored memory");
  }

  async function doSync(snap) {
    const none = { added: 0, removed: 0, updated: 0, failed: false, error: null };
    if (!snap) return none;
    const fogColor = snap.fogColor;
    const gm = !!ctx.isGm;
    const onGm = ctx.memoryOnGm !== false;
    // The device flag counts on a GM screen only (the contract): a player's window on the same browser
    // profile as a GM tab shares its storage, and must still show the table's shade.
    flag = gm ? flagNow() : null;
    shade = shadeOf(snap.sceneMeta);
    const inSig = `${gm ? "gm" : "pl"}|${onGm ? 1 : 0}|${flag ?? "-"}|${memoryInputSig(snap, { fogColor })}`;
    if (!sweep && inSig === appliedIn) return none;
    const plan = memoryPlan(snap, { fogColor, gm, memoryOnGm: onGm, dimOpacity: flag });
    const psig = planSig(plan);
    if (!sweep && psig === applied) { appliedIn = inSig; return none; }
    const del = [];
    if (sweep) {
      await readBack(del); // (a read that fails throws: nothing written, fog.js tries again)
      sweep = false;
    }
    const want = new Map(plan.map((s) => [s.key, s]));
    for (const [key, rec] of drawn) {
      const s = want.get(key);
      if (!s || s.make !== rec.make || s.part !== rec.part) { del.push(rec.id); drawn.delete(key); }
    }
    const add = [];
    const upd = new Map(); // id -> spec
    for (const s of plan) {
      const rec = drawn.get(s.key);
      if (!rec) add.push(s);
      else if (rec.sig !== s.sig) upd.set(rec.id, s);
    }

    let failed = false;
    const done = { added: 0, removed: 0, updated: 0 };
    const fail = (what, e) => {
      failed = true;
      lastError = String(e?.message || e);
      log(`${what} failed: ${lastError}`);
    };
    if (del.length) {
      try {
        await OBR().scene.local.deleteItems(del);
        done.removed = del.length;
      } catch (e) {
        fail("delete", e);
      }
    }
    if (add.length) {
      try {
        const built = add.map(build);
        await OBR().scene.local.addItems(built);
        add.forEach((s, k) => drawn.set(s.key, { id: built[k].id, make: s.make, sig: s.sig, part: s.part, map: s.map }));
        done.added = add.length;
      } catch (e) {
        fail("add", e);
      }
    }
    if (upd.size) {
      try {
        await OBR().scene.local.updateItems([...upd.keys()], (drafts) => {
          for (const d of drafts) {
            const s = upd.get(d.id);
            if (s) restyle(d, s);
          }
        });
        for (const s of upd.values()) {
          const rec = drawn.get(s.key);
          if (rec) rec.sig = s.sig;
        }
        done.updated = upd.size;
      } catch (e) {
        fail("update", e);
      }
    }
    // A failure: forget what we think we drew and read it back on the next sync (fog.js calls it
    // again after its retry), so strays are swept and nothing is drawn twice.
    if (failed) {
      sweep = true;
      applied = null;
      appliedIn = null;
    } else {
      applied = psig;
      appliedIn = inSig;
      lastError = null;
      sayMaps(snap, plan);
    }
    return { ...done, failed, error: failed ? lastError : null };
  }

  // One at a time: a clear() can't slip in while an add is on its way.
  let chain = Promise.resolve();
  function queue(job) {
    const run = chain.then(job);
    chain = run.catch(() => {});
    return run;
  }

  function sync(snap) {
    return queue(() => doSync(snap).catch((e) => {
      sweep = true;
      applied = null;
      appliedIn = null;
      lastError = String(e?.message || e);
      log(`sync failed: ${lastError}`);
      return { added: 0, removed: 0, updated: 0, failed: true, error: lastError };
    }));
  }

  function reset() {
    drawn = new Map();
    applied = null;
    appliedIn = null;
    sweep = true;
    saidMaps = "";
  }

  // Everything of ours (this host's memory items) comes off, and is forgotten.
  function clear() {
    return queue(async () => {
      const ids = new Set([...drawn.values()].map((r) => r.id));
      reset();
      try {
        for (const i of (await OBR().scene.local.getItems(ours)) || []) ids.add(i.id);
      } catch { /* the scene is closed: its local items went with it */ }
      if (!ids.size) return { removed: 0 };
      try {
        await OBR().scene.local.deleteItems([...ids]);
        lastError = null;
        return { removed: ids.size };
      } catch (e) {
        lastError = String(e?.message || e);
        return { removed: 0, error: lastError };
      }
    });
  }

  // The scene closed (Owlbear dropped every local item with it): forget, write nothing.
  function forget() {
    reset();
  }

  // shade: the scene's memory shade; flag: this device's "dnd-npc/fog-dim" when it beats the shade
  // here (the 🔥 Lighting list says so), else null.
  function status() {
    return { maps: new Set([...drawn.values()].map((r) => r.map)).size, items: drawn.size, error: lastError, shade, flag };
  }

  return { sync, clear, forget, status };
}
