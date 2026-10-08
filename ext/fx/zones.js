// Living zones (Entangle's vines, Create Bonfire's flames, Spirit Guardians' motes...).
//
// Each zone is ONE shared item, written only by the bridge: a dashed outline (a CIRCLE or a
// RECTANGLE on the PROP layer, under the tokens and the fog) tagged with "dnd-npc/zone". The
// panel sends the full list of zones that should exist; sync() adds the missing ones and removes
// the ones no longer listed, and never moves one that's already there (so a DM's drag of a
// Moonbeam stays put). Every screen then decorates each outline it may see with a local
// ATTACHMENT effect: the zone's look, clipped to the outline, following it when it's dragged or
// when the outline follows its caster's token. A player's screen skips hidden outlines.
import { ZONE_LOOKS, colors } from "./archetypes.js?v=b6b85c2-d73ac97";
import { finite, footprint, gridOf, placeRect } from "./place.js?v=b6b85c2-d73ac97";
import { customUniforms, fillUniforms, shaderFor } from "./shaders.js?v=b6b85c2-d73ac97";

export const ZONE_KEY = "dnd-npc/zone"; // on the shared outline: {id, zid, spell, look, color, power, seed, sig}
export const DECO_KEY = "dnd-npc/fx-zone"; // on a local decoration: {outline, sig}
export const OUTLINE_Z = 4e12; // above every auto z-index (those are timestamps) on PROP
export const FADE_IN = 500, FADE_OUT = 600;
// An outline is marked "ending" this long before the bridge deletes it, so every screen has
// time to fade its decoration out first: the 600 ms fade, plus the broadcast reaching the screen
// and a margin (a screen starts the fade the moment it sees the mark, without its usual wait).
export const ENDING_MS = 1000;
const SETTLE_MS = 150; // other outline changes: reconcile once they've settled
const LITE_EVERY = 200; // lite zones are static; their fade moves at 5 Hz

// Owlbear's shape builder for zoneItem() calls that don't bring one: the engine sets it once it
// has the SDK (createFx), so the frozen 3-argument zoneItem(spec, grid, footprints) builds a
// real item (with the ids and timestamps Owlbear's builders add) on a page that runs the engine.
let defaultBuildShape = null;
export function setZoneBuilder(fn) {
  defaultBuildShape = typeof fn === "function" ? fn : null;
}

// What makes two specs "the same zone" (a change means: replace the outline).
export function zoneSig(spec) {
  return [spec.look, spec.color, spec.shape, spec.size_ft, spec.rot || 0, spec.hidden ? 1 : 0, spec.movable ? 1 : 0,
    spec.follow || "", spec.fit || "", spec.grow_by_caster ? 1 : 0].join("|");
}

function validSpec(s) {
  return s && typeof s === "object" && s.id != null && ZONE_LOOKS.includes(s.look);
}

let idn = 0;
const plainId = () => `dnd-npc-zone-${Date.now().toString(36)}-${(++idn).toString(36)}`;

// The shared outline for one ZoneSpec (spec 7.5). `grid` is {dpi, multiplier} (or place.gridOf's
// shape), `footprints` maps token ids to {x, y, w, h} (for a zone that follows a token, grows by
// its caster, or fits round a target). `opts.buildShape` is Owlbear's builder; without one it's
// the engine's (setZoneBuilder). With neither (no engine on this page) a plain item comes back,
// for the offline checks ONLY: it lacks the user ids and timestamps Owlbear's builders add, so
// it must never be written to the scene. The bridge writes zones with fx.zones.sync() anyway.
// null when the zone can't be placed.
export function zoneItem(spec, grid, footprints = {}, opts = {}) {
  if (!validSpec(spec)) return null;
  if (typeof opts === "function") opts = { buildShape: opts };
  const buildShape = opts?.buildShape || defaultBuildShape;
  const G = grid?.pxPerFt ? grid : gridOf(grid?.dpi, grid?.multiplier ?? grid?.ftPerCell);
  const fp = spec.follow ? footprints[spec.follow] : null;
  const origin = fp ? { x: fp.x, y: fp.y } : spec.origin;
  if (!origin || !finite(origin.x, origin.y)) return null;
  const col = colors(spec.color, opts?.palette);
  let type = "CIRCLE", w, h, position = { x: origin.x, y: origin.y }, rotation = 0;
  if (spec.fit === "token" && fp) {
    const r = 0.6 * Math.max(fp.w, fp.h);
    w = h = 2 * r;
  } else if (spec.shape === "square") {
    type = "RECTANGLE";
    w = h = Math.max(1, (spec.size_ft || 5) * G.pxPerFt);
    rotation = spec.rot || 0;
    position = placeRect(w, h, origin, rotation);
  } else {
    let r = Math.max(1, (spec.size_ft || 5) * G.pxPerFt);
    if (spec.grow_by_caster && fp) r += Math.max(fp.w, fp.h) / 2;
    w = h = 2 * r;
  }
  if (!finite(w, h, position.x, position.y)) return null;
  const movable = !!spec.movable;
  const style = {
    fillColor: col.hexA, fillOpacity: 0.08,
    strokeColor: col.hexA, strokeOpacity: 0.5,
    strokeWidth: Math.max(2, G.dpi * 0.03), strokeDash: [G.dpi * 0.12, G.dpi * 0.08],
  };
  const meta = {
    [ZONE_KEY]: { id: String(spec.id), zid: spec.zid ?? null, spell: spec.spell ?? "", look: spec.look,
      color: spec.color ?? "arcane", power: typeof spec.power === "number" ? spec.power : 1,
      seed: typeof spec.seed === "number" ? spec.seed : 1, sig: zoneSig(spec) },
  };
  const name = `✨ ${spec.label || spec.spell || "zone"}`;
  const follow = spec.follow && fp ? spec.follow : null;
  const behaviours = ["VISIBLE", "ROTATION", "SCALE", "COPY"];
  if (buildShape) {
    let b = buildShape()
      .shapeType(type).width(w).height(h).position(position).rotation(rotation)
      .style(style)
      .layer("PROP").zIndex(OUTLINE_Z).disableAutoZIndex(true)
      .locked(!movable).disableHit(!movable).visible(!spec.hidden)
      .name(name).metadata(meta);
    if (follow) b = b.attachedTo(follow).disableAttachmentBehavior(behaviours);
    return b.build();
  }
  const item = {
    id: plainId(), type: "SHAPE", name, visible: !spec.hidden, locked: !movable, zIndex: OUTLINE_Z,
    position, rotation, scale: { x: 1, y: 1 }, metadata: meta, layer: "PROP", disableHit: !movable,
    disableAutoZIndex: true, width: w, height: h, shapeType: type, style,
  };
  if (follow) Object.assign(item, { attachedTo: follow, disableAttachmentBehavior: behaviours });
  return item;
}

// The zone half of the engine. env (from engine.js): {getApi, role(), tier(), style(), settings(),
// palette(), clock, track(entry), untrack(id), remove(id), warn}.
export function createZones(env) {
  const decos = new Map(); // outline id -> {id, sig, fadingOut}
  const ending = new Set(); // outlines this bridge marked and will delete
  let syncing = Promise.resolve();
  let unsubs = [];
  let debounce = null;
  let active = false; // decorating: from start() until stop()

  async function doSync(specs) {
    const api = await env.getApi();
    const OBR = api.OBR;
    const list = (Array.isArray(specs) ? specs : []).filter(validSpec);
    const want = new Map(list.map((s) => [String(s.id), s]));
    const have = await OBR.scene.items.getItems((i) => !!i.metadata?.[ZONE_KEY]);
    const kept = new Set(), fadeOut = [], removeNow = [];
    for (const o of have) {
      const m = o.metadata[ZONE_KEY] || {};
      const s = want.get(String(m.id));
      if (m.ending) {
        if (!ending.has(o.id)) removeNow.push(o.id); // left over from an earlier bridge
        continue;
      }
      if (s && m.sig === zoneSig(s) && !kept.has(String(m.id))) { kept.add(String(m.id)); continue; }
      fadeOut.push(o.id);
    }
    const add = [];
    const missing = list.filter((s) => !kept.has(String(s.id)));
    if (missing.length) {
      const dpi = await OBR.scene.grid.getDpi();
      const scale = await OBR.scene.grid.getScale();
      const G = gridOf(dpi, scale?.parsed?.multiplier);
      const ids = [...new Set(missing.flatMap((s) => (s.follow ? [s.follow] : [])))];
      const tokens = ids.length ? await OBR.scene.items.getItems(ids) : [];
      const feet = {};
      for (const t of tokens) feet[t.id] = footprint(t, dpi) || (t.position ? { x: t.position.x, y: t.position.y, w: dpi, h: dpi } : null);
      const seen = new Set();
      for (const s of missing) {
        if (seen.has(String(s.id))) continue;
        seen.add(String(s.id));
        const item = zoneItem(s, G, feet, { buildShape: api.buildShape, palette: env.palette() });
        if (item) add.push(item);
        else env.warn(`fx: zone ${s.id} could not be placed`);
      }
    }
    if (fadeOut.length) {
      const now = env.clock.wall();
      await OBR.scene.items.updateItems(fadeOut, (items) => {
        for (const i of items) i.metadata[ZONE_KEY] = { ...i.metadata[ZONE_KEY], ending: now };
      });
      fadeOut.forEach((id) => ending.add(id));
      env.clock.setTimeout(() => {
        OBR.scene.items.deleteItems(fadeOut).catch((e) => env.warn("fx: zone delete failed", e))
          .finally(() => fadeOut.forEach((id) => ending.delete(id)));
      }, ENDING_MS);
    }
    if (removeNow.length) await OBR.scene.items.deleteItems(removeNow);
    if (add.length) await OBR.scene.items.addItems(add);
    return { added: add.length, removed: fadeOut.length + removeNow.length };
  }

  // Bridge only: make the shared outlines match `specs` (the FULL list). Calls run one at a time.
  function sync(specs) {
    const run = syncing.then(() => doSync(specs));
    syncing = run.catch((e) => { env.warn("fx: zone sync failed", e); });
    return run.catch(() => ({ added: 0, removed: 0, error: true }));
  }

  function decoOn() {
    const s = env.settings();
    return active && s.fx !== false && s.zones !== false && env.style() === "shader" && env.tier() !== "off";
  }

  function decoItem(api, o, m, tier, dpi) {
    const sksl = shaderFor(`zone:${m.look}`, tier);
    const decl = customUniforms(sksl);
    const col = colors(m.color, env.palette());
    const circle = o.shapeType === "CIRCLE";
    const base = {
      progress: 0, colA: col.colA, colB: col.colB, seed: (Number(m.seed) || 1) % 97, power: Number(m.power) || 1,
      ofs: circle ? { x: -(o.width || 0) / 2, y: -(o.height || 0) / 2 } : { x: 0, y: 0 },
      shape: circle ? 0 : 1, cell: dpi, density: tier === "lite" ? 0.7 : 1,
    };
    const item = api.buildEffect()
      .effectType("ATTACHMENT")
      .attachedTo(o.id)
      .sksl(sksl)
      .uniforms(fillUniforms(decl, { ...base, fade: 0 }, env.warn))
      .position(o.position).rotation(o.rotation || 0).scale(o.scale || { x: 1, y: 1 })
      .layer("PROP").zIndex((o.zIndex || OUTLINE_Z) + 1).disableAutoZIndex(true)
      .locked(true).disableHit(true)
      .disableAttachmentBehavior(["COPY"])
      .name("dnd-npc zone look")
      .metadata({ [DECO_KEY]: { outline: o.id } })
      .build();
    return { item, decl, base };
  }

  function fadeEntry(id, item, decl, base, from, to, ms, tier, onDone) {
    const t0 = env.clock.now();
    return {
      id, item, kind: "zone", ticking: true, added: true, every: tier === "lite" ? LITE_EVERY : 0, last: 0,
      frame(draft, now) {
        const k = Math.min(1, Math.max(0, (now - t0) / ms));
        draft.uniforms = fillUniforms(decl, { ...base, fade: from + (to - from) * k });
        if (k >= 1) onDone();
      },
    };
  }

  async function doReconcile(items) {
    const api = await env.getApi();
    const OBR = api.OBR;
    const all = items || (await OBR.scene.items.getItems((i) => !!i.metadata?.[ZONE_KEY]));
    const gm = env.role() === "GM";
    const tier = env.tier();
    const desired = new Map();
    if (decoOn()) {
      for (const o of all) {
        const m = o.metadata?.[ZONE_KEY];
        if (!m || o.type !== "SHAPE" || !ZONE_LOOKS.includes(m.look)) continue;
        if (!gm && o.visible === false) continue;
        desired.set(o.id, { o, m, sig: `${m.look}|${m.color}|${tier}|${o.shapeType}|${o.width}x${o.height}`, ending: !!m.ending });
      }
    }
    const del = [];
    for (const [oid, d] of decos) {
      const w = desired.get(oid);
      if (!w || w.sig !== d.sig) {
        del.push(d.id);
        decos.delete(oid);
        env.untrack(d.id);
      }
    }
    const add = [];
    let dpi = null;
    for (const [oid, w] of desired) {
      const d = decos.get(oid);
      if (d) {
        if (w.ending && !d.fadingOut) {
          d.fadingOut = true;
          env.track(fadeEntry(d.id, d.item, d.decl, d.base, 1, 0, FADE_OUT, tier, () => env.untrack(d.id)));
        }
        continue;
      }
      if (w.ending) continue;
      if (dpi == null) dpi = await OBR.scene.grid.getDpi();
      const built = decoItem(api, w.o, w.m, tier, dpi);
      const rec = { id: built.item.id, item: built.item, decl: built.decl, base: built.base, sig: w.sig, fadingOut: false };
      decos.set(oid, rec);
      add.push(rec);
    }
    if (del.length) await OBR.scene.local.deleteItems(del).catch((e) => env.warn("fx: zone look delete failed", e));
    if (add.length) {
      try {
        await OBR.scene.local.addItems(add.map((r) => r.item));
        for (const r of add) {
          env.track(fadeEntry(r.id, r.item, r.decl, r.base, 0, 1, FADE_IN, tier, () => env.untrack(r.id)));
        }
      } catch (e) {
        // try again on the next change
        for (const [oid, d] of decos) if (add.includes(d)) decos.delete(oid);
        env.warn("fx: zone look add failed", e);
      }
    }
    return { added: add.length, removed: del.length };
  }

  // Reconciles (and clears) run one at a time, so a clear can't slip in while an add is on its way.
  let reconciling = Promise.resolve();
  function queue(job) {
    const run = reconciling.then(job);
    reconciling = run.catch((e) => env.warn("fx: zone reconcile failed", e));
    return run.catch(() => ({ added: 0, removed: 0, error: true }));
  }

  // Every screen: make the local decorations match the outlines this role may see (none before
  // start() or after stop()).
  function reconcile(items) {
    return queue(() => doReconcile(items));
  }

  // An outline this screen decorates was just marked ending: fade it now, not after the settle.
  const newlyEnding = (items) => (Array.isArray(items) ? items : [])
    .some((i) => i?.metadata?.[ZONE_KEY]?.ending && decos.has(i.id) && !decos.get(i.id).fadingOut);

  let starts = 0; // a stop() during a start() that's still loading wins
  // Every screen that draws: decorate the zones, and keep doing it as outlines come and go.
  async function start() {
    const run = ++starts;
    const api = await env.getApi();
    if (run !== starts) return;
    const OBR = api.OBR;
    unsubscribe();
    active = true;
    // Every decoration is made afresh (after any reconcile still on its way): forget the ones of
    // an earlier start, and delete those and any left by an earlier copy of this page.
    await queue(async () => {
      for (const d of decos.values()) env.untrack(d.id);
      decos.clear();
      try {
        const old = await OBR.scene.local.getItems((i) => !!i.metadata?.[DECO_KEY]);
        if (old.length) await OBR.scene.local.deleteItems(old.map((i) => i.id));
      } catch (e) { /* the scene isn't ready yet */ }
    });
    if (run !== starts) return;
    unsubs.push(OBR.scene.items.onChange((items) => {
      if (debounce) env.clock.clearTimeout(debounce);
      debounce = null;
      if (newlyEnding(items)) { reconcile(items); return; }
      debounce = env.clock.setTimeout(() => { debounce = null; reconcile(items); }, SETTLE_MS);
    }));
    unsubs.push(OBR.scene.onReadyChange((ready) => {
      if (ready) reconcile();
      else { for (const d of decos.values()) env.untrack(d.id); decos.clear(); }
    }));
    if (await OBR.scene.isReady()) await reconcile();
  }

  function unsubscribe() {
    for (const u of unsubs) { try { u(); } catch (e) { /* already gone */ } }
    unsubs = [];
    if (debounce) env.clock.clearTimeout(debounce);
    debounce = null;
  }

  // Stop decorating here: no more scene subscription, and the decorations come off. Nothing
  // brings them back (a change, new settings) until start() runs again.
  function stop() {
    starts++;
    active = false;
    unsubscribe();
    if (decos.size) clear();
  }

  // Every decoration off this screen (settings turned zones off, or the engine is cleared).
  function clear() {
    return queue(async () => {
      const ids = [...decos.values()].map((d) => d.id);
      for (const id of ids) env.untrack(id);
      decos.clear();
      if (!ids.length) return { added: 0, removed: 0 };
      const api = await env.getApi();
      await api.OBR.scene.local.deleteItems(ids).catch((e) => env.warn("fx: zone look delete failed", e));
      return { added: 0, removed: ids.length };
    });
  }

  return { sync, reconcile, start, stop, clear, active: () => active, decorations: () => new Map(decos) };
}
