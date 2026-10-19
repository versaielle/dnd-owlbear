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
//   sightReachFt(item, vctx)   how far a PC sees (feet): the number Smoke gets from
//                           fx/lightmeta.js smokeFor for a seer today
//   sightAttached(ctx)      whether this screen attaches the lights: always, except on a GM screen
//                           with ctx.gmPass "B" (the default), where they stand alone (section 8)
//   sightPlan(snap, {attached, sourceRadius})   -> [{key, of, attached, position, attenuation,
//                           sourceRadius, sig}]: one per PC in snap.pcs (pure); a PC whose middle
//                           is on no map (between maps, past an edge) sees SELF_SIGHT at most
//   planSig(plan)           what a sync compares: the specs as they'd be drawn (an attached
//                           light's position is left out: it rides with its token)
//   createSight(api, ctx)   -> {sync(snap), clear(), forget(), status()}
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

import { FOG_LOCAL_KEY } from "../keys.js?v=2094e30";
import { LIT_SIGHT, SELF_SIGHT, effectiveLight, visionOf } from "../fx/lightmeta.js?v=2094e30";
import { farLight, lightsFor } from "../fx/darkness.js?v=2094e30";
import { centreOf, mapAt } from "../views.js?v=2094e30";

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
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };

// ---- the plan (pure) ----

// How far this PC sees, in feet. ☀/🌒 where it stands: its sight (everything in line of sight, or
// the DM's limit). 🌑: the farthest of its darkvision, its own light and the far edge of the
// farthest public light ON ITS OWN MAP (fx/darkness.js lightsFor: a light on another map is behind
// that map's edge wall, so it never counts), at least SELF_SIGHT, at most LIT_SIGHT. vctx:
// fx/lightwriter.js planCtx (the darkness regions, the lights with their maps, the map rectangles,
// pxPerFt, senses, lighting).
export function sightReachFt(item, vctx = {}) {
  const v = visionOf(item, vctx || {});
  if (v.where !== "dark") return v.sight;
  const light = safe(() => effectiveLight(item, vctx?.lighting));
  const reach = light && light.reach > 0 ? light.reach : 0;
  return Math.min(LIT_SIGHT, Math.max(SELF_SIGHT, v.dark, reach, farLight(item, lightsFor(item, vctx || {}), vctx?.pxPerFt)));
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
  for (const item of pcs) {
    const of = item?.id;
    if (of == null || seen.has(of)) continue;
    const c = centreOf(item, dpi);
    if (!c || !finite(c.x, c.y)) continue;
    seen.add(of);
    let ft = safe(() => sightReachFt(item, snap?.vctx || {}), 0);
    if (rects.length && !mapAt(c, rects) && finite(ft)) ft = Math.min(ft, SELF_SIGHT);
    const attenuation = finite(ft, pxPerFt) && ft > 0 && pxPerFt > 0 ? r2(ft * pxPerFt) : 0;
    out.push({ key: of, of, attached: !!attached, position: { x: r2(c.x), y: r2(c.y) }, attenuation,
      sourceRadius: sr, sig: sigOf(!!attached, of) });
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
      .zIndex(SIGHT_Z)
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
