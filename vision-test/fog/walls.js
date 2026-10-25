// Local walls for the vision layer (docs/vision-layer-spec.md section 4; the builders' contract is
// docs/vision-layer-b2b3.md section 4): on every screen, while 🌫 Our fog is on, one LOCAL wall
// per wall line in the scene (fog/lines.js readLines: our key or Smoke & Spectre's), plus a wall
// round every map's edge. Owlbear's own lights stop at them (sight), and a
// token that carries a light on that screen stops at a blocking one (a drag, an arrow-key nudge).
//
//   wallOf(line, {gmOpen, z})   one line's wall spec, or null: an open door, a line the DM switched
//                        off in Smoke, or one with under two points makes none
//   wallSpecs(lines, maps, {mapOf, dpi, gmOpen, anyMap, z})   the pure planner: the walls for the
//                        lines on `maps` (a Set or an array of map ids; anyMap: every line,
//                        whatever map it's on, or none) and an edge round each map (mapOf(id): the
//                        map image, else its views.js mapRects rectangle) -> {specs, maps, segments}
//   zoneWall(zone, {gmOpen, z})   a heavy zone's wall spec (key "zone:<item id>"), or null
//   LAYERS / layerOf(what, rules)   the walls' and lights' zIndex while 🧱 is on (below), else 0
//   wallPlan(snap, {gmOpen})   the same from fog.js's snapshot for EVERY map (snap.rects) and every
//                        line (snap.lines, snap.byId, snap.grid.dpi), and, while ☁ is on
//                        (snap.rules.zones), a wall round every heavy zone (snap.zones)
//   sightBlockersOf(snap, mapId, {sense})   the fog/los.js segments the live light of a PC on that
//                        map meets (pure): see below
//   planSig(plan)        the whole plan as one string: an unchanged one makes no Owlbear call
//   createWalls(api, ctx) -> {sync(snap), clear(), status()}
//
// A spec is {key, points, doubleSided, blocking, visible, kind, sig} (and z, only when it isn't 0):
//   - a wall, or a closed door (locked or not): visible (sight stops), blocking as the line says
//     (ours always; a Smoke line as the DM set it);
//   - a window: visible false (sight passes), blocking (moves stop);
//   - an open door: no wall at all;
//   - the edge round a map (key "edge:<map id>"): visible, never blocking, so it stops sight
//     spilling onto the next map and never catches a drag, a portal or 🧭 Bring PCs;
//   - doubleSided as the line says (ours always; the spike found pairs pixel-identical);
//   - a heavily obscured zone (key "zone:<item id>", kind "zone", docs/vision-layer-2024.md section
//     7), only while ☁ Obscured is on: its ring, closed, visible (sight stops), never blocking (a drag
//     walks through fog), double-sided;
//   - gmOpen (a GM screen with ctx.gmPass "A"): nothing blocks.
// `sig` is the points (to 0.01 px), d/s, b/o and v/h, as the spike's wallsOfLine, and "|z<n>" when the
// wall sits on a layer above 0: any change is an add and then a delete, never an update. Walls change only
// on events: a door opens or shuts, a line is edited or switched off, a map is added or moved, a zone
// is drawn, marked, cast or moved, a 2024 switch is tapped.
//
// LAYERS, only while 🧱 Senses through fog is on (rules2024.js effectiveRules: pierce, which counts only
// while 🦇 Senses is on too). A light at zIndex N meets only walls at zIndex N or above (b4 doc,
// section 5), so:
//   z 0   magic-darkness zones          normal sight (fog/sight.js)
//   z 1   the other heavy zones         truesight's own light
//   z 2   map walls, doors, map edges   blindsight's own light
// truesight passes magic darkness but not fog; blindsight passes both; real walls stop everything.
// With 🧱 off every wall stays at z 0, exactly as before the 2024 rules, and nothing in a spec says z.
//
// sightBlockersOf(snap, mapId, {sense = "sight"}): what the live light of a PC standing on that map
// meets, as fog/los.js segments: the map's lines and the lines on no map (fog/los.js sightBlockers:
// walls, closed and secret doors), the map's edge ring (its image's, else its rectangle's, as
// wallPlan draws it) and, while ☁ is on, the rings of the heavy zones on that map, on no map, or
// reaching over it. sense "true" or "blind" (the truesight and blindsight lights) follows the layer
// table while 🧱 is on: truesight skips magic-darkness zones, blindsight skips every zone. With every
// switch off it is exactly the explored memory's inline blockers (fog/seen.js before the 2024 rules).
//
// Every map, not only the ones a PC stands on (review 2026-10-12): a PC's light rides with it the
// moment it lands on another map (a portal, 🧭 Bring PCs, a drag), and a PC between maps or off
// them sees LIT_SIGHT on a lit scene; walls that waited for the next pass would let both show a
// building's rooms. Each map's own edge ring keeps sight from spilling between maps, and the spike
// held 56-60 fps on the Chromecast with every map's walls loaded (1,712 segments).
//
// The items (contract section 7): buildWall() on the FOG layer at WALL_Z (or the spec's z while 🧱
// is on), locked, never hit, tagged
// FOG_LOCAL_KEY {kind: "wall", key, sig, host}. This module touches only walls with its own host
// ("local" or "pages": the Dell's tab runs both copies). A sync whose plan signature is the one it
// last applied makes no Owlbear call at all; otherwise at most one addItems, then one deleteItems: a
// changed wall's new copy goes on before its old copy comes off (a 🧱 flip changes every wall's layer,
// so deleting first left the map a moment with no walls at all; both for a moment hides more, never
// less), and if the add fails, the old copies stay until the next sync. It reads its walls back only
// on its first sync, after clear(), and after a write that failed (to sweep strays). fog.js retries a
// failed sync.
//
// Why the spike's "GM screens: walls don't block" still stopped the DM (2026-10-11) is unproven;
// the likeliest cause is someone else's walls on the DM's screen (Smoke & Spectre's own local
// walls, drawn from the very same lines, so a stop at one looks like a stop at ours): Owlbear stops
// a token at ANY blocking wall on that screen once a light is attached to it there, and the spike
// attached one. So each read-back also counts the local walls on this screen that aren't ours
// (status().foreign), for the live check to look at. Our own GM walls can't stay blocking: the
// blocking flag is in every wall's sig (a change of gmPass is a delete and an add), and the first
// sync sweeps whatever an earlier page of ours left.

import { FOG_LOCAL_KEY } from "../keys.js?v=9a30147";
import { effectiveRules } from "../rules2024.js?v=9a30147";
import { edgeLine, edgeWalls, segmentsOf } from "./lines.js?v=9a30147";
import { sightBlockers } from "./los.js?v=9a30147";

export const WALL_Z = 0; // on the FOG layer (buildWall's own); walls draw nothing, so the order doesn't show
// The layer table while 🧱 Senses through fog is on (docs/vision-layer-2024.md section 7): walls and
// lights alike. With 🧱 off everything is at WALL_Z.
export const LAYERS = Object.freeze({ magic: 0, zone: 1, wall: 2, sight: 0, true: 1, blind: 2 });

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const isPt = (p) => !!p && finite(p.x, p.y);
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0
const ptsSig = (pts) => pts.map((p) => `${p.x},${p.y}`).join(" ");
const tagOf = (i) => {
  const t = i?.metadata?.[FOG_LOCAL_KEY];
  return t && typeof t === "object" ? t : null;
};

// ---- the plan (pure) ----

// The zIndex of a wall ("magic" | "zone" | "wall") or a light ("sight" | "true" | "blind") under these
// rules (rules2024.js effectiveRules, or anything: junk is all off): LAYERS' while 🧱 is on, else 0.
export function layerOf(what, rules) {
  if (!effectiveRules(rules).pierce) return WALL_Z;
  return Object.hasOwn(LAYERS, what) ? LAYERS[what] : WALL_Z;
}

// One line's wall (a fog/lines.js line, or an edgeLine), or null when it makes none. z: its layer
// (0 unless 🧱 is on), in the spec and its sig only when it isn't 0.
export function wallOf(line, { gmOpen = false, z = WALL_Z } = {}) {
  if (!line || line.disabled || (line.kind === "door" && line.open)) return null;
  if (!Array.isArray(line.points) || !line.points.every(isPt)) return null;
  const points = line.points.map((p) => ({ x: r2(p.x), y: r2(p.y) }));
  if (points.length < 2) return null;
  const visible = line.kind !== "window";
  const blocking = line.blocking === true && !gmOpen;
  const doubleSided = line.doubleSided === true;
  const kind = line.src === "edge" ? "edge" : line.kind;
  const layer = finite(z) && z !== WALL_Z ? z : null;
  const spec = { key: String(line.id), points, doubleSided, blocking, visible, kind,
                 sig: `${ptsSig(points)}|${doubleSided ? "d" : "s"}|${blocking ? "b" : "o"}|${visible ? "v" : "h"}${layer == null ? "" : `|z${layer}`}` };
  if (layer != null) spec.z = layer;
  return spec;
}

// A heavy zone's wall (fog/zoneread.js zonesOf's {id, level, magic, points}): its ring closed, kind
// "zone", sight stops (visible), a drag doesn't (never blocking), both sides. null for a light zone or a
// broken ring.
export function zoneWall(zone, { gmOpen = false, z = WALL_Z } = {}) {
  if (!zone || zone.level !== "heavy" || zone.id == null || !Array.isArray(zone.points) || zone.points.length < 3) return null;
  if (!zone.points.every(isPt)) return null;
  const ring = [...zone.points, zone.points[0]];
  return wallOf({ id: `zone:${zone.id}`, kind: "zone", src: "zone", blocking: false, doubleSided: true, points: ring }, { gmOpen, z });
}

// The walls for the lines on `maps`, and an edge round each. maps: a Set or an array of map ids;
// anyMap: every line counts, on one of them or on none. mapOf(id): the map image (its real corners,
// turned with it), else a {x0, y0, x1, y1} rectangle; a map it can't give has no edge. z: the lines'
// and edges' layer (0 unless 🧱 is on).
// -> {specs, maps: [ids, sorted], segments: n}
export function wallSpecs(lines, maps, { mapOf = () => null, dpi = 150, gmOpen = false, anyMap = false, z = WALL_Z } = {}) {
  const keep = maps instanceof Set ? maps : new Set(Array.isArray(maps) ? maps : []);
  const ids = [...keep].filter((id) => id != null).map(String).sort();
  const specs = [];
  const seen = new Set();
  const push = (w) => {
    if (!w || seen.has(w.key)) return; // one wall per key (an id twice in the scene: the first)
    seen.add(w.key);
    specs.push(w);
  };
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || (!anyMap && (l.mapId == null || !keep.has(l.mapId)))) continue;
    push(wallOf(l, { gmOpen, z }));
  }
  for (const id of ids) {
    let m = null;
    try { m = mapOf(id); } catch (e) { m = null; }
    let edge = m ? edgeLine(m, dpi) : null;
    if (edge) edge = { ...edge, id: `edge:${id}`, mapId: id };
    push(wallOf(edge, { gmOpen, z }));
  }
  const segments = specs.reduce((n, s) => n + s.points.length - 1, 0);
  return { specs, maps: ids, segments };
}

// The same from fog.js's snapshot, for every map and every line in the scene. A map's edge follows
// its image (turned with it) when the image has grid settings, else its rectangle. While ☁ Obscured is
// on (snap.rules.zones), every heavy zone in snap.zones gets its wall too, whatever map it's on.
export function wallPlan(snap, { gmOpen = false } = {}) {
  const dpi = finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150;
  const rects = Array.isArray(snap?.rects) ? snap.rects : [];
  const byId = snap?.byId instanceof Map ? snap.byId : new Map();
  const rules = effectiveRules(snap?.rules);
  const mapOf = (id) => {
    const img = byId.get(id);
    if (img && edgeLine(img, dpi)) return img;
    return rects.find((r) => String(r.id) === id) || null;
  };
  const plan = wallSpecs(snap?.lines, rects.map((r) => r?.id), { mapOf, dpi, gmOpen, anyMap: true, z: layerOf("wall", rules) });
  if (!rules.zones) return plan;
  const keys = new Set(plan.specs.map((s) => s.key));
  for (const zone of Array.isArray(snap?.zones) ? snap.zones : []) {
    const w = zoneWall(zone, { gmOpen, z: layerOf(zone?.magic ? "magic" : "zone", rules) });
    if (!w || keys.has(w.key)) continue;
    keys.add(w.key);
    plan.specs.push(w);
    plan.segments += w.points.length - 1;
  }
  return plan;
}

// ---- what the live light meets, for the explored memory (pure) ----

const ringBox = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
};
const overlaps = (a, b) => !!a && !!b && a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

// A zone's ring as fog/los.js segments of kind "zone" (they stop sight, never a drag).
function zoneSegments(zone) {
  const pts = zone.points;
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    if (!isPt(a) || !isPt(b) || (a.x === b.x && a.y === b.y)) continue;
    out.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, kind: "zone", open: false, id: `zone:${zone.id}`, mapId: zone.mapId ?? null });
  }
  return out;
}

// The segments the live light of a PC on map `mapId` meets (see the header). snap: fog.js's snapshot
// (lines, maps or byId, rects, grid, rules, zones); a missing part is none, missing rules are all off.
export function sightBlockersOf(snap, mapId, { sense = "sight" } = {}) {
  const dpi = finite(snap?.grid?.dpi) && snap.grid.dpi > 0 ? snap.grid.dpi : 150;
  const lines = (Array.isArray(snap?.lines) ? snap.lines : []).filter((l) => l && (l.mapId === mapId || l.mapId == null));
  const rect = (Array.isArray(snap?.rects) ? snap.rects : []).find((r) => r?.id === mapId) || null;
  let edge = [];
  if (mapId != null) {
    const m = (Array.isArray(snap?.maps) ? snap.maps : []).find((x) => x?.id === mapId);
    const img = m?.item ?? (snap?.byId instanceof Map ? snap.byId.get(mapId) : null);
    edge = img ? edgeWalls(img, dpi) : [];
    if (!edge.length && (m?.rect || rect)) edge = edgeWalls(m?.rect || rect, dpi); // as wallPlan's edge
  }
  const out = [...segmentsOf(lines), ...edge];
  const rules = effectiveRules(snap?.rules);
  if (rules.zones) {
    const layer = layerOf(sense === "true" || sense === "blind" ? sense : "sight", rules);
    const area = rect || (Array.isArray(snap?.maps) ? snap.maps : []).find((x) => x?.id === mapId)?.rect || null;
    for (const z of Array.isArray(snap?.zones) ? snap.zones : []) {
      if (z?.level !== "heavy" || !Array.isArray(z.points) || z.points.length < 3) continue;
      if (layerOf(z.magic ? "magic" : "zone", rules) < layer) continue; // this sense's light passes it
      if (!(z.mapId === mapId || z.mapId == null || overlaps(ringBox(z.points), area))) continue;
      out.push(...zoneSegments(z));
    }
  }
  return sightBlockers(out);
}

export const planSig = (plan) => (plan?.specs || []).map((s) => `${s.key}=${s.sig}`).sort().join(";");

// ---- the local items on one screen ----

export function createWalls(api = {}, ctx = {}) {
  const host = ctx.host ?? "";
  const log = typeof ctx.log === "function" ? ctx.log : (...a) => console.log(...a);
  const gmOpen = () => !!ctx.isGm && ctx.gmPass === "A";
  const drawn = new Map(); // key -> {id, sig}
  let applied = null; // the plan signature last drawn in full
  let fresh = true; // read our walls back before the next write
  let info = { walls: 0, segments: 0, maps: [] };
  let foreign = null; // local walls on this screen that aren't ours, at the last read-back
  let lastError = null;
  let warnedForeign = -1;

  function wallItem(s) {
    return api.buildWall()
      .name(`dnd-npc ${s.kind} wall`)
      .points(s.points)
      .position({ x: 0, y: 0 })
      .doubleSided(s.doubleSided)
      .blocking(s.blocking)
      .visible(s.visible)
      .zIndex(finite(s.z) ? s.z : WALL_Z)
      .locked(true)
      .disableHit(true)
      .metadata({ [FOG_LOCAL_KEY]: { kind: "wall", key: s.key, sig: s.sig, host } })
      .build();
  }

  // Our walls as Owlbear holds them: the records start again from them (a duplicate key, one from
  // an earlier page, goes), and the others' walls are counted.
  async function readBack(OBR, del) {
    const local = await OBR.scene.local.getItems((i) => i?.type === "WALL" || !!tagOf(i));
    drawn.clear();
    let others = 0;
    for (const i of local) {
      const t = tagOf(i);
      if (!t) {
        if (i.type === "WALL") others++;
        continue;
      }
      if (t.kind !== "wall" || t.host !== host) continue;
      if (typeof t.key !== "string" || drawn.has(t.key)) del.push(i.id);
      else drawn.set(t.key, { id: i.id, sig: t.sig });
    }
    foreign = others;
    if (others && others !== warnedForeign) {
      warnedForeign = others;
      log(`fog: ${others} other wall${others === 1 ? "" : "s"} on this screen (Smoke & Spectre's?): they stop a PC too, whatever ours say`);
    }
  }

  async function doSync(snap) {
    const none = { added: 0, removed: 0, updated: 0, failed: 0, error: null };
    if (!snap) return none;
    const plan = wallPlan(snap, { gmOpen: gmOpen() });
    info = { walls: plan.specs.length, segments: plan.segments, maps: plan.maps };
    const sig = planSig(plan);
    if (sig === applied && !fresh) return none;
    const { OBR } = api;
    const del = [];
    if (fresh) {
      try {
        await readBack(OBR, del);
      } catch (e) {
        lastError = String(e?.message || e);
        applied = null;
        return { ...none, failed: 1, error: lastError };
      }
      fresh = false;
    }
    const want = new Map(plan.specs.map((s) => [s.key, s]));
    const oldOf = new Map(); // key -> the old copy of a wall that changed (it comes off after its new copy is on)
    for (const [key, rec] of drawn) {
      if (want.get(key)?.sig === rec.sig) continue;
      del.push(rec.id);
      if (want.has(key)) oldOf.set(key, rec.id);
      drawn.delete(key);
    }
    const add = [];
    const added = [];
    const keep = new Set(); // old copies that stay: their new copy wasn't built or wasn't added
    let failed = 0;
    for (const s of plan.specs) {
      if (drawn.has(s.key)) continue;
      try {
        const item = wallItem(s);
        add.push(item);
        added.push(s.key);
        drawn.set(s.key, { id: item.id, sig: s.sig });
      } catch (e) {
        failed++;
        lastError = `a wall could not be built: ${e?.message || e}`;
        if (oldOf.has(s.key)) keep.add(oldOf.get(s.key));
      }
    }
    let error = failed ? lastError : null;
    // Add first, then delete: never a moment with fewer walls than either plan has.
    if (add.length) {
      try {
        await OBR.scene.local.addItems(add);
      } catch (e) {
        for (const key of added) {
          drawn.delete(key);
          if (oldOf.has(key)) keep.add(oldOf.get(key));
        }
        failed += add.length;
        error = lastError = `add: ${e?.message || e}`;
      }
    }
    const off = keep.size ? del.filter((id) => !keep.has(id)) : del;
    if (off.length) {
      try {
        await OBR.scene.local.deleteItems(off);
      } catch (e) {
        failed += off.length;
        error = lastError = `delete: ${e?.message || e}`;
      }
    }
    // A failure leaves strays or gaps: read back and try again on the next sync (fog.js retries).
    if (failed) {
      fresh = true;
      applied = null;
    } else {
      applied = sig;
      lastError = null;
    }
    return { added: failed ? 0 : add.length, removed: failed ? 0 : off.length, updated: 0, failed, error };
  }

  async function doClear() {
    const { OBR } = api;
    let ids = [...drawn.values()].map((r) => r.id);
    try {
      const local = await OBR.scene.local.getItems((i) => tagOf(i)?.kind === "wall" && tagOf(i)?.host === host);
      ids = [...new Set([...ids, ...local.map((i) => i.id)])];
      if (ids.length) await OBR.scene.local.deleteItems(ids);
      lastError = null;
      return { removed: ids.length, error: null };
    } catch (e) {
      lastError = String(e?.message || e);
      return { removed: 0, error: lastError };
    } finally {
      // forgotten either way: a scene that went away took its local items with it
      drawn.clear();
      applied = null;
      fresh = true;
      info = { walls: 0, segments: 0, maps: [] };
    }
  }

  // one at a time: a clear can't slip in while an add is on its way
  let chain = Promise.resolve();
  const serial = (job) => {
    const run = chain.then(job);
    chain = run.catch(() => {});
    return run.catch((e) => {
      lastError = String(e?.message || e);
      fresh = true;
      applied = null;
      return { added: 0, removed: 0, updated: 0, failed: 1, error: lastError };
    });
  };

  return {
    sync: (snap) => serial(() => doSync(snap)),
    clear: () => serial(doClear),
    status: () => ({ walls: drawn.size, segments: info.segments, maps: [...info.maps], foreign, error: lastError }),
  };
}
