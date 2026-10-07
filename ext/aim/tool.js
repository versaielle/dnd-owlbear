// The live template aim tool, for the DM and for players' phones. A spell's real area
// follows the pointer, the tokens it catches light up, and a click (or a tap) locks it.
//
//   installAim(api, ctx, hooks) -> {ready, toolReady(), start(spec, hooks?), cancel(id?), lock(),
//     showTemplate(id, template, style, opts?), clearTemplate(id, {fadeMs}), setOwnTokens(ids),
//     isAiming(), current(), state(), stop()}
//
//   api   {OBR, buildShape, buildLabel, buildPath, now?, setTimeout?, clearTimeout?}
//         (any builder missing is taken from ../obr-sdk.js)
//   ctx   {role: "GM"|"PLAYER", playerId, kind, isPublic(id, item), pcTokens?, log,
//          arrows?: true to turn a cube with ← → as well as [ ] (off until probe P6 says
//                   arrows don't also nudge things),
//          tool?: false for a screen that only shows templates (the Cast receiver): never a tool}
//   hooks {onLocked(AimResult, info), onCancelled(id, reason), onState(hudState)}
//         start(spec, hooks) can bring its own hooks for that one aim (the player's state does);
//         then the install-wide ones aren't called for it.
//
// background.js installs it, because Owlbear sends a tool's events to the frame that created
// it. The toolbar entry appears with the first aim (toolReady() makes it sooner). Everything
// drawn here is a LOCAL item (only this screen sees it), plain shapes only, so aiming works
// even when the spell effects (fx/) don't. Nothing here throws into the caller.
//
// What a player's screen may say about a creature (the HUD is a POPOVER, above the fog, and the
// area's label can sit outside it): R1 keeps hidden tokens out; a visible creature under the
// fog (fog.js) is kept out the same way, never listed, picked by a tap or counted. With the
// fog's fill on (dynamic fog: Owlbear's lights or Smoke & Spectre decide who sees what), this
// screen can't tell, so no creature is named, listed or counted there; a tap still picks one
// ("→ a target") and its ring stays below the fog. A creature's name on a player's screen is
// only one the players see on the map (geometry.tokenLabel publicOnly). PCs are always named.
import * as F from "./fog.js?v=23059e2";
import * as G from "./geometry.js?v=23059e2";
import {
  ACTION_CANCEL, ACTION_LOCK, AIM_KEY, AMBER, CH, DEFAULT_COLOR, DRAW_MS, FADE_MS, FALLBACK_TOOL, FILL_OPACITY,
  HIGHLIGHT_SCALE, HUD_HEIGHT, HUD_HEIGHT_PICK, HUD_ID, HUD_WIDTH, MODE_PICK, MODE_PLACE, SECRET_OPACITY,
  SHOW_TTL_MS, STROKE_CELLS, STROKE_OPACITY, TOOL_ID,
} from "./consts.js?v=23059e2";

const MOVE = 0, LINE = 1, CLOSE = 5; // Path commands
// The template's outline, label and range ring sit above the fog, so a player aiming into the
// dark still sees their own shape; the rings on caught tokens stay under it (ATTACHMENT), so a
// sweep never shows where a fogged creature stands.
const TEMPLATE_LAYER = "POINTER";
// What a redraw may change on an item already drawn (anything else means a new item).
const KEYS = ["position", "rotation", "width", "height", "style", "text", "commands", "shapeType", "visible", "scale"];
const HUD_MS = 150; // the HUD's status line updates at most this often
const SHOW_MS = 100; // shown templates follow moving tokens this often
const LOCK_PREVIEW_TTL = 15000; // the aimer's own copy of a locked template, until the panel's copy arrives

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function installAim(api = {}, ctx = {}, hooks = {}) {
  const OBR = api.OBR;
  const log = (...a) => {
    // background.js's ctx.log takes one line of text (and adds "dnd-npc "); the console takes anything.
    try {
      if (ctx.log) ctx.log(`aim: ${a.map(G.logText).join(" ")}`);
      else console.warn("dnd-npc aim:", ...a);
    } catch {
      // nothing to do
    }
  };
  const now = () => (api.now ? api.now() : globalThis.performance?.now?.() ?? Date.now());
  const later = (fn, ms) => (api.setTimeout || globalThis.setTimeout)(fn, ms);
  const unlater = (h) => h != null && (api.clearTimeout || globalThis.clearTimeout)(h);
  const sleep = (ms) => new Promise((done) => later(done, ms));
  const gm = () => String(ctx.role || "").toUpperCase() === "GM";
  const touchy = () => {
    // A phone or tablet: fingers, where a second one is Owlbear's pinch zoom.
    if (ctx.kind === "touch") return true;
    try {
      return !!globalThis.matchMedia?.("(pointer: coarse)")?.matches;
    } catch {
      return false;
    }
  };
  const here = (rel) => new URL(rel, import.meta.url);
  const fire = (fn, ...args) => {
    try {
      const r = typeof fn === "function" ? fn(...args) : null;
      if (r && typeof r.catch === "function") r.catch((e) => log("hook failed", e));
    } catch (e) {
      log("hook failed", e);
    }
  };

  // ---- builders ----
  let sdk = null;
  async function B() {
    if (api.buildShape && api.buildLabel && api.buildPath) return api;
    sdk ||= import("../obr-sdk.js?v=23059e2").catch((e) => {
      sdk = null;
      throw e;
    });
    const m = await sdk;
    return { buildShape: api.buildShape || m.buildShape, buildLabel: api.buildLabel || m.buildLabel, buildPath: api.buildPath || m.buildPath };
  }
  const maybe = (b, name, ...v) => (typeof b[name] === "function" ? b[name](...v) : b);

  // ---- what's on the map ----
  // CHARACTER items by id. It is only right while we follow the map (an aim, or a template on
  // show): the list is fetched fresh when aiming starts and for every template shown, kept up
  // by the map's change events in between, and forgotten when nothing is on screen.
  let chars = new Map();
  const boundsAt = new Map(); // non-image tokens: their bounds, and where the token stood then
  const boundsOf = new Map(); // ...moved along with the token since (what footprints use)

  function placeBounds(item) {
    const a = boundsAt.get(item.id);
    if (!a) return;
    const dx = (+item.position?.x || 0) - a.x, dy = (+item.position?.y || 0) - a.y;
    boundsOf.set(item.id, { min: { x: a.b.min.x + dx, y: a.b.min.y + dy }, max: { x: a.b.max.x + dx, y: a.b.max.y + dy } });
  }

  function setChars(items) {
    chars = new Map((items || []).filter((i) => i?.layer === "CHARACTER").map((i) => [i.id, i]));
    boundsOf.clear();
    for (const i of chars.values()) if (!i.image) placeBounds(i);
  }

  // The fog, on a player's screen only (the GM sees through it): the FOG layer's drawings and
  // whether the fog's fill is on (null: unread, which counts as on: fail closed).
  let fogItems = [];
  let fogFilled = null;
  const fogMemo = new Map(); // token id -> {x, y, under}: under the fog where it stood then

  function setScene(items) {
    setChars(items);
    if (gm()) return;
    fogItems = F.fogShapes(items);
    fogMemo.clear();
  }

  async function readFill() {
    if (gm()) return null;
    try {
      const v = await OBR.scene.fog.getFilled();
      return typeof v === "boolean" ? v : null;
    } catch {
      return null; // can't tell: as if filled
    }
  }

  function underFogAt(id, fp) {
    const m = fogMemo.get(id);
    if (m && m.x === fp.cx && m.y === fp.cy) return m.under;
    const under = F.underFog({ x: fp.cx, y: fp.cy }, fogItems);
    fogMemo.set(id, { x: fp.cx, y: fp.cy, under });
    return under;
  }

  async function fetchBounds(items) {
    // A shape on the character layer has no image to size it by: ask Owlbear, once per
    // token while we follow the map (it moves the box along with the token after that).
    for (const i of items) {
      if (i.image || boundsAt.has(i.id)) continue;
      try {
        const b = await OBR.scene.items.getItemBounds([i.id]);
        if (b?.min && b?.max) {
          boundsAt.set(i.id, { b, x: +i.position?.x || 0, y: +i.position?.y || 0 });
          placeBounds(chars.get(i.id) || i);
        }
      } catch {
        // a token we can't size can't be caught
      }
    }
  }

  async function loadChars() {
    const player = !gm();
    const items = await OBR.scene.items.getItems((i) => i.layer === "CHARACTER" || (player && i.layer === "FOG"));
    boundsAt.clear();
    setScene(items);
    fogFilled = await readFill();
    await fetchBounds(items);
  }

  async function refreshChars(ids) {
    // The tokens a shown template needs, as they are now. While we follow the map the rest of
    // the list is current already; when we don't, nothing else is read until we do.
    ids = [...new Set(ids.filter(Boolean).map(String))];
    if (!ids.length) return;
    let got = [];
    try {
      got = await OBR.scene.items.getItems(ids);
    } catch {
      return; // drawn with what we have
    }
    const live = new Map((got || []).filter((i) => i?.layer === "CHARACTER").map((i) => [i.id, i]));
    for (const id of ids) {
      if (live.has(id)) chars.set(id, live.get(id));
      else chars.delete(id); // deleted, or not a token any more
    }
    for (const i of live.values()) if (!i.image) placeBounds(i);
    await fetchBounds([...live.values()]);
  }

  function forgetChars() {
    chars = new Map();
    boundsAt.clear();
    boundsOf.clear();
    fogItems = [];
    fogFilled = null;
    fogMemo.clear();
  }

  async function readGrid() {
    try {
      const g = OBR.scene.grid;
      const [dpi, scale, measurement, type] = await Promise.all([g.getDpi(), g.getScale(), g.getMeasurement(), g.getType()]);
      return G.gridInfo({ dpi, multiplier: scale?.parsed?.multiplier, unit: scale?.parsed?.unit, measurement, type });
    } catch (e) {
      log("grid unreadable", e);
      return G.gridInfo(null);
    }
  }

  const pcSet = () => (ctx.pcTokens instanceof Set ? ctx.pcTokens : new Set(typeof ctx.pcTokens === "function" ? ctx.pcTokens() : ctx.pcTokens || []));
  let own = new Set(); // a player's own PC token (from their roster entry, via setOwnTokens)
  function publicHere(item) {
    // R1: hidden and not a PC = secret. On a player's screen their own PC token (the one in
    // their roster entry, or the one they're aiming from) counts as public before the first
    // heartbeat names the PC tokens; nothing else does.
    if (!item) return false;
    if (item.visible !== false || pcSet().has(item.id)) return true;
    try {
      if (ctx.isPublic?.(item.id, item)) return true;
    } catch {
      // treat as secret
    }
    if (gm()) return false;
    return own.has(item.id) || s?.spec?.caster_token === item.id;
  }

  function isPc(item) {
    // On a player's screen: a PC token (the heartbeat's list, my own, the caster), or a hidden
    // token R1 still calls public (only a PC can be that).
    return pcSet().has(item.id) || own.has(item.id) || s?.spec?.caster_token === item.id || item.visible === false;
  }

  function records(g) {
    const all = G.tokensOf([...chars.values()], g, { bounds: boundsOf, isPublic: (id, item) => publicHere(item) });
    if (gm()) return all;
    // A player's screen: a creature under the fog is left out like a secret one. With the fill
    // on (or unread) nobody can say what this player sees: each creature is kept (a tap may
    // pick it) but hushed: no name, no chip, not counted. PCs keep their names.
    const out = [];
    for (const t of all) {
      if (t.secret) continue; // candidates() never hands a player a secret token
      if (isPc(t.item)) {
        out.push(t);
        continue;
      }
      if (fogFilled !== false) out.push({ ...t, hush: true, label: "" });
      else if (!underFogAt(t.id, t.fp)) out.push({ ...t, label: G.tokenLabel(t.item, { publicOnly: true }) });
    }
    return out;
  }

  // ---- drawn sets: local items kept in step with what we want shown ----
  function newSet() {
    return { items: new Map() };
  }

  async function sync(set, want) {
    // Add what's new, delete what's gone, and change the rest in one update. Always Owlbear's
    // normal update: the fast one draws but doesn't store the change (probe P4), so a later
    // normal update that sends only, say, a label's text would put the item back where the
    // last normal update left it.
    const L = OBR.scene.local;
    const adds = [], dels = [], upd = [];
    for (const [id, item] of want) {
      const had = set.items.get(id);
      if (!had) adds.push(item);
      else if (had.type !== item.type) {
        dels.push(id); // a shape can't become a path in place
        adds.push(item);
      } else {
        const diff = KEYS.filter((k) => !same(had[k], item[k]));
        if (diff.length) upd.push({ had, item, diff });
      }
    }
    for (const id of set.items.keys()) if (!want.has(id) && !dels.includes(id)) dels.push(id);
    if (dels.length) {
      await L.deleteItems(dels);
      for (const id of dels) set.items.delete(id);
    }
    if (adds.length) {
      await L.addItems(adds);
      for (const i of adds) set.items.set(i.id, i);
    }
    if (upd.length) {
      await L.updateItems(upd.map((u) => clone(u.had)), (drafts) => {
        drafts.forEach((d, n) => {
          for (const k of upd[n].diff) d[k] = clone(upd[n].item[k]);
        });
      });
      for (const u of upd) for (const k of u.diff) u.had[k] = clone(u.item[k]);
    }
  }

  function throttle(obj, paint, force, ms) {
    // Draw now when the last draw was long enough ago, else once at the end of the wait;
    // never two draws at once (a change during a draw is drawn right after it).
    if (!obj || obj.ending || obj.dead) return;
    if (obj.painting) {
      obj.dirty = true;
      return;
    }
    const wait = ms - (now() - (obj.lastDraw ?? -Infinity));
    if (force || wait <= 0) {
      unlater(obj.timer);
      obj.timer = null;
      obj.lastDraw = now();
      obj.dirty = false;
      obj.painting = paint(obj)
        .catch((e) => log("draw failed", e))
        .finally(() => {
          obj.painting = null;
          if (obj.dirty) throttle(obj, paint, false, ms);
        });
    } else if (!obj.timer) {
      obj.timer = later(() => {
        obj.timer = null;
        throttle(obj, paint, true, ms);
      }, wait);
    }
  }

  // ---- item recipes ----
  function look(b, g, color, { dashed = false, fill = FILL_OPACITY, stroke = STROKE_OPACITY } = {}) {
    const w = g.cell * STROKE_CELLS;
    return b.fillColor(color).fillOpacity(fill).strokeColor(color).strokeOpacity(stroke).strokeWidth(w)
      .strokeDash(dashed ? [w * 3, w * 2] : []);
  }

  function finishItem(b, id, layer, name, meta) {
    return maybe(b.id(id).name(name).layer(layer).locked(true).disableHit(true), "disableAutoZIndex", true).metadata(meta).build();
  }

  function templateItem(bs, id, t, area, g, color, dashed, meta, name) {
    let b;
    if (area.kind === "circle") {
      b = bs.buildShape().shapeType("CIRCLE").width(2 * area.r).height(2 * area.r).position({ x: area.cx, y: area.cy });
    } else if (t.shape === "cone") {
      // Owlbear's triangle: apex at its position, pointing down its +y; turned to the aim.
      const L = t.size_ft * g.pxPerFt;
      b = bs.buildShape().shapeType("TRIANGLE").width(2 * L * Math.tan(G.CONE_HALF)).height(L)
        .position({ x: t.origin.x, y: t.origin.y }).rotation(G.normDeg((t.rot || 0) - 90));
    } else if (t.shape === "line") {
      const L = t.size_ft * g.pxPerFt, W = (t.width_ft || 5) * g.pxPerFt;
      b = bs.buildShape().shapeType("RECTANGLE").width(L).height(W).position(area.pts[0]).rotation(G.normDeg(t.rot || 0));
    } else if (area.kind === "poly") {
      // cube or square: a rectangle turns about its top-left corner, so it is placed there.
      const side = t.size_ft * g.pxPerFt;
      b = bs.buildShape().shapeType("RECTANGLE").width(side).height(side).position(area.pts[0]).rotation(G.normDeg(t.rot || 0));
    } else {
      const o = { x: area.rect.cx, y: area.rect.cy };
      const cmds = G.outline(area, 8).map((p, i) => [i ? LINE : MOVE, p.x - o.x, p.y - o.y]);
      b = bs.buildPath().commands([...cmds, [CLOSE]]).position(o);
    }
    return finishItem(look(b, g, color, { dashed }), id, TEMPLATE_LAYER, name, meta);
  }

  function labelItem(bs, id, text, area, g, meta) {
    const bb = G.bounds(area) || { minX: 0, maxX: 0, minY: 0 };
    let b = bs.buildLabel().plainText(text).position({ x: (bb.minX + bb.maxX) / 2, y: bb.minY - g.cell * 0.12 });
    b = maybe(b, "pointerDirection", "DOWN");
    b = maybe(b, "backgroundColor", "#1d1b2a");
    b = maybe(b, "backgroundOpacity", 0.85);
    b = maybe(b, "minViewScale", 1);
    return finishItem(b, id, TEMPLATE_LAYER, "🎯 label", meta);
  }

  function ringItem(bs, id, fp, radius, g, color, { secret = false, layer = "ATTACHMENT", opacity = STROKE_OPACITY, dashed = false } = {}, meta) {
    const w = g.cell * STROKE_CELLS;
    const b = bs.buildShape().shapeType("CIRCLE").width(radius ? radius * 2 : fp.w * HIGHLIGHT_SCALE).height(radius ? radius * 2 : fp.h * HIGHLIGHT_SCALE)
      .position({ x: fp.cx, y: fp.cy }).fillColor(color).fillOpacity(0).strokeColor(color)
      .strokeOpacity(secret ? SECRET_OPACITY : opacity).strokeWidth(w).strokeDash(secret || dashed ? [w * 2, w * 1.5] : []);
    return finishItem(b, id, layer, secret ? "🎯 🙈" : "🎯", meta);
  }

  // ---- the aim in progress ----
  let s = null;
  let seq = 0;
  let gen = 0;

  const nameOf = (spec) => String(spec?.label || spec?.name || spec?.key || "Spell");
  const areaTextOf = (spec) => spec?.area_text || G.areaText(spec?.area);

  function locateCaster(sess) {
    const id = sess.spec.caster_token;
    const item = id ? chars.get(id) : null;
    const fp = item ? G.footprint(item, sess.grid.dpi, boundsOf.get(id)) : null;
    if (fp) {
      sess.casterFp = fp;
      sess.virtual = false;
    } else if (!sess.virtual) sess.casterFp = null;
  }

  function candidates(sess) {
    // The GM sees everyone (hidden monsters flagged); a player never hears of a secret token.
    const all = records(sess.grid);
    return gm() ? all : all.filter((t) => !t.secret);
  }

  function compute(sess) {
    if (!sess.pointer) return;
    const t = G.snap(sess.spec, sess.pointer, sess.casterFp, sess.grid, { free: sess.free, step45: sess.step45, rot: sess.rot });
    if (sess.virtual) t.caster_token = null;
    sess.template = t;
    const pool = candidates(sess);
    const hushed = new Set(pool.filter((x) => x.hush).map((x) => x.id));
    sess.caught = G.caughtBy(t, pool, sess.grid, {
      includeSecret: gm(), casterId: sess.virtual ? null : sess.spec.caster_token ?? null, casterFp: sess.casterFp,
    }).map((c) => (hushed.has(c.id) ? { ...c, hush: true } : c));
    const fromPoint = !G.isSelf({ shape: t.shape, from: t.from });
    sess.feet = fromPoint && sess.casterFp && !sess.virtual ? G.nearestFeet(sess.casterFp, t.origin, sess.grid) : null;
    sess.range = G.inRange(sess.feet, +sess.spec.range_ft || 0);
  }

  function computePick(sess) {
    const spec = sess.spec, pool = candidates(sess);
    const secretOf = new Map(pool.map((t) => [t.id, t.secret]));
    // A hushed creature (fog fill on, a player's screen) is never offered as a chip.
    sess.chips = G.chips(sess.casterFp, pool.filter((t) => !t.hush), sess.grid, +spec.range_ft || 0, {
      longFt: +spec.long_ft || null, casterId: spec.caster_token ?? null, includeSelf: !!spec.self_ok,
    }).map((c) => ({ ...c, secret: !!secretOf.get(c.id) }));
    const picked = sess.pick ? pool.find((t) => t.id === sess.pick) : null;
    if (sess.pick && !picked) sess.pick = null;
    sess.pickLabel = picked ? picked.label || (gm() ? "that token" : "a target") : null;
    sess.feet = picked ? (picked.id === spec.caster_token ? 0 : G.nearestFeet(sess.casterFp, picked.fp, sess.grid)) : null;
    sess.range = G.inRange(sess.feet, +spec.range_ft || 0, +spec.long_ft || null);
  }

  function aimAt(p, e = {}, force = false) {
    const sess = s;
    if (!sess || sess.ending || sess.mode !== "area" || sess.needOrigin || !p) return;
    sess.pointer = { x: +p.x || 0, y: +p.y || 0 };
    sess.free = !!e.altKey;
    sess.step45 = !!e.shiftKey;
    compute(sess);
    schedule(sess, force);
  }

  function schedule(sess, force = false) {
    throttle(sess, paint, force, DRAW_MS);
    pushHud(sess);
  }

  // How many an area catches, as this screen may say it: everyone on the GM's; on a player's,
  // only who they can see (PCs, creatures in the open), and nothing at all while the fog's fill
  // is on, so the number never moves for a creature they can't see.
  const countsHere = () => gm() || fogFilled === false;
  const shownCaught = (sess) => (gm() ? sess.caught.length : sess.caught.filter((c) => !c.hush).length);

  function aimLabel(sess) {
    const spec = sess.spec, n = shownCaught(sess), k = sess.caught.filter((c) => c.secret).length;
    let text = `${nameOf(spec)} · ${areaTextOf(spec)}`;
    if (countsHere()) text += ` · ${n} caught${gm() && k ? ` (${k} 🙈)` : ""}`;
    if (sess.range.far) text += ` · too far (${sess.feet}/${spec.range_ft} ft)`;
    return text;
  }

  async function paint(sess) {
    if (sess.ending) return;
    const bs = await B();
    if (sess.ending) return;
    const g = sess.grid, spec = sess.spec, want = new Map();
    const P = `dnd-npc-aim-${sess.id}-${sess.gen}-`;
    const meta = (part) => ({ [AIM_KEY]: { aim: sess.id, part } });
    const color = spec.color || DEFAULT_COLOR;
    const put = (item) => want.set(item.id, item);
    if (sess.mode === "area" && sess.template) {
      const area = G.templateArea(sess.template, g, sess.casterFp);
      if (area) {
        put(templateItem(bs, P + "tpl", sess.template, area, g, sess.range.far ? AMBER : color, true, meta("template"), `🎯 ${nameOf(spec)}`));
        put(labelItem(bs, P + "label", aimLabel(sess), area, g, meta("label")));
      }
    }
    const rangeFt = +spec.range_ft || 0;
    const fromPoint = sess.mode === "pick" || (sess.mode === "area" && !G.isSelf(spec.area));
    if (rangeFt > 0 && fromPoint && sess.casterFp && !sess.virtual) {
      const r = rangeFt * g.pxPerFt + Math.max(sess.casterFp.w, sess.casterFp.h) / 2;
      put(ringItem(bs, P + "range", sess.casterFp, r, g, color, { layer: TEMPLATE_LAYER, opacity: 0.5, dashed: true }, meta("range")));
    }
    const lit = sess.mode === "pick" ? (sess.pick ? [{ id: sess.pick, secret: false }] : []) : sess.caught;
    for (const c of lit) {
      const item = chars.get(c.id);
      const fp = item && G.footprint(item, g.dpi, boundsOf.get(c.id));
      if (fp) put(ringItem(bs, P + "hl-" + c.id, fp, 0, g, color, { secret: c.secret && gm() }, meta("caught")));
    }
    if (!sess.ending) await sync(sess.drawn, want);
  }

  // ---- the HUD ----
  let hudLast = "", hudTimer = null, hudAt = -Infinity;

  function hudState(sess) {
    const spec = sess.spec, name = nameOf(spec), gmView = gm();
    const st = {
      id: sess.id, mode: sess.mode, title: name, color: spec.color || DEFAULT_COLOR, keys: ctx.kind !== "touch",
      canRotate: sess.mode === "area" && G.canRotate(spec), chips: [], picked: sess.pick || null,
      caught: shownCaught(sess), secret: gmView ? sess.caught.filter((c) => c.secret).length : 0,
      inRange: !sess.range.far, long: !!sess.range.long, feet: sess.feet, rangeFt: +spec.range_ft || null,
      ready: false, status: "", alert: null, warn: sess.mode !== "self" && !sess.grid.square ? "Not a square grid: no snapping" : null,
    };
    if (sess.mode === "self") {
      st.status = `Cast ${name} on yourself?`;
      st.ready = true;
    } else if (sess.mode === "pick") {
      st.chips = sess.chips.map((c) => ({
        id: c.id, feet: c.feet, long: c.long, secret: c.secret,
        label: `${c.label || (gmView ? "?" : "Target")}${c.feet != null ? ` ${c.feet} ft` : ""}${c.secret && gmView ? " 🙈" : ""}`,
      }));
      st.status = sess.pick ? `${name} → ${sess.pickLabel || "a target"}${sess.feet != null ? ` · ${sess.feet} ft` : ""}` : `${name}: tap a target`;
      st.ready = !!sess.pick;
    } else if (sess.needOrigin) {
      st.status = `${name}: tap where you stand`;
      st.alert = "your token isn't on the map";
    } else {
      st.status = sess.template ? aimLabel(sess).replace(/ · too far.*$/, "") : `${name} · ${areaTextOf(spec)}`;
      st.ready = !!sess.template;
    }
    // The HUD shows the alert in amber between its buttons; the status keeps it too.
    if (sess.range.far) st.alert = `too far (${sess.feet}/${spec.range_ft} ft)`;
    else if (sess.range.long) st.alert = "long range: disadvantage";
    if (sess.range.far || sess.range.long) st.status += ` · ${st.alert}`;
    return st;
  }

  function sendHud(msg) {
    try {
      const p = OBR.broadcast.sendMessage(CH.LOCAL_HUD, msg, { destination: "LOCAL" });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // the HUD will ask again
    }
  }

  function pushHud(sess = s, force = false, note = null) {
    // The HUD hears the state at most every 150 ms, and only when it changed.
    const go = () => {
      hudTimer = null;
      hudAt = now();
      const cur = s;
      const st = cur && !cur.ending ? hudState(cur) : null;
      if (st && note) st.note = note;
      const msg = { state: st };
      const key = JSON.stringify(msg);
      if (!force && key === hudLast) return;
      hudLast = key;
      sendHud(msg);
      if (cur) fire(cur.hooks?.onState ?? hooks.onState, st);
    };
    if (force || note || now() - hudAt >= HUD_MS) {
      unlater(hudTimer);
      go();
    } else if (!hudTimer) hudTimer = later(go, HUD_MS - (now() - hudAt));
  }

  async function openHud(sess) {
    let vw = 800, vh = 600;
    try {
      [vw, vh] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
    } catch {
      // keep the guesses
    }
    const url = here("./hud.html");
    url.searchParams.set("mode", sess.mode);
    if (ctx.kind) url.searchParams.set("kind", ctx.kind);
    if (ctx.arrows === true) url.searchParams.set("arrows", "1"); // the HUD turns with ← → too
    if (s !== sess || sess.ending) return; // cancelled while we measured: no HUD left open for nobody
    try {
      await OBR.popover.open({
        id: HUD_ID, url: url.href,
        width: Math.max(240, Math.min(HUD_WIDTH, vw - 16)), height: sess.mode === "pick" ? HUD_HEIGHT_PICK : HUD_HEIGHT,
        anchorReference: "POSITION", anchorPosition: { left: Math.round(vw / 2), top: Math.round(vh - 8) },
        anchorOrigin: { horizontal: "CENTER", vertical: "BOTTOM" }, transformOrigin: { horizontal: "CENTER", vertical: "BOTTOM" },
        hidePaper: true, disableClickAway: true,
      });
    } catch (e) {
      log("HUD didn't open", e);
    }
    if (!s) await closeHud(); // cancelled while it opened (a newer aim opens its own)
  }

  async function closeHud() {
    try {
      await OBR.popover.close(HUD_ID);
    } catch {
      // already closed
    }
  }

  // ---- starting, locking, cancelling ----
  async function firstLook(sess) {
    // Something to see before the pointer moves (a phone has no hover): the area at the
    // caster, or the middle of the view; an emanation is complete at once.
    const spec = sess.spec;
    if (sess.mode === "pick") {
      computePick(sess);
      schedule(sess, true);
      return;
    }
    if (sess.needOrigin) {
      pushHud(sess, true);
      return;
    }
    let p = null;
    if (sess.casterFp) {
      p = G.isSelf(spec.area) ? { x: sess.casterFp.cx + sess.grid.cell * 2, y: sess.casterFp.cy } : { x: sess.casterFp.cx, y: sess.casterFp.cy };
    } else {
      try {
        const [vw, vh] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
        p = await OBR.viewport.inverseTransformPoint({ x: vw / 2, y: vh / 2 });
      } catch {
        p = null;
      }
    }
    if (p && s === sess && !sess.pointer) aimAt(p, {}, true);
    else pushHud(sess, true);
  }

  async function start(spec, startHooks = null) {
    if (!spec || typeof spec !== "object" || ctx.tool === false) return null;
    const prev = s;
    const mode = spec.mode === "pick" || spec.mode === "self" ? spec.mode : spec.area ? "area" : "pick";
    const sess = {
      id: String(spec.id ?? `aim-${++seq}`), gen: ++gen, spec, mode, hooks: startHooks || hooks,
      grid: G.gridInfo(null), drawn: newSet(), caught: [], template: null, feet: null, range: G.inRange(null, 0),
      chips: [], pick: null, pickLabel: null, rot: 0, pointer: null, casterFp: null, virtual: false, needOrigin: false,
      prevTool: prev?.active ? prev.prevTool : null, active: false, ending: false, painting: null, timer: null,
    };
    // The tool the user had before aiming. If the aim being replaced already switched to ours,
    // its saved tool is the one to go back to (whether or not its switch has finished).
    if (prev) await finish(prev, { restore: mode === "self" || !prev.active, closeHud: false });
    if (prev?.active && mode !== "self") sess.prevTool = prev.prevTool;
    s = sess;
    const gone = () => s !== sess || sess.ending; // cancelled, locked or replaced meanwhile
    try {
      if (mode === "self") {
        await openHud(sess);
        if (gone()) return null;
        pushHud(sess, true);
        return sess.id;
      }
      await toolReady();
      sess.grid = await readGrid();
      await loadChars();
      if (gone()) return null;
      locateCaster(sess);
      sess.needOrigin = mode === "area" && G.isSelf(spec.area) && !sess.casterFp;
      if (!sess.prevTool) {
        let t = null;
        try {
          t = await OBR.tool.getActiveTool();
        } catch {
          // fall back to Move
        }
        sess.prevTool = t && t !== TOOL_ID ? t : FALLBACK_TOOL;
      }
      try {
        await OBR.player.deselect(); // so arrow keys and clicks can't move a selected token
      } catch {
        // nothing selected
      }
      if (gone()) return null; // cancelled before we switched tools: nothing to undo
      // From here on a cancel puts the previous tool back itself (finish() sees active).
      sess.active = true;
      await OBR.tool.activateTool(TOOL_ID);
      if (gone()) return await settle(sess);
      await OBR.tool.activateMode(TOOL_ID, mode === "pick" ? MODE_PICK : MODE_PLACE);
      if (gone()) return await settle(sess);
      watch();
      await openHud(sess);
      if (gone()) return await settle(sess);
      await firstLook(sess);
      return sess.id;
    } catch (e) {
      log("couldn't start aiming", e);
      if (s === sess) {
        await finish(sess, { restore: true });
        fire(sess.hooks?.onCancelled, sess.id, "error");
      }
      return null;
    }
  }

  async function settle(sess) {
    // The aim ended while our tool was still coming up. finish() put the previous tool back,
    // but our own switch may have landed after that: unless a newer aim has the tool now,
    // put it back again, so nobody is left in a crosshair that does nothing.
    if (!s && sess.prevTool) {
      try {
        if ((await OBR.tool.getActiveTool()) === TOOL_ID) await OBR.tool.activateTool(sess.prevTool);
      } catch (e) {
        log("previous tool not restored", e);
      }
    }
    return null;
  }

  async function finish(sess, { restore = true, closeHud = true } = {}) {
    if (!sess || sess.ending) return;
    sess.ending = true;
    if (s === sess) s = null;
    unlater(sess.timer);
    sess.timer = null;
    try {
      await sess.painting;
    } catch {
      // drawn or not, it is removed below
    }
    const ids = [...sess.drawn.items.keys()];
    sess.drawn.items.clear();
    if (ids.length) {
      try {
        await OBR.scene.local.deleteItems(ids);
      } catch (e) {
        log("preview not removed", e);
      }
    }
    if (restore && sess.active && sess.prevTool) {
      try {
        await OBR.tool.activateTool(sess.prevTool);
      } catch (e) {
        log("previous tool not restored", e);
      }
    }
    if (restore && closeHud) {
      try {
        await OBR.popover.close(HUD_ID);
      } catch {
        // already closed
      }
    }
    if (!s) {
      hudLast = "";
      sendHud({ state: null });
    }
    unwatchIfIdle();
  }

  async function lock() {
    const sess = s;
    if (!sess || sess.ending) return false;
    const spec = sess.spec;
    let result;
    if (sess.mode === "self") result = { aim_id: sess.id, template: null, target: spec.caster_token ?? null, cancel: false };
    else if (sess.mode === "pick") {
      if (!sess.pick) {
        pushHud(sess, true, "Tap a target first");
        return false;
      }
      result = { aim_id: sess.id, template: null, target: sess.pick, cancel: false };
    } else {
      if (sess.needOrigin || !sess.template) return false;
      result = { aim_id: sess.id, template: clone(sess.template), target: null, cancel: false };
    }
    const info = { spec, caught: sess.caught.slice(), feet: sess.feet, inRange: !sess.range.far, long: !!sess.range.long, out_of_range: !!sess.range.far };
    await finish(sess, { restore: true });
    if (result.template && spec.who !== "player") {
      // The DM's own screen keeps the locked template (solid) until the panel's copy arrives.
      showTemplate(sess.id, result.template, "locked", {
        label: lockedLabel(spec), color: spec.color, ttl: LOCK_PREVIEW_TTL,
        caught_public: info.caught.filter((c) => !c.secret).map((c) => c.id), secret: info.caught.filter((c) => c.secret).map((c) => c.id),
      });
    }
    fire(sess.hooks?.onLocked, result, info);
    return true;
  }

  const lockedLabel = (spec) => [nameOf(spec), spec.save_label].filter(Boolean).join(" · ");

  async function userCancel(reason) {
    const sess = s;
    if (!sess || sess.ending) return false;
    await finish(sess, { restore: true });
    fire(sess.hooks?.onCancelled, sess.id, reason);
    return true;
  }

  async function cancel(id = null) {
    // From outside (the panel cancelled, or another GM tab locked this aim): stop quietly.
    const sess = s;
    if (!sess || (id != null && String(id) !== sess.id)) return false;
    await finish(sess, { restore: true });
    return true;
  }

  function rotate(dir, shift) {
    const sess = s;
    if (!sess || sess.ending || sess.mode !== "area" || !G.canRotate(sess.spec)) return;
    sess.rot = G.rotateBy(sess.rot, dir, { shift: !!shift });
    if (sess.pointer) {
      compute(sess);
      schedule(sess, true);
    } else pushHud(sess, true);
  }

  function choose(id) {
    const sess = s;
    if (!sess || sess.ending || sess.mode !== "pick" || !id) return;
    if (!candidates(sess).some((t) => t.id === id)) return;
    if (id === sess.spec.caster_token && !sess.spec.self_ok) {
      // A tap on your own token for an attack or a spell aimed at others: not a request to
      // cast it on yourself.
      pushHud(sess, true, "Not on yourself: tap a target");
      return;
    }
    if (sess.pick === id) {
      lock(); // a second tap on the same token locks
      return;
    }
    sess.pick = id;
    computePick(sess);
    schedule(sess, true);
  }

  function click(e) {
    const sess = s;
    if (!sess || sess.ending || !e?.pointerPosition) return;
    const p = e.pointerPosition;
    if (sess.mode === "pick") {
      const id = G.pickAt(p, candidates(sess), sess.grid);
      if (id) choose(id);
      return;
    }
    if (sess.mode !== "area") return;
    if (sess.needOrigin) {
      // No caster token on the map: this tap says where the caster stands (one square).
      const c = G.snapCentre(p, sess.grid.cell, sess.grid);
      sess.casterFp = G.box(c.x, c.y, sess.grid.cell, sess.grid.cell);
      sess.virtual = true;
      sess.needOrigin = false;
      aimAt(String(sess.spec.area?.shape).toLowerCase() === "emanation" ? c : { x: c.x + sess.grid.cell * 2, y: c.y }, e, true);
      return;
    }
    if (String(sess.spec.area?.shape).toLowerCase() !== "emanation") aimAt(p, e, true);
    lock();
  }

  function key(e) {
    const k = e?.key;
    if (!s || !k) return;
    if (k === "Escape") userCancel("escape");
    else if (k === "Enter") lock();
    else if (k === "[" || k === "{") rotate(-1, e.shiftKey || k === "{");
    else if (k === "]" || k === "}") rotate(1, e.shiftKey || k === "}");
    // ← → only when switched on (ctx.arrows: true), until probe P6 shows they don't also nudge things.
    else if (ctx.arrows === true && (k === "ArrowLeft" || k === "ArrowRight")) rotate(k === "ArrowLeft" ? -1 : 1, e.shiftKey);
  }

  function hudCommand(d) {
    switch (d.cmd) {
      case "hello":
        pushHud(s, true);
        break;
      case "lock":
        lock();
        break;
      case "cancel":
        userCancel("hud");
        break;
      case "rotate-left":
        rotate(-1, d.shift);
        break;
      case "rotate-right":
        rotate(1, d.shift);
        break;
      case "pick":
        choose(d.id);
        break;
      default:
        break;
    }
  }

  // ---- following the map ----
  let unsubItems = null, unsubFog = null;
  function watch() {
    if (!unsubFog && !gm()) {
      // A player's screen also follows the fog's fill (the DM turning it on mid-aim hushes
      // every creature at once; off brings the fog drawings back into play).
      try {
        unsubFog = OBR.scene.fog.onChange((fog) => {
          const filled = typeof fog?.filled === "boolean" ? fog.filled : null;
          if (filled === fogFilled) return;
          fogFilled = filled;
          redo();
        });
      } catch {
        unsubFog = null; // can't follow it: the fill read at the aim's start stands
      }
    }
    if (unsubItems) return;
    try {
      unsubItems = OBR.scene.items.onChange(onItems);
    } catch (e) {
      log("can't follow the map", e);
    }
  }
  function unwatchIfIdle() {
    if (s || shows.size) return;
    // Nothing on screen: stop following the map, and forget the tokens, which go out of date
    // from now on (the next aim or shown template fetches them again).
    forgetChars();
    for (const off of [unsubFog, unsubItems]) {
      try {
        if (typeof off === "function") off();
      } catch {
        // gone already
      }
    }
    unsubFog = null;
    unsubItems = null;
  }
  function onItems(all) {
    setScene(all);
    redo();
  }
  function redo() {
    // The map (or its fog) changed: the aim's caught list, chips and HUD again, and the shown
    // templates follow their tokens.
    const sess = s;
    if (sess && !sess.ending && sess.mode !== "self") {
      locateCaster(sess);
      if (sess.mode === "pick") computePick(sess);
      else compute(sess);
      schedule(sess);
    }
    for (const d of shows.values()) throttle(d, paintShow, false, SHOW_MS);
  }

  // ---- templates shown without aiming: locked, a player's request, a pending one ----
  const shows = new Map();

  async function showTemplate(id, template, style = "locked", opts = {}) {
    // style: "locked" (solid, the spell's colour), "request" (amber dashed: a player's
    // request, on GM screens) or "pending" (amber dashed: my own request, waiting).
    // opts: {label, color, caught_public: [ids], secret: [ids] (GM only), caught: [{id, secret}], ttl}.
    // A second call for the same id updates it (the public and GM copies of one template merge).
    try {
      if (id && typeof id === "object") {
        opts = id;
        id = opts.id;
        template = opts.template;
        style = opts.style || "locked";
      }
      opts = opts || {};
      if (id == null || !template?.origin) return false;
      id = String(id);
      let d = shows.get(id);
      if (!d) {
        d = { id, gen: ++gen, drawn: newSet(), pub: [], sec: [], label: null, color: null, painting: null, timer: null, ttl: null };
        shows.set(id, d);
      }
      d.template = clone(template);
      d.style = style || d.style || "locked";
      if (opts.label != null) d.label = String(opts.label);
      if (opts.color) d.color = opts.color;
      if (Array.isArray(opts.caught)) {
        d.pub = opts.caught.filter((c) => !c.secret).map((c) => String(c.id));
        d.sec = opts.caught.filter((c) => c.secret).map((c) => String(c.id));
      }
      if (Array.isArray(opts.caught_public)) d.pub = opts.caught_public.map(String);
      if (Array.isArray(opts.secret)) d.sec = opts.secret.map(String);
      if (!gm()) d.sec = []; // R2: a player's screen never draws a hidden monster
      watch(); // follow the map from now on, so nothing that moves after this read is missed
      d.grid = await readGrid();
      // Every token this template needs, fetched again now: since the last time this screen
      // looked they may have walked, been hidden or been deleted (the DM writes the rings
      // before the template arrives, often while nothing was shown and nobody listened).
      await refreshChars([...d.pub, ...d.sec, template.caster_token]);
      if (shows.get(id) !== d) { // cleared meanwhile
        unwatchIfIdle();
        return false;
      }
      unlater(d.ttl);
      d.ttl = later(() => {
        if (shows.get(id) === d) clearTemplate(id);
      }, opts.ttl ?? SHOW_TTL_MS);
      throttle(d, paintShow, true, SHOW_MS);
      await d.painting;
      return true;
    } catch (e) {
      log("template not shown", e);
      return false;
    }
  }

  async function paintShow(d) {
    if (d.dead) return;
    const bs = await B();
    if (d.dead) return;
    const g = d.grid, t = d.template, want = new Map();
    const P = `dnd-npc-show-${d.id}-${d.gen}-`;
    const meta = (part) => ({ [AIM_KEY]: { show: d.id, part } });
    const put = (item) => want.set(item.id, item);
    const casterItem = t.caster_token ? chars.get(t.caster_token) : null;
    const casterFp = casterItem ? G.footprint(casterItem, g.dpi, boundsOf.get(casterItem.id)) : null;
    // R2, second guard: a player's screen draws nothing that comes out of a secret caster.
    const fromSecret = !gm() && casterItem && !publicHere(casterItem) && G.isSelf(t);
    const area = fromSecret ? null : G.templateArea(t, g, casterFp);
    const locked = d.style === "locked";
    const color = locked ? d.color || DEFAULT_COLOR : AMBER;
    if (area) {
      put(templateItem(bs, P + "tpl", t, area, g, color, !locked, meta("template"), locked ? "🎯 locked" : "🎯 request"));
      put(labelItem(bs, P + "label", d.label || G.areaText(t), area, g, meta("label")));
    }
    const lit = (ids, secret) => {
      for (const id of ids) {
        const item = chars.get(id);
        if (!item || (!gm() && !publicHere(item))) continue;
        const fp = G.footprint(item, g.dpi, boundsOf.get(id));
        if (fp) put(ringItem(bs, P + "hl-" + id, fp, 0, g, color, { secret }, meta("caught")));
      }
    };
    lit(d.pub, false);
    if (gm()) lit(d.sec, true);
    if (!d.dead) await sync(d.drawn, want);
  }

  async function clearTemplate(id, { fadeMs = FADE_MS } = {}) {
    // Fade the template out, then delete it.
    const d = shows.get(String(id));
    if (!d) return false;
    shows.delete(d.id);
    d.dead = true;
    unlater(d.ttl);
    unlater(d.timer);
    try {
      await d.painting;
    } catch {
      // removed below either way
    }
    const items = [...d.drawn.items.values()];
    d.drawn.items.clear();
    if (items.length) {
      if (fadeMs > 0) {
        try {
          await OBR.scene.local.updateItems(items.map(clone), (drafts) => {
            for (const x of drafts) {
              for (const k of ["fillOpacity", "strokeOpacity", "backgroundOpacity"]) if (typeof x.style?.[k] === "number") x.style[k] *= 0.35;
              if (typeof x.text?.style?.fillOpacity === "number") x.text.style.fillOpacity *= 0.35;
            }
          });
        } catch {
          // no fade, just gone
        }
        await sleep(fadeMs);
      }
      try {
        await OBR.scene.local.deleteItems(items.map((i) => i.id));
      } catch (e) {
        log("template not removed", e);
      }
    }
    unwatchIfIdle();
    return true;
  }

  // ---- the tool, its modes and actions (created once, in this frame) ----
  const icon = (f) => here(`../icons/${f}`).href;
  const modeHandlers = {
    onToolMove: (_c, e) => aimAt(e?.pointerPosition, e),
    onToolDragStart: (_c, e) => aimAt(e?.pointerPosition, e),
    onToolDragMove: (_c, e) => aimAt(e?.pointerPosition, e),
    onToolDragEnd: (_c, e) => aimAt(e?.pointerPosition, e, true), // lifting the finger leaves it there
    // On a phone a second finger (Owlbear's pinch zoom) cancels the drag: the template stays
    // put. With a mouse it means Esc during a drag: cancel the aim, like Esc does otherwise.
    onToolDragCancel: () => {
      if (!touchy()) userCancel("escape");
    },
    onToolClick: (_c, e) => {
      click(e);
      return false; // never select what was under the click
    },
    onToolDoubleClick: () => false,
    onKeyDown: (_c, e) => key(e),
    onDeactivate: () => {
      // Another tool was picked mid-aim: that cancels it (once we're sure the tool changed).
      const sess = s;
      if (!sess || !sess.active || sess.ending) return;
      later(async () => {
        if (s !== sess || sess.ending) return;
        let t = null;
        try {
          t = await OBR.tool.getActiveTool();
        } catch {
          return;
        }
        if (t && t !== TOOL_ID && s === sess && !sess.ending) {
          sess.active = false; // keep the tool they picked
          userCancel("tool");
        }
      }, 80);
    },
  };

  // The toolbar entry is made by the first aim on this screen, not at install: a screen that
  // never aims (the Cast receiver, a player not linked to a character, a GM tab with "Open the
  // aim tool here" off) never shows an aim button that does nothing.
  let made = null;
  function toolReady() {
    if (ctx.tool === false) return Promise.resolve(false); // display only: shown templates, no tool
    made ||= makeTool().then(
      () => true,
      (e) => {
        made = null; // try again on the next aim
        throw e;
      },
    );
    return made;
  }

  async function makeTool() {
    try {
      await OBR.tool.create({
        id: TOOL_ID,
        icons: [{ icon: icon("aim.svg"), label: "Aim a spell (DND)" }],
        defaultMode: MODE_PLACE,
        onClick: () => {
          if (s) return true;
          // Not aiming: open the extension's list instead (a player's spells and attacks).
          try {
            OBR.action.open()?.catch?.(() => {});
          } catch {
            // no list to open
          }
          return false;
        },
      });
      await OBR.tool.createMode({
        id: MODE_PLACE, cursors: [{ cursor: "crosshair" }],
        icons: [{ icon: icon("aim.svg"), label: "Place the area", filter: { activeTools: [TOOL_ID], activeModes: [MODE_PLACE] } }],
        ...modeHandlers,
      });
      await OBR.tool.createMode({
        id: MODE_PICK, cursors: [{ cursor: "pointer" }],
        icons: [{ icon: icon("target.svg"), label: "Pick a target", filter: { activeTools: [TOOL_ID], activeModes: [MODE_PICK] } }],
        ...modeHandlers,
      });
      await OBR.tool.createAction({
        id: ACTION_LOCK, shortcut: "Enter",
        icons: [{ icon: icon("cast.svg"), label: "Cast here (Enter)", filter: { activeTools: [TOOL_ID] } }],
        onClick: () => lock(),
      });
      await OBR.tool.createAction({
        id: ACTION_CANCEL,
        icons: [{ icon: icon("cancel.svg"), label: "Cancel (Esc)", filter: { activeTools: [TOOL_ID] } }],
        onClick: () => userCancel("action"),
      });
    } catch (e) {
      log("aim tool not created", e);
      throw e;
    }
  }

  let offHud = null;
  try {
    offHud = OBR.broadcast.onMessage(CH.LOCAL_HUD, (ev) => {
      const d = ev?.data;
      if (d && typeof d.cmd === "string") hudCommand(d);
    });
  } catch (e) {
    log("HUD channel not open", e);
  }

  function setOwnTokens(ids) {
    // The player's own PC token(s), from their roster entry: public on their screen even
    // before the first heartbeat lists the PC tokens.
    own = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String));
  }

  const ready = Promise.resolve(true); // everything above is set up; the tool waits for the first aim

  async function stop() {
    if (s) await finish(s, { restore: true });
    for (const id of [...shows.keys()]) await clearTemplate(id, { fadeMs: 0 });
    try {
      offHud?.();
    } catch {
      // already off
    }
    if (!made) return;
    made = null;
    for (const [fn, id] of [["removeAction", ACTION_LOCK], ["removeAction", ACTION_CANCEL], ["removeMode", MODE_PLACE], ["removeMode", MODE_PICK], ["remove", TOOL_ID]]) {
      try {
        await OBR.tool[fn](id);
      } catch {
        // not there
      }
    }
  }

  return {
    ready,
    toolReady,
    start,
    cancel,
    lock,
    showTemplate,
    clearTemplate,
    setOwnTokens,
    isAiming: () => !!s,
    current: () => (s ? { id: s.id, mode: s.mode, spec: s.spec, template: s.template, caught: s.caught.slice(), pick: s.pick } : null),
    state: () => (s ? hudState(s) : null),
    stop,
  };
}
