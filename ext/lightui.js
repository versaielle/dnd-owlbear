// The DM's lighting controls, the parts with no Owlbear in them (lights redo,
// docs/lights-redo-spec.md): the right-click 🔥 Light menu (light.html) and the 🔥 Lighting list
// in the GM box (popover.html, lightpanel.js) both build their answers here, so they say the same
// thing. node owlbear/check_lightui.mjs runs them offline.
//
//   lightingOf(sceneMeta)          the scene's {darkness, auto, managed} (missing = lit, auto on, managed)
//   uiCtx({...})                   the ctx fx/lightmeta.js's visionOf/planItem take: the lights
//                                  writer's own (fx/lightwriter.js planCtx: party darkvision, the
//                                  PC rule, the scene's lighting, Smoke's default range) + pcName
//   editFor(change)                the edit writeNow() runs on a token for {light} / {vision}
//   planWrite(item, ctx, change)   the same, pure: {metadata, changed} (the offline checks)
//   describe(item, ctx)            "Ana carries a torch (40 ft)", "Sconce put out — won't relight by itself"
//   lightingRows(items, ctx)       the list's PCs and lit objects
//   screenLine(s), screenWarnings(screens, opts)   the screens heard, and what to do about them
//
// Everything the inputs change goes through lightmeta.js's setLight / setVision, then planItem
// with the writer's ctx, in ONE write (fx/lightwriter.js writeNow): the same pure function on the
// same inputs as the leader's writer, so a tap writes once and the writer's next pass plans
// nothing for that token.
import * as LM from "./fx/lightmeta.js?v=585985a-dc1dbb6";
import { planCtx } from "./fx/lightwriter.js?v=585985a-dc1dbb6";
import { SOURCES } from "./fx/lights.js?v=585985a-dc1dbb6";
import { CARRIER_KEY, LIGHT_KEY, SCENE_LIGHTING_KEY, SMOKE, SPELL_LIGHT_KEY, VISION_KEY } from "./keys.js?v=585985a-dc1dbb6";
import { pcName, tokenLabel } from "./fx/pcs.js?v=585985a-dc1dbb6";

// The scene's (and each map's) darkness, as docs/lights-darkness-spec.md says it: darkness comes
// from light, per point. The 🔥 Lighting list's chips (lightpanel.js) say these.
export const DARKNESS = [
  { value: "lit", icon: "☀", label: "lit", about: "Lit: everyone sees by line of sight; lights only for the look" },
  { value: "dim", icon: "🌒", label: "dim", about: "Dim: everything visible, a little darker away from the lights" },
  { value: "dark", icon: "🌑", label: "dark", about: "Dark: black except within lights and darkvision (grey); PCs' own minis always show" },
];

export const lightingOf = (sceneMeta) => LM.lightingOf(sceneMeta?.[SCENE_LIGHTING_KEY]);
export const rangeDefaultOf = (sceneMeta) => LM.rangeDefaultOf(sceneMeta || {});

const known = (k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(SOURCES, k);
const clone = (m) => JSON.parse(JSON.stringify(m || {}));
export const { LIGHT_KINDS, reachOf, autoKind, effectiveLight, visionOf } = LM;
export const releaseItem = (item, ctx) => LM.release(item, ctx);

// ---- the ctx ----

// What visionOf / planItem need: the lights writer's own planCtx (fx/lightwriter.js) over the
// scene's items (by id, parents included), the scene's and the room's metadata, `party` (the
// room's names) and `pcIds` (the bridge heartbeat's PC ids, when the caller has them), plus
// pcName for what the controls say. `grid`: the scene's ({dpi, ftPerCell}, fx/darkness.js
// readGrid(OBR)), so a map's darkness under a PC is found where it really is (missing = 150 dpi, 5 ft).
export function uiCtx({ byId = new Map(), sceneMeta = {}, roomMeta = {}, party = [], pcIds = null, grid = null } = {}) {
  const c = planCtx([...byId.values()], sceneMeta || {}, roomMeta || {}, { party, pcTokens: pcIds, grid });
  const secret = c.isSecret;
  return {
    ...c, byId,
    pcName: (i) => (c.isPc(i) ? pcName(i, c.party) || tokenLabel(i) : null),
    isSecret: (i) => !c.isPc(i) && secret(i),
  };
}

// ---- one write ----

// The edit for one token after a DM change: {light: kind | "none" | null} and/or {vision:
// {sight?, dark?, seer?}} (null clears an override). Mutates and returns `meta`.
export function applyChange(meta, change = {}) {
  if (change && "light" in change) {
    // A 🔥 tap on the DM's own Smoke torch (Enable Torchlight, never ours) takes it over: its
    // torch keys count as ours from now, so 🔥 None puts it out in Smoke too (not relit as an
    // adopted torch) and a 🔥 kind rewrites them. Its Smoke range is adopted as the reach.
    const on = meta?.[`${SMOKE}/isTorch`] === true && !!meta?.[`${SMOKE}/hasVision`];
    const p = LM.profileOf(meta);
    if (on && p.out.isTorch !== true) {
      p.out.isTorch = true;
      p.out.hasVision = meta[`${SMOKE}/hasVision`];
      meta[VISION_KEY] = p;
    }
    LM.setLight(meta, change.light);
  }
  if (change && "vision" in change) LM.setVision(meta, change.vision);
  return meta;
}
// writeNow()'s edit: `changeOf(item)` -> the change for that token (or null: none).
export const editFor = (changeOf) => (meta, item) => {
  const c = typeof changeOf === "function" ? changeOf(item) : changeOf;
  if (c) applyChange(meta, c);
};

// The same as one writeNow() for one item, pure (the offline checks): {metadata, changed}.
export function planWrite(item, ctx, change = {}) {
  const meta = applyChange(clone(item.metadata), change);
  const planned = LM.planItem({ ...item, metadata: meta }, ctx);
  const out = planned || meta;
  return { metadata: out, changed: LM.stable(out) !== LM.stable(item.metadata || {}) };
}

// Put the new metadata on an Owlbear draft: only the keys that changed (a key another tab
// wrote meanwhile is kept). `before`: the metadata planWrite started from.
export function applyMeta(draft, before, after) {
  draft.metadata = draft.metadata || {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = JSON.stringify(before?.[k]), b = JSON.stringify(after?.[k]);
    if (a === b) continue;
    if (after?.[k] === undefined) delete draft.metadata[k];
    else draft.metadata[k] = clone({ v: after[k] }).v;
  }
}

// ---- what it says ----

const SPELLISH = new Set(["light", "continual_flame", "dancing_lights", "produce_flame"]);
export function lightName(kind) {
  const s = SOURCES[kind];
  if (!s) return String(kind || "a light");
  if (SPELLISH.has(kind)) return s.label;
  const l = s.label.toLowerCase();
  return `${/^[aeiou]/.test(l) ? "an" : "a"} ${l}`;
}
const feet = (kind) => `${reachOf(kind)} ft`;

export function nameOf(item, ctx) {
  return (ctx.pcName?.(item) || tokenLabel(item) || "It").replace(/\.(png|jpe?g|webp|gif|avif|svg)$/i, "").trim() || "It";
}

// One line for the 🔥 menu and the list: what this item's light is now, after a write.
export function describe(item, ctx) {
  const name = nameOf(item, ctx);
  const pc = ctx.isPc(item);
  const hand = item.metadata?.[LIGHT_KEY]?.kind;
  const eff = effectiveLight(item, ctx.lighting);
  const spell = known(item.metadata?.[SPELL_LIGHT_KEY]?.kind) ? item.metadata[SPELL_LIGHT_KEY].kind : null;
  const hidden = !pc && ctx.isSecret?.(item);
  let s;
  if (eff && eff.from !== "spell") {
    s = `${name} ${pc || item.layer === "CHARACTER" ? "carries" : "gives off"} ${lightName(eff.kind)} (${eff.reach} ft)`;
    if (eff.from === "auto") s += " — lit by itself (its name)";
    if (eff.from === "smoke") s += " — Smoke's own torchlight (its range is Smoke's; a 🔥 light makes it ours)";
  } else if (hand === "none") {
    s = pc ? `${name} carries no light` : `${name} put out — won't relight by itself`;
  } else {
    s = pc ? `${name} carries no light` : `${name}: no light`;
  }
  if (spell) s += eff?.from === "spell" ? ` — ✨ ${SOURCES[spell].label} from a spell (${feet(spell)})` : ` (+ ✨ ${SOURCES[spell].label})`;
  if (hidden && eff && LM.isAmbientLight(item, ctx)) s += " — hidden: an ambient light (players see its light, not the prop)";
  else if (hidden && eff) s += " — hidden: players see it once it's shown";
  else if (!pc && item.layer === "CHARACTER" && eff) s += " — players see its light while it's visible";
  if (pc) {
    const v = visionOf(item, ctx);
    if (v.dark > 0) s += ` · darkvision ${v.dark} ft`;
  }
  return s;
}

// ---- the 🔥 Lighting list ----

// {pcs: [...], lit: [...]} for the scene's items: every PC token (roots only: a ring under a mini
// follows its parent) with its sight, darkvision (and the sheet's) and light; every other item with
// a light (the DM's, a spell's, one lit by its name, an adopted Smoke torch), by name.
export function lightingRows(items, ctx) {
  const pcs = [], lit = [];
  for (const i of items || []) {
    if (!i?.id || (i.layer && !["CHARACTER", "PROP", "MOUNT", "ATTACHMENT"].includes(i.layer))) continue;
    if (i.metadata?.[CARRIER_KEY]) continue; // our invisible carrier child: its NPC is listed
    const eff = effectiveLight(i, ctx.lighting);
    const hand = i.metadata?.[LIGHT_KEY]?.kind;
    if (ctx.isPc(i)) {
      if (i.attachedTo && ctx.isPc(ctx.byId?.get?.(i.attachedTo))) continue;
      const dm = i.metadata?.[VISION_KEY]?.dm || {};
      const v = visionOf(i, ctx);
      pcs.push({ id: i.id, name: nameOf(i, ctx), sight: dm.sight ?? null, dark: dm.dark ?? null,
                 sheetDark: ctx.senses(i)?.dark ?? null, seesFt: v.sight, darkFt: v.dark,
                 kind: known(hand) ? hand : hand === "none" ? "none" : "", eff });
    } else if (eff || hand === "none") {
      lit.push({ id: i.id, name: nameOf(i, ctx), kind: known(hand) ? hand : hand === "none" ? "none" : "", eff,
                 auto: eff?.from === "auto", smoke: eff?.from === "smoke", spell: eff?.from === "spell",
                 hidden: !!ctx.isSecret?.(i), layer: i.layer || "" });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { pcs: pcs.sort(byName), lit: lit.sort(byName) };
}

// The items "Release lights to Smoke" gives back: every token we manage (VISION_KEY on it).
export const managed = (items) => (items || []).filter((i) => i?.metadata?.[VISION_KEY] && !i.metadata[CARRIER_KEY]);
// The carriers we made for lit NPCs (fx/lightwriter.js): released scenes don't keep them.
export const carriers = (items) => (items || []).filter((i) => i?.metadata?.[CARRIER_KEY]);

// ---- the screens heard ----

const KIND_ICON = { gm: "🖥", table: "📺", touch: "📱", other: "💻" };

// A dotted version ("2.306.0") as numbers, or null (a git build like "313fc9a").
const ver = (b) => (/^\d+(\.\d+)+$/.test(String(b || "")) ? String(b).split(".").map(Number) : null);
export function olderBuild(b, ref) {
  const x = ver(b), y = ver(ref);
  if (!x || !y) return false;
  for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] || 0) !== (y[k] || 0)) return (x[k] || 0) < (y[k] || 0);
  return false;
}

// "📺 Cast Receiver · table · 2.306.0 · 🔥 3 · 🌑 1"
export function screenLine(s) {
  const parts = [`${KIND_ICON[s.kind] || "💻"} ${s.name || "?"}`, s.kind || "?", s.build || "?"];
  const l = s.lights;
  if (l && typeof l === "object") {
    if (l.error) parts.push(`⚠ lights: ${l.error}`);
    else if (l.on === false) parts.push("🔥 off");
    else {
      if (Number.isFinite(l.flames)) parts.push(`🔥 ${l.flames}`);
      if (Number.isFinite(l.rings)) parts.push(`🌑 ${l.rings}`);
    }
    if (l.leader || l.state === "leader") parts.push("✍ writes");
    else if (l.state === "blocked") parts.push("✍ blocked");
  }
  return parts.join(" · ");
}

const isCast = (s) => s.role !== "GM" && (s.kind === "table" || /cast|receiver|chromecast|tv/i.test(s.name || ""));

// The build every screen should be on: `ref` (the build this box runs: the newest the DM loaded),
// else this GM tab's own (the list's first), else the one most screens have. "dev" (the copy the
// panel serves) and "owlbear-only" say nothing.
const devBuild = (b) => !b || b === "dev" || b === "owlbear-only";
export function wantedBuild(list, ref = "") {
  if (!devBuild(ref)) return ref;
  if (list[0] && !devBuild(list[0].build)) return list[0].build;
  const n = new Map();
  for (const s of list) if (!devBuild(s.build)) n.set(s.build, (n.get(s.build) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

// What's wrong, as the DM would fix it: a screen on an older build than wantedBuild() (versions
// compared; git builds just differ), or one that says nothing about lights (its HELLO is from
// before the redo) while another does; a screen whose lights failed; no table screen.
export function screenWarnings(screens, { ref = "" } = {}) {
  const list = (screens || []).filter((s) => s && typeof s === "object");
  const out = [];
  const want = wantedBuild(list, ref);
  const anyLights = list.some((s) => s.lights && typeof s.lights === "object");
  for (const s of list) {
    const fix = isCast(s) ? "restart the cast" : "reload it";
    const name = s.name || s.kind || "A screen";
    const b = s.build;
    const stale = !devBuild(b) && want && b !== want && (ver(b) && ver(want) ? olderBuild(b, want) : true);
    if (stale) out.push(`${name} is on ${ver(b) && ver(want) ? "an older" : "another"} build (${b}; this GM tab has ${want}) — ${fix}`);
    else if (anyLights && s.lights === undefined) out.push(`${name} is on an older build${b ? ` (${b})` : ""} — ${fix}`);
    else if (s.lights?.error) out.push(`${name}: the lights failed (${s.lights.error}) — ${fix}`);
  }
  if (!list.some((s) => s.kind === "table")) {
    out.push("No table screen heard — is the projector's cast running (and marked 📺 table on the panel)?");
  }
  return out;
}
