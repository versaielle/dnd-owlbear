// The dark cover for the vision layer (docs/vision-layer-2024.md section 12, fix C): on a 🌑 map, a
// LOCAL black shape over every creature that no PC sees, so its HP bar, its badges and rings and its
// name tag never float in the black where a PC's sight light has lifted Owlbear's fog. Drawn on
// players' screens, phones and the projector's Cast receiver only, never on a GM screen (Fog Preview
// there is left uncovered), and only while 🌫 Our fog is on: fog.js makes it with the other parts and
// calls sync() on each pass (first in each pass, before the walls and the sight lights), clear() when
// the switch goes off.
//
// WHY. On dark ground a PC's PRIMARY sight light (fog/sight.js) reaches as far as the farthest light on
// its own map (ruling (a): lit ground in line of sight is seen from the dark), so Owlbear's fog opens a
// whole circle round it, unlit squares included. Our darkness overlay (fx/lighting.js, ATTACHMENT z 0)
// paints those squares and the tokens on them black, but everything drawn above it still shows there:
// Stat Bubbles' HP bars (ATTACHMENT z 10000 and up, and TEXT), our condition badges, Colored Rings, the
// aim rings, name tags. Live 2026-10-14 (the DM: "also seeing npcs/tokens through the dark"; he chose
// bars "Only when visible").
//
// THE RULE, per creature (a CHARACTER or MOUNT token, hidden ones too, not a PC by fx/pcs.js, never a
// light carrier), on a map whose darkness is 🌑 (fog/maps.js mapStates darkLocked, the 🌑 lock's own
// resolution), with or without a PC on it (a PC's sight light lands on a new map still sized for the
// one it left):
//   SEEN   some PC on that map has line of sight to the creature's middle (inside that PC's sight
//          polygon: fog/los.js visibilityPolygon from its middle, out to fog/sight.js sightReachFt,
//          among fog/shapes.js sightBlockersOf: walls, closed and secret doors and the map's edge; a
//          window or an open door lets sight through; or nothing in the way and some part of it inside
//          that reach: the fog lifts over its near side), AND either that PC doesn't stand in 🌑 (it sees
//          by line of sight), or the middle is strictly within the PC's own reach on dark ground
//          (fog/shapes.js darkReachFt: at least its own square, its darkvision, its own light), or ANY
//          PART of the creature (its disc, half its smaller side) is strictly within that PC's
//          darkvision or the reach of a public light ON THE SAME MAP (fog/shapes.js litLightsOn; a cone
//          only with the middle in the cone) that has line of sight to the middle itself (lights don't
//          shine through walls): what our overlay paints in colour or grey there, it shows
//          (the test itself lives in fog/inview.js seenTest since V1, shared with the map report's
//          seen_by; on a 🌑 map it is this rule word for word)
//   COVERED   every other one, nearest a PC first (those on a map with no PC last), at most MAX_COVERS:
//          under the fog a cover can't be
//          seen, so it is already in place when a door opens, a PC steps or a sight light grows, and
//          when the DM unhides a creature or drags it into the lifted dark (the cover keeps VISIBLE)
// A PC is never covered. Nothing is drawn on a ☀ or 🌒 map, on a GM screen, or with 🌫 off.
//
// THE COVER. A PATH on the RULER layer (COVER_LAYER, z COVER_Z, auto z off): above every ATTACHMENT
// and TEXT item (Stat Bubbles' bars and name tags, badges, rings: Owlbear draws its layers in the SDK's
// Layer order, MAP ... ATTACHMENT, NOTE, TEXT, RULER, FOG, POINTER ...), and still UNDER the FOG layer,
// so wherever part of it lies outside the lifted fog, the fog covers that part: no black shape on the
// fog colour, and Owlbear's own reveal does the clipping exactly. (The order is the SDK's. RULER under
// the fog matches the 2026-10-06 spell FX live test, commit 4e816a5: effects and the aim template, then
// on ATTACHMENT, TEXT and RULER, "sat under FOG"; RULER over the bars is a live check.) Owlbear's rulers
// (auto z: timestamps) draw above it; spell effects, numbers and aim templates (POINTER, fx/engine.js)
// above the fog too.
// Pure black (COVER_COLOR, #000000: the overlay's player black, MULTIPLY 0), no stroke, locked,
// disableHit. Its box: the token's footprint (fx/place.js footprint: its image over its grid dpi, times
// the scene's dpi and its scale) grown by COVER_SIDE, COVER_TOP and COVER_BELOW of the token's smaller
// side (at least COVER_*_MIN of a square: name tags and bars don't shrink with a small token), more
// below for Stat Bubbles' bar and name tag; the condition badges reach 0.64 of a token from its middle;
// the box is held to the creature's own map. Cut out of it (with the polygon library, fog/clipper.js)
// is every PC's and seen creature's disc (the overlay keeps the PCs' minis clear). With OWN_BOX_BLACK
// (the default since the 2026-10-15 review) that is all: the rest of the box is black on any ground,
// lit, darkvision grey or a neighbour's bar and name tag, because the creature's own name tag, bar and
// badges hang there (a black strip says something is there, never what). With it false (fc4c17a), the
// cover is drawn only where our overlay paints black: also cut out (CUT_SOFT_FT past each edge, where
// the overlay's own fade ends) are
//   - the ground lit by each public light on the same map, within its own line of sight (its
//     visibilityPolygon out to its reach),
//   - the ground inside each PC's darkvision on that map, within that PC's line of sight,
//   - every PC's and seen creature's whole box (bar, bubbles, badges, name tag: coverBox) except where
//     it lies on this creature's own footprint (its own token, ring and badges stay black there).
// (A light's ground behind a wall from it stays covered: the overlay still colours its circle through
// walls, so a creature there would show in colour; the black hides it. A cone light's ground is its
// whole circle, as the overlay paints it.) A HIDDEN creature's cover keeps off every public light's
// whole circle (any map, through walls), every PC's whole darkvision and every neighbour's whole box
// off its own footprint, either way, so even if Owlbear showed a local item attached to a hidden token
// (a live check), it would be black on black.
// Where nothing of that meets the box, the cover is the box itself (no library call). Until the library
// has loaded on this screen (it loads the first time a dark map has a creature on it; never on a GM
// screen), if it can't, or for a shape it refuses: the box with each PC's and seen creature's disc cut
// out (even-odd), as before the review; a library that won't load is said once in the 🪵 Live log.
// ATTACHED to its creature (POSITION, VISIBLE and DELETE kept; ROTATION, SCALE and COPY off), so it
// rides along on every drag at once, goes when the token is deleted, and a move asks Owlbear for
// nothing: a spec's sig is relative to the token's position (as an attached sight light's). Its place
// is worked out from the creature's position read from Owlbear just before each write (not the pass's
// snapshot, which is old by then while the DM drags it), and checked once on the next sync after any
// write: a cover that sits more than POS_SLACK_PX off its creature + its offset is put back.
//
//   COVER_LAYER, COVER_Z, COVER_COLOR, MAX_COVERS, COVER_SIDE, COVER_TOP, COVER_BELOW (+ _MIN), HOLE_STEPS,
//   CUT_SOFT_FT, POS_SLACK_PX, OWN_BOX_BLACK
//   coverBox(item, dpi)     {x0, y0, x1, y1, cx, cy, r}: the cover's box round a token (scene px) and
//                           its own disc (middle, radius); null when it has no place
//   darkMapIds(snap)        the ids of the snapshot's maps whose darkness is 🌑
//   coverInputSig(snap, {gm})   everything coverPlan reads (pure): unchanged = no plan is built
//   coverPlan(snap, {gm, max, clip, cache})  -> {specs: [{key, of, position, width, height, commands,
//                           rings, holes, rel, sig, d}], wanted, cut}: the covers this screen draws,
//                           nearest a PC first, at most `max` (MAX_COVERS); wanted = how many creatures
//                           needed one; cut = drawn with the library (clip: fog/clipper.js's default
//                           export; without it, the fallback above). cache: an object this screen keeps
//                           between plans, so a creature's move doesn't work out the PCs', lights' and
//                           darkvisions' polygons again (pure otherwise)
//   planSig(specs)
//   createCover(api, ctx)   -> {sync(snap), clear(), forget(), status()}
//
// ctx (fog.js partCtx): host, isGm, log(text, kind), kick() (a pass soon: the library has loaded).
// api: {OBR, buildPath}, optionally clip (the library, already loaded: the checks) or loadClip() (a
// promise of it). Each sync makes at most one addItems, one updateItems and one deleteItems (and one
// read of the creatures' positions before a write, one read-back after it), and none at all when the
// input or the plan is unchanged (a sig per creature, like fog/memory.js). LOCAL items only
// (OBR.scene.local): nothing here writes the scene, its items or any metadata. A failed write is read
// back on the next sync (fog.js retries the pass); fog.js's own sweep removes our items
// (FOG_LOCAL_KEY {kind: "cover", host}) whenever the switch goes off or the page starts.

import { FOG_LOCAL_KEY } from "../keys.js?v=a4e86997-d1d2510";
import { DV_SOFT_FT } from "../fx/lights.js?v=a4e86997-d1d2510";
import { centreOf } from "../views.js?v=a4e86997-d1d2510";
import { arcSteps, clipOk, litLights } from "./shapes.js?v=a4e86997-d1d2510";
import { seenInputSig } from "./seen.js?v=a4e86997-d1d2510";
import { creaturesOf, darkMapIds, dvFtOf, footOf, seenTest } from "./inview.js?v=a4e86997-d1d2510";

export { darkMapIds }; // (fog/inview.js's: the 🌑 maps)

export const COVER_LAYER = "RULER";
export const COVER_Z = 0; // under Owlbear's own rulers (auto z: timestamps)
export const COVER_COLOR = "#000000";
export const MAX_COVERS = 40;
// The box round the token's footprint, as shares of its smaller side (s), each at least the _MIN share
// of a square (the scene's dpi): sides, top, and below (Stat Bubbles' bar and name tag sit under it).
export const COVER_SIDE = 0.25, COVER_SIDE_MIN = 0.2;
export const COVER_TOP = 0.2, COVER_TOP_MIN = 0.15;
export const COVER_BELOW = 0.55, COVER_BELOW_MIN = 0.45;
export const HOLE_STEPS = 24; // a hole's disc as a polygon of this many sides, drawn round the disc
export const CUT_SOFT_FT = DV_SOFT_FT; // the overlay fades to black over this past a light's reach and a darkvision's
export const POS_SLACK_PX = 1; // a cover this far off its creature + its offset is put back
// Where a shown creature's box lies on lit or darkvision ground, or over a neighbour's bar, badges or
// name tag, the black wins: its own name tag, HP bar and badges hang there, and the DM chose bars "Only
// when visible" (review of fix C, 2026-10-15: cutting that ground out showed the Reeve's name tag on the
// PCs' side of a closed door, and a goblin's on top of Ari's square). Only the PCs' and seen creatures'
// minis are cut out. The black says something is there, never what. false = fc4c17a's way: that ground
// and those boxes are cut out, so the creature's own name tag, bar and badges show wherever they reach.
export const OWN_BOX_BLACK = true;
const CLIP_RETRY_MS = 30000; // a library that didn't load is tried again after this
const SCALE = 10; // the library works in whole numbers: tenths of a pixel
const KIND = "cover";
const NAME = "dnd-npc cover";
const MOVE = 0, LINE = 1, CLOSE = 5; // Path commands (as fog/memory.js)
// The cover follows its creature: on a drag at once, hidden and shown with it, gone with it; never
// turned or scaled by Owlbear (the next pass gives it the token's new box), never copied.
const DETACHED = ["ROTATION", "SCALE", "COPY"];

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const r1 = (x) => Math.round(x * 10) / 10 + 0;
const r2 = (x) => Math.round(x * 100) / 100 + 0; // + 0: no -0
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };

// ---- the box (pure) ----

export function coverBox(item, dpi) {
  const D = finite(dpi) && dpi > 0 ? dpi : 150;
  const fp = footOf(item, D); // (null: no place, or no size)
  if (!fp) return null;
  const s = Math.min(fp.w, fp.h);
  const side = Math.max(COVER_SIDE * s, COVER_SIDE_MIN * D);
  const top = Math.max(COVER_TOP * s, COVER_TOP_MIN * D);
  const below = Math.max(COVER_BELOW * s, COVER_BELOW_MIN * D);
  return { x0: fp.x - fp.w / 2 - side, y0: fp.y - fp.h / 2 - top, x1: fp.x + fp.w / 2 + side, y1: fp.y + fp.h / 2 + below,
    cx: fp.x, cy: fp.y, r: s / 2, fp: { x0: fp.x - fp.w / 2, y0: fp.y - fp.h / 2, x1: fp.x + fp.w / 2, y1: fp.y + fp.h / 2 } };
}

const boxPts = (b) => [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }];
const meet = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const andBox = (a, b) => {
  const o = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return o.x1 > o.x0 && o.y1 > o.y0 ? o : null;
};

// A polygon clipped to box b (Sutherland-Hodgman against the box, which is convex): the part inside
// it, [] when none. A star-shaped polygon whose inside falls apart in the box comes back as one ring
// with edges that run back along the box's side: they hold no area (the library's NonZero ignores them).
function clipToBox(pts, b) {
  let out = pts;
  const edges = [
    [(p) => p.x >= b.x0, (p, q) => ({ x: b.x0, y: p.y + ((q.y - p.y) * (b.x0 - p.x)) / (q.x - p.x) })],
    [(p) => p.x <= b.x1, (p, q) => ({ x: b.x1, y: p.y + ((q.y - p.y) * (b.x1 - p.x)) / (q.x - p.x) })],
    [(p) => p.y >= b.y0, (p, q) => ({ x: p.x + ((q.x - p.x) * (b.y0 - p.y)) / (q.y - p.y), y: b.y0 })],
    [(p) => p.y <= b.y1, (p, q) => ({ x: p.x + ((q.x - p.x) * (b.y1 - p.y)) / (q.y - p.y), y: b.y1 })],
  ];
  for (const [inside, cross] of edges) {
    const src = out;
    out = [];
    for (let k = 0; k < src.length; k++) {
      const p = src[k], q = src[(k + 1) % src.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(cross(p, q));
    }
    if (!out.length) return [];
  }
  return out;
}

// A disc as a polygon drawn round it (its sides touch the circle, so the whole disc is cut out).
function discPolygon(c, r, steps = HOLE_STEPS) {
  const R = r / Math.cos(Math.PI / steps);
  return Array.from({ length: steps }, (_, k) => {
    const t = (2 * Math.PI * k) / steps;
    return { x: c.x + R * Math.cos(t), y: c.y + R * Math.sin(t) };
  });
}

const discMeetsBox = (d, b) => {
  const nx = Math.max(b.x0, Math.min(d.x, b.x1)), ny = Math.max(b.y0, Math.min(d.y, b.y1));
  return (d.x - nx) ** 2 + (d.y - ny) ** 2 < d.r * d.r;
};

// ---- the polygon library (fog/clipper.js, passed in as `clip`) ----

const toPath = (pts) => pts.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
function positive(clip, path) {
  if (path.length >= 3 && !clip.Clipper.Orientation(path)) path.reverse();
  return path;
}
function run(clip, type, subject, other) {
  const c = new clip.Clipper();
  if (subject.length) c.AddPaths(subject, clip.PolyType.ptSubject, true);
  if (other.length) c.AddPaths(other, clip.PolyType.ptClip, true);
  const out = [];
  if (!c.Execute(clip.ClipType[type], out, clip.PolyFillType.pftNonZero, clip.PolyFillType.pftNonZero)) {
    throw new Error("the polygon library refused a cover's shape");
  }
  return out.filter((p) => Array.isArray(p) && p.length >= 3);
}
const MIN_RING_AREA = 2 * SCALE * SCALE; // a ring under 2 square px is dropped (a sliver of rounding)

// ---- who stands where (pure) ----

const mapsOf = (snap) => (Array.isArray(snap?.maps) ? snap.maps : []);

// Every token that could be a creature (fog/inview.js creaturesOf: on CHARACTER or MOUNT, not a PC,
// not a light carrier, with a place; hidden ones too: a cover made for a hidden creature hides and
// shows with it, so it is on before the DM unhides it). -> [{item, c, mapId, r, fp, box}] (box: coverBox).
function tokensOf(snap) {
  const dpi = snap?.grid?.dpi;
  const out = [];
  for (const t of creaturesOf(snap)) {
    const box = coverBox(t.item, dpi);
    if (box) out.push({ ...t, box });
  }
  return out;
}

// The PCs' own boxes (their discs are what the overlay keeps clear), wherever they stand.
function pcBoxes(snap) {
  const dpi = snap?.grid?.dpi;
  const out = [];
  for (const pc of Array.isArray(snap?.pcs) ? snap.pcs : []) {
    const b = pc ? coverBox(pc, dpi) : null;
    if (b) out.push({ id: pc.id, x: b.cx, y: b.cy, r: b.r, box: b });
  }
  return out;
}

export function coverInputSig(snap, { gm = false } = {}) {
  if (gm) return "gm";
  if (!snap) return "none";
  const dark = darkMapIds(snap);
  if (!dark.size) return "no dark map";
  const cs = tokensOf(snap).filter((t) => dark.has(t.mapId))
    .map((t) => [t.item.id, t.mapId, r1(t.c.x), r1(t.c.y), r1(t.box.x0), r1(t.box.y0), r1(t.box.x1), r1(t.box.y1),
      finite(t.item.position?.x, t.item.position?.y) ? [r1(t.item.position.x), r1(t.item.position.y)] : null, t.item.visible === false]);
  if (!cs.length) return `dark ${JSON.stringify([...dark])}|no creature`;
  const pcs = pcBoxes(snap).map((d) => [d.id, r1(d.box.x0), r1(d.box.y0), r1(d.box.x1), r1(d.box.y1)]);
  const dv = (Array.isArray(snap.pcs) ? snap.pcs : []).map((p) => [p?.id, dvFtOf(p, snap.vctx)]);
  const lights = safe(() => litLights(snap.vctx), []).map((l) => [l.id ?? null, r1(l.x), r1(l.y), l.reach]);
  return JSON.stringify([[...dark], cs, pcs, dv, lights, safe(() => seenInputSig(snap), "?")]);
}

// ---- the plan (pure; the polygons kept between plans in `cache`: fog/inview.js polygons) ----

export function coverPlan(snap, { gm = false, max = MAX_COVERS, clip = null, cache = null } = {}) {
  const none = { specs: [], wanted: 0, cut: false };
  if (gm || !snap) return none;
  const dark = darkMapIds(snap);
  if (!dark.size) return none;
  const dpi = snap.grid?.dpi, pxPerFt = snap.grid?.pxPerFt;
  if (!finite(dpi, pxPerFt) || !(dpi > 0) || !(pxPerFt > 0)) return none;
  const all = tokensOf(snap);
  const onDark = all.filter((t) => dark.has(t.mapId));
  if (!onDark.length) return none;
  const lib = clipOk(clip) ? clip : null;
  // Each PC's sight polygon (the fog it lifts), only on the dark maps a creature stands on, and the
  // one test of who sees what (fog/inview.js seenTest; on a 🌑 map: THE RULE above).
  const S = seenTest(snap, { cache, maps: new Set(onDark.map((t) => t.mapId)) });
  const P = S.polys, views = S.views, lightsOf = S.lightsOf, seen = S.sees;
  const soft = CUT_SOFT_FT * pxPerFt + 1; // past the overlay's fade, and its pixel
  const rectOf = new Map(mapsOf(snap).filter((m) => m?.id != null && m.rect).map((m) => [m.id, m.rect]));
  const pcItem = new Map((Array.isArray(snap.pcs) ? snap.pcs : []).filter((p) => p?.id != null).map((p) => [p.id, p]));
  // (a 🌑 map with no PC on it still gets its covers, under the fog: a PC's sight light rides with it
  // the moment the party lands there, still sized for the map it left: review of fix C, 2026-10-15)

  const seenOnes = [];
  const unseen = [];
  for (const t of onDark) {
    const vs = views.get(t.mapId) || []; // none: no PC on this map, the fog hides it all (for now)
    if (seen(t)) { // (a hidden one shows nothing on this screen: nothing is cut for it)
      if (t.item.visible !== false) seenOnes.push({ id: t.item.id, x: t.box.cx, y: t.box.cy, r: t.box.r, box: t.box });
      continue;
    }
    // nearest a PC first; on a map with no PC on it, last
    unseen.push({ t, d: vs.length ? Math.min(...vs.map(({ v }) => Math.sqrt(d2(v.c, t.c)))) : Infinity });
  }
  unseen.sort((a, b) => a.d - b.d || (String(a.t.item.id) < String(b.t.item.id) ? -1 : 1));
  // What our overlay doesn't paint black, per map: each light's lit ground and each PC's darkvision,
  // within their own line of sight (polygons), and the PCs' and seen creatures' minis and boxes.
  const litPolys = new Map();
  const litOf = (id) => {
    if (!litPolys.has(id)) {
      const out = [];
      for (const l of lightsOf(id)) {
        const p = P.get(id, { x: l.x, y: l.y }, l.reach * pxPerFt + soft);
        if (p.poly.length >= 3) out.push(p);
      }
      for (const { v, dvPx } of views.get(id) || []) {
        if (!(dvPx > 0)) continue;
        const p = P.get(id, v.c, dvPx + soft);
        if (p.poly.length >= 3) out.push(p);
      }
      litPolys.set(id, out);
    }
    return litPolys.get(id);
  };
  // A hidden creature's cover (it hides with its creature, but whether Owlbear hides a local item
  // attached to a hidden one is a live check): never on ground our overlay paints at all, so it can't
  // tell of the creature even if it shows. Every public light's whole circle (any map, through walls,
  // as the overlay paints it) and every PC's whole darkvision.
  let wholeCircles = null;
  const wholeOf = () => {
    if (!wholeCircles) {
      wholeCircles = [];
      const add = (c, r) => {
        const poly = discPolygon(c, r, arcSteps(r));
        wholeCircles.push({ poly, bounds: { x0: c.x - r - 1, y0: c.y - r - 1, x1: c.x + r + 1, y1: c.y + r + 1 } });
      };
      for (const l of safe(() => litLights(snap.vctx), [])) add({ x: l.x, y: l.y }, l.reach * pxPerFt + soft);
      for (const pc of pcItem.values()) {
        const dv = dvFtOf(pc, snap.vctx);
        const c = dv > 0 ? safe(() => centreOf(pc, dpi)) : null;
        if (c && finite(c.x, c.y)) add(c, dv * pxPerFt + soft);
      }
    }
    return wholeCircles;
  };
  const others = [...pcBoxes(snap), ...seenOnes];
  const specs = [];
  const cap = Math.max(0, max);
  for (const { t, d } of unseen) {
    if (specs.length >= cap) break;
    const rect = rectOf.has(t.mapId) ? andBox(t.box, rectOf.get(t.mapId)) : { x0: t.box.x0, y0: t.box.y0, x1: t.box.x1, y1: t.box.y1 };
    if (!rect) continue;
    const near = others.filter((o) => o.id !== t.item.id && meet(o.box, rect));
    const hidden = t.item.visible === false;
    const lit = lib ? (hidden ? wholeOf() : OWN_BOX_BLACK ? [] : litOf(t.mapId)).filter((p) => p.bounds && meet(p.bounds, rect)) : [];
    // (a shape the library refuses: the fallback for this one)
    const cutOnes = lib ? safe(() => cutRings(lib, t, rect, near, lit, hidden || !OWN_BOX_BLACK), null) : null;
    const rings = cutOnes ?? holeRings(rect, near);
    if (!rings.length) continue; // nothing of it on black ground
    specs.push(specOf(t, rect, rings, d, !!cutOnes));
  }
  P.done();
  return { specs, wanted: unseen.length, cut: !!lib };
}

// The cover's rings with the library: the box (held to its map) less the lit and darkvision ground
// passed in (lit), the minis near it, and (boxCut) their boxes off this creature's own footprint.
// -> rings, scene px.
function cutRings(clip, t, rect, near, lit, boxCut) {
  const cuts = [];
  for (const p of lit) {
    const piece = clipToBox(p.poly, rect);
    if (piece.length >= 3) cuts.push(positive(clip, toPath(piece)));
  }
  for (const o of near) {
    const disc = { x: o.x, y: o.y, r: o.r + 1 };
    if (!discMeetsBox(disc, rect)) continue;
    const piece = clipToBox(discPolygon(disc, disc.r), rect);
    if (piece.length >= 3) cuts.push(positive(clip, toPath(piece)));
  }
  const boxes = boxCut ? near.map((o) => andBox(o.box, rect)).filter(Boolean).map((b) => positive(clip, toPath(boxPts(b)))) : [];
  if (boxes.length) {
    const own = andBox(t.box.fp, rect);
    cuts.push(...(own ? run(clip, "ctDifference", boxes, [positive(clip, toPath(boxPts(own)))]) : boxes));
  }
  if (!cuts.length) return [boxPts(rect)];
  let out = run(clip, "ctDifference", [positive(clip, toPath(boxPts(rect)))], cuts);
  out = safe(() => clip.Clipper.CleanPolygons(out, SCALE / 2), out) || out;
  return out.filter((p) => Array.isArray(p) && p.length >= 3 && Math.abs(clip.Clipper.Area(p)) >= MIN_RING_AREA)
    .map((p) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE })));
}

// Without the library: the box with the discs it overlaps cut out (even-odd), each clipped to it.
function holeRings(rect, near) {
  const rings = [boxPts(rect)];
  for (const o of near) {
    if (!discMeetsBox(o, rect)) continue;
    const ring = clipToBox(discPolygon(o, o.r), rect);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function specOf(t, rect, rings, d, cut) {
  const ox = r2(rect.x0), oy = r2(rect.y0);
  const w = r2(rect.x1 - ox), h = r2(rect.y1 - oy);
  const commands = [];
  for (const ring of rings) {
    ring.forEach((p, k) => commands.push([k ? LINE : MOVE, r2(p.x - ox), r2(p.y - oy)]));
    commands.push([CLOSE]);
  }
  const pos = t.item.position;
  const rel = { dx: r2(ox - pos.x), dy: r2(oy - pos.y) };
  return { key: String(t.item.id), of: t.item.id, position: { x: ox, y: oy }, width: w, height: h, commands,
    rings: rings.length, holes: cut ? null : rings.length - 1, rel,
    sig: `${rel.dx},${rel.dy}|${w}x${h}|${JSON.stringify(commands)}`, d: r1(d) };
}

export const planSig = (specs) => (specs || []).map((s) => `${s.key}#${s.sig}`).join(";");

// ---- drawing ----

export function createCover(api = {}, ctx = {}) {
  const host = ctx.host ?? "";
  const log = (text) => { try { ctx.log?.(text, KIND); } catch { /* nowhere to say it */ } };
  const OBR = () => api.OBR;
  const T = ctx.timers || { now: () => Date.now() };
  const now = () => safe(() => T.now(), Date.now());
  const tagOf = (i) => {
    const t = i?.metadata?.[FOG_LOCAL_KEY];
    return t && typeof t === "object" ? t : null;
  };
  const ours = (i) => tagOf(i)?.kind === KIND && tagOf(i)?.host === host;

  let drawn = new Map(); // key -> {id, of, sig, rel}
  let appliedIn = null; // the input signature last drawn in full
  let applied = null; // the plan signature last drawn in full
  let dirty = false; // a write failed: read our items back before the next one
  let check = false; // a write went out: check the covers' places on the next sync
  let lastError = null;
  let wanted = 0, saidOn = false, saidCap = false;
  const cache = {}; // the polygons, between plans

  // ---- the polygon library: loaded the first time a dark map has a creature, never on a GM screen ----
  let clip = clipOk(api.clip) ? api.clip : null;
  let clipLoading = null, clipFailedAt = -Infinity, clipSaid = null;
  const loadClip = typeof api.loadClip === "function" ? api.loadClip : () => import("./clipper.js?v=a4e86997-d1d2510").then((m) => m.default);
  function ensureClip() {
    if (clip || clipLoading || now() - clipFailedAt < CLIP_RETRY_MS) return;
    const job = Promise.resolve().then(() => loadClip());
    clipLoading = job;
    job.then((lib) => {
      if (!clipOk(lib)) throw new Error("fog/clipper.js didn't give the polygon library");
      clip = lib;
      clipLoading = null;
      if (clipSaid) log("the dark covers' polygon library loaded: covers are cut to the dark ground again");
      clipSaid = null;
      appliedIn = null; // plan again, now with the cuts
      safe(() => ctx.kick?.());
    }).catch((e) => {
      if (clipLoading !== job) return;
      clipLoading = null;
      clipFailedAt = now();
      const text = String(e?.message || e);
      if (text !== clipSaid) {
        log(`✖ the dark covers' polygon library (fog/clipper.js) didn't load, so each cover is its creature's whole box`
          + ` (it may show as a black shape on lit ground; tried again in ${Math.round(CLIP_RETRY_MS / 1000)} s): ${text}`);
      }
      clipSaid = text;
    });
  }

  const tag = (s) => ({ kind: KIND, key: s.key, sig: s.sig, of: s.of, rel: s.rel, host });
  const opt = (b, method, ...v) => (typeof b?.[method] === "function" ? b[method](...v) : b);

  // Where each creature stands NOW (read from Owlbear just before a write: the pass's snapshot is old
  // by then while the DM drags it). A read that fails or misses one: the snapshot's place.
  async function placesOf(ids) {
    const out = new Map();
    if (!ids.length) return out;
    try {
      const list = await OBR().scene.items.getItems([...new Set(ids)]);
      for (const i of Array.isArray(list) ? list : []) if (i?.id != null && finite(i.position?.x, i.position?.y)) out.set(i.id, { ...i.position });
    } catch { /* the snapshot's place, then */ }
    return out;
  }
  const placeOf = (s, at) => {
    const p = at.get(s.of);
    return p ? { x: r2(p.x + s.rel.dx), y: r2(p.y + s.rel.dy) } : { ...s.position };
  };

  function build(s, at) {
    let b = api.buildPath().commands(s.commands).position(placeOf(s, at)).fillRule("evenodd")
      .fillColor(COVER_COLOR).fillOpacity(1).strokeColor(COVER_COLOR).strokeOpacity(0).strokeWidth(0)
      .layer(COVER_LAYER).zIndex(COVER_Z);
    b = opt(b, "disableAutoZIndex", true);
    b = b.attachedTo(s.of);
    b = opt(b, "disableAttachmentBehavior", DETACHED);
    return b.locked(true).disableHit(true).name(NAME).metadata({ [FOG_LOCAL_KEY]: tag(s) }).build();
  }

  function restyle(d, s, at) {
    d.position = placeOf(s, at);
    d.commands = s.commands.map((c) => [...c]);
    d.fillRule = "evenodd";
    d.style = { ...(d.style || {}), fillColor: COVER_COLOR, fillOpacity: 1, strokeColor: COVER_COLOR, strokeOpacity: 0, strokeWidth: 0 };
    d.metadata = { ...(d.metadata || {}), [FOG_LOCAL_KEY]: tag(s) };
  }

  async function readBack(del) {
    const local = await OBR().scene.local.getItems(ours);
    const next = new Map();
    for (const i of local || []) {
      const t = tagOf(i);
      if (typeof t.key !== "string" || next.has(t.key)) { del.push(i.id); continue; }
      next.set(t.key, { id: i.id, of: i.attachedTo ?? t.of, sig: t.sig, rel: isObj(t.rel) ? t.rel : null });
    }
    drawn = next;
  }

  // Once after a write, when its creatures have stopped (where Owlbear has them now is where the
  // pass's snapshot has them): every cover of ours where it should be (its creature's place + its
  // offset); one that isn't (added or changed while its creature was being dragged) is put back.
  // -> {fixed, moving}: moving = some creature is still on its way, so look again next time.
  async function checkPlaces(snap) {
    const local = (await OBR().scene.local.getItems(ours)) || [];
    const at = await placesOf(local.map((i) => i.attachedTo ?? tagOf(i)?.of).filter((x) => x != null));
    const fix = new Map();
    let moving = false;
    for (const i of local) {
      const t = tagOf(i), of = i.attachedTo ?? t?.of, p = at.get(of);
      if (!p || !isObj(t?.rel) || !finite(t.rel.dx, t.rel.dy, i.position?.x, i.position?.y)) continue;
      const was = safe(() => snap.byId.get(of)?.position, null);
      if (was && finite(was.x, was.y) && (Math.abs(was.x - p.x) > POS_SLACK_PX || Math.abs(was.y - p.y) > POS_SLACK_PX)) { moving = true; continue; }
      const want = { x: r2(p.x + t.rel.dx), y: r2(p.y + t.rel.dy) };
      if (Math.abs(i.position.x - want.x) > POS_SLACK_PX || Math.abs(i.position.y - want.y) > POS_SLACK_PX) fix.set(i.id, want);
    }
    if (fix.size) {
      await OBR().scene.local.updateItems([...fix.keys()], (drafts) => {
        for (const d of drafts) if (fix.has(d.id)) d.position = fix.get(d.id);
      });
    }
    return { fixed: fix.size, moving };
  }

  function say(specs) {
    if (wanted > MAX_COVERS) {
      if (!saidCap) log(`${wanted} creatures stand unseen on dark ground: only the nearest ${MAX_COVERS} are covered on this screen`);
      saidCap = true;
    } else saidCap = false;
    if (specs.length && !saidOn) {
      saidOn = true;
      log(`covering ${specs.length} creature${specs.length === 1 ? "" : "s"} standing unseen in the dark on this screen (token, HP bar and badges black till a PC sees it)`);
    }
  }

  async function doSync(snap) {
    const none = { added: 0, removed: 0, updated: 0, failed: false, error: null };
    if (!snap) return none;
    const gm = !!ctx.isGm;
    if (check && !dirty && !gm) {
      check = false;
      const r = await checkPlaces(snap); // (a read that fails throws: fog.js tries again)
      if (r.fixed || r.moving) check = true; // ...and those are looked at once more
    }
    const inSig = coverInputSig(snap, { gm });
    if (!dirty && inSig === appliedIn) return none;
    if (!gm && inSig.startsWith("[")) ensureClip(); // a dark map with a creature on it
    const planClip = clip; // (the library may arrive while this sync writes: then the next one plans again)
    const plan = coverPlan(snap, { gm, clip, cache });
    wanted = plan.wanted;
    const specs = plan.specs;
    const psig = planSig(specs);
    if (!dirty && psig === applied) { appliedIn = inSig; say(specs); return none; }
    const del = [];
    if (dirty) await readBack(del); // (a read that fails throws: nothing written, fog.js tries again)
    dirty = false;
    const want = new Map(specs.map((s) => [s.key, s]));
    for (const [key, rec] of drawn) {
      const s = want.get(key);
      if (!s || s.of !== rec.of) { del.push(rec.id); drawn.delete(key); }
    }
    const add = [];
    const upd = new Map(); // id -> spec
    for (const s of specs) {
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
    const at = add.length || upd.size ? await placesOf([...add, ...upd.values()].map((s) => s.of)) : new Map();
    // New covers first, then the ones that changed, then the ones no longer needed: a creature
    // stepping into the dark is never shown for a write in between.
    if (add.length) {
      try {
        const built = add.map((s) => build(s, at));
        await OBR().scene.local.addItems(built);
        add.forEach((s, k) => drawn.set(s.key, { id: built[k].id, of: s.of, sig: s.sig, rel: s.rel }));
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
            if (s) restyle(d, s, at);
          }
        });
        for (const s of upd.values()) {
          const rec = drawn.get(s.key);
          if (rec) { rec.sig = s.sig; rec.rel = s.rel; }
        }
        done.updated = upd.size;
      } catch (e) {
        fail("update", e);
      }
    }
    if (del.length) {
      try {
        await OBR().scene.local.deleteItems(del);
        done.removed = del.length;
      } catch (e) {
        fail("delete", e);
      }
    }
    if (done.added || done.updated) check = true;
    if (failed) {
      dirty = true;
      applied = null;
      appliedIn = null;
    } else {
      applied = psig;
      appliedIn = clip === planClip ? inSig : null;
      lastError = null;
      say(specs);
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
      dirty = true;
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
    dirty = false;
    check = false;
    wanted = 0;
    saidOn = false;
    saidCap = false;
  }

  // Everything of ours (this host's covers) comes off, and is forgotten. Nothing drawn and no failed
  // write: nothing to ask Owlbear (fog.js's sweep follows anyway).
  function clear() {
    return queue(async () => {
      const ids = new Set([...drawn.values()].map((r) => r.id));
      const look = dirty || ids.size > 0;
      reset();
      if (look) {
        try {
          for (const i of (await OBR().scene.local.getItems(ours)) || []) ids.add(i.id);
        } catch { /* the scene is closed: its local items went with it */ }
      }
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
    return { covers: drawn.size, wanted, capped: Math.max(0, wanted - MAX_COVERS), cut: !!clip, error: lastError };
  }

  return { sync, clear, forget, status };
}
