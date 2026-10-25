// The party's sight for the vision layer (docs/vision-layer-spec.md section 4; the contract is
// docs/vision-layer-b2b3.md section 4): one LOCAL PRIMARY light per PC, on every screen that draws
// (the GM tabs, the laptop, the projector's Cast receiver, the phones). Owlbear's own fog cuts
// round each light as far as its attenuation reaches and stops at the local walls (fog/walls.js),
// so every screen shows the same reveal from the same snapshot: nothing here depends on who owns
// a token. fog.js creates it and calls sync() on each pass while 🌫 Our fog is on, and clear()
// when it goes off: while the switch is off this file adds nothing.
//
//   SIGHT_Z                 the lights' z-index (0)
//   SIGHT_FALLOFF           the lights' falloff (0: a hard edge, as Smoke draws a PC's sight)
//   SOURCE_RADIUS           the default sourceRadius (0: Owlbear's fast light path, and a blocking
//                           wall stops an attached token with its middle on the wall line)
//   sightReachFt(item, vctx)   how far a PC sees (feet). With every 2024 switch off: the number Smoke
//                           gets from fx/lightmeta.js smokeFor for a seer. With them (vctx.rules, below):
//                           truesight, the weather, heavy zones, Blinded and blindsight too
//   darkReachFt(item, vctx)  🌑: how far a PC sees by itself, feet (the explored memory's dark rule):
//                           max(SELF_SIGHT, its darkvision, its own light's reach); with 🦇 Senses on,
//                           its truesight and blindsight too; its own light only while it has no cone
//   senseLightsFt(item, vctx)  while 🧱 Senses through fog is on: [{sense: "true" | "blind", ft}], the
//                           extra lights of a PC with truesight or blindsight (else [])
//   senseFt(item, vctx)     while 🦇 Senses is on: {truesight, blind}, a PC's feet of each (the DM's
//                           override first), the circles the 2024 darkness paints for it; else 0 each
//   sightAttached(ctx)      whether this screen attaches the lights: always, except on a GM screen
//                           with ctx.gmPass "B" (the default), where they stand alone (section 8)
//   sightPlan(snap, {attached, sourceRadius})   -> [{key, of, attached, position, attenuation,
//                           sourceRadius, sig}]: one per PC in snap.pcs (pure); a PC whose middle
//                           is on no map (between maps, past an edge) sees SELF_SIGHT at most. While
//                           🧱 is on, a PC with truesight or blindsight also gets one light per sense
//                           (key "<token id>|true" or "|blind", z its layer: fog/walls.js LAYERS)
//   planSig(plan)           what a sync compares: the specs as they'd be drawn (an attached
//                           light's position is left out: it rides with its token)
//   createSight(api, ctx)   -> {sync(snap), clear(), forget(), status()}
//
// THE 2024 RULES (docs/vision-layer-2024.md section 7, "How far a PC sees"). fog.js puts in vctx the
// scene's switches (vctx.rules: rules2024.js effectiveRules), its weather (vctx.weather: weatherOf),
// the zones (vctx.zones: fog/zoneread.js zonesOf), outdoorAt(point) and the grid's dpi. sightReachFt, in
// order:
//   1. the reach above (on 🌑 ground, with 🦇 Senses on, truesight joins darkvision in the maximum);
//   2. 🌦 Weather on, the PC's centre on a map marked outdoor: at most the weather's limit (fog 100,
//      200 or 300 ft; rain and snow reach past LIT_SIGHT, so they change nothing);
//   3. ☁ Obscured on, the PC's centre inside a heavy zone: SELF_SIGHT at most (5 ft from its centre);
//   4. 🦇 Senses on, the PC Blinded (COND_KEY holds "blinded"): SELF_SIGHT at most;
//   5. 🦇 Senses on: at least its blindsight.
// A PC's truesight and blindsight: visionOf's (the DM's override first, once the lights carry them),
// else the party file's (vctx.senses(item), rules2024.js sensesOf). A missing switch is off, so with
// every switch off (or no vctx.rules at all) everything here is exactly as before the 2024 rules.
//
// A light ATTACHED to its PC (players, the projector, a GM screen on pass "A") rides with the
// token, so a drag or a nudge changes nothing here. Its VISIBLE and SCALE behaviours are off: a
// hidden PC still sees (spike S3), and a big mini doesn't stretch its reach. On a GM screen in
// pass "B" the light is STANDALONE at the token's middle and is moved by an update on the pass
// after the token moves: nothing is attached there, so no wall can stop the DM's drags, arrow
// keys or 🧭 Bring PCs. A light is made again (a delete and an add) only when its sig changes,
// which is whether it's attached and to what; a new reach (a 🌑 PC walking towards a torch), a
// new sourceRadius, a standalone light's new place or a light read back with another falloff (an
// earlier page's, drawn with Owlbear's default) is one update.
//
// ctx (fog.js): host, isGm, gmPass, log(text); optionally sightSourceRadius (a number, or a
// function returning one, read on every sync: scene px, default SOURCE_RADIUS). api: {OBR,
// buildLight}. Each sync makes at most one deleteItems, one addItems and one updateItems, and none
// at all when the plan is the same as the last one drawn. It reads its own items back (tagged
// FOG_LOCAL_KEY {kind: "sight", key, sig, host}) only on its first sync after a clear(), a
// forget() (the scene closed: Owlbear dropped them) or a failed write; fog.js retries a failure.

import { COND_KEY, FOG_LOCAL_KEY } from "../keys.js?v=9a30147";
import { LIT_SIGHT, SELF_SIGHT, effectiveLight, visionOf } from "../fx/lightmeta.js?v=9a30147";
import { farLight, lightsFor } from "../fx/darkness.js?v=9a30147";
import { MAX_SENSE_FT, effectiveRules, sensesOf } from "../rules2024.js?v=9a30147";
import { centreOf, mapAt } from "../views.js?v=9a30147";
import { layerOf } from "./walls.js?v=9a30147";
import { insideZone } from "./zoneread.js?v=9a30147";

export const SIGHT_Z = 0;
// A hard edge: Smoke's default for a seer (BSConstants FALLOFFDEFAULT "0"). buildLight's own
// default, 1, fades the fog out across the whole reach and leaves a grey film over everything a PC
// sees, even on a lit scene (found live 2026-10-12).
export const SIGHT_FALLOFF = 0;
export const SOURCE_RADIUS = 0;
const KIND = "sight";
// The light rides with its PC; nothing of the PC's own visibility or size carries over.
const DETACHED = ["VISIBLE", "SCALE"];

const finite = (...xs) => xs.every((x) => typeof x === "number" && Number.isFinite(x));
const r2 = (x) => Math.round(x * 100) / 100 + 0;
const safe = (f, dflt = null, onError = null) => { try { return f(); } catch (e) { try { onError?.(e); } catch { /* a broken onError never changes the fallback */ } return dflt; } };

// ---- the 2024 inputs in vctx (fog.js buildSnapshot) ----

const blinded = (item) => { const c = item?.metadata?.[COND_KEY]; return Array.isArray(c) && c.includes("blinded"); };
// A PC's truesight and blindsight, feet: visionOf's when it gives them (the DM's override first), else
// the party file's.
function sensesFor(item, ctx, v) {
  const sheet = sensesOf(safe(() => ctx?.senses?.(item)));
  const pick = (k) => (finite(v?.[k]) && v[k] >= 0 ? Math.min(MAX_SENSE_FT, v[k]) : sheet[k]);
  return { truesight: pick("truesight"), blind: pick("blind") };
}
const centreIn = (item, ctx) => safe(() => centreOf(item, finite(ctx?.dpi) && ctx.dpi > 0 ? ctx.dpi : 150));
const outdoorAt = (ctx, c) => !!c && !!safe(() => ctx?.outdoorAt?.(c), false);
const weatherLimit = (ctx) => (finite(ctx?.weather?.limitFt) && ctx.weather.limitFt >= 0 ? ctx.weather.limitFt : null);
// The heavy zones (vctx.zones) holding point c; magic: true / false for only those, null for any.
const inHeavy = (ctx, c, magic = null) => !!c && (Array.isArray(ctx?.zones) ? ctx.zones : [])
  .some((z) => z?.level === "heavy" && (magic == null || !!z.magic === magic) && insideZone(c, z));

// ---- the plan (pure) ----

// How far this PC sees, in feet. ☀/🌒 where it stands: its sight (everything in line of sight, or
// the DM's limit). 🌑: the farthest of its darkvision, its own light and the far edge of the
// farthest public light ON ITS OWN MAP (fx/darkness.js lightsFor: a light on another map is behind
// that map's edge wall, so it never counts, with the 2024 switches on or off), at least SELF_SIGHT,
// at most LIT_SIGHT. vctx: fx/lightwriter.js planCtx (the darkness regions, the lights with their
// maps, the map rectangles, pxPerFt, senses, lighting), and fog.js's 2024 inputs (rules, weather,
// zones, outdoorAt, dpi): the steps in the header. onError(e): told when its own light throws (it
// then counts 0, as it always did); visionOf and the public lights throw to the caller.
export function sightReachFt(item, vctx = {}, onError = null) {
  const ctx = vctx || {};
  const v = visionOf(item, ctx);
  const rules = effectiveRules(ctx.rules);
  const s = rules.senses ? sensesFor(item, ctx, v) : null;
  let reach;
  if (v.where !== "dark") reach = v.sight;
  else {
    const light = safe(() => effectiveLight(item, ctx.lighting), null, onError);
    const own = light && light.reach > 0 ? light.reach : 0;
    reach = Math.min(LIT_SIGHT, Math.max(SELF_SIGHT, v.dark, own, farLight(item, lightsFor(item, ctx), ctx.pxPerFt), s ? s.truesight : 0));
  }
  if (!rules.weather && !rules.zones && !rules.senses) return reach; // every switch off: as before the 2024 rules
  const c = centreIn(item, ctx);
  const limit = weatherLimit(ctx);
  if (rules.weather && limit != null && outdoorAt(ctx, c)) reach = Math.min(reach, limit);
  if (rules.zones && inHeavy(ctx, c)) reach = Math.min(reach, SELF_SIGHT);
  if (rules.senses && blinded(item)) reach = Math.min(reach, SELF_SIGHT);
  if (s) reach = Math.max(reach, s.blind);
  return reach;
}

// 🌑: how far a PC sees by itself (the explored memory's dark rule, fog/seen.js until the integration
// re-exports this one). Its own light counts only while it has no cone (vctx.lights' entry for this
// token, which carries the cone only while 🔦 and 💡 are both on): a coned light lights only its cone,
// which the memory's dark rule takes from the public lights. onError(e): told when visionOf or
// effectiveLight throws (that part then counts 0, as it always did).
export function darkReachFt(item, vctx = {}, onError = null) {
  const ctx = vctx || {};
  const v = safe(() => visionOf(item, ctx), null, onError);
  const rules = effectiveRules(ctx.rules);
  const light = safe(() => effectiveLight(item, ctx.lighting), null, onError);
  let own = light && finite(light.reach) && light.reach > 0 ? light.reach : 0;
  if (own && rules.cones) {
    const mine = (Array.isArray(ctx.lights) ? ctx.lights : []).find((l) => l && l.id === item?.id);
    if (mine?.cone != null) own = 0;
  }
  const dark = v && finite(v.dark) && v.dark > 0 ? v.dark : 0;
  const s = rules.senses ? sensesFor(item, ctx, v) : { truesight: 0, blind: 0 };
  return Math.max(SELF_SIGHT, dark, own, s.truesight, s.blind);
}

// While 🧱 Senses through fog is on (so 🦇 too): the extra lights of a PC with truesight or blindsight,
// each on its own layer (fog/walls.js LAYERS: truesight passes magic darkness, blindsight every zone).
// Truesight is sight: none while Blinded, none from inside a heavy zone that isn't magic (fog), and
// outdoors no farther than the weather lets anyone see. Blindsight isn't: none of those stop it.
export function senseLightsFt(item, vctx = {}) {
  const ctx = vctx || {};
  const rules = effectiveRules(ctx.rules);
  if (!rules.pierce) return [];
  const v = safe(() => visionOf(item, ctx), null);
  const s = sensesFor(item, ctx, v);
  const out = [];
  const c = centreIn(item, ctx);
  if (s.truesight > 0 && !blinded(item) && !(rules.zones && inHeavy(ctx, c, false))) {
    const limit = weatherLimit(ctx);
    const ft = rules.weather && limit != null && outdoorAt(ctx, c) ? Math.min(s.truesight, limit) : s.truesight;
    if (ft > 0) out.push({ sense: "true", ft });
  }
  if (s.blind > 0) out.push({ sense: "blind", ft: s.blind });
  return out;
}

// While 🦇 Senses is on: a PC's truesight and blindsight, feet (fx/lighting.js darkInputs paints a circle
// of each; fog/cover.js keeps a hidden creature's cover off them). 🦇 off: none.
export function senseFt(item, vctx = {}) {
  const ctx = vctx || {};
  if (!effectiveRules(ctx.rules).senses) return { truesight: 0, blind: 0 };
  return sensesFor(item, ctx, safe(() => visionOf(item, ctx), null));
}

// Attached everywhere but a GM screen on pass "B" (contract section 8; "B" when unset).
export const sightAttached = (ctx = {}) => !(ctx?.isGm && (ctx?.gmPass ?? "B") === "B");

const sigOf = (attached, of) => `${attached ? "a" : "s"}|${of}`;
const radiusOf = (x) => (finite(x) && x >= 0 ? r2(x) : SOURCE_RADIUS);

// One light per PC in snap.pcs that has a place on the scene: keyed by its token, at its middle,
// reaching sightReachFt in scene px (snap.grid.pxPerFt), to 0.01 px. A PC whose middle is on none
// of the scene's maps (snap.rects: parked off the map, in the gap 🏘 Set up interiors leaves
// between buildings, dragged past an edge) reaches SELF_SIGHT at most: on a lit scene it would
// otherwise light LIT_SIGHT from outside every map's edge ring (review 2026-10-12). A scene with no
// map at all has nothing to be off, so no cap there.
export function sightPlan(snap, { attached = true, sourceRadius = SOURCE_RADIUS } = {}) {
  const pcs = Array.isArray(snap?.pcs) ? snap.pcs : [];
  const dpi = snap?.grid?.dpi;
  const pxPerFt = snap?.grid?.pxPerFt;
  const sr = radiusOf(sourceRadius);
  const rects = Array.isArray(snap?.rects) ? snap.rects : [];
  const out = [];
  const seen = new Set();
  const vctx = snap?.vctx || {};
  const rules = effectiveRules(vctx.rules);
  for (const item of pcs) {
    const of = item?.id;
    if (of == null || seen.has(of)) continue;
    const c = centreOf(item, dpi);
    if (!c || !finite(c.x, c.y)) continue;
    seen.add(of);
    let ft = safe(() => sightReachFt(item, vctx), 0);
    const offMap = rects.length && !mapAt(c, rects);
    if (offMap && finite(ft)) ft = Math.min(ft, SELF_SIGHT);
    const attenuation = finite(ft, pxPerFt) && ft > 0 && pxPerFt > 0 ? r2(ft * pxPerFt) : 0;
    const position = { x: r2(c.x), y: r2(c.y) };
    out.push({ key: of, of, attached: !!attached, position, attenuation, sourceRadius: sr, sig: sigOf(!!attached, of) });
    // 🧱 Senses through fog: one more light per sense, on its own layer (none for a PC off every map)
    if (!rules.pierce || offMap || !(pxPerFt > 0)) continue;
    for (const { sense, ft: sf } of safe(() => senseLightsFt(item, vctx), []) || []) {
      if (!finite(sf) || !(sf > 0)) continue;
      out.push({ key: `${of}|${sense}`, of, attached: !!attached, position: { ...position }, attenuation: r2(sf * pxPerFt),
        sourceRadius: sr, z: layerOf(sense, rules), sig: `${sigOf(!!attached, of)}|${sense}` });
    }
  }
  return out;
}

// The parts of a spec a sync acts on. An attached light's position is its token's business.
const drawnSig = (s) => [s.key, s.sig, s.attenuation, s.sourceRadius, s.attached ? "" : `${s.position.x},${s.position.y}`].join("|");
export const planSig = (plan) => (plan || []).map(drawnSig).join(";");

// ---- drawing ----

export function createSight(api = {}, ctx = {}) {
  const host = ctx.host ?? "";
  const log = (text) => { try { ctx.log?.(`sight: ${text}`); } catch { /* nowhere to say it */ } };
  const OBR = () => api.OBR;
  const ours = (i) => i?.metadata?.[FOG_LOCAL_KEY]?.kind === KIND && i.metadata[FOG_LOCAL_KEY].host === host;
  const sourceRadius = () => {
    const v = typeof ctx.sightSourceRadius === "function" ? safe(() => ctx.sightSourceRadius()) : ctx.sightSourceRadius;
    return radiusOf(v ?? SOURCE_RADIUS);
  };

  // key -> {id, sig, attached, attenuation, sourceRadius, falloff, position}: what this screen has drawn.
  let drawn = new Map();
  let applied = null; // planSig of the last plan drawn in full
  let sweep = true; // read our items back before the next sync
  let lastError = null;

  function item(s) {
    const a = api.buildLight()
      .name("dnd-npc sight")
      .position(s.position);
    if (s.attached) a.attachedTo(s.of).disableAttachmentBehavior(DETACHED);
    return a
      .sourceRadius(s.sourceRadius)
      .attenuationRadius(s.attenuation)
      .falloff(SIGHT_FALLOFF)
      .lightType("PRIMARY")
      .zIndex(finite(s.z) ? s.z : SIGHT_Z)
      .locked(true)
      .disableHit(true)
      .metadata({ [FOG_LOCAL_KEY]: { kind: KIND, key: s.key, sig: s.sig, host } })
      .build();
  }

  // What's on the scene now: our tagged items, one per key (any spare is deleted).
  async function readBack(del) {
    const local = await OBR().scene.local.getItems(ours);
    const next = new Map();
    for (const i of local || []) {
      const t = i.metadata[FOG_LOCAL_KEY];
      if (t.key == null || next.has(t.key)) { del.push(i.id); continue; }
      next.set(t.key, { id: i.id, sig: t.sig, attached: !!i.attachedTo, attenuation: radiusOf(i.attenuationRadius),
        sourceRadius: radiusOf(i.sourceRadius), falloff: finite(i.falloff) ? i.falloff : null,
        position: i.position ? { x: r2(i.position.x), y: r2(i.position.y) } : null });
    }
    drawn = next;
  }

  async function doSync(snap) {
    const plan = sightPlan(snap, { attached: sightAttached(ctx), sourceRadius: sourceRadius() });
    const psig = planSig(plan);
    if (!sweep && psig === applied) return { added: 0, removed: 0, updated: 0, failed: false, error: null };
    const del = [];
    if (sweep) {
      await readBack(del); // (a read that fails throws: nothing written, fog.js tries again)
      sweep = false;
    }
    const want = new Map(plan.map((s) => [s.key, s]));
    const add = [];
    const upd = new Map(); // id -> spec
    for (const [key, rec] of drawn) {
      const s = want.get(key);
      if (!s || s.sig !== rec.sig) { del.push(rec.id); drawn.delete(key); }
    }
    for (const s of plan) {
      const rec = drawn.get(s.key);
      if (!rec) { add.push(s); continue; }
      const moved = !s.attached && (!rec.position || rec.position.x !== s.position.x || rec.position.y !== s.position.y);
      if (moved || rec.attenuation !== s.attenuation || rec.sourceRadius !== s.sourceRadius || rec.falloff !== SIGHT_FALLOFF) {
        upd.set(rec.id, s);
      }
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
        const built = add.map(item);
        await OBR().scene.local.addItems(built);
        add.forEach((s, k) => drawn.set(s.key, { id: built[k].id, sig: s.sig, attached: s.attached, attenuation: s.attenuation,
          sourceRadius: s.sourceRadius, falloff: SIGHT_FALLOFF, position: s.position }));
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
            if (!s) continue;
            d.attenuationRadius = s.attenuation;
            d.sourceRadius = s.sourceRadius;
            d.falloff = SIGHT_FALLOFF;
            if (!s.attached) d.position = { ...s.position };
          }
        });
        for (const s of upd.values()) {
          const rec = drawn.get(s.key);
          if (rec) Object.assign(rec, { attenuation: s.attenuation, sourceRadius: s.sourceRadius, falloff: SIGHT_FALLOFF, position: s.position });
        }
        done.updated = upd.size;
      } catch (e) {
        for (const id of upd.keys()) for (const [key, rec] of drawn) if (rec.id === id) drawn.delete(key);
        fail("update", e);
      }
    }
    // A failure: forget what we think we drew and read it back on the next sync (fog.js calls it
    // again after RETRY_MS), so strays are swept and nothing is drawn twice.
    if (failed) {
      sweep = true;
      applied = null;
    } else {
      applied = psig;
      lastError = null;
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
      lastError = String(e?.message || e);
      log(`sync failed: ${lastError}`);
      return { added: 0, removed: 0, updated: 0, failed: true, error: lastError };
    }));
  }

  // Everything of ours (this host's sight lights) comes off, and is forgotten.
  function clear() {
    return queue(async () => {
      const ids = new Set([...drawn.values()].map((r) => r.id));
      drawn = new Map();
      applied = null;
      sweep = true;
      try {
        for (const i of (await OBR().scene.local.getItems(ours)) || []) ids.add(i.id);
      } catch { /* the scene is closed: its local items went with it */ }
      if (!ids.size) return { removed: 0 };
      try {
        await OBR().scene.local.deleteItems([...ids]);
        return { removed: ids.size };
      } catch (e) {
        lastError = String(e?.message || e);
        return { removed: 0, error: lastError };
      }
    });
  }

  // The scene closed (Owlbear dropped every local item with it): forget, write nothing.
  function forget() {
    drawn = new Map();
    applied = null;
    sweep = true;
  }

  function status() {
    let standalone = 0;
    for (const r of drawn.values()) if (!r.attached) standalone++;
    return { lights: drawn.size, standalone, error: lastError };
  }

  return { sync, clear, forget, status };
}
