// "🧭 Bring PCs here" (GM only): the player characters' tokens move to a building map, the
// town map, a room drawing or next to a token, each on its own square, packed around one spot.
// The menu (menu.html, kind=bring) offers "All PCs" and each PC on their own.
//
// Where they go:
//   a building map                    its entry (ground floors), else its first stairs, else its middle
//   any other map image (the town)    the middle of the image
//   a room drawing                    its middle, or a point inside it when that's outside (an L)
//   a token                           the squares around it (not its own)
// Squares are kept off portal circles (the Portals extension would teleport a token dropped
// there) and off furniture (the props that block, on the maps in the scene).
//
// A building map's entry, stairs and furniture come from its image's MAP_INFO_KEY, which
// "🏘 Set up interiors" writes (interiors.js mapInfo()): every copy reads that, the laptop's
// Pages copy too, which can never reach interiors.json. Only a map without it yet (interiors
// not set up since) falls back to interiors.json, on the copy the panel serves.
//
// Also "👥 Place townsfolk" (GM only, on a map image): each NPC listed in interiors.json's
// town.townsfolk for that map (townsfolkFor) goes to its own square in its room, next to its piece
// of furniture, named as its entry's token. On a building's or a site's own map it also places that
// map's monsters (monsterPlan): the adventure's encounters, as many as the party's size calls for, and
// the scenery its places hide (two dead goblins under a bridge), all hidden: the token of each kind the
// DM dropped beside the maps moved in first, then copies of it, each named as the engine reads it. On a road
// camp's own map (the road's night 1 camp: one place with several fights to roll from) it lays out the road's pool
// instead (poolPlan), as from a drawing marked as that place; the road's other maps say to press it there.
// check_interiors.mjs and check_road_maps.mjs test the pure parts offline.
import OBR, { MathM } from "./obr-sdk.js?v=9a30147";
import { contains, isRoom, outline } from "./areas.js?v=9a30147";
import { ask, directBase } from "./bus.js?v=9a30147";
import { bounds, groupOf, listed, loadInteriors, mapToScene, matchImages, normName, sceneGroups, toScene } from "./interiors.js?v=9a30147";
import { BUBBLES_KEY, BUBBLES_NAME_KEY, DOWN_COLOR, INTERIOR_KEY, MAP_INFO_KEY, PARTY_KEY, PARTY_SENSES_KEY, PLACE_KEY,
         RING_KEY, WHO_KEY, onTokenLayer } from "./keys.js?v=9a30147";
import { nameKey, pcName, tokenLabel } from "./fx/pcs.js?v=9a30147";
import { SENSES, senseMapOf, sensesOf } from "./rules2024.js?v=9a30147";
import { readLine, toWorld } from "./fog/lineread.js?v=9a30147";

const RADIUS = 12; // squares around the spot that are tried

// A name's first word, leading articles skipped ("the old miller" -> "old"; "" when none is left).
const ARTICLES = new Set(["the", "a", "an"]);
const firstWord = (s) => String(s || "").trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "").toLowerCase())
  .find((w) => w && !ARTICLES.has(w)) || "";

// The name a token shows (Stat Bubbles' name tag, then Owlbear's label, then the item's name),
// and the PC a token is, or null: the one rule for the whole extension and the panel
// (fx/pcs.js): "This is…" (pc:<name>) first, a token marked as an NPC is never a PC, else its
// name against the party, whole or its first word ("Ana Ring" is Ana).
export { pcName, tokenLabel };

// Every PC token that can be moved: only roots (an attached one follows its parent), by name.
export function findPcs(items, party = []) {
  return items
    .filter((i) => !i.attachedTo)
    .map((item) => ({ item, name: pcName(item, party) }))
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A token's centre and size on the scene (tokens are images; the offset is the anchor).
export function tokenBox(t, dpi) {
  if (!t.image || !t.grid?.dpi) return { x: t.position.x, y: t.position.y, size: dpi };
  const k = dpi / t.grid.dpi;
  const sx = Math.abs(t.scale?.x ?? 1), sy = Math.abs(t.scale?.y ?? 1);
  return {
    x: t.position.x + (t.image.width / 2 - (t.grid.offset?.x ?? t.image.width / 2)) * k * sx,
    y: t.position.y + (t.image.height / 2 - (t.grid.offset?.y ?? t.image.height / 2)) * k * sy,
    size: Math.min(t.image.width * sx, t.image.height * sy) * k,
  };
}

// The squares a token touches: a box holding the centre of every square that overlaps it (a
// token off the grid blocks the 2 or 4 squares it straddles; one on it, just its own).
function tokenArea(t, dpi) {
  const b = tokenBox(t, dpi);
  return areaAt(b, b.size, dpi);
}

// ...the same for a token of that size with its centre at c.
function areaAt(c, size, dpi) {
  const h = size / 2 + dpi / 2 - dpi / 100;
  return { min: { x: c.x - h, y: c.y - h }, max: { x: c.x + h, y: c.y + h } };
}

// Each portal circle's box on the scene, and the circle itself: a square is blocked when its
// centre is inside the box or on the circle's edge (a box corner, outside the circle, is free).
export function portalBoxes(items) {
  return items.filter((i) => i.metadata?.[INTERIOR_KEY]?.kind === "portal").map((i) => {
    const rx = ((i.width || 0) * Math.abs(i.scale?.x ?? 1)) / 2, ry = ((i.height || 0) * Math.abs(i.scale?.y ?? 1)) / 2;
    return { min: { x: i.position.x - rx, y: i.position.y - ry }, max: { x: i.position.x + rx, y: i.position.y + ry },
             circle: { x: i.position.x, y: i.position.y, r: Math.max(rx, ry) } };
  });
}

const inBox = (b, p) => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y;
const blocks = (b, p) => (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y)
  || (b.circle && Math.hypot(p.x - b.circle.x, p.y - b.circle.y) <= b.circle.r + 1e-6);
const centreOf = (b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 });

// A box [x0, y0, x1, y1] in a map's pixels -> its box on the scene (`here`: mapToScene).
function sceneBox(box, here) {
  const c = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(here);
  const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
  return { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
}

const isMapImage = (i) => i.layer === "MAP" && i.type === "IMAGE";
const xyOk = (p) => p === null || p === undefined || (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));

// A map image's MAP_INFO_KEY (interiors.js mapInfo()), or null when it has none (or a broken one).
export function mapInfoOf(image) {
  const m = image?.metadata?.[MAP_INFO_KEY];
  if (!m || typeof m !== "object" || m.v !== 1 || !xyOk(m.entry) || !xyOk(m.stairs)) return null;
  const props = Array.isArray(m.props) ? m.props.filter((b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) : [];
  return { w: Number.isFinite(m.w) && m.w > 0 ? m.w : 0, entry: m.entry || null, stairs: m.stairs || null, props };
}

// True when interiors.json could still add something: a map image in the scene without MAP_INFO_KEY.
export function needsInteriors(items) {
  return items.some((i) => isMapImage(i) && !mapInfoOf(i));
}

// The furniture nobody can stand on, as scene boxes: every prop that blocks (not rugs, stairs,
// garden beds…) on each map image in the scene, from the image's MAP_INFO_KEY, or from
// interiors.json for an image without it. A square whose centre is inside one is avoided, like a token's.
export function propBoxes(json, items, sceneDpi) {
  const images = items.filter(isMapImage);
  const out = [], rest = [];
  for (const image of images) {
    const info = mapInfoOf(image);
    if (!info) {
      rest.push(image);
      continue;
    }
    const here = mapToScene({ width: info.w }, image, sceneDpi);
    for (const b of info.props) out.push(sceneBox(b, here));
  }
  if (!json || !rest.length) return out;
  const maps = listed(json);
  for (const [name, image] of matchImages(maps, rest)) {
    const map = maps.find((m) => m.name === name);
    const here = mapToScene(map, image, sceneDpi);
    for (const pr of map.props || []) if (pr.blocks !== false && pr.box?.length === 4) out.push(sceneBox(pr.box, here));
  }
  return out;
}

// A drawing's box on the scene, from its outline (getItemBounds does this live).
export function drawingBox(item) {
  const m = MathM.fromItem(item);
  let pts = outline(item);
  if (!pts && item.type === "SHAPE") {
    const rx = item.width / 2, ry = item.height / 2;
    pts = [{ x: -rx, y: -ry }, { x: rx, y: -ry }, { x: rx, y: ry }, { x: -rx, y: ry }];
  }
  const sc = (pts || [{ x: 0, y: 0 }]).map((p) => MathM.decompose(MathM.multiply(m, MathM.fromPosition(p))).position);
  const xs = sc.map((p) => p.x), ys = sc.map((p) => p.y);
  return { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
}

// A point inside the room: the middle of its box if that's in it, else the inside point
// (on a half-square grid over the box) nearest the middle, else its first corner.
export function insidePoint(room, box, dpi) {
  const c = centreOf(box);
  if (contains(room, c)) return c;
  let best = null, bestD = Infinity;
  const step = dpi / 2;
  for (let y = box.min.y + step / 2; y < box.max.y; y += step) {
    for (let x = box.min.x + step / 2; x < box.max.x; x += step) {
      const d = (x - c.x) ** 2 + (y - c.y) ** 2;
      if (d < bestD && contains(room, { x, y })) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  if (best) return best;
  const first = outline(room)?.[0];
  return first ? MathM.decompose(MathM.multiply(MathM.fromItem(room), MathM.fromPosition(first))).position : c;
}

// A map image's name for the notice: its label or name, without the file's extension.
function imageName(image) {
  return tokenLabel(image).replace(/\.(png|jpe?g|webp|gif|avif)$/i, "").trim() || "the map";
}

// Where "Bring PCs here" on this item sends them: {kind, name, point, allowed(p), avoid[]},
// or null for something it can't (a line, text, a prop). `box` is the item's scene bounds when known.
export function targetFor(json, target, sceneDpi, { box } = {}) {
  if (target.layer === "MAP" && target.type === "IMAGE") {
    const area = bounds(target, sceneDpi);
    const allowed = (p) => inBox(area, p);
    const info = mapInfoOf(target);
    if (info) {
      // Laid out by 🏘 Set up interiors: everything needed is on the image (the same on every copy).
      const px = info.entry || info.stairs;
      const point = px ? mapToScene({ width: info.w }, target, sceneDpi)(px) : centreOf(box || area);
      return { kind: "map", name: imageName(target), point, allowed, avoid: [] };
    }
    const names = [target.name, target.text?.plainText].map(normName).filter(Boolean);
    const map = listed(json || {}).find((m) => names.includes(normName(m.name)));
    if (map) {
      const px = map.entry || map.links?.[0]?.at;
      const ratio = map.width ? target.image.width / map.width : 1;
      const point = px ? toScene(target, { x: px[0] * ratio, y: px[1] * ratio }, sceneDpi) : centreOf(area);
      return { kind: "map", name: map.name, point, allowed, avoid: [] };
    }
    const town = json?.town?.name && names.includes(normName(json.town.name));
    return { kind: "map", name: town ? json.town.name : imageName(target), point: centreOf(box || area),
             allowed, avoid: [] };
  }
  if (isRoom(target)) {
    const b = box || drawingBox(target);
    return { kind: "room", name: target.name || "the room", point: insidePoint(target, b, sceneDpi),
             allowed: (p) => contains(target, p), avoid: [] };
  }
  if (target.layer === "CHARACTER") {
    const t = tokenBox(target, sceneDpi);
    return { kind: "token", name: tokenLabel(target) || "the token", point: { x: t.x, y: t.y }, allowed: () => true,
             avoid: [tokenArea(target, sceneDpi)] };
  }
  return null;
}

// The centre of the grid square a point is in (square grid from the scene's origin). Live, the
// spot is snapped by Owlbear instead (OBR.scene.grid.snapPosition), which knows the grid.
export function cellCentre(p, dpi) {
  return { x: Math.floor(p.x / dpi) * dpi + dpi / 2, y: Math.floor(p.y / dpi) * dpi + dpi / 2 };
}

const CLEAR = 0.45; // squares between a token's centre and any wall line (a token on a line gets stuck)

// Every wall line that blocks a move right now, as scene segments [[a, b], ...]: walls and
// windows, and doors unless they're open; never a line the DM switched off. fog/lineread.js readLine
// says what a line is, so our format (WALL_KEY) and Smoke & Spectre's both count, ours and the
// DM's own alike; its points are turned, scaled and moved with their line by lineread.js toWorld (the
// same as MathM, check_fog_lines.mjs), not rounded.
export function wallSegments(items) {
  const out = [];
  for (const i of items || []) {
    const line = readLine(i);
    if (!line || line.disabled || (line.kind === "door" && line.open)) continue;
    const pts = i.points.map((p) => toWorld(i, p));
    if (i.style?.closed && pts.length > 2) pts.push(pts[0]);
    for (let k = 1; k < pts.length; k++) out.push([pts[k - 1], pts[k]]);
  }
  return out;
}

function distToSegment(p, [a, b]) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function crosses(p, q, [a, b]) {
  const side = (u, v, w) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const d1 = side(a, b, p), d2 = side(a, b, q), d3 = side(p, q, a), d4 = side(p, q, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// n square centres around the spot, nearest first: never on a portal or an `avoid` box (the
// target token, other tokens), never within CLEAR of a wall line, and only squares reachable
// from the spot without crossing one (so nobody lands on the wrong side of a wall). Inside
// `allowed` (the room, the map) while there's room enough there, then wherever is nearest.
export function arrange(n, { point, anchor, dpi, allowed = () => true, avoid = [], walls = [], radius = RADIUS }) {
  anchor ||= cellCentre(point, dpi);
  const r = Math.max(radius, Math.ceil(Math.sqrt(n)) + 2);
  const reach = (r + 1) * dpi;
  const near = walls.filter(([a, b]) => Math.min(a.x, b.x) < anchor.x + reach && Math.max(a.x, b.x) > anchor.x - reach
    && Math.min(a.y, b.y) < anchor.y + reach && Math.max(a.y, b.y) > anchor.y - reach);
  const at = (i, j) => ({ x: anchor.x + i * dpi, y: anchor.y + j * dpi });
  // squares reachable from the spot without crossing a line
  const seen = new Set(["0,0"]), queue = [[0, 0]], reached = [];
  while (queue.length) {
    const [i, j] = queue.shift();
    reached.push([i, j]);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj, key = `${ni},${nj}`;
      if (Math.abs(ni) > r || Math.abs(nj) > r || seen.has(key)) continue;
      if (near.some((s) => crosses(at(i, j), at(ni, nj), s))) continue;
      seen.add(key);
      queue.push([ni, nj]);
    }
  }
  const pick = (cells) => {
    const inside = [], outside = [];
    for (const [i, j] of cells) {
      const c = at(i, j);
      if (avoid.some((b) => blocks(b, c))) continue;
      if (near.some((s) => distToSegment(c, s) < CLEAR * dpi)) continue;
      const d = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
      (allowed(c) ? inside : outside).push({ c, d, i, j });
    }
    const order = (a, b) => a.d - b.d || a.j - b.j || a.i - b.i;
    return [...inside.sort(order), ...outside.sort(order)];
  };
  let out = pick(reached);
  if (out.length < n) {   // a tiny walled-in spot: any clear square nearby rather than none
    const all = [];
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (!seen.has(`${i},${j}`)) all.push([i, j]);
    out = [...out, ...pick(all)];
  }
  return out.slice(0, n).map((s) => s.c);
}

// The whole move, without touching Owlbear: [{id, position}] for each chosen PC (all of them
// when `chosen` is null), plus the place's name. A PC that is the target stays put.
export function gather(json, target, items, party, sceneDpi, { chosen = null, box, anchor } = {}) {
  const t = targetFor(json, target, sceneDpi, { box });
  if (!t) return { error: "not a place PCs can be brought to" };
  let pcs = findPcs(items, party).filter((p) => p.item.id !== target.id);
  if (chosen) pcs = pcs.filter((p) => chosen.includes(p.item.id));
  if (!pcs.length) return { name: t.name, moves: [], pcs: [] };
  const moving = new Set(pcs.map((p) => p.item.id));
  // Tokens nobody lands on: a loose mount too (keys.js TOKEN_LAYERS; read only, never moved). An attached one rides along.
  const others = items.filter((i) => onTokenLayer(i) && !i.attachedTo && !moving.has(i.id) && i.id !== target.id);
  const avoid = [...t.avoid, ...portalBoxes(items), ...others.map((i) => tokenArea(i, sceneDpi)),
                 ...propBoxes(json, items, sceneDpi)];
  const cells = arrange(pcs.length, { point: t.point, anchor, dpi: sceneDpi, allowed: t.allowed, avoid,
                                      walls: wallSegments(items) });
  const moves = pcs.map((p, k) => {
    // The token's centre goes on the square's centre (its position is wherever its anchor is).
    const b = tokenBox(p.item, sceneDpi);
    return { id: p.item.id, position: { x: cells[k].x + p.item.position.x - b.x, y: cells[k].y + p.item.position.y - b.y } };
  });
  return { name: t.name, kind: t.kind, point: t.point, moves, pcs: pcs.map((p) => p.name) };
}

// ---- 👥 Place townsfolk ----

// The token of each town.townsfolk entry: [{entry, item}] (item null when it isn't in the scene).
// In order, each pass over every entry still without one: a token marked as the entry's person
// (🎲 DND → 🏷 This is…, "npc:<person>"); a token's names (Stat Bubbles' name tag, Owlbear's label, the
// item's name; case, spacing and a file extension don't matter) the same as the entry's token;
// the same as its person slug ("old_miller" as "Old Miller"); then the same first word,
// leading articles skipped. Each token goes to one entry only. Only root tokens, and never one
// marked as a PC.
export function findTownsfolk(entries, items) {
  const tokens = items.filter((i) => i.layer === "CHARACTER" && !i.attachedTo
    && !String(i.metadata?.[WHO_KEY] || "").startsWith("pc:"));
  const names = new Map(tokens.map((i) => [i.id,
    [i.metadata?.[BUBBLES_NAME_KEY], i.text?.plainText, i.name].map(normName).filter(Boolean)]));
  const out = entries.map((entry) => ({ entry, item: null }));
  const used = new Set();
  const pass = (same) => {
    for (const o of out) {
      if (o.item) continue;
      const t = tokens.find((i) => !used.has(i.id) && same(i, o.entry));
      if (t) {
        o.item = t;
        used.add(t.id);
      }
    }
  };
  const person = (e) => String(e.person || "").trim().toLowerCase();
  const named = (i, want) => !!want && names.get(i.id).some((n) => n === want);
  pass((i, e) => !!person(e) && String(i.metadata?.[WHO_KEY] || "").trim().toLowerCase() === `npc:${person(e)}`);
  pass((i, e) => named(i, normName(e.token)));
  pass((i, e) => named(i, normName(person(e).replace(/_/g, " "))));
  pass((i, e) => !!firstWord(e.token) && names.get(i.id).some((n) => firstWord(n) === firstWord(e.token)));
  return out;
}

// The entries "👥 Place townsfolk" on this map image places (all of them with no image). A building's
// map (one in interiors.json, by its name or label): the entries on that building's maps, every floor.
// Any other image is the town (as 🏘 Set up interiors takes it): the entries on the buildings with a
// spot on the town map and any naming a map interiors.json doesn't have (reported, as before), but
// none on a map without a town spot (Chapter 3's sites) or on a building in town.townsfolk_own_map
// (the hideout: placed only from its own map), so a rescued or travelling NPC isn't sent back to
// their start room from the town.
export function townsfolkFor(json, image) {
  const all = json?.town?.townsfolk || [];
  if (!image) return all;
  const maps = listed(json || {});
  const buildingOf = (name) => {
    const m = maps.find((x) => normName(x.name) === normName(name));
    return m ? m.building || m.name : null;
  };
  const [clicked] = matchImages(maps, [image]).keys();
  if (clicked) return all.filter((e) => buildingOf(e.map) === buildingOf(clicked));
  const spots = json?.town?.spots || {};
  const own = new Set((Array.isArray(json?.town?.townsfolk_own_map) ? json.town.townsfolk_own_map : []).map(normName));
  return all.filter((e) => {
    const b = buildingOf(e.map);
    return b === null || (Object.hasOwn(spots, b) && !own.has(normName(b)));
  });
}

// Where an entry's NPC goes on its map's image: the room (the map's room named "… · <room>"), as
// a drawing on the scene, and the spot: the middle of the first prop of kind `near` whose middle is
// in the room, else a point inside the room. Null when the map has no such room.
export function townsfolkSpot(map, image, entry, sceneDpi) {
  const want = `· ${String(entry.room || "").trim().toLowerCase()}`;
  const room = (map.rooms || []).find((r) => String(r.name || "").trim().toLowerCase().endsWith(want)
    && (r.points || []).length >= 3);
  if (!room) return null;
  const here = mapToScene(map, image, sceneDpi);
  const area = { type: "CURVE", layer: "DRAWING", name: room.name, position: { x: 0, y: 0 }, rotation: 0,
                 scale: { x: 1, y: 1 }, points: room.points.map(here) };
  const inside = (p) => contains(area, p);
  const prop = (map.props || []).filter((pr) => pr.kind === entry.near && pr.box?.length === 4)
    .map((pr) => centreOf(sceneBox(pr.box, here))).find(inside);
  return { room: room.name, area, inside, point: prop || insidePoint(area, drawingBox(area), sceneDpi) };
}

// The whole placing, without touching Owlbear: {moves: [{id, token, room, cell, position}],
// notFound: [token names], noMap: [map names], noRoom: ["map · room"]}. Each NPC gets one square
// in its room, reachable from its spot without crossing a wall line and clear of them, off
// portals, furniture, every other token and the squares given to the NPCs before it. `clicked`:
// the map image the menu was opened on; only its entries move (townsfolkFor), but tokens are
// matched against every entry, so each token still goes to its own. On the town, `elsewhere`: the
// maps in the scene with entries it left for a press on their own map.
export function townsfolkPlan(json, items, sceneDpi, { clicked } = {}) {
  const entries = json?.town?.townsfolk || [];
  const mine = new Set(townsfolkFor(json, clicked));
  const maps = listed(json || {});
  const images = items.filter((i) => i.layer === "MAP" && i.type === "IMAGE");
  const found = findTownsfolk(entries, items).filter((f) => mine.has(f.entry));
  const moving = new Set(found.filter((f) => f.item).map((f) => f.item.id));
  const others = items.filter((i) => onTokenLayer(i) && !i.attachedTo && !moving.has(i.id)); // a loose mount too
  const fixed = [...portalBoxes(items), ...others.map((i) => tokenArea(i, sceneDpi)), ...propBoxes(json, items, sceneDpi)];
  const walls = wallSegments(items);
  const out = { moves: [], notFound: [], noMap: [], noRoom: [], elsewhere: [] };
  if (clicked && !matchImages(maps, [clicked]).size) {
    for (const e of entries) {
      if (mine.has(e) || out.elsewhere.includes(e.map)) continue;
      const map = maps.find((m) => normName(m.name) === normName(e.map));
      if (map && matchImages([map], images).size) out.elsewhere.push(e.map);
    }
  }
  const given = [];
  for (const { entry, item } of found) {
    if (!item) {
      out.notFound.push(entry.token);
      continue;
    }
    const map = maps.find((m) => normName(m.name) === normName(entry.map));
    const image = map && matchImages([map], images).get(map.name);
    if (!image) {
      if (!out.noMap.includes(entry.map)) out.noMap.push(entry.map);
      continue;
    }
    const spot = townsfolkSpot(map, image, entry, sceneDpi);
    const [cell] = spot ? arrange(1, { point: spot.point, dpi: sceneDpi, allowed: spot.inside,
                                        avoid: [...fixed, ...given], walls }) : [];
    if (!cell) {
      out.noRoom.push(`${entry.map} · ${entry.room}`);
      continue;
    }
    // The token's centre goes on the square's centre (its position is wherever its anchor is).
    const b = tokenBox(item, sceneDpi);
    out.moves.push({ id: item.id, token: entry.token, room: spot.room, cell,
                     position: { x: cell.x + item.position.x - b.x, y: cell.y + item.position.y - b.y } });
    given.push(areaAt(cell, b.size, sceneDpi));
  }
  return out;
}

export function townsfolkText({ moves, notFound, noMap, noRoom, elsewhere = [] }) {
  let s = `👥 ${moves.length} townsfolk placed`;
  if (notFound.length) s += `. Not in the scene: ${notFound.join(", ")}`;
  if (noMap.length) s += `. Map not laid out: ${noMap.join(", ")}`;
  if (noRoom.length) s += `. No room for: ${noRoom.join(", ")}`;
  if (elsewhere.length) s += `. On their own maps, press there: ${elsewhere.join(", ")}`;
  return s;
}

// ---- 👾 monsters, with 👥 Place townsfolk ----
// The data is the panel's (or tools/owlbear_only.py's) /api/map/monsters: {present: the party's size as the
// Story tab counts it (director.json's `present`; 0 = nobody marked), fallen: the NPCs the game last saw dead,
// every token of theirs (director.json's `fallen`: a row that speaks as one is never placed again),
// rows: adventure_source.encounters(), props: adventure_source.props(), the scenery tokens hides edges lay out}.
// A press on a building's or a site's own map places only that map's encounters and scenery (every floor of it);
// the town's never places any, so nothing is sent back from the town. Every token starts hidden, on its own square
// in its room: the one of a kind the DM dropped beside the maps (on no map, in no room) is moved in as the first,
// and copies of it make up the rest. Nothing in play is ever changed, moved or brought back: a place that already
// holds a token of a kind (alive, down at 0 HP or dead), or a fight a press placed before, gets no more of it, so a
// second press adds nothing and leaves a spare token beside the maps where it is.

// A label as the engine matches names (map_state.bare): case and spacing don't matter, a leading "the" and a
// picture's extension are dropped, and so are its numbers ("Zombie 3" -> "zombie"; a bare number stays).
export function bareName(s) {
  const words = normName(s).replace(/^the /, "").split(" ").filter(Boolean);
  const kept = words.filter((w) => !/^#?\d+$/.test(w));
  return (kept.length ? kept : words).join(" ");
}

const titleCase = (s) => String(s || "").trim().replace(/(^|\s)(\p{Ll})/gu, (m, a, c) => a + c.toUpperCase());
const spaced = (slug) => String(slug || "").replace(/_/g, " ");

// The names a token goes by (Stat Bubbles' name tag, Owlbear's label, the item's name), bare.
const tokenNames = (i) => [i.metadata?.[BUBBLES_NAME_KEY], i.text?.plainText, i.name].map(bareName).filter(Boolean);

// The name a row's copies get: its first label when that is a name of its own ("Zeond", "Pit Captain": used
// as it is while no token has it), else the creature's name, always with a number ("Zombie 2"): a bare
// "Bugbear" would read as the Wyvern Tor raiders by their first name, a numbered one never does.
export function baseName(row) {
  const own = new Set([row.creature_name, spaced(row.creature)].map(bareName));
  const first = (row.labels || []).find((l) => typeof l === "string" && bareName(l));
  if (first && !own.has(bareName(first))) return { name: titleCase(first), own: true };
  return { name: String(row.creature_name || "").trim() || titleCase(spaced(row.creature)), own: false };
}

// How many of a row's creatures: its line for the party's size (by_party), else the book's count.
export function countFor(row, present) {
  const bp = row.by_party;
  const hit = present > 0 && bp && typeof bp === "object"
    ? (Array.isArray(bp) ? bp.find((p) => p?.size === present) : bp[String(present)]) : null;
  if (hit && Number.isInteger(hit.count) && hit.count >= 0) return { count: hit.count, scaled: true, noLine: false };
  const scaled = !!bp && typeof bp === "object";
  return { count: Number.isInteger(row.count) && row.count > 0 ? row.count : 1, scaled, noLine: scaled && present > 0 };
}

// The place a row's creatures are set up in: its room, else its one place (none for a row in several).
const placeOf = (row) => row.room || (Array.isArray(row.places) && row.places.length === 1 ? row.places[0] : null);

// The tokens down at 0 HP: Stat Bubbles' HP at 0, or a red (down) Colored Rings ring on them.
function downIds(items) {
  const out = new Set();
  for (const i of items) {
    const b = i.metadata?.[BUBBLES_KEY];
    if (Number(b?.["max health"]) > 0 && Number(b?.health) === 0) out.add(i.id);
    if (i.attachedTo && i.metadata?.[RING_KEY]?.enabled && String(i.style?.strokeColor || "").toLowerCase() === DOWN_COLOR) {
      out.add(i.attachedTo);
    }
  }
  return out;
}

// On each copy: {place, encounter, creature, base} it was placed for, so a later press knows that encounter is
// out wherever its tokens have gone since (a fight spilling into the hall), alive, down or dead. (A copy from
// the first version, 10-20, has no place: it counts for its encounter's every place.)
export const PLACED_KEY = "dnd-npc/placed";
const placedAs = (i, place, encounter, creature, base) => {
  const t = i.metadata?.[PLACED_KEY];
  return !!t && (!t.place || t.place === place) && t.encounter === encounter && t.creature === creature
    && bareName(t.base) === bareName(base);
};

// The NPCs the game last saw dead (data.fallen) who are one person, and whether a row speaks as one of them. One
// person: a voice the rows give one token in all (a band's leader). A group's (one voice for a site's sentry and
// its band; the director lists a group once its tokens on the open scene are all dead) never
// leaves its fights out: its dead are counted where they lie, or were deleted by the DM.
const fallenOf = (data) => {
  const most = new Map();
  for (const r of Array.isArray(data?.rows) ? data.rows : []) {
    if (typeof r?.speaks_as !== "string") continue;
    const bp = r.by_party && typeof r.by_party === "object" ? Object.values(r.by_party) : [];
    const n = Math.max(Number.isInteger(r.count) && r.count > 0 ? r.count : 1,
                       ...bp.map((p) => (Number.isInteger(p?.count) ? p.count : 0)));
    most.set(r.speaks_as, (most.get(r.speaks_as) || 0) + n);
  }
  return new Set((Array.isArray(data?.fallen) ? data.fallen : []).filter((x) => typeof x === "string" && most.get(x) === 1));
};
const speaksDead = (row, fallen) => typeof row.speaks_as === "string" && fallen.has(row.speaks_as);

// The party size a notice names, as the Story tab's encounter line counts it.
const sizeNote = (scaled, noLines, present) => !scaled ? "book counts"
  : present ? `party of ${present}${noLines ? ` (the book's count where the adventure has no line for ${present})` : ""}`
  : "book counts (nobody is marked present on the panel)";

// A hidden copy of `src` (a token of the kind), as a scene item: its picture, size, layer and turn, a new id,
// `name` as its name (what the engine reads when a token has no label), its label and Stat Bubbles name tag
// only when the source shows one (so no name appears on the projector that wasn't there), its Stat Bubbles
// stats at full HP when it has some (so the copy needn't wait for the map tool's stats), and `placed`
// (PLACED_KEY). Nothing else of the source's (links, conditions, marks) comes along.
export function copyItem(src, name, position, id, placed) {
  const meta = placed ? { [PLACED_KEY]: placed } : {};
  const b = src.metadata?.[BUBBLES_KEY];
  if (b && Number(b["max health"]) > 0) meta[BUBBLES_KEY] = { ...b, health: Number(b["max health"]), "temporary health": 0 };
  if (src.metadata?.[BUBBLES_NAME_KEY]) meta[BUBBLES_NAME_KEY] = name;
  const { attachedTo, ...rest } = src;
  return { ...rest, id, name, position, visible: false, locked: false, metadata: meta,
           text: { ...(src.text || {}), plainText: src.text?.plainText ? name : "" } };
}

// A room drawing's size, for "the smallest room wins" (as the engine and the map tool count a token's room).
function polyArea(pts) {
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[(k + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : `dnd-npc-monster-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// The scenery tokens the map's places hide (data.props, adventure_source.props(): two dead goblins under a bridge),
// as rows like an encounter's creatures: placed hidden in their place's room the same way, named as their token
// reads ("Goblin Corpse", then "Goblin Corpse 2"). Their own kind (`prop:` and the name): never a creature's.
function propRows(data) {
  return (Array.isArray(data?.props) ? data.props : [])
    .filter((p) => p && typeof p.token === "string" && bareName(p.token) && typeof p.place === "string" && p.place)
    .map((p) => ({ prop: true, encounter: `prop:${p.secret || p.place}`, creature: `prop:${bareName(p.token)}`,
                   creature_name: p.token.trim(), names: [p.token.trim()], labels: [], places: [p.place], room: null,
                   room_name: p.place_name || p.place, count: Number.isInteger(p.count) && p.count > 0 ? p.count : 1 }));
}

// The whole monster placing, without touching Owlbear: {copies: [{item, name, room, place, prop, kind}], adopt:
// [{id, name, position, placed, room, place, prop, kind}] (the DM's own tokens of a kind, dropped beside the maps:
// each moved in as the first of its kind, hidden, marked and named, and copies only make up the rest), size: "party
// of 6", already: [places left alone], missing: [kinds with no token in the scene], crowded: [rooms with tokens
// outside them], byHand: [places with several encounters (a road camp's choices)]}. `avoid`: boxes no token goes
// on (the squares the townsfolk were just given); `skip`: ids never moved in (the townsfolk this press moves).
// Only on a listed map (`clicked`); the town gets nothing.
export function monsterPlan(json, data, items, sceneDpi, { clicked, avoid: extra = [], skip = new Set(), id = newId } = {}) {
  const out = { copies: [], adopt: [], size: "", already: [], missing: [], crowded: [], byHand: [], fallen: [] };
  const maps = listed(json || {});
  const [name] = clicked ? matchImages(maps, [clicked]).keys() : [];
  if (!name || !Array.isArray(data?.rows)) return out;
  const buildingOf = (m) => m.building || m.name;
  const b = buildingOf(maps.find((m) => m.name === name));
  const mine = maps.filter((m) => buildingOf(m) === b);
  const found = matchImages(mine, items.filter(isMapImage));
  // every room of those maps in the scene, by its place: its own place first (a map's rooms without one are
  // its place's too, used only when no room says so itself: a site's courtyard, not its outside)
  const rooms = new Map(), every = [];
  for (const m of mine) {
    const image = found.get(m.name);
    if (!image) continue;
    const here = mapToScene(m, image, sceneDpi);
    for (const r of m.rooms || []) {
      if ((r.points || []).length < 3) continue;
      const own = typeof r.place === "string" && r.place.trim() ? r.place : null;
      const place = own || m.place || null;
      const area = { type: "CURVE", layer: "DRAWING", name: r.name, position: { x: 0, y: 0 }, rotation: 0,
                     scale: { x: 1, y: 1 }, points: r.points.map(here) };
      const room = { name: r.name, place, area, size: polyArea(area.points) };
      every.push(room);
      if (!place) continue;
      const e = rooms.get(place) || { own: [], rest: [] };
      (own ? e.own : e.rest).push(room);
      rooms.set(place, e);
    }
  }
  // the room a point is in: the smallest that holds it (Wyvern Tor's outside holds its cave)
  const roomAt = (p) => {
    let best = null;
    for (const r of every) if ((!best || r.size < best.size) && contains(r.area, p)) best = r;
    return best;
  };
  for (const r of every) r.inside = (p) => roomAt(p) === r;
  const present = Number.isInteger(data.present) && data.present > 0 ? data.present : 0;
  const rows = [...data.rows, ...propRows(data)];
  // the names each creature goes by, over every row (a row's own label is that creature anywhere)
  const kinds = new Map();
  for (const row of rows) {
    const k = kinds.get(row.creature) || new Set();
    for (const n of [row.creature_name, ...(row.prop ? [] : [spaced(row.creature)]), ...(row.names || []),
                     ...(row.labels || [])]) {
      if (typeof n === "string" && bareName(n)) k.add(bareName(n));
    }
    kinds.set(row.creature, k);
  }
  // this map's rows, by place, then by the name their tokens get; never one that speaks as someone dead. A place's
  // scenery is none of its encounters (a road camp's choices still get theirs).
  const byPlace = new Map();
  const fallen = fallenOf(data);
  for (const row of rows) {
    const place = placeOf(row);
    if (!place || !rooms.has(place) || !row.creature) continue;
    const p = byPlace.get(place) || { encounters: new Set(), groups: new Map(), label: row.room_name || place };
    if (!row.prop) p.encounters.add(row.encounter);
    byPlace.set(place, p);
    const base = row.prop ? { name: row.creature_name, own: false } : baseName(row);
    if (speaksDead(row, fallen)) {
      if (!out.fallen.includes(base.name)) out.fallen.push(base.name);
      continue;
    }
    const key = `${row.creature}\n${bareName(base.name)}`;
    const g = p.groups.get(key) || { creature: row.creature, kind: row.creature_name || titleCase(spaced(row.creature)),
                                      base, count: 0, scaled: false, noLine: false, prop: !!row.prop, place,
                                      encounter: row.prop ? row.encounter : null, voices: new Set(), adopt: [] };
    const c = row.prop ? { count: row.count, scaled: false, noLine: false } : countFor(row, present);
    g.count += c.count;
    g.scaled ||= c.scaled;
    g.noLine ||= c.noLine;
    if (typeof row.speaks_as === "string") g.voices.add(row.speaks_as);
    p.groups.set(key, g);
  }
  const roots = items.filter((i) => onTokenLayer(i) && !i.attachedTo); // a PC or a loose mount too: nobody lands on one
  const tokens = roots.filter((i) => !String(i.metadata?.[WHO_KEY] || "").startsWith("pc:"));
  const down = downIds(items);
  const ofKind = (i, creature) => tokenNames(i).some((n) => kinds.get(creature)?.has(n));
  const fixed = [...portalBoxes(items), ...roots.map((i) => tokenArea(i, sceneDpi)), ...propBoxes(json, items, sceneDpi), ...extra];
  const walls = wallSegments(items);
  const given = [];

  // the groups to place: none of a road camp's fights (by hand), none out already (a token placed for it, wherever
  // it is now; or a token of the kind in one of its rooms)
  let scaled = false, noLines = false;
  const todo = [];
  for (const p of byPlace.values()) {
    const several = p.encounters.size > 1;
    if (several) out.byHand.push(p.label);
    for (const g of p.groups.values()) {
      if (several && !g.prop) continue;
      g.encounter ||= [...p.encounters][0];
      scaled ||= g.scaled;
      noLines ||= g.noLine;
      if (!g.count) continue;
      const placedFor = (i) => placedAs(i, g.place, g.encounter, g.creature, g.base.name);
      if (tokens.some(placedFor) || tokens.some((i) => ofKind(i, g.creature) && roomAt(tokenBox(i, sceneDpi))?.place === g.place)) {
        if (!out.already.includes(p.label)) out.already.push(p.label);
        continue;
      }
      todo.push(g);
    }
  }
  // the DM's own tokens moved in: of the kind, dropped beside the maps (on no map, in no room or marked place),
  // alive, placed for nothing, linked (🏷 This is…) to nobody but the group's own voice, no townsfolk this press
  // moves. A speaker's own label goes to its own group first, the plain ones to the plain groups, then the speakers.
  const images = items.filter((i) => isMapImage(i) && i.image).map((m) => bounds(m, sceneDpi));
  const drawn = items.filter((i) => i.layer === "DRAWING" && (isPlaceDrawing(i) || i.metadata?.[INTERIOR_KEY]?.kind === "room"));
  const loose = tokens.filter((i) => {
    const c = tokenBox(i, sceneDpi);
    return !skip.has(i.id) && !i.metadata?.[PLACED_KEY] && !down.has(i.id) && !images.some((bx) => inBox(bx, c))
      && !drawn.some((d) => contains(d, c));
  });
  const taken = new Set();
  const named = (i, n) => tokenNames(i).includes(bareName(n));
  const give = (g, test) => {
    for (const i of loose) {
      if (g.adopt.length >= g.count) return;
      const w = String(i.metadata?.[WHO_KEY] || "");
      if (taken.has(i.id) || !ofKind(i, g.creature) || (w.startsWith("npc:") && !g.voices.has(w.slice(4))) || !test(i)) continue;
      g.adopt.push(i);
      taken.add(i.id);
    }
  };
  const elses = (g, i) => todo.some((o) => o !== g && o.creature === g.creature && o.base.own && named(i, o.base.name));
  for (const g of todo) if (g.base.own) give(g, (i) => named(i, g.base.name));
  for (const g of todo) if (!g.base.own) give(g, (i) => !elses(g, i));
  for (const g of todo) if (g.base.own) give(g, (i) => !elses(g, i));

  // the numbers a name already has in the scene ("Zombie" is 1, "Zombie 3" is 3), and those given here (a token
  // moved in counts only by the name it gets)
  const used = new Map();
  const numbersOf = (base) => {
    const k = bareName(base);
    if (used.has(k)) return used.get(k);
    const nums = new Set();
    for (const i of tokens) {
      if (taken.has(i.id)) continue;
      for (const s of [i.metadata?.[BUBBLES_NAME_KEY], i.text?.plainText, i.name]) {
        if (!s || bareName(s) !== k) continue;
        const ns = normName(s).split(" ").map((w) => /^#?(\d+)$/.exec(w)).filter(Boolean).map((m) => Number(m[1]));
        if (ns.length) ns.forEach((n) => nums.add(n));
        else nums.add(1);
      }
    }
    used.set(k, nums);
    return nums;
  };
  // bare: a row's own label while no token has it, or a kind's name where the engine still reads it as the kind
  // (data.bare_unsafe, from the panel; a panel that doesn't say: never); else numbered ("Zombie 2")
  const unsafe = Array.isArray(data.bare_unsafe) ? new Set(data.bare_unsafe.map(bareName)) : null;
  const nameFor = (base) => {
    const nums = numbersOf(base.name);
    if ((base.own || (!!unsafe && !unsafe.has(bareName(base.name)))) && !nums.has(1)) {
      nums.add(1);
      return base.name;
    }
    let n = 2;
    while (nums.has(n)) n++;
    nums.add(n);
    return `${base.name} ${n}`;
  };
  const missing = new Set();
  for (const g of todo) {
    let where = rooms.get(g.place).own.length ? rooms.get(g.place).own : rooms.get(g.place).rest;
    // a room's side rooms ("Cells (north)", "Cells (south)") only when it has no main room
    const main = where.filter((r) => !where.some((o) => o !== r && normName(r.name).startsWith(`${normName(o.name)} (`)));
    if (main.length) where = main;
    // the token copied: the first moved in, else one of the kind: alive before down, hidden before shown
    const src = g.adopt[0] || [...tokens.filter((i) => ofKind(i, g.creature))].sort((a, c) => (down.has(a.id) - down.has(c.id)) * 2
      + ((a.visible !== false) - (c.visible !== false)))[0];
    if (!src) {
      missing.add(g.kind);
      continue;
    }
    // the DM's own first, then the copies that make up the rest
    const jobs = [...g.adopt, ...Array.from({ length: Math.max(0, g.count - g.adopt.length) }, () => null)];
    let k = 0;
    where.forEach((room, r) => {
      const n = Math.floor(g.count / where.length) + (r < g.count % where.length ? 1 : 0);
      if (!n) return;
      const cells = arrange(n, { point: insidePoint(room.area, drawingBox(room.area), sceneDpi), dpi: sceneDpi,
                                 allowed: room.inside, avoid: [...fixed, ...given], walls });
      if (cells.some((c) => !room.inside(c)) && !out.crowded.includes(room.name)) out.crowded.push(room.name);
      for (const cell of cells) {
        const tok = jobs[k++] || null;
        const from = tok || src;
        const box = tokenBox(from, sceneDpi);
        const nm = nameFor(g.base);
        // the token's centre on the square's centre (its position is wherever its anchor is)
        const position = { x: cell.x + from.position.x - box.x, y: cell.y + from.position.y - box.y };
        const placed = { place: g.place, encounter: g.encounter, creature: g.creature, base: g.base.name };
        const at = { name: nm, room: room.name, place: g.place, cell, prop: g.prop, kind: g.kind };
        if (tok) out.adopt.push({ id: tok.id, position, placed, ...at });
        else out.copies.push({ item: copyItem(src, nm, position, id(), placed), ...at });
        given.push(areaAt(cell, box.size, sceneDpi));
      }
    });
  }
  out.missing = [...missing];
  // the size used, as the Story tab's encounter line counts it; a map with no counts by size says the book's
  out.size = sizeNote(scaled, noLines, present);
  return out;
}

// A list for a notice: the first few, then how many more.
const few = (xs, n = 4) => xs.length > n ? `${xs.slice(0, n).join(", ")} and ${xs.length - n} more` : xs.join(", ");

const DEAD_TEXT = "Dead in the campaign record, never brought back";

// "11 new copies, 1 of yours moved in"
const madeOf = (c, a) => `${c} new cop${c === 1 ? "y" : "ies"}${a ? `, ${a} of yours moved in` : ""}`;

export function monsterText({ copies, adopt = [], size, already, missing, crowded, byHand, fallen = [] }) {
  const mc = copies.filter((c) => !c.prop).length, ma = adopt.filter((a) => !a.prop).length, n = mc + ma;
  let s = n ? `👾 ${n} monster${n === 1 ? "" : "s"} placed, hidden (${madeOf(mc, ma)}), ${size}`
    : `👾 No monsters added, ${size}`;
  const scenery = [...adopt, ...copies].filter((x) => x.prop);
  if (scenery.length) {
    const by = new Map();
    for (const x of scenery) by.set(x.kind, (by.get(x.kind) || 0) + 1);
    s += `. ${scenery.length} scenery token${scenery.length === 1 ? "" : "s"} placed, hidden`
      + ` (${madeOf(copies.length - mc, adopt.length - ma)}): ${few([...by].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)))}`;
  }
  if (already.length) s += `. Already there, left alone: ${few(already)}`;
  if (fallen.length) s += `. ${DEAD_TEXT}: ${few(fallen)}`;
  if (missing.length) s += `. Not in the scene: ${few(missing)} (drop one token of each beside the maps, outside every room, then press again)`;
  if (crowded.length) s += `. Out of room, some placed just outside: ${few(crowded)}`;
  if (byHand.length) s += `. Several encounters to choose from, place by hand: ${few(byHand)}`;
  return s;
}

// ---- 👾 the tokens that wait at a road camp: on its own map, or on a drawing marked as a place ----
// A place with several encounters to roll from (the road's night 1 camp: the table's eight fights) keeps all
// their tokens hidden beside its map or its drawing, one row a fight, as many as each can bring, for the DM to
// drag to whichever strip or camp the roll puts the fight on (the runbook, 3.4). From its map (interiors.json's
// road maps, town.scenes "The road") the rows are clear of every map and drawing, and a token on any of the
// road's maps is in play there. A place with one fight gets nothing
// from a drawing (game night 1's goblin hideout: its goblins are never brought back): only its own map
// places it. Every name is as the engine reads it: a speaker's own label once, never numbered; every other
// token its kind, the first bare and the rest numbered ("Goblin", "Goblin 2"), and every one numbered where a
// bare name reads as someone ("Bugbear 2", never a bare "Bugbear").

// A drawing the DM marked as a place by hand (🎲 DND → 🗺 Mark as place), not a room 🏘 Set up interiors drew.
export const isPlaceDrawing = (i) => !!i && i.layer === "DRAWING" && typeof i.metadata?.[PLACE_KEY] === "string"
  && !!i.metadata[PLACE_KEY].trim() && !i.metadata?.[INTERIOR_KEY];

// The places with several encounters to roll from (where a road's tokens wait): place -> its name.
function poolsOf(rows) {
  const by = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const place = row && placeOf(row);
    if (!place || !row.creature) continue;
    const e = by.get(place) || { name: row.room_name || place, encounters: new Set() };
    e.encounters.add(row.encounter);
    by.set(place, e);
  }
  return new Map([...by].filter(([, e]) => e.encounters.size > 1).map(([place, e]) => [place, e.name]));
}

// interiors.json's map for a map image (by its name or label), or null.
function mapEntry(json, image) {
  const maps = listed(json || {});
  const [name] = image ? matchImages(maps, [image]).keys() : [];
  return (name && maps.find((m) => m.name === name)) || null;
}

// The pool place a map is, or null: a road camp's own map (interiors.json's road contract: the map's place has
// several fights to roll from, and it has rooms, every one of them that place by name, its one "<name> ·
// Outside"). Any other map with a place of several fights is no pool, even one whose rooms carry no place of
// their own (a building's, a site's): monsterPlan places its other rooms and says "place by hand".
export function poolOfMap(map, rows) {
  const place = typeof map?.place === "string" ? map.place.trim() : "";
  if (!place || !poolsOf(rows).has(place)) return null;
  const rooms = Array.isArray(map.rooms) ? map.rooms : [];
  return rooms.length && rooms.every((r) => r?.place === place) ? place : null;
}

// The road a pool place is on (the town.scenes group whose maps hold it: "The road"): {name, places (every map's
// and room's), images (its map images in this scene)}, or null. A token on one of them, or in one of their
// rooms, is in play: counted where it stands, never moved into the rows (a goblin the DM put on a strip).
export function poolGroup(json, items, place) {
  const maps = listed(json || {});
  for (const g of sceneGroups(json)) {
    const mine = maps.filter((m) => g.buildings.includes(normName(m.building || m.name)));
    const places = new Set(mine.flatMap((m) => [m.place, ...(m.rooms || []).map((r) => r.place)])
      .filter((p) => typeof p === "string" && p.trim()));
    if (places.has(place)) return { name: g.name, places, images: [...matchImages(mine, (items || []).filter(isMapImage)).values()] };
  }
  return null;
}

// On a map of a scene group that holds a pool's map, not one itself (the road's strips, its second camp): the
// pools' maps by name, for the notice ("press this on" the night 1 camp's map); [] anywhere else (a Chapter 3 site).
export function poolsAway(json, rows, image) {
  const entry = mapEntry(json, image);
  const g = entry && groupOf(json, image);
  if (!g || poolOfMap(entry, rows)) return [];
  return [...new Set(g.maps.filter((m) => poolOfMap(m, rows)).map((m) => m.building || m.name))];
}

// The whole pool, without touching Owlbear: {label, total, copies: [{item, name, cell}], adopt: [{id, name,
// position}] (tokens of the kind lying loose, alive, in no place: renamed if they must be, moved into the rows,
// hidden and marked), kept: [counted where they stand: on a map, in a place, or down], already: [fights a
// press placed before, left alone], fallen, missing, size, none (no fight waits here), one (one fight: by its
// own map, or by hand), map (pressed on the camp's map), under (from the map: "the road maps", where the rows
// are)}. Each fight's count counts every token of it already in the scene, so a second press adds nothing and
// nothing dead comes back. `clicked`: the drawing, or the camp's map image with its `place` (poolOfMap); `group`:
// the road it is on (poolGroup); `avoid`: boxes no token goes on; `skip`: ids never taken (the townsfolk the same
// press moves).
export function poolPlan(data, items, sceneDpi, { clicked, place: at = null, group = null, avoid: extra = [], skip = new Set(),
                                                  id = newId } = {}) {
  const onMap = !!clicked && isMapImage(clicked);
  const place = String(at || clicked?.metadata?.[PLACE_KEY] || "").trim();
  const allRows = Array.isArray(data?.rows) ? data.rows : [];
  const rows = allRows.filter((r) => r && r.creature && placeOf(r) === place);
  const out = { label: rows[0]?.room_name || (onMap ? imageName(clicked) : tokenLabel(clicked)) || place, total: 0, copies: [],
                adopt: [], kept: [], already: [], fallen: [], missing: [], size: "", none: false, one: false, map: onMap, under: "",
                pools: [...poolsOf(allRows).values()] };
  const encounters = [...new Set(rows.map((r) => r.encounter))];
  if (!rows.length) out.none = true;
  else if (encounters.length < 2) out.one = true;
  if (out.none || out.one) return out;
  const present = Number.isInteger(data.present) && data.present > 0 ? data.present : 0;
  const fallen = fallenOf(data);
  const kinds = new Map();
  for (const row of allRows) {
    const k = kinds.get(row.creature) || new Set();
    for (const n of [row.creature_name, spaced(row.creature), ...(row.names || []), ...(row.labels || [])]) {
      if (typeof n === "string" && bareName(n)) k.add(bareName(n));
    }
    kinds.set(row.creature, k);
  }
  // each fight's rows, in the adventure's order, by the name their tokens get
  const groups = [];
  let scaled = false, noLines = false;
  for (const row of rows) {
    const base = baseName(row);
    if (speaksDead(row, fallen)) {
      if (!out.fallen.includes(base.name)) out.fallen.push(base.name);
      continue;
    }
    const c = countFor(row, present);
    scaled ||= c.scaled;
    noLines ||= c.noLine;
    const g = groups.find((x) => x.encounter === row.encounter && x.creature === row.creature
      && bareName(x.base.name) === bareName(base.name));
    if (g) g.count += c.count;
    else groups.push({ encounter: row.encounter, creature: row.creature, base, count: c.count, members: [],
                       kind: row.creature_name || titleCase(spaced(row.creature)),
                       own: new Set([row.creature_name, spaced(row.creature)].map(bareName)) });
  }
  out.size = sizeNote(scaled, noLines, present);
  const roots = items.filter((i) => onTokenLayer(i) && !i.attachedTo);
  const tokens = roots.filter((i) => !String(i.metadata?.[WHO_KEY] || "").startsWith("pc:"));
  const down = downIds(items);
  // where a token stands in play: in a room 🏘 Set up interiors drew, in a drawing marked as a place, or on one of
  // the road's own maps (the camp's map pressed on, and the group's)
  const places = items.filter((i) => i.layer === "DRAWING" && (isPlaceDrawing(i) || i.metadata?.[INTERIOR_KEY]?.kind === "room"));
  const images = items.filter((i) => isMapImage(i) && i.image).map((i) => ({ id: i.id, box: bounds(i, sceneDpi) }));
  const road = new Set([...(group?.images || []).map((i) => i.id), ...(onMap ? [clicked.id] : [])]);
  const roadPlaces = new Set([place, ...(group?.places || [])]);
  const onImage = (c, ours) => images.some((m) => road.has(m.id) === ours && inBox(m.box, c));
  const inPlay = (i) => { const c = tokenBox(i, sceneDpi); return places.some((d) => contains(d, c)) || onImage(c, true); };
  // ...and none of the pool's at all: in a site's room (not the road's), or, pressed on the camp's map, on a map
  // that isn't the road's
  const inRoom = (i) => {
    const c = tokenBox(i, sceneDpi);
    return places.some((d) => d.metadata?.[INTERIOR_KEY] && !roadPlaces.has(d.metadata?.[PLACE_KEY]) && contains(d, c))
      || (onMap && onImage(c, false));
  };
  for (const g of groups) if (tokens.some((i) => placedAs(i, place, g.encounter, g.creature, g.base.name))) g.done = true;
  // the tokens of each kind that are the pool's own: none placed for anything, none in a site's room, none linked
  // (🏷 This is…) to an NPC who isn't one of this place's speakers (a "Wolf" that is someone's pet)
  const voices = new Set(rows.map((r) => r.speaks_as).filter((s) => typeof s === "string"));
  const linkedElse = (i) => {
    const w = String(i.metadata?.[WHO_KEY] || "");
    return w.startsWith("npc:") && !voices.has(w.slice(4));
  };
  const free = tokens.filter((i) => !skip.has(i.id) && !i.metadata?.[PLACED_KEY] && !linkedElse(i) && !inRoom(i));
  const taken = new Set();
  const give = (g, test) => {
    for (const i of free) {
      if (g.done || g.members.length >= g.count) return;
      if (taken.has(i.id) || !tokenNames(i).some((n) => kinds.get(g.creature)?.has(n)) || !test(i)) continue;
      g.members.push(i);
      taken.add(i.id);
    }
  };
  const named = (i, n) => tokenNames(i).includes(bareName(n));
  // a speaker's own label first (on a token of its kind), then the kind's plain tokens, then any token of the kind
  for (const g of groups) if (!g.own.has(bareName(g.base.name))) give(g, (i) => named(i, g.base.name));
  for (const g of groups) if (g.own.has(bareName(g.base.name))) {
    give(g, (i) => !groups.some((o) => o !== g && o.creature === g.creature && !o.own.has(bareName(o.base.name))
      && named(i, o.base.name)));
  }
  for (const g of groups) give(g, () => true);

  // each fight's loose members (alive, in no place: moved into the rows); the rest are counted where they stand
  for (const g of groups) g.loose = g.members.filter((i) => !down.has(i.id) && !inPlay(i));
  const pending = new Set(groups.flatMap((g) => g.loose.map((i) => i.id)));
  // names: what the engine needs (numbersOf as monsterPlan's: every name in the scene, and those given here)
  const used = new Map();
  const numbersOf = (base) => {
    const k = bareName(base);
    if (used.has(k)) return used.get(k);
    const nums = new Set();
    for (const i of tokens) {
      if (pending.has(i.id)) continue; // a loose member's number counts only once it is kept (keeps)
      for (const s of [i.metadata?.[BUBBLES_NAME_KEY], i.text?.plainText, i.name]) {
        if (!s || bareName(s) !== k) continue;
        const ns = normName(s).split(" ").map((w) => /^#?(\d+)$/.exec(w)).filter(Boolean).map((m) => Number(m[1]));
        if (ns.length) ns.forEach((n) => nums.add(n));
        else nums.add(1);
      }
    }
    used.set(k, nums);
    return nums;
  };
  const speaker = (g) => !g.own.has(bareName(g.base.name));
  // a kind's name bare only where the engine still reads it as the kind (data.bare_unsafe, from the panel; a
  // panel that doesn't say: never bare)
  const unsafe = Array.isArray(data.bare_unsafe) ? new Set(data.bare_unsafe.map(bareName)) : null;
  const bareOk = (g) => speaker(g) || (!!unsafe && !unsafe.has(bareName(g.base.name)));
  const nameFor = (g) => {
    if (speaker(g)) return g.base.name; // never numbered: a speaker's label with a number is a plain creature, no voice
    const nums = numbersOf(g.base.name);
    if (bareOk(g) && !nums.has(1)) {
      nums.add(1);
      return g.base.name;
    }
    let n = 2;
    while (nums.has(n)) n++;
    nums.add(n);
    return `${g.base.name} ${n}`;
  };
  // a member's name kept when the engine already reads it right (its label, else its name): a speaker's own
  // label with no number, the kind's name bare where that's safe, or numbered with a number nobody else has
  const keeps = (g, i) => {
    const nm = tokenLabel(i).trim();
    if (bareName(nm) !== bareName(g.base.name) || /\.(png|jpe?g|webp|gif|avif)$/i.test(nm)) return false;
    const num = normName(nm).split(" ").map((w) => /^#?(\d+)$/.exec(w)).find(Boolean);
    if (speaker(g)) return !num;
    const nums = numbersOf(g.base.name);
    if (num ? nums.has(Number(num[1])) : !bareOk(g) || nums.has(1)) return false;
    nums.add(num ? Number(num[1]) : 1);
    return true;
  };
  // every kept name first, so no new one takes its number
  for (const g of groups) g.keep = new Set(g.done ? [] : g.loose.filter((i) => keeps(g, i)).map((i) => i.id));

  // the rows: under the drawing, a square below its lowest edge, one row a fight, left to right. From the camp's
  // map: under all the road's maps together (the strips laid out below the camp leave a gap too narrow for eight
  // rows), clear of every map too.
  const ours = images.filter((m) => road.has(m.id)).map((m) => m.box);
  const box = !onMap ? drawingBox(clicked) : {
    min: { x: Math.min(...ours.map((b) => b.min.x)), y: Math.min(...ours.map((b) => b.min.y)) },
    max: { x: Math.max(...ours.map((b) => b.max.x)), y: Math.max(...ours.map((b) => b.max.y)) } };
  if (onMap && ours.length > 1) out.under = `the ${String(group?.name || "road").replace(/^the\s+/i, "")} maps`;
  const fixed = [...portalBoxes(items), ...roots.filter((i) => !pending.has(i.id)).map((i) => tokenArea(i, sceneDpi)), ...extra];
  const walls = wallSegments(items);
  // a token `span` squares wide with its top-left square's centre at (x, y): every square of it clear
  const clear = (x, y, span) => {
    for (let a = 0; a < span; a++) {
      for (let b = 0; b < span; b++) {
        const p = { x: x + a * sceneDpi, y: y + b * sceneDpi };
        if (fixed.some((f) => blocks(f, p)) || places.some((d) => contains(d, p)) || (onMap && images.some((m) => inBox(m.box, p)))
          || walls.some((w) => distToSegment(p, w) < CLEAR * sceneDpi)) return false;
      }
    }
    return true;
  };
  const left = cellCentre({ x: box.min.x, y: 0 }, sceneDpi).x;
  let top = cellCentre({ x: 0, y: box.max.y }, sceneDpi).y + sceneDpi;
  const fights = [...new Set(groups.map((g) => g.encounter))];
  for (const encounter of fights) {
    // a row starts clear of every drawing (a strip drawn under the camp: the row goes below it), and from the
    // camp's map clear of every map
    for (let k = 0; k < 200 && !clear(left, top, 1); k++) top += sceneDpi;
    let x = left, tall = 1, placedAny = false;
    for (const g of groups.filter((o) => o.encounter === encounter)) {
      if (g.done) {
        if (!out.already.includes(g.base.name)) out.already.push(g.base.name);
        continue;
      }
      const loose = g.loose;
      for (const i of g.members) if (!loose.includes(i)) out.kept.push(tokenLabel(i) || g.kind);
      const want = g.count - g.members.length;
      // the token copied: one of the pool's own alive, else any of the kind (alive, then hidden, first)
      const kindTokens = tokens.filter((i) => tokenNames(i).some((n) => kinds.get(g.creature)?.has(n)));
      const src = loose[0] || [...kindTokens].sort((a, c) => (down.has(a.id) - down.has(c.id)) * 2
        + ((a.visible !== false) - (c.visible !== false)))[0];
      if (want > 0 && !src) {
        if (!out.missing.includes(g.kind)) out.missing.push(g.kind);
        continue;
      }
      const jobs = [...loose.map((i) => ({ i })), ...Array.from({ length: Math.max(0, want) }, () => ({ i: null }))];
      for (const job of jobs) {
        const from = job.i || src;
        const tb = tokenBox(from, sceneDpi);
        const span = Math.max(1, Math.round(tb.size / sceneDpi));
        let cell = null;
        for (let k = 0; k < 400; k++) {
          if (clear(x, top, span)) {
            cell = { x: x + (span - 1) * sceneDpi / 2, y: top + (span - 1) * sceneDpi / 2 };
            break;
          }
          x += sceneDpi;
        }
        if (!cell) continue;
        x += span * sceneDpi;
        tall = Math.max(tall, span);
        placedAny = true;
        fixed.push(areaAt(cell, tb.size, sceneDpi));
        const position = { x: cell.x + from.position.x - tb.x, y: cell.y + from.position.y - tb.y };
        const placed = { place, encounter, creature: g.creature, base: g.base.name };
        if (job.i) {
          const kept = g.keep.has(job.i.id);
          const nm = kept ? tokenLabel(job.i).trim() : nameFor(g);
          out.adopt.push({ id: job.i.id, name: nm, position, placed, rename: !kept });
        } else {
          const nm = nameFor(g);
          out.copies.push({ item: copyItem(src, nm, position, id(), placed), name: nm, cell });
        }
        out.total++;
      }
    }
    if (placedAny) top += tall * sceneDpi;
  }
  return out;
}

export function poolText(p) {
  const pools = p.pools.length ? p.pools : [];
  if (p.none) return `👾 No monsters wait at ${p.label}${pools.length ? ` (press this on ${few(pools, 2)})` : ""}`;
  if (p.one) return `👾 No monsters added at ${p.label}: its one fight is placed from its own map or by hand`
    + ` (only a place with several fights to roll from${pools.length ? `, like ${few(pools, 2)},` : ""} keeps its tokens by its drawing)`;
  const c = p.copies.length, a = p.adopt.length;
  let s = p.total ? `👾 ${p.total} monster${p.total === 1 ? " waits" : "s wait"} hidden below ${p.under || p.label}, a row a fight`
    + ` (${c} new cop${c === 1 ? "y" : "ies"}${a ? `, ${a} of yours moved there` : ""}), ${p.size}`
    : `👾 No monsters added, ${p.size}`;
  if (p.already.length) s += `. Already there, left alone: ${few(p.already)}`;
  if (p.kept.length) s += `. Counted where they stand (in play or down): ${few(p.kept)}`;
  if (p.fallen.length) s += `. ${DEAD_TEXT}: ${few(p.fallen)}`;
  if (p.missing.length) {
    s += `. Not in the scene: ${few(p.missing)} (drop one token of each beside the ${p.map ? "maps, off every map and drawing"
      : "drawings, outside them all"}, then press again)`;
  }
  return s;
}

// The townsfolk moves whose token isn't named exactly as its entry yet: [{id, name}], so the engine reads each
// as its person without the DM renaming it. The item's name always; its label and Stat Bubbles name tag only
// when it shows one (no name appears on the projector that wasn't there: a label that hides a name stays). Only a
// token found by its "This is…" link or by its whole name (case, spacing, a file extension, the person's slug
// aside), never one found by its first word alone, which may be someone else's token.
export function townsfolkNames(moves, items, entries = []) {
  const byId = new Map(items.map((i) => [i.id, i]));
  return moves.filter((m) => {
    const i = byId.get(m.id), e = entries.find((x) => x.token === m.token);
    if (!i || !m.token) return false;
    const person = String(e?.person || "").trim().toLowerCase();
    const names = [i.metadata?.[BUBBLES_NAME_KEY], i.text?.plainText, i.name].map(normName).filter(Boolean);
    const sure = (person && String(i.metadata?.[WHO_KEY] || "").trim().toLowerCase() === `npc:${person}`)
      || names.includes(normName(m.token)) || (person && names.includes(normName(person.replace(/_/g, " "))));
    return !!sure && (i.name !== m.token || (!!i.text?.plainText && i.text.plainText !== m.token)
      || (!!i.metadata?.[BUBBLES_NAME_KEY] && i.metadata[BUBBLES_NAME_KEY] !== m.token));
  }).map((m) => ({ id: m.id, name: m.token }));
}

// ---- the party's names, remembered in the room ----
// The names only help match tokens by name ("This is…" (pc:<name>) works without them). They
// come from the panel, which the laptop only reaches through the Dell's bridge, so each copy
// that gets them from the panel also keeps them in the Owlbear room's metadata (PARTY_KEY): the
// laptop then finds the PCs even on a night the Dell's panel isn't running.

const MAX_NAMES = 20, MAX_NAME = 80; // room metadata is 16 KB for everything: keep it small

// A name list as stored: strings, trimmed, non-empty, no repeats, in order (anything else -> []).
export function cleanParty(x) {
  if (!Array.isArray(x)) return [];
  const out = [];
  for (const n of x) {
    const s = typeof n === "string" ? n.trim().slice(0, MAX_NAME) : "";
    if (s && !out.includes(s) && out.length < MAX_NAMES) out.push(s);
  }
  return out;
}

// The names to use: the panel's when it answered with some (it wins), else the room's.
export function mergeParty(stored, fetched) {
  const f = cleanParty(fetched);
  return f.length ? f : cleanParty(stored);
}

// What to write to the room, or null: the panel's names when there are some and they differ
// from what the room has (so nothing is written twice).
export function partyToStore(stored, fetched) {
  const f = cleanParty(fetched), s = Array.isArray(stored) ? stored : [];
  if (!f.length) return null;
  return s.length === f.length && s.every((n, k) => n === f[k]) ? null : f;
}

// The room's remembered names (instant: Owlbear already has the room's metadata).
export async function storedParty(O = OBR) {
  try {
    return cleanParty((await O.room.getMetadata())?.[PARTY_KEY]);
  } catch {
    return [];
  }
}

// ---- the party's senses, remembered in the room ----
// PARTY_SENSES_KEY: {<nameKey(name)>: {dark, blind, truesight, tremor}}, whole feet 0-1000, all four
// always (0 for none), from personas/party.yaml's `darkvision:`, `blindsight:`, `truesight:` and
// `tremorsense:` per member (the catalog's `senses`, map_state.party_senses, keyed the same way by
// the panel and tools/owlbear_only.py). Numbers only: the room's metadata reaches every device.
// Every screen's lights and fog read it for a PC's senses, and the 🔥 Lighting list shows it as the
// sheet's values. The one parser is rules2024.js (sensesOf, senseMapOf): an older value with
// {dark} only reads the other three as 0.

const sensesKey = (k) => nameKey(k).slice(0, MAX_NAME);

// A senses map as stored: name keys (fx/pcs.js nameKey, as the PC rule compares names) to all four
// senses in whole feet 0..1000 (rules2024.js senseMapOf: an entry that isn't an object, or a name
// with no key, is dropped; a missing or junk sense is 0). At most MAX_NAMES. Not an object -> {}.
export function cleanSenses(x) {
  return senseMapOf(x, { keyOf: sensesKey, max: MAX_NAMES });
}

// Is the room's raw value already exactly this clean map (the same names, each with all four senses
// as these very numbers)? An older {dark}-only value, a numeric string or a name not yet a name key
// isn't, so it's written whole once; a field the room has beyond the four is left alone.
const sameSenses = (clean, raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const ka = Object.keys(clean).sort(), kb = Object.keys(raw).sort();
  return ka.length === kb.length && ka.every((k, n) => k === kb[n] && !!raw[k] && typeof raw[k] === "object"
    && SENSES.every((s) => raw[k][s] === clean[k][s]));
};

// What to write to the room, or null: the panel's senses when it sent some (an object, even an
// empty one: nobody has a sense) and the room's value isn't already exactly them. A panel from
// before the senses (no `senses` at all) changes nothing. Always the whole map, every PC with all four.
export function sensesToStore(stored, fetched) {
  if (!fetched || typeof fetched !== "object" || Array.isArray(fetched)) return null;
  const f = cleanSenses(fetched);
  return sameSenses(f, stored) ? null : f;
}

// The room's remembered senses (instant).
export async function storedSenses(O = OBR) {
  try {
    return cleanSenses((await O.room.getMetadata())?.[PARTY_SENSES_KEY]);
  } catch {
    return {};
  }
}

// A PC's four senses from the sheet ({dark, blind, truesight, tremor}, feet), or null when the room
// doesn't know that name. `senses`: the room's map, raw or clean; `name`: as a token shows it.
export function sensesFor(senses, name) {
  const key = sensesKey(name);
  if (!key || !senses || typeof senses !== "object" || !Object.hasOwn(senses, key)) return null;
  const s = senses[key];
  return s && typeof s === "object" && !Array.isArray(s) ? sensesOf(s) : null;
}

// A PC's darkvision from the sheet, in feet, or null when the room doesn't know it.
export function senseOf(senses, name) {
  return sensesFor(senses, name)?.dark ?? null;
}

// Keep names just got from the panel in the room, when they differ (GM only: players can't
// write room metadata). `stored`: the room's raw value when already read. `senses`: the
// catalog's `senses` (party.yaml's four senses), kept as PARTY_SENSES_KEY in the same write when
// the room's isn't already exactly them. True when written. Each key gets a whole value; nothing
// is ever removed.
export async function rememberParty(fetched, O = OBR, stored, senses) {
  if (!cleanParty(fetched).length) return false;
  try {
    const meta = stored === undefined || senses !== undefined ? (await O.room.getMetadata()) || {} : null;
    if (stored === undefined) stored = meta?.[PARTY_KEY];
    const names = partyToStore(stored, fetched);
    const sense = senses === undefined ? null : sensesToStore(meta?.[PARTY_SENSES_KEY], senses);
    if ((!names && !sense) || (await O.player.getRole()) !== "GM") return false;
    await O.room.setMetadata({ ...(names ? { [PARTY_KEY]: names } : {}), ...(sense ? { [PARTY_SENSES_KEY]: sense } : {}) });
    return true;
  } catch (e) {
    console.warn("dnd-npc: couldn't keep the party in the room", e);
    return false;
  }
}

// Text for a list with no PC tokens: with no party names at all, how to get them remembered.
export function noPcsText(party) {
  return party?.length ? "No PC tokens on this map. Mark one with 🎲 DND → 🏷 This is…, or name it after the PC."
    : "No PC tokens found. Start the game (or tools\\owlbear_only.py) on the Dell once so the party is "
      + "remembered in this room, or mark tokens with 🎲 DND → 🏷 This is…";
}

// ---- live ----

// The party's names: the room's (instant), then the panel's (straight from it when this copy
// can, else through the bridge: bus.js ask(), which gives up after its timeout); the panel's win
// when it answers, and are then kept in the room.
export async function partyNames() {
  let raw;
  try {
    raw = (await OBR.room.getMetadata())?.[PARTY_KEY];
  } catch {
    raw = undefined;
  }
  const refresh = async () => {
    let fetched = [], senses;
    try {
      const c = await ask(OBR, "/api/map/catalog");
      fetched = cleanParty(c?.party);
      senses = c?.senses;
    } catch {
      fetched = [];
    }
    if (fetched.length) await rememberParty(fetched, OBR, raw ?? null, senses);
    return fetched;
  };
  // The room already knows the party: answer at once and refresh it from the panel meanwhile
  // (without the Dell's panel, asking takes the full timeout).
  if (cleanParty(raw).length) {
    refresh().catch(() => {});
    return mergeParty(raw, []);
  }
  return mergeParty(raw, await refresh());
}

// From the menu: bring the chosen PC tokens (ids; null = all of them) to the target item. Works
// on every copy: interiors.json is only asked for (`load`, only the panel's own copy gets it)
// when a map image in the scene has no MAP_INFO_KEY yet, and nothing breaks without it.
// `O` and `load` are only swapped by the offline check.
export async function bringPcs(targetId, chosen, party, { O = OBR, load = loadInteriors } = {}) {
  const [target] = await O.scene.items.getItems([targetId]);
  if (!target) return;
  const sceneDpi = await O.scene.grid.getDpi();
  const items = await O.scene.items.getItems();
  let json = null;
  if (needsInteriors(items)) {
    try {
      json = (await load()) || null;
    } catch {
      json = null;
    }
  }
  let box;
  try {
    box = await O.scene.items.getItemBounds([targetId]);
  } catch {
    box = undefined;
  }
  const t = targetFor(json, target, sceneDpi, { box });
  if (!t) {
    O.notification.show("🧭 PCs can be brought to a map, a room or a token", "WARNING");
    return;
  }
  let anchor;
  try {
    anchor = await O.scene.grid.snapPosition(t.point, 1, false, true);
  } catch {
    anchor = undefined;
  }
  const g = gather(json, target, items, party, sceneDpi, { chosen, box, anchor });
  if (!g.moves.length) {
    O.notification.show(`🧭 ${noPcsText(party)}`, "WARNING");
    return;
  }
  await moveTokens(new Map(g.moves.map((m) => [m.id, m.position])), O);
  O.notification.show(`🧭 ${g.moves.length} PC${g.moves.length === 1 ? "" : "s"} brought to ${g.name}`, "SUCCESS");
}

// Tokens (id -> position) moved in one updateItems call. Smoke & Spectre stops a token at the
// first wall it crosses, which would leave it stuck on another map. Like the Portals extension's
// teleport: hide what's attached to the tokens (that's how Smoke tracks them), move, then show it
// again in a separate step. Only the position changes: a hidden token stays hidden.
async function moveTokens(to, O = OBR) {
  const ids = [...to.keys()];
  const shown = (list) => list.filter((i) => i.visible).map((i) => i.id);
  const scene = shown(await O.scene.items.getItemAttachments(ids));
  const local = shown(await O.scene.local.getItemAttachments(ids));
  const setVisible = async (on) => {
    if (scene.length) await O.scene.items.updateItems(scene, (ds) => { for (const d of ds) d.visible = on; });
    if (local.length) await O.scene.local.updateItems(local, (ds) => { for (const d of ds) d.visible = on; });
  };
  await setVisible(false);
  try {
    await O.scene.items.updateItems(ids, (drafts) => {
      for (const d of drafts) d.position = to.get(d.id);
    });
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await setVisible(true);
  }
}

// The adventure's monsters from the panel (or tools/owlbear_only.py): {present, rows}, or null when this
// copy can't reach it, or it is from before them (then it needs a restart).
export async function loadMonsters() {
  const base = directBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/api/map/monsters`, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const ADD_BATCH = 80, ADD_PAUSE_MS = 400; // as interiors.js: Owlbear rate-limits big addItems calls

// From a map image's menu: every NPC of town.townsfolk for that map (townsfolkFor) that's in the scene to
// its room, named as its entry; and on a building's or a site's own map, its monsters and scenery (monsterPlan),
// hidden: the DM's dropped token of each kind moved in, then the copies. On a road camp's own map, the road's
// pool (poolPlan) in rows below the road's maps; on the road's other maps, a notice naming the camp's. `O`, `load`
// and `monsters` are only swapped by the offline checks.
export async function placeTownsfolk(clickedId, { O = OBR, load = loadInteriors, monsters = loadMonsters } = {}) {
  const json = await load();
  // a drawing marked as a place (the road's camp) needs only the panel's monsters, not interiors.json
  if (json || directBase()) {
    const drawn = (await O.scene.items.getItems()).find((i) => i.id === clickedId);
    if (isPlaceDrawing(drawn)) return placePool(drawn, { O, monsters, json });
    if (drawn && drawn.layer !== "MAP") { // a drawing whose mark was cleared, a room: never the town's press
      O.notification.show("👥 Right-click a map, or a drawing marked as a place (🎲 DND → 🗺 Mark as place)", "WARNING");
      return;
    }
  }
  if (!json) {
    O.notification.show(directBase() ? "👥 No interiors.json on the panel yet (owlbear/maps/interiors.py makes it)"
      : "👥 Can't reach the DND panel from here: use the “DND NPC (this PC)” copy's menu on the Dell", "ERROR");
    return;
  }
  const sceneDpi = await O.scene.grid.getDpi();
  const items = await O.scene.items.getItems();
  const clicked = items.find((i) => i.id === clickedId);
  if (!clicked) return;
  const own = matchImages(listed(json), [clicked]).size > 0; // a building's or a site's own map, not the town
  const folk = !!json.town?.townsfolk?.length && townsfolkFor(json, clicked).length > 0;
  let data = null;
  if (own) {
    try {
      data = await monsters();
    } catch {
      data = null;
    }
  }
  const r = folk ? townsfolkPlan(json, items, sceneDpi, { clicked }) : null;
  const byId = new Map(items.map((i) => [i.id, i]));
  const taken = (r?.moves || []).map((m) => areaAt(m.cell, tokenBox(byId.get(m.id), sceneDpi).size, sceneDpi));
  const skip = new Set((r?.moves || []).map((mv) => mv.id));
  // a road camp's own map: the road's pool, in rows below the road's maps (as from the camp's drawing); else the
  // map's monsters
  const at = data ? poolOfMap(mapEntry(json, clicked), data.rows) : null;
  const p = at ? poolPlan(data, items, sceneDpi, { clicked, place: at, group: poolGroup(json, items, at), avoid: taken, skip })
    : null;
  const m = data && !p ? monsterPlan(json, data, items, sceneDpi, { clicked, avoid: taken, skip }) : null;
  const anyMonsters = !!m && (m.copies.length || m.adopt.length || m.already.length || m.missing.length || m.byHand.length
    || m.fallen.length);
  // the road's other maps (its strips, its second camp): nothing waits there, the notice names the camp's map
  const away = data && !p && !anyMonsters ? poolsAway(json, data.rows, clicked) : [];
  if (!r && !p && !anyMonsters && !away.length && !(own && !data)) {
    O.notification.show(own ? "👥 No townsfolk or monsters start on this map" : json.town?.townsfolk?.length
      ? "👥 No townsfolk start on this map" : "👥 No townsfolk listed in interiors.json", "WARNING");
    return;
  }
  const names = r ? townsfolkNames(r.moves, items, json.town?.townsfolk || []) : [];
  if (names.length) {
    const to = new Map(names.map((n) => [n.id, n.name]));
    await O.scene.items.updateItems([...to.keys()], (drafts) => {
      for (const d of drafts) {
        const nm = to.get(d.id);
        d.name = nm;
        if (d.text?.plainText) d.text.plainText = nm;
        if (d.metadata?.[BUBBLES_NAME_KEY]) d.metadata[BUBBLES_NAME_KEY] = nm;
      }
    });
  }
  if (r?.moves.length) await moveTokens(new Map(r.moves.map((mv) => [mv.id, mv.position])), O);
  // the copies, then the DM's own moved in, each step waiting out Owlbear's rate limit. A step that still fails
  // shows its error: what got in is tagged, so the reset is to delete them all, drop one of each again and press
  const made = p || m;
  await addInBatches((made?.copies || []).map((c) => c.item), O);
  await moveIn(made?.adopt || [], O);
  const parts = [];
  if (r) parts.push(townsfolkText(r));
  if (p) parts.push(poolText(p));
  else if (anyMonsters) parts.push(monsterText(m));
  else if (away.length) {
    const here = mapEntry(json, clicked);
    parts.push(poolText({ none: true, label: here.building || here.name, pools: away }));
  } else if (own && !data) {
    parts.push("👾 Monsters: the map tool can't list them yet (restart tools\\owlbear_only.py or the game, then press again)");
  }
  const warn = (r && (r.notFound.length || r.noMap.length || r.noRoom.length)) || (own && !data) || away.length > 0
    || (p && (p.missing.length || p.fallen.length))
    || (m && (m.missing.length || m.crowded.length || m.byHand.length || m.fallen.length));
  O.notification.show(parts.join(". "), warn ? "WARNING" : "SUCCESS");
}

// One Owlbear call, waiting out its rate limit ("RateLimitHit": wait 1, 2, 4 s and try again); any other error is thrown.
async function rateLimited(call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= 3 || !/RateLimit|Too many requests/i.test(String(e?.error?.message || e?.message || e))) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

// Owlbear's addItems in batches, waiting out its rate limit.
async function addInBatches(add, O) {
  for (let k = 0; k < add.length; k += ADD_BATCH) {
    if (k) await new Promise((res) => setTimeout(res, ADD_PAUSE_MS));
    await rateLimited(() => O.scene.items.addItems(add.slice(k, k + ADD_BATCH)));
  }
}

// The DM's own tokens a plan moves in ([{id, name, position, placed, rename}]): hidden, marked as placed (PLACED_KEY)
// and named (unless `rename` is false: its name is already right), then moved, in one step for all (each step
// waits out Owlbear's rate limit, right after the copies' adds; both steps are safe to repeat).
async function moveIn(adopt, O) {
  if (!adopt.length) return;
  const to = new Map(adopt.map((a) => [a.id, a]));
  await rateLimited(() => O.scene.items.updateItems([...to.keys()], (drafts) => {
    for (const d of drafts) {
      const a = to.get(d.id);
      d.visible = false;
      d.metadata[PLACED_KEY] = a.placed;
      if (a.rename === false) continue;
      d.name = a.name;
      if (d.text?.plainText) d.text.plainText = a.name;
      if (d.metadata[BUBBLES_NAME_KEY]) d.metadata[BUBBLES_NAME_KEY] = a.name;
    }
  }));
  await rateLimited(() => moveTokens(new Map(adopt.map((a) => [a.id, a.position])), O));
}

// From a drawing marked as a place: the tokens that wait there (poolPlan), the new copies, then the DM's own
// renamed, hidden and marked, and moved into the rows. `json` (interiors.json, when the panel has it) says which
// maps are the road's: a token on one of them is in play there.
async function placePool(drawing, { O = OBR, monsters = loadMonsters, json = null } = {}) {
  let data = null;
  try {
    data = await monsters();
  } catch {
    data = null;
  }
  if (!data) {
    O.notification.show("👾 Monsters: the map tool can't list them yet (restart tools\\owlbear_only.py or the game, then press again)", "WARNING");
    return;
  }
  const sceneDpi = await O.scene.grid.getDpi();
  const items = await O.scene.items.getItems();
  const place = String(drawing.metadata[PLACE_KEY]).trim();
  const p = poolPlan(data, items, sceneDpi, { clicked: drawing, group: json ? poolGroup(json, items, place) : null });
  // the copies, then the DM's own moved in, each step waiting out Owlbear's rate limit. A step that still fails
  // shows its error: what got in is tagged, so the reset is to delete them all, drop one of each again and press
  await addInBatches(p.copies.map((c) => c.item), O);
  await moveIn(p.adopt, O);
  const warn = p.none || p.one || p.missing.length || p.fallen.length;
  O.notification.show(poolText(p), warn ? "WARNING" : "SUCCESS");
}
