// Explored memory, drawn (docs/vision-layer-spec.md section 6, "Drawing it", Plan A from spike S2;
// the builders' contract is docs/vision-layer-b4.md section 5): on EVERY screen, while 🌫 Our fog
// is on, a few LOCAL items on the FOG layer per map whose mode (fog/maps.js mapStates: fog/mode.js
// fogMode from its darkness, kind, remembered building and the DM's override) keeps what the party
// has seen. The spike found FOG-layer local items opaque to players: they act as fog, hide the
// tokens under them, and the party's PRIMARY lights (zIndex 0) cut through them, so live sight
// shows the real map and its creatures while the remembered parts show only the picture.
//
//   "fog"    nothing (the scene's own fog, cut by the party's lights)
//   "dim"    (a) the map's picture, (b) a dark layer over it, (c) the scene's fog colour over every
//            square not yet seen
//   "lit"    (a) and (c)
//   "clear"  a light over the whole map above every wall, held to the map by its own edge ring
//   a map with no seen square (dim or lit), or one the DM hid: nothing
//
//   holeRects(bits, grid, rect)    the seen squares as rectangles: each row's runs, a run merged
//                        downward while the rows below have the same run; clipped to rect; never
//                        overlapping
//   cutPath(rect, holes)  {position, commands}: rect's outline, then each hole's, as Path commands
//                        relative to position (MOVE 0, LINE 1, CLOSE 5), for fillRule "evenodd"
//   memoryInputSig(snap, {fogColor})   what the plan depends on: per map its id, mode, hidden,
//                        rectangle, grid, transform, image and (dim/lit only) its SEEN_KEY bits;
//                        and the fog colour. Unchanged: no plan is built, Owlbear is asked nothing
//   memoryPlan(snap, {fogColor, gm, memoryOnGm})   the item specs (pure): [{key, map, part, make,
//                        sig, ...the part's own}]. key "<part>:<map id>": at most 3 per map
//   createMemory(api, ctx) -> {sync(snap), clear(), forget(), status()}
//
// A spec's `make` is what the item can't change without being made again (the picture's file and
// size, the edge's points); `sig` is everything it's drawn from. A part whose make holds and whose
// sig changed is one update (the cut's holes or colour, the light's place or reach, the picture's
// place, the dim layer's size), never a delete and an add. Each sync makes at most one deleteItems,
// one addItems and one updateItems, and none at all when the input or the plan is unchanged. It
// reads its own items back (tagged FOG_LOCAL_KEY {kind: "memory", key, sig, make, host, map,
// part}) only on its first sync, after clear(), forget() or a failed write; fog.js retries a
// failure. Local items only: nothing here writes the scene.
//
// ctx (fog.js partCtx): host, isGm, log(text, kind), memoryOnGm (false: this GM screen draws no
// memory, the live-check flag of section 9), optionally dimOpacity (a number 0-1, or a function
// giving one, read on every sync: the dim layer's opacity, default DIM_OPACITY). api: {OBR, buildImage, buildShape, buildPath,
// buildLight, buildWall}.

import { FOG_LOCAL_KEY, SEEN_KEY } from "../keys.js?v=69dedbd";
import { getBit } from "./bitset.js?v=69dedbd";
import { edgeLine } from "./lines.js?v=69dedbd";
import { seenOf } from "./maps.js?v=69dedbd";

export const MEMORY_LAYER = "FOG";
export const MEMORY_IMAGE_Z = -3; // (a) the map's own picture
export const MEMORY_DIM_Z = -2; // (b) "dim" only: the darkening over it
export const MEMORY_CUT_Z = -1; // (c) the fog over everything not yet seen
export const CLEAR_Z = 1; // "clear": a light above every wall (fog/walls.js WALL_Z 0), stopped only by its own edge ring
export const DIM_COLOR = "#000000";
export const DIM_OPACITY = 0.45; // tune live (the lights redo's table band is about 0.55; 🌒 may stack too dark)
export const DEFAULT_FOG_COLOR = "#000000";

const KIND = "memory";
const NAME = "dnd-npc memory";
const MOVE = 0, LINE = 1, CLOSE = 5; // Path commands (as aim/tool.js)
const DRAWS = new Set(["dim", "lit", "clear"]);

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0
const isPt = (p) => !!p && finite(p.x, p.y);
const pt = (p) => (isPt(p) ? { x: r2(p.x), y: r2(p.y) } : { x: 0, y: 0 });
const rectOk = (r) => !!r && finite(r.x0, r.y0, r.x1, r.y1) && r.x1 > r.x0 && r.y1 > r.y0;
const gridOk = (g) => !!g && finite(g.x0, g.y0, g.cell, g.cols, g.rows) && g.cell > 0 && g.cols > 0 && g.rows > 0;
const opacityOf = (x) => (finite(x) && x >= 0 && x <= 1 ? r2(x) : DIM_OPACITY);
const colourOf = (c) => (typeof c === "string" && c.trim() ? c.trim() : DEFAULT_FOG_COLOR);

// A short fingerprint of a long string (FNV-1a, 32 bits, with the length): the cut's commands in a sig.
function hash(s) {
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(36)}.${s.length}`;
}

// ---- the holes (pure) ----

// The seen squares (a fog/bitset.js set of the grid's size) as rectangles in scene px: each row's
// runs of seen squares, a run carried down while the next row has exactly the same run (so a room
// seen whole is one rectangle), clipped to rect. No two overlap: each square is in one run of its
// row, and each run in one rectangle.
export function holeRects(bits, grid, rect) {
  if (!bits || !gridOk(grid) || !rectOk(rect) || bits.cols !== grid.cols || bits.rows !== grid.rows) return [];
  const { x0, y0, cell, cols, rows } = grid;
  const out = [];
  let open = new Map(); // "c0,c1" -> the row it started on
  const close = (key, r0, r1) => {
    const [c0, c1] = key.split(",").map(Number);
    const h = {
      x0: r2(Math.max(rect.x0, x0 + c0 * cell)), y0: r2(Math.max(rect.y0, y0 + r0 * cell)),
      x1: r2(Math.min(rect.x1, x0 + c1 * cell)), y1: r2(Math.min(rect.y1, y0 + r1 * cell)),
    };
    if (h.x1 > h.x0 && h.y1 > h.y0) out.push(h);
  };
  for (let r = 0; r <= rows; r++) {
    const here = new Map();
    if (r < rows) {
      let c = 0;
      while (c < cols) {
        if (!getBit(bits, r * cols + c)) { c++; continue; }
        const c0 = c;
        while (c < cols && getBit(bits, r * cols + c)) c++;
        const key = `${c0},${c}`;
        here.set(key, open.has(key) ? open.get(key) : r);
      }
    }
    for (const [key, r0] of open) if (!here.has(key)) close(key, r0, r);
    open = here;
  }
  return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

// rect's outline, then each hole's, relative to rect's top-left corner (the Path's position).
// With fillRule "evenodd" every hole is cut out of the fill.
export function cutPath(rect, holes = []) {
  if (!rectOk(rect)) return null;
  const ox = r2(rect.x0), oy = r2(rect.y0);
  const box = (x0, y0, x1, y1) => [[MOVE, x0, y0], [LINE, x1, y0], [LINE, x1, y1], [LINE, x0, y1], [CLOSE]];
  const commands = box(0, 0, r2(rect.x1 - ox), r2(rect.y1 - oy));
  for (const h of Array.isArray(holes) ? holes : []) {
    if (!rectOk(h)) continue;
    commands.push(...box(r2(h.x0 - ox), r2(h.y0 - oy), r2(h.x1 - ox), r2(h.y1 - oy)));
  }
  return { position: { x: ox, y: oy }, commands };
}

// ---- the plan (pure) ----

const mapsOf = (snap) => (Array.isArray(snap?.maps) ? snap.maps : []);
const dpiOf = (snap) => (finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150);
const rectSig = (r) => (rectOk(r) ? `${r2(r.x0)},${r2(r.y0)},${r2(r.x1)},${r2(r.y1)}` : "-");
const gridSig = (g) => (gridOk(g) ? `${g.x0},${g.y0},${g.cell},${g.cols}x${g.rows}` : "-");
function itemSig(i) {
  const p = pt(i?.position), s = isPt(i?.scale) ? i.scale : { x: 1, y: 1 };
  const im = i?.image || {}, g = i?.grid || {}, off = isPt(g.offset) ? g.offset : { x: 0, y: 0 };
  return `${p.x},${p.y}|${r2(finite(i?.rotation) ? i.rotation : 0)}|${s.x},${s.y}|${im.url ?? ""}|${im.width}x${im.height}|${im.mime ?? ""}|${g.dpi}|${off.x},${off.y}`;
}

export function memoryInputSig(snap, { fogColor = snap?.fogColor } = {}) {
  const parts = mapsOf(snap).map((m) => {
    const raw = DRAWS.has(m?.mode) && m.mode !== "clear" ? m?.item?.metadata?.[SEEN_KEY] : null;
    const seen = raw && typeof raw === "object" ? `${raw.v}|${raw.cols}x${raw.rows}|${raw.bits}` : "";
    return [m?.id, m?.mode, m?.hidden ? 1 : 0, rectSig(m?.rect), gridSig(m?.grid), itemSig(m?.item), seen].join("|");
  });
  return `${dpiOf(snap)}|fog=${colourOf(fogColor)}||${parts.join(";")}`;
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

function specsFor(m, { fogColor, dpi, dimOpacity }) {
  const id = String(m.id);
  const spec = (part, own) => ({ key: `${part}:${id}`, map: id, part, ...own });
  const rect = m.rect;
  if (!rectOk(rect)) return [];
  if (m.mode === "clear") {
    const cell = gridOk(m.grid) ? m.grid.cell : dpi;
    const position = { x: r2((rect.x0 + rect.x1) / 2), y: r2((rect.y0 + rect.y1) / 2) };
    const attenuation = r2(Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0) / 2 + cell);
    const out = [spec("light", { position, attenuation, make: "light", sig: `${position.x},${position.y}|${attenuation}` })];
    const edge = edgeLine(m.item, dpi) || edgeLine(rect, dpi);
    if (edge) {
      const points = edge.points.map(pt);
      const s = points.map((p) => `${p.x},${p.y}`).join(" ");
      out.push(spec("edge", { points, make: s, sig: s }));
    }
    return out;
  }
  if (m.mode !== "dim" && m.mode !== "lit") return [];
  const seen = seenOf(m.item, m.grid);
  const holes = holeRects(seen, m.grid, rect);
  if (!holes.length) return [];
  const out = [];
  const img = imageOf(m.item);
  if (img) {
    const make = `${img.image.url}|${img.image.width}x${img.image.height}|${img.image.mime}|${img.grid.dpi}|${img.grid.offset.x},${img.grid.offset.y}`;
    out.push(spec("image", { ...img, make,
      sig: `${make}|${img.position.x},${img.position.y}|${r2(img.rotation)}|${img.scale.x},${img.scale.y}` }));
  }
  if (m.mode === "dim") {
    const position = { x: r2(rect.x0), y: r2(rect.y0) }, width = r2(rect.x1 - rect.x0), height = r2(rect.y1 - rect.y0);
    out.push(spec("dim", { position, width, height, color: DIM_COLOR, opacity: dimOpacity, make: "dim",
      sig: `${position.x},${position.y}|${width}x${height}|${DIM_COLOR}|${dimOpacity}` }));
  }
  const cut = cutPath(rect, holes);
  const color = colourOf(fogColor);
  out.push(spec("cut", { position: cut.position, commands: cut.commands, color, holes: holes.length, make: "cut",
    sig: `${cut.position.x},${cut.position.y}|${hash(JSON.stringify(cut.commands))}|${color}` }));
  return out;
}

// Per map that isn't hidden, what this screen draws for it (contract section 5). A GM screen with
// memoryOnGm false draws nothing at all.
export function memoryPlan(snap, { fogColor = snap?.fogColor, gm = false, memoryOnGm = true, dimOpacity = DIM_OPACITY } = {}) {
  if (gm && memoryOnGm === false) return [];
  const dpi = dpiOf(snap);
  dimOpacity = opacityOf(dimOpacity);
  const out = [];
  const done = new Set();
  for (const m of mapsOf(snap)) {
    if (!m || m.id == null || m.hidden || !DRAWS.has(m.mode) || done.has(String(m.id))) continue;
    done.add(String(m.id));
    out.push(...specsFor(m, { fogColor, dpi, dimOpacity }));
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
  // A live-tuning knob (contract section 9, check 2): ctx.dimOpacity, a number or a function giving
  // one, read on every sync; missing or junk = DIM_OPACITY.
  const dimOpacityNow = () => {
    let v = ctx.dimOpacity;
    if (typeof v === "function") { try { v = v(); } catch { v = null; } }
    return opacityOf(v);
  };

  let drawn = new Map(); // key -> {id, make, sig, part, map}
  let appliedIn = null; // the input signature last drawn in full
  let applied = null; // the plan signature last drawn in full
  let sweep = true; // read our items back before the next write
  let lastError = null;
  let saidMaps = ""; // the maps (and modes) the live log last heard about

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
      case "light":
        return finish(api.buildLight().position(s.position).attenuationRadius(s.attenuation).sourceRadius(0)
          .falloff(0).lightType("PRIMARY"), s, CLEAR_Z);
      case "edge":
        return finish(api.buildWall().points(s.points).position({ x: 0, y: 0 }).doubleSided(true).blocking(false)
          .visible(true), s, CLEAR_Z);
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
      style({ fillColor: s.color, fillOpacity: s.opacity });
    } else if (s.part === "cut") {
      d.position = { ...s.position };
      d.commands = s.commands.map((c) => [...c]);
      d.fillRule = "evenodd";
      style({ fillColor: s.color, fillOpacity: 1 });
    } else if (s.part === "light") {
      d.position = { ...s.position };
      d.attenuationRadius = s.attenuation;
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
      const cut = plan.find((s) => s.key === `cut:${id}`);
      return `${m?.name || id} ${m?.mode}${cut ? ` (${cut.holes} hole${cut.holes === 1 ? "" : "s"})` : ""}`;
    });
    const key = ids.map((id) => `${id}:${byId.get(id)?.mode}`).join(",");
    if (key === saidMaps) return;
    saidMaps = key;
    log(text.length ? `drawing ${text.join(", ")}` : "nothing to draw");
  }

  async function doSync(snap) {
    const none = { added: 0, removed: 0, updated: 0, failed: false, error: null };
    if (!snap) return none;
    const fogColor = snap.fogColor;
    const gm = !!ctx.isGm;
    const onGm = ctx.memoryOnGm !== false;
    const dimOpacity = dimOpacityNow();
    const inSig = `${gm ? "gm" : "pl"}|${onGm ? 1 : 0}|${dimOpacity}|${memoryInputSig(snap, { fogColor })}`;
    if (!sweep && inSig === appliedIn) return none;
    const plan = memoryPlan(snap, { fogColor, gm, memoryOnGm: onGm, dimOpacity });
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

  function status() {
    return { maps: new Set([...drawn.values()].map((r) => r.map)).size, items: drawn.size, error: lastError };
  }

  return { sync, clear, forget, status };
}
