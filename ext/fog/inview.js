// Which PCs see a creature: the one test, for the dark covers (fog/cover.js coverPlan: on a 🌑 map, a
// creature no PC sees is covered) and for the map report's seen_by (background.js summary(): the
// panel's "known to the party" mark, dm-docs/plan-vision-after-gn3.md V1). Lifted from fog/cover.js
// coverPlan (its seen / inView / litAt closures and its polygon cache, as of 575da6f) and widened to
// every map. Pure: no Owlbear import, so the offline checks and the bridge's report load it as is.
//
// THE RULE, per creature (a CHARACTER or MOUNT token, hidden ones too, not a PC, never a light
// carrier: creaturesOf) and per PC (snap.pcs, hidden ones too: a hidden PC still sees, fog/sight.js):
//   only a PC on the creature's own map (fog/shapes.js pcViews, per mapId; a PC or a creature on no
//   map: nobody), and only when the creature is IN VIEW of that PC: its middle inside the PC's sight
//   polygon (fog/los.js visibilityPolygon from the PC's middle, out to fog/sight.js sightReachFt, among
//   fog/shapes.js sightBlockersOf: walls, closed and secret doors and the map's edge; a window or an
//   open door lets sight through), or in its line of sight with some part of it (its disc, half its
//   smaller side) inside that reach (the fog lifts over its near side). Then:
//     ☀ / 🌒 map (not fog/maps.js darkLocked): in view is seen.
//     🌑 map: fog/cover.js's rule exactly as it was: seen when the PC doesn't stand in 🌑 (visionOf
//          where), or the middle is strictly within its own reach on dark ground (fog/shapes.js
//          darkReachFt: its square, its darkvision, its own light), or any part strictly within its
//          darkvision, or any part strictly within the reach of a public light ON THE SAME MAP
//          (fog/shapes.js litLightsOn; a cone only with the middle in the cone) that itself has line
//          of sight to the middle (lights don't shine through walls).
//
//   creaturesOf(snap)       [{item, c, mapId, r, fp}]: every creature token the rule covers (c: its
//                           middle; r: half its smaller side; fp: footOf)
//   footOf(item, dpi)       {x, y, w, h}: a token's footprint (fx/place.js footprint, else its scale
//                           times a square), scene px; null when it has no place or no size
//   darkMapIds(snap)        the ids of the snapshot's 🌑 maps
//   dvFtOf(item, vctx, onError)   a token's darkvision in feet (0 for none, or when visionOf throws)
//   polygons(cache, snap)   -> {get(mapId, origin, reachPx) -> {poly, bounds}, blockers(mapId), done(),
//                           failed()}: the sight polygons, kept in `cache` between plans (a map's blockers
//                           changing drops its polygons; one no plan asked for goes at done())
//   seenTest(snap, {cache, maps, polys})   -> {views, polys, lightsOf(mapId), seersOf(t), sees(t),
//                           degraded()}: the PCs' views (Map mapId -> [{v, poly, dvPx}]; only on `maps`, a
//                           Set of mapIds, when given) and the test on one creature (creaturesOf's shape).
//                           The caller calls polys.done() once it has asked everything. degraded(): the
//                           first part that threw ("<part>: <message>"), its fallback taken, or null
//   seenByPlan(snap, {cache, strict})   -> Map(creature id -> [PC ids, sorted]): every creature
//                           creaturesOf finds, [] when no PC sees it; strict: throws when degraded

import { CARRIER_KEY } from "../keys.js?v=e323d3ba-df9cbf7";
import { footprint } from "../fx/place.js?v=e323d3ba-df9cbf7";
import { visionOf } from "../fx/lightmeta.js?v=e323d3ba-df9cbf7";
import { inCone } from "../rules2024.js?v=e323d3ba-df9cbf7";
import { centreOf, mapAt } from "../views.js?v=e323d3ba-df9cbf7";
import { canSee, pointInPolygon, visibilityPolygon } from "./los.js?v=e323d3ba-df9cbf7";
import { arcSteps, litLightsOn, pcViews, sightBlockersOf } from "./shapes.js?v=e323d3ba-df9cbf7";

const LAYERS = ["CHARACTER", "MOUNT"];

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };

function boundsOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x0, y0, x1, y1 };
}

// ---- who stands where (pure) ----

const mapsOf = (snap) => (Array.isArray(snap?.maps) ? snap.maps : []);
export const darkMapIds = (snap) => new Set(mapsOf(snap).filter((m) => m?.id != null && m.darkLocked).map((m) => m.id));

// A token's footprint: its image over its grid dpi, times the scene's dpi and its scale; without an
// image, a square times its scale (fog/cover.js coverBox builds its box on it).
export function footOf(item, dpi) {
  const D = finite(dpi) && dpi > 0 ? dpi : 150;
  let fp = safe(() => footprint(item, D));
  if (!fp) {
    const p = item?.position;
    if (!p || !finite(p.x, p.y)) return null;
    const sx = Math.abs(finite(item?.scale?.x) ? item.scale.x : 1) || 1, sy = Math.abs(finite(item?.scale?.y) ? item.scale.y : 1) || 1;
    fp = { x: p.x, y: p.y, w: D * sx, h: D * sy };
  }
  return Math.min(fp.w, fp.h) > 0 ? fp : null;
}

// Every token that could be a creature: on CHARACTER or MOUNT, not a PC, not a light carrier, with a
// place; hidden ones too (a cover is on before the DM unhides it; the map report leaves their seen_by out).
export function creaturesOf(snap) {
  const dpi = snap?.grid?.dpi;
  const pcIds = new Set((Array.isArray(snap?.pcs) ? snap.pcs : []).map((i) => i?.id));
  const rects = Array.isArray(snap?.rects) ? snap.rects : [];
  const out = [];
  for (const item of Array.isArray(snap?.items) ? snap.items : []) {
    if (!item || item.id == null || !LAYERS.includes(item.layer) || pcIds.has(item.id)) continue;
    if (isObj(item.metadata) && item.metadata[CARRIER_KEY]) continue;
    const c = safe(() => centreOf(item, dpi));
    if (!c || !finite(c.x, c.y)) continue;
    const fp = footOf(item, dpi);
    if (!fp) continue;
    out.push({ item, c, mapId: mapAt(c, rects), r: Math.min(fp.w, fp.h) / 2, fp });
  }
  return out;
}

// (onError(e): told when visionOf throws; the darkvision is then 0, as it always was)
export const dvFtOf = (item, vctx, onError = null) => {
  let v = null;
  try { v = visionOf(item, vctx || {}); } catch (e) { try { onError?.(e); } catch { /* never changes the fallback */ } }
  return v && finite(v.dark) && v.dark > 0 ? v.dark : 0;
};

// The first part of the test that threw, as "<part>: <message>" (null: none). Each catch keeps its old
// fallback (an empty list, no polygon, no cone), so the covers draw as they always did; the map
// report fails closed on it instead (seenByPlan strict: a broken part must not send [] for "nobody").
const failures = () => {
  let first = null;
  // Never throws: a thrown value String() can't print (a null-prototype object) still marks the test failed.
  const text = (e) => { try { return String(e?.message || e); } catch { return "an unprintable error"; } };
  const note = (what, e) => { first ??= `${what}: ${text(e)}`; };
  const guard = (what, f, dflt) => { try { return f(); } catch (e) { note(what, e); return dflt; } };
  return { note, guard, first: () => first };
};

// ---- the polygons, kept between plans (pure apart from the cache) ----

// cache: {maps: Map(mapId -> {sig, polys: Map(key -> polygon)})}. A map's blockers changing (a door,
// a wall) drops its polygons; a polygon no plan asked for is dropped at the end of the next plan. A
// polygon whose making threw isn't kept (the next plan tries again, and says so again: failed()).
export function polygons(cache, snap) {
  const store = cache && typeof cache === "object" ? cache : null;
  if (store && !(store.maps instanceof Map)) store.maps = new Map();
  const fails = failures();
  const blockers = new Map();
  const used = new Map(); // mapId -> Set of keys
  const blockersOf = (id) => {
    if (!blockers.has(id)) {
      const list = fails.guard("sightBlockersOf", () => sightBlockersOf(snap, id), []);
      const sig = store ? list.map((s) => `${s.a.x},${s.a.y},${s.b.x},${s.b.y}`).join(";") : "";
      blockers.set(id, { list, sig });
    }
    return blockers.get(id);
  };
  function get(mapId, o, reachPx) {
    const { list, sig } = blockersOf(mapId);
    let bad = false;
    const make = () => {
      let poly;
      try { poly = visibilityPolygon(o, list, reachPx, { arcSteps: arcSteps(reachPx) }); } catch (e) {
        fails.note("visibilityPolygon", e);
        bad = true;
        poly = [];
      }
      return { poly, bounds: poly.length >= 3 ? boundsOf(poly) : null };
    };
    if (!store) return make();
    let m = store.maps.get(mapId);
    if (!m || m.sig !== sig) { m = { sig, polys: new Map() }; store.maps.set(mapId, m); }
    const key = `${r2(o.x)},${r2(o.y)},${r2(reachPx)}`;
    if (!used.has(mapId)) used.set(mapId, new Set());
    used.get(mapId).add(key);
    let p = m.polys.get(key);
    if (!p) {
      p = make();
      if (!bad) m.polys.set(key, p);
    }
    return p;
  }
  function done() {
    if (!store) return;
    for (const [id, m] of store.maps) {
      const keep = used.get(id);
      if (!keep) { store.maps.delete(id); continue; }
      for (const k of [...m.polys.keys()]) if (!keep.has(k)) m.polys.delete(k);
    }
  }
  return { get, blockers: (id) => blockersOf(id).list, done, failed: fails.first };
}

// ---- the test (pure) ----

export function seenTest(snap, { cache = null, maps = null, polys = null } = {}) {
  const P = polys || polygons(cache, snap);
  const fails = failures();
  const pxPerFt = snap?.grid?.pxPerFt;
  const dark = darkMapIds(snap);
  const lights = new Map(); // mapId -> the public lights on it
  const lightsOf = (id) => {
    if (!lights.has(id)) lights.set(id, fails.guard("litLightsOn", () => litLightsOn(snap, id), []));
    return lights.get(id);
  };
  // Each PC's sight polygon (the fog it lifts), only on the maps asked for.
  const pcItem = new Map((Array.isArray(snap?.pcs) ? snap.pcs : []).filter((p) => p?.id != null).map((p) => [p.id, p]));
  const views = new Map(); // mapId -> [{v, poly, dvPx}]
  // pcViews swallows a throw in a PC's reach (visionOf, its light, the lights near it) and drops that
  // PC, as the covers always had it; here it is noted too, so the report fails closed
  const reachFailed = (e) => fails.note("pcViews", e);
  for (const v of finite(pxPerFt) && pxPerFt > 0 ? fails.guard("pcViews", () => pcViews(snap, reachFailed), []) : []) {
    if (maps && !maps.has(v.mapId)) continue;
    const { poly } = P.get(v.mapId, v.c, v.reachPx);
    if (poly.length < 3) continue;
    if (!views.has(v.mapId)) views.set(v.mapId, []);
    views.get(v.mapId).push({ v, poly, dvPx: dvFtOf(pcItem.get(v.id), snap.vctx, (e) => fails.note("visionOf", e)) * pxPerFt });
  }

  // Lit for a PC on dark ground: some part of it strictly within a light's reach on the same map,
  // its middle in the light's cone and in that light's own line of sight.
  const litAt = (t) => lightsOf(t.mapId).some((l) => Math.sqrt(d2(l, t.c)) - t.r < l.reach * pxPerFt
    && fails.guard("inCone", () => inCone(l, t.c), false) && canSee({ x: l.x, y: l.y }, t.c, P.blockers(t.mapId)));
  // In a PC's sight: its middle inside the PC's sight polygon, or in its line of sight with some part
  // of it inside the polygon's reach (the fog lifts over the near part of a creature at the edge).
  const inView = (t, v, poly, d) => pointInPolygon(t.c, poly)
    || (d - t.r < v.reachPx && canSee(v.c, t.c, P.blockers(t.mapId)));
  // The PCs that see t, in snap.pcs order (`first`: stop at the first one).
  const seers = (t, first) => {
    const out = [];
    const onDark = dark.has(t.mapId);
    let lit = null;
    for (const { v, poly, dvPx } of views.get(t.mapId) || []) {
      const d = Math.sqrt(d2(v.c, t.c));
      if (!inView(t, v, poly, d)) continue;
      let ok = !onDark // ☀ / 🌒: in view is seen
        || !v.dark // it stands on ground that isn't 🌑: it sees by line of sight
        || d < v.dark.ft * pxPerFt // the middle within its own reach (its square, darkvision, own light)
        || (dvPx > 0 && d - t.r < dvPx); // some part of it in its darkvision (the overlay greys it)
      if (!ok) {
        if (lit == null) lit = litAt(t);
        ok = lit;
      }
      if (!ok) continue;
      out.push(v.id);
      if (first) break;
    }
    return out;
  };
  return { views, polys: P, lightsOf, seersOf: (t) => seers(t, false), sees: (t) => seers(t, true).length > 0,
    // the first part that threw so far (its fallback taken), or null; the covers never ask
    degraded: () => fails.first() ?? P.failed?.() ?? null };
}

// Every creature the snapshot holds -> the PCs that see it, sorted ([] = nobody). cache: an object
// the caller keeps between plans (background.js keeps one between map reports), so an unchanged map
// works out no polygon again. strict (the map report's): throws when a part of the test threw (its
// fallback would have sent [] for a creature a PC sees, or seen one through a wall).
export function seenByPlan(snap, { cache = null, strict = false } = {}) {
  const out = new Map();
  if (!snap) return out;
  const all = creaturesOf(snap);
  const S = seenTest(snap, { cache, maps: new Set(all.map((t) => t.mapId).filter((id) => id != null)) });
  for (const t of all) out.set(t.item.id, S.seersOf(t).map(String).sort());
  S.polys.done();
  const why = S.degraded();
  if (strict && why) throw new Error(`the sight test failed in part (${why})`);
  return out;
}
