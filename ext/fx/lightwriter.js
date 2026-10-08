// The one writer of Smoke & Spectre's keys (docs/lights-redo-spec.md). On ONE GM screen (the
// leader) it watches the scene and brings every token in line with fx/lightmeta.js planItem():
// the WHO marks (fx/pcs.js), the DM's Smoke edits adopted, the Smoke keys written, and the
// carriers made or removed. The 🔥 menu and the spell lights write through the same planItem()
// at once (writeNow below): the same pure function gives the same answer, so nothing fights.
//
// A CARRIER is the child item that carries a lit goblin's torchlight for Smoke (a token on the
// CHARACTER layer never gets isTorch: Smoke fixes a light's type when it makes it, and a PC
// marked later would stay a torch on every open screen). It's a tiny invisible shape, attached
// to the goblin (it moves and deletes with it), made by a GM (so every player's Smoke lights it),
// with CARRIER_KEY {of} and Smoke's torch keys; only while the goblin is lit, shown and doesn't
// see by itself. Its id is CARRIER_PREFIX + the goblin's id, so every writer names it alike.

import { CARRIER_KEY, PARTY_KEY, PARTY_SENSES_KEY, SCENE_LIGHTING_KEY, SMOKE, WHO_KEY } from "../keys.js?v=585985a-dc1dbb6";
import { LIGHT_PART, SMOKE_DEFAULT_KEYS, effectiveLight, isSecret, lightingOf, planItem, rangeDefaultOf, stable, visionOf, writeLightPart } from "./lightmeta.js?v=585985a-dc1dbb6";
import { isPcToken, nameKey, pcName, whoMarksFor } from "./pcs.js?v=585985a-dc1dbb6";
import { darknessCtx, readGrid } from "./darkness.js?v=585985a-dc1dbb6";

const K = (name) => `${SMOKE}/${name}`;
export const CARRIER_PREFIX = "dnd-npc-carrier-";
export const CARRIER_LAYER = "ATTACHMENT"; // one of Smoke's vision layers (ItemFilters:2)
export const SETTLE_MS = 1000; // Smoke's sliders write on every drag step: adopt after the last
export const HEARD_MS = 70000; // a GM screen's HELLO (every 30 s) counts this long
export const WARM_MS = 35000; // after this long every GM screen has said hello at least once
export const RECHECK_MS = 15000; // a blocked or standing-by writer looks again this often
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const metaOf = (x) => (isObj(x?.metadata) ? x.metadata : isObj(x) ? x : {});

// The room's party names (PARTY_KEY) and darkvision (PARTY_SENSES_KEY: {nameKey: {dark}}).
export function partyOf(roomMeta) {
  const v = roomMeta?.[PARTY_KEY];
  return Array.isArray(v) ? v.filter((n) => typeof n === "string" && n.trim()) : [];
}
export function sensesOf(roomMeta) {
  const v = roomMeta?.[PARTY_SENSES_KEY];
  const out = {};
  if (!isObj(v)) return out;
  for (const [k, s] of Object.entries(v)) {
    const d = Number(s?.dark);
    if (k && Number.isFinite(d) && d >= 0) out[nameKey(k)] = { dark: Math.round(d) };
  }
  return out;
}

// The ctx planItem() takes, for a scene: `items` (all of them, for the attachment chains),
// `scene` and `room` (their metadata, or objects holding it), ctx {pcTokens (a Set, an array or a
// function: the bridge heartbeat's PC ids), party?, senses? (overrides of the room's), grid?
// ({dpi, ftPerCell}: fx/darkness.js readGrid; else 150 dpi, 5 ft)}. It carries the darkness too
// (fx/darkness.js darknessCtx: regions, the public lights, pxPerFt): a seer's Smoke range depends
// on where it stands (docs/lights-darkness-spec.md).
export function planCtx(items, scene, room, ctx = {}) {
  const sm = metaOf(scene), rm = metaOf(room);
  const party = Array.isArray(ctx.party) && ctx.party.length ? ctx.party : partyOf(rm);
  const table = isObj(ctx.senses) ? ctx.senses : sensesOf(rm);
  const pcIds = ctx.pcTokens ?? ctx.pcIds ?? null;
  const byId = new Map((items || []).filter((i) => i?.id).map((i) => [i.id, i]));
  const isPc = (it) => isPcToken(it, { party, pcIds });
  return {
    party, byId, isPc,
    lighting: lightingOf(sm[SCENE_LIGHTING_KEY]),
    rangeDefault: rangeDefaultOf(sm),
    smokeDefaults: Object.fromEntries(Object.entries(SMOKE_DEFAULT_KEYS).map(([k, d]) => [k, sm[K(d)] || null]).filter(([, v]) => v)),
    senses: (it) => {
      const n = pcName(it, party);
      return n ? table[nameKey(n)] ?? null : null;
    },
    isSecret: (it) => isSecret(it, { parentOf: (id) => byId.get(id), isPc: (id) => { const x = byId.get(id); return x ? isPc(x) : false; } }),
    ...darknessCtx(items, sm, { isPc, grid: ctx.grid, lighting: sm[SCENE_LIGHTING_KEY] }),
  };
}

export const carrierId = (parentId) => `${CARRIER_PREFIX}${parentId}`;
export function carrierMeta(parentId, reach) {
  return { [CARRIER_KEY]: { of: parentId }, [K("hasVision")]: true, [K("isTorch")]: true,
           [K("visionRange")]: String(reach), [K("visionDark")]: "0" };
}
const CARRIER_KEYS = [CARRIER_KEY, K("hasVision"), K("isTorch"), K("visionRange"), K("visionDark")];

// What to write in this scene: {update: [{id, metadata}], add: [carrier specs], remove: [ids],
// notes: [strings]}. Pure. A pass over its own result plans nothing.
// `r1`: {update: ids, remove: ids}, the part of the plan that is R1 (see planR1).
export function planScene(items, scene, room, ctx = {}) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i?.id);
  // Released to Smoke (SCENE_LIGHTING_KEY managed false): no Smoke keys and no WHO marks; only a
  // carrier left over (the Release button deletes them) goes: it would light Smoke's fog.
  if (!lightingOf(metaOf(scene)[SCENE_LIGHTING_KEY]).managed) {
    const remove = list.filter((i) => i.metadata?.[CARRIER_KEY]).map((i) => i.id);
    return { update: [], add: [], remove, notes: [], released: true, r1: { update: [], remove } };
  }
  const party = Array.isArray(ctx.party) && ctx.party.length ? ctx.party : partyOf(metaOf(room));
  const pcIds = ctx.pcTokens ?? ctx.pcIds ?? null;
  const marks = new Map(whoMarksFor(list, pcIds, party).map((m) => [m.id, m.who]));
  const view = list.map((i) => (marks.has(i.id) ? { ...i, metadata: { ...(i.metadata || {}), [WHO_KEY]: marks.get(i.id) } } : i));
  const c = planCtx(view, scene, room, { ...ctx, party });
  const update = [], notes = [];
  const after = new Map(view.map((i) => [i.id, i]));
  for (const i of view) {
    if (i.metadata?.[CARRIER_KEY]) continue;
    const next = planItem(i, c, notes);
    if (next) {
      update.push({ id: i.id, metadata: next });
      after.set(i.id, { ...i, metadata: next });
    } else if (marks.has(i.id)) update.push({ id: i.id, metadata: i.metadata });
  }
  // The carriers: one per lit, shown, non-seer token on the CHARACTER layer.
  const want = new Map(); // parent id -> reach
  for (const i of after.values()) {
    if (i.layer !== "CHARACTER" || i.metadata?.[CARRIER_KEY]) continue;
    const l = effectiveLight(i, c.lighting);
    if (!l || !l.reach || visionOf(i, c).seer || c.isSecret(i)) continue;
    want.set(i.id, l.reach);
  }
  const keep = new Set(), remove = [], add = [];
  for (const k of view.filter((i) => i.metadata?.[CARRIER_KEY])) {
    const parent = k.attachedTo;
    if (!want.has(parent) || k.metadata[CARRIER_KEY]?.of !== parent || keep.has(parent)) {
      remove.push(k.id);
      continue;
    }
    keep.add(parent);
    const m = carrierMeta(parent, want.get(parent));
    if (CARRIER_KEYS.some((key) => stable(k.metadata[key]) !== stable(m[key]))) update.push({ id: k.id, metadata: { ...k.metadata, ...m } });
  }
  for (const [pid, reach] of want) {
    if (keep.has(pid)) continue;
    const p = after.get(pid);
    const id = carrierId(pid); // the writer deletes `remove` before it adds, so a reused id is free
    add.push({ id, attachedTo: pid, layer: CARRIER_LAYER, position: { x: p.position?.x ?? 0, y: p.position?.y ?? 0 },
               name: "dnd-npc light", visible: false, locked: true, disableHit: true, metadata: carrierMeta(pid, reach) });
  }
  // R1: carriers whose NPC is hidden or gone; Smoke keys coming off a hidden non-PC CHARACTER
  // token or anything hanging from one.
  const r1 = { update: [], remove: [] };
  for (const id of remove) {
    const k = c.byId.get(id), p = k && c.byId.get(k.attachedTo);
    if (!p || c.isSecret(p)) r1.remove.push(id);
  }
  for (const u of update) {
    const i = c.byId.get(u.id);
    if (!i || i.metadata?.[CARRIER_KEY] || c.isPc(i) || !c.isSecret(i) || !(i.layer === "CHARACTER" || hangsFromHiddenNpc(i, c))) continue;
    if (SMOKE_KEYS.some((k) => i.metadata?.[k] !== undefined && u.metadata?.[k] === undefined)) r1.update.push(u.id);
  }
  return { update, add, remove, notes, released: false, r1 };
}

const SMOKE_KEYS = ["hasVision", "isTorch", "visionRange", "visionDark"].map(K);
function hangsFromHiddenNpc(item, c) {
  let i = item;
  for (let n = 0; n < 8; n++) {
    const own = Array.isArray(i?.disableAttachmentBehavior) && i.disableAttachmentBehavior.includes("VISIBLE");
    if (!i || i.attachedTo == null || own) return false;
    i = c.byId.get(i.attachedTo);
    if (!i) return false;
    if (i.layer === "CHARACTER" && i.visible === false && !c.isPc(i)) return true;
  }
  return true;
}

// Only the R1 part of planScene's plan (no adds, no other updates): what every GM copy that may
// write does whatever its gate says (blocked by an old build, waiting, standing by, backing
// off), so a hidden goblin's light never shows through the fog. Removing is idempotent: two
// tabs doing it at once remove the same keys/items, and then plan nothing.
export function planR1(items, scene, room, ctx = {}) {
  const p = planScene(items, scene, room, ctx);
  const u = new Set(p.r1.update), r = new Set(p.r1.remove);
  return { update: p.update.filter((x) => u.has(x.id)), add: [], remove: p.remove.filter((id) => r.has(id)), notes: [],
           released: p.released, r1: p.r1 };
}

// ---- writing now (the 🔥 menu, the spell lights) ----

// Read the scene, change the given tokens with `edit(meta, item)` (setLight / setSpellLight /
// setVision on a copy of the token's metadata; null = no change, only bring them in line), then
// planItem() each with the writer's own ctx (planCtx: the party's darkvision, the PC rule, the
// scene's lighting and Smoke's default range), and write the ones that changed in ONE
// updateItems. A token planScene() would give a WHO mark gets it here too (not in a scene
// released to Smoke), so the leader's next pass plans nothing for it. opts: {pcTokens, party}.
// Returns {ok, wrote: [ids], notes, released}.
export async function writeNow(OBR, ids, edit, opts = {}) {
  const want = new Set(ids || []);
  if (!want.size) return { ok: true, wrote: [], notes: [], released: false };
  const [items, sm, rm, grid] = await Promise.all([
    OBR.scene.items.getItems(), Promise.resolve(OBR.scene.getMetadata?.()).catch(() => ({})),
    Promise.resolve(OBR.room?.getMetadata?.()).catch(() => ({})), readGrid(OBR),
  ]);
  const released = !lightingOf(metaOf(sm)[SCENE_LIGHTING_KEY]).managed;
  const party = Array.isArray(opts.party) && opts.party.length ? opts.party : partyOf(metaOf(rm));
  const pcIds = opts.pcTokens ?? opts.pcIds ?? null;
  const marks = new Map(released ? [] : whoMarksFor(items.filter((i) => want.has(i.id)), pcIds, party).map((m) => [m.id, m.who]));
  const view = items.map((i) => (marks.has(i.id) ? { ...i, metadata: { ...(i.metadata || {}), [WHO_KEY]: marks.get(i.id) } } : i));
  const c = planCtx(view, sm || {}, rm || {}, { ...opts, party, grid });
  const notes = [];
  const plan = (i) => {
    const before = i.metadata || {};
    const meta = JSON.parse(JSON.stringify(before));
    if (marks.has(i.id) && !meta[WHO_KEY]) meta[WHO_KEY] = marks.get(i.id);
    edit?.(meta, i);
    return planItem({ ...i, metadata: meta }, c, notes) || (stable(meta) === stable(before) ? null : meta);
  };
  const due = items.filter((i) => want.has(i.id) && plan(i));
  if (!due.length) return { ok: true, wrote: [], notes, released };
  await OBR.scene.items.updateItems(due.map((i) => i.id), (drafts) => {
    for (const d of drafts) {
      d.metadata = d.metadata || {};
      const next = plan(d); // the draft as it is now
      if (!next) continue;
      if (next[WHO_KEY] && !d.metadata[WHO_KEY]) d.metadata[WHO_KEY] = next[WHO_KEY];
      writeLightPart(d.metadata, next);
    }
  });
  return { ok: true, wrote: due.map((i) => i.id), notes, released };
}

// ---- the leader GM screen ----

// Which copy writes: among the GM copies that say `writer` in their HELLO and don't only relay,
// the lowest connection id (on a tab with two copies, the Pages one).
const rank = (h) => `${h.conn}|${h.host === "pages" ? 0 : 1}`;
const nameOf = (h) => `${h.name || "a GM screen"} (${h.kind || "gm"}, ${h.host || "?"} build ${h.build || "?"})`;

// createWriter(api, ctx, opts) -> {start, stop, status, kick, heard, hello}
// api: {OBR, buildShape}. ctx: background.js's (role, conn, host, build, relayOnly, pcTokens,
// party, log). opts: {timers, hello() (send this copy's HELLO now), settleMs}.
export function createWriter(api, ctx, opts = {}) {
  const O = api?.OBR ?? api;
  const T = opts.timers || {
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now(),
  };
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const heardMap = new Map(); // "conn|host" -> {conn, host, role, build, writer, relay, name, kind, at}
  let running = false, sceneReady = false, timer = null, busy = false, again = false;
  let startedAt = 0, gmConns = null, unsubs = [];
  let failures = 0, holdUntil = 0, lastAnswer = -Infinity;
  const st = { state: "off", why: "", wrote: 0, writes: 0, at: 0, error: "", notes: [], released: false };
  const log = (t) => { try { ctx.log?.(`lights: ${t}`); } catch { /* quiet */ } };

  function others() {
    const now = T.now();
    for (const [k, h] of heardMap) if (now - h.at > HEARD_MS) heardMap.delete(k);
    return [...heardMap.values()]; // a screen that left the room is dropped by onParty
  }

  // May this copy write now? {ok, state, why}
  function gate() {
    if (!running) return { ok: false, state: "off", why: "not started" };
    if (ctx.role !== "GM") return { ok: false, state: "off", why: "not a GM screen" };
    if (ctx.relayOnly) return { ok: false, state: "off", why: "this copy only relays (the Pages copy writes)" };
    const heard = others();
    const old = heard.filter((h) => !h.writer);
    if (old.length) return { ok: false, state: "blocked", why: `reload ${old.map(nameOf).join(", ")}: an older build is open, so no light writes until it reloads` };
    const mine = String(ctx.build ?? "");
    const diff = heard.filter((h) => !h.relay && String(h.writer) !== mine);
    if (diff.length) return { ok: false, state: "blocked", why: `GM screens on different builds (this one ${mine}): reload ${diff.map(nameOf).join(", ")} or this tab` };
    const me = { conn: String(ctx.conn ?? ""), host: ctx.host };
    const lead = [me, ...heard.filter((h) => !h.relay)].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0))[0];
    if (lead.conn !== me.conn || lead.host !== me.host) return { ok: false, state: "standby", why: `${nameOf(lead)} writes the lights` };
    if (!warm()) return { ok: false, state: "waiting", why: "listening for the other GM screens first" };
    if (T.now() < holdUntil) return { ok: false, state: "backoff", why: st.error || "waiting after a failed write" };
    return { ok: true, state: "leader", why: "" };
  }
  function warm() {
    if (T.now() - startedAt >= WARM_MS) return true;
    if (!gmConns) return false;
    const heard = new Set(others().map((h) => h.conn));
    for (const c of gmConns) if (c !== String(ctx.conn) && !heard.has(c)) return false;
    return true;
  }

  function schedule(ms = settleMs) {
    if (!running) return;
    if (timer) T.clearTimeout(timer);
    timer = T.setTimeout(() => {
      timer = null;
      pass().catch((e) => log(`pass failed: ${e?.message || e}`));
    }, ms);
  }

  // Per token: the light part we last wrote there, when, and how many times in a row that same
  // write was needed again soon after (something keeps undoing it: an old build's guard). That
  // token waits longer each time, so it's never a write -> change -> write loop; the others and
  // every R1 removal go on.
  const streaks = new Map(); // id -> {sig, at, n, until}
  const sigOf = (m) => stable(Object.fromEntries(LIGHT_PART.map((k) => [k, m?.[k]])));

  function later(g) {
    if (g.state === "waiting" || g.state === "backoff") schedule(Math.max(1000, Math.min(5000, holdUntil - T.now())));
    // Blocked or standing by: look again now and then (an old screen's hello runs out after
    // 70 s; the leader may leave): the gate itself reads nothing.
    else if (g.state === "blocked" || g.state === "standby") schedule(RECHECK_MS);
  }

  async function pass() {
    if (!running || !sceneReady) return { wrote: 0 };
    if (busy) {
      again = true;
      return { wrote: 0 };
    }
    const g = gate();
    st.state = g.state;
    st.why = g.why;
    if (g.state === "off") return { wrote: 0 };
    // Not the leader (or not yet, or backing off): only R1 (planR1), on every GM copy that writes.
    const r1Only = !g.ok;
    busy = true;
    try {
      const [items, sm, rm, grid] = await Promise.all([O.scene.items.getItems(), O.scene.getMetadata(), O.room.getMetadata(), readGrid(O)]);
      const plan = (r1Only ? planR1 : planScene)(items, sm || {}, rm || {}, { pcTokens: ctx.pcTokens, party: ctx.party, grid });
      st.released = !!plan.released;
      if (plan.notes.length) {
        st.notes = [...plan.notes, ...st.notes].slice(0, 6);
        for (const t of plan.notes) log(t);
      }
      const now = T.now();
      for (const [id, s] of streaks) if (now - s.at > 120000 && now >= s.until) streaks.delete(id);
      const r1u = new Set(plan.r1?.update || []);
      const held = (id) => !r1u.has(id) && (streaks.get(id)?.until ?? 0) > now;
      const update = plan.update.filter((u) => !held(u.id));
      const add = plan.add.filter((s) => !held(s.attachedTo));
      const remove = plan.remove;
      const waits = [...plan.update.filter((u) => held(u.id)).map((u) => u.id), ...plan.add.filter((s) => held(s.attachedTo)).map((s) => s.attachedTo)];
      if (waits.length) schedule(Math.max(500, Math.min(...waits.map((id) => streaks.get(id).until)) - now + 50));
      const n = update.length + add.length + remove.length;
      if (!n) {
        if (!waits.length) failures = 0;
        if (r1Only) later(g);
        return { wrote: 0 };
      }
      const g2 = gate();
      if (!running || g2.state === "off" || (!r1Only && !g2.ok)) return { wrote: 0 };
      if (remove.length) await O.scene.items.deleteItems(remove);
      if (update.length) {
        const by = new Map(update.map((u) => [u.id, u]));
        const c = planCtx(items, sm || {}, rm || {}, { pcTokens: ctx.pcTokens, party: ctx.party, grid });
        await O.scene.items.updateItems([...by.keys()], (drafts) => {
          for (const d of drafts) {
            const u = by.get(d.id);
            if (!u) continue;
            if (d.metadata?.[CARRIER_KEY]) {
              Object.assign(d.metadata, u.metadata);
              continue;
            }
            if (u.metadata?.[WHO_KEY] && !d.metadata?.[WHO_KEY]) d.metadata[WHO_KEY] = u.metadata[WHO_KEY];
            const next = planItem(d, c); // the draft as it is now (an edit since the read is kept)
            if (next) writeLightPart(d.metadata, next);
          }
        });
      }
      if (add.length) await O.scene.items.addItems(add.map((s) => buildCarrier(api, s)));
      const t = T.now();
      let stuck = null;
      for (const u of update) {
        const sig = sigOf(u.metadata), s = streaks.get(u.id);
        const k = s && s.sig === sig && t - s.at < 5000 ? s.n + 1 : 0;
        const hold = k >= 3 && !r1u.has(u.id);
        streaks.set(u.id, { sig, at: t, n: k, until: hold ? t + Math.min(60000, 2000 * 2 ** (k - 3)) : 0 });
        if (hold) stuck = { id: u.id, k };
      }
      failures = 0;
      st.wrote = n;
      st.writes++;
      st.at = t;
      if (stuck) {
        const i = items.find((x) => x.id === stuck.id);
        st.error = `${i?.text?.plainText || i?.name || stuck.id}: the same light keeps changing back (${stuck.k} writes in a row): waiting`;
        log(st.error);
      } else if (t >= holdUntil) st.error = "";
      log(`${r1Only ? "R1 only: " : ""}wrote ${update.length} token(s), +${add.length}/-${remove.length} carrier(s)`);
      if (r1Only) later(g);
      return { wrote: n };
    } catch (e) {
      failures++;
      holdUntil = T.now() + Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
      st.error = String(e?.message || e);
      log(`write failed: ${st.error}`);
      schedule(holdUntil - T.now());
      return { wrote: 0, error: true };
    } finally {
      busy = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }

  // A HELLO from another copy (background.js passes every one): GM copies only.
  function heard(msg, ev) {
    if (!msg || msg.role !== "GM" || ev?.local) return;
    const conn = String(ev?.connectionId ?? "");
    if (!conn || (conn === String(ctx.conn) && msg.host === ctx.host)) return;
    const k = `${conn}|${msg.host || "?"}`;
    const was = heardMap.get(k);
    heardMap.set(k, { conn, host: msg.host || "?", build: String(msg.build ?? ""), writer: msg.writer ? String(msg.writer) : null,
                      relay: !!msg.relay, name: String(msg.name || ""), kind: String(msg.kind || ""), at: T.now() });
    // A new screen asks who's here: answer at once, so it doesn't wait for our next hello.
    if (Array.isArray(msg.need) && msg.need.includes("writer") && T.now() - lastAnswer > 3000) {
      lastAnswer = T.now();
      try { opts.hello?.(); } catch { /* next hello */ }
    }
    if (!was || was.writer !== heardMap.get(k).writer || was.relay !== heardMap.get(k).relay) schedule(0);
  }

  function onParty(players) {
    const s = new Set();
    for (const p of players || []) if (p?.role === "GM" && p.connectionId != null) s.add(String(p.connectionId));
    gmConns = s;
    for (const [k, h] of heardMap) if (h.conn !== String(ctx.conn) && !s.has(h.conn)) heardMap.delete(k); // gone
    schedule(0);
  }

  function start() {
    if (running) return;
    running = true;
    startedAt = T.now();
    const sub = (f) => { try { const u = f(); if (typeof u === "function") unsubs.push(u); } catch (e) { log(`can't watch: ${e?.message || e}`); } };
    sub(() => O.scene.items.onChange(() => schedule()));
    sub(() => O.scene.onMetadataChange?.(() => schedule()));
    sub(() => O.room?.onMetadataChange?.(() => schedule()));
    sub(() => O.party?.onChange?.(onParty));
    sub(() => O.scene.onReadyChange((r) => {
      sceneReady = !!r;
      if (r) schedule(settleMs);
    }));
    Promise.resolve(O.party?.getPlayers?.()).then((p) => { if (Array.isArray(p)) onParty(p); }, () => {});
    Promise.resolve(O.scene.isReady()).then((r) => {
      sceneReady = !!r;
      if (r) schedule(settleMs);
    }, () => {});
    // Wake once every screen had time to say hello (the gate waits that long at most).
    T.setTimeout(() => schedule(0), WARM_MS + 100);
  }

  function stop() {
    running = false;
    if (timer) T.clearTimeout(timer);
    timer = null;
    for (const u of unsubs) { try { u(); } catch { /* gone */ } }
    unsubs = [];
    st.state = "off";
  }

  function status() {
    if (running) {
      const g = gate();
      st.state = g.state;
      st.why = g.why;
    }
    return { ...st, notes: [...st.notes], heard: others().map((h) => ({ conn: h.conn, host: h.host, build: h.build, writer: h.writer, relay: h.relay, name: h.name })) };
  }

  return { start, stop, status, kick: () => schedule(0), heard, pass, gate };
}

// The carrier as an Owlbear item (api.buildShape from the SDK): a 2 px circle, no fill, no
// outline, hidden, locked, not clickable.
export function buildCarrier(api, s) {
  const b = api.buildShape?.();
  if (!b) return { type: "SHAPE", shapeType: "CIRCLE", width: 2, height: 2, rotation: 0, scale: { x: 1, y: 1 }, zIndex: 0,
                   style: { fillColor: "#000000", fillOpacity: 0, strokeColor: "#000000", strokeOpacity: 0, strokeWidth: 0, strokeDash: [] },
                   ...s };
  let x = b.shapeType("CIRCLE").width(2).height(2).fillOpacity(0).strokeOpacity(0).strokeWidth(0)
    .position(s.position).attachedTo(s.attachedTo).layer(s.layer).locked(true).disableHit(true).visible(false)
    .name(s.name).metadata(s.metadata);
  if (typeof x.id === "function") x = x.id(s.id);
  const item = x.build();
  item.id = s.id;
  return item;
}
