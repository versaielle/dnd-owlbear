// The lights and the darkvision on a token, as pure functions (docs/lights-redo-spec.md): no
// Owlbear import, so the offline checks load it too. Every writer (the leader GM screen's
// fx/lightwriter.js, the 🔥 Light menu, the spell lights in fx/lightjobs.js) calls planItem() on
// the same inputs and so writes the same answer: they can't fight, and the order of the DM's
// actions never matters.
//
// The INPUTS, all on the token itself (they move, copy and delete with it):
//   LIGHT_KEY {kind}          the DM's light; {kind: "none"} = the DM put it out (a tombstone:
//                             no auto light, no adopted Smoke torch; a spell light still shows)
//   SPELL_LIGHT_KEY {kind, magic}  a spell's light (fx/lightjobs.js)
//   VISION_KEY {dm, out}      dm: the DM's overrides {sight?, dark?, seer?} (feet; from the 🔥
//                             Lighting list, or adopted from an edit in Smoke's own panel);
//                             out: the Smoke keys we last wrote, and their values. `out` is the
//                             ONLY history: it tells a DM's edit in Smoke from our own write,
//                             and which keys are ours to remove.
//   + is it a PC (fx/pcs.js, one rule), is it secret (hidden, not a PC), the party's darkvision
//     (room PARTY_SENSES_KEY), the scene's lighting (SCENE_LIGHTING_KEY), Smoke's default range.
// The OUTPUT: Smoke & Spectre's keys, a pure function of the inputs (smokeFor):
//   a SEER (a PC, or a token the DM gave Smoke vision): hasVision, visionRange = the farthest it
//     sees (own sight, darkvision, its light), visionDark "0": Smoke reveals the fog and never
//     draws its grey ring; we draw the darkvision band ourselves (fx/lighting.js). Never isTorch.
//   a lit, public, non-seer token NOT on the CHARACTER layer (a sconce, a brazier): a Smoke torch.
//   anything else: nothing (a lit goblin's light rides on a child carrier: fx/lightwriter.js).
// Smoke reads ranges as strings ("40") in the grid's units (feet on a 5 ft grid); compare them as
// strings. A missing visionDark leaves a stale ring in Smoke: we write "0", never delete it while
// the token is ours.

import { BUBBLES_NAME_KEY, CARRIER_KEY, LIGHT_BASE_KEY, LIGHT_KEY, SMOKE, SPELL_LIGHT_KEY, VISION_KEY } from "../keys.js?v=585985a-dc1dbb6";
import { SOURCES } from "./lights.js?v=585985a-dc1dbb6";
import { farLight, regionAt } from "./darkness.js?v=585985a-dc1dbb6";

const K = (name) => `${SMOKE}/${name}`;
// The Smoke keys we write (and so may have to remove), by their short names.
export const MANAGED = ["hasVision", "isTorch", "visionRange", "visionDark"];
export const LIGHT_KINDS = Object.keys(SOURCES);
export const LIT_SIGHT = 1000; // a lit scene: everyone sees everything in colour
export const SELF_SIGHT = 5; // 🌑 with no light or darkvision: Smoke still uncovers the PC's own square
export const DEFAULT_RANGE = 30; // Smoke's own default sight (no scene default set)
// (unmarked = ☀ lit, as fx/darkness.js sceneDarkness: the DM marks caves and cellars 🌑)
export const DEFAULT_LIGHTING = Object.freeze({ darkness: "lit", auto: true, managed: true });
// Smoke's vision layers (ItemFilters:2): only these ever get Smoke keys from us.
export const VISION_LAYERS = ["CHARACTER", "MOUNT", "ATTACHMENT", "PROP"];
// Where a prop lights itself by its name or picture (autoKind): not a map, a drawing or a token.
const PROP_LAYERS = ["PROP", "MOUNT", "ATTACHMENT"];

// Own keys only: "toString" or "__proto__" is not a light (SOURCES inherits them from Object).
const known = (kind) => typeof kind === "string" && Object.prototype.hasOwnProperty.call(SOURCES, kind);
export const reachOf = (kind) => (known(kind) ? SOURCES[kind].bright + SOURCES[kind].dim : 0);

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const norm = (v) => (v === undefined || v === null ? null : String(v));
const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
};
const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };

// JSON with every object's keys in order, so two equal values compare equal however built.
export function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  if (x && typeof x === "object") {
    return `{${Object.keys(x).sort().filter((k) => x[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(",")}}`;
  }
  return JSON.stringify(x) ?? "null";
}

// ---- the scene's settings ----

// SCENE_LIGHTING_KEY as it is, with the defaults: {darkness: "lit"|"dim"|"dark" (unmarked: lit),
// auto: bool, managed: bool}. managed false: the DM released this scene's lights to Smoke (no Smoke
// keys from us, planItem/adoptEdits change nothing; our own keys are still written by the callers).
export function lightingOf(v) {
  const o = isObj(v) ? v : {};
  return { darkness: ["lit", "dim", "dark"].includes(o.darkness) ? o.darkness : DEFAULT_LIGHTING.darkness, auto: o.auto !== false,
           managed: o.managed !== false };
}
export const isManaged = (lighting) => lightingOf(lighting).managed;

// Smoke's default sight for this scene: its visionRangeDefault (a number or a scene metadata
// object holding it), else 30. Smoke uses `||` too: "" or 0 falls through to 30.
export function rangeDefaultOf(x) {
  const v = isObj(x) ? x[K("visionRangeDefault")] : x;
  const n = num(v);
  return n ? n : DEFAULT_RANGE;
}

// ---- which light a token has ----

const AUTO = [[/candle/, "candle"], [/torch|sconce/, "torch"], [/brazier|campfire|fire ?pit|hearth/, "brazier"],
  [/lantern/, "hooded_lantern"], [/lamp/, "lamp"]];

function fileOf(url) {
  const last = String(url || "").split(/[?#]/)[0].split("/").pop() || "";
  return safe(() => decodeURIComponent(last), last);
}

// The light a prop gives by its name, label or picture (a "Sconce", "brazier.webp"), or null.
// Only images on the prop layers (PROP, MOUNT, ATTACHMENT): never a token, a map or a drawing.
export function autoKind(item) {
  if (!item || !PROP_LAYERS.includes(item.layer) || (item.type && item.type !== "IMAGE")) return null;
  if (item.metadata?.[CARRIER_KEY]) return null;
  const text = [item.metadata?.[BUBBLES_NAME_KEY], item.text?.plainText, item.name, fileOf(item.image?.url)]
    .filter((s) => typeof s === "string" && s).join(" ").toLowerCase();
  for (const [re, kind] of AUTO) if (re.test(text) && known(kind)) return kind;
  return null;
}

// A Smoke torch we didn't make (Smoke's own Enable Torchlight), not yet adopted.
const smokeTorch = (meta) => meta?.[K("isTorch")] === true && !!meta?.[K("hasVision")]
  && !(isObj(meta?.[VISION_KEY]?.out) && meta[VISION_KEY].out.isTorch === true);

// Does this item hang (up its attachment chain, as isSecret climbs it) from a hidden non-PC
// CHARACTER token? R1 holds there (a carried torch, a goblin's carrier).
function underHiddenCharacter(item, ctx = {}) {
  const parentOf = typeof ctx.parentOf === "function" ? ctx.parentOf
    : ctx.byId instanceof Map ? (id) => ctx.byId.get(id) : () => undefined;
  let i = item;
  for (let n = 0; n < 8; n++) {
    const own = Array.isArray(i?.disableAttachmentBehavior) && i.disableAttachmentBehavior.includes("VISIBLE");
    if (!i || i.attachedTo == null || own) return false;
    i = parentOf(i.attachedTo);
    if (!i) return false;
    if (i.layer === "CHARACTER" && i.visible === false && !callPc(ctx, i)) return true;
  }
  return true;
}

// The DM's own Smoke torch, left to Smoke: never adopted, never stripped (planItem changes nothing
// on it). Smoke's Enable Torchlight on a prop (not the CHARACTER layer) with no light of ours (no
// 🔥 light or tombstone, no spell, not lit by its name while auto lights are on), not given vision
// or darkvision, and not hanging from a hidden CHARACTER (R1). Its light is effectiveLight's "smoke": its own
// Smoke range, which Smoke's own controls change. ctx: planCtx's (lighting, byId, isPc).
export function isNativeTorch(item, ctx = {}) {
  const meta = item?.metadata;
  if (!isObj(meta) || meta[CARRIER_KEY] || !smokeTorch(meta) || meta[LIGHT_BASE_KEY] !== undefined) return false;
  if (!VISION_LAYERS.includes(item.layer) || item.layer === "CHARACTER") return false;
  if (meta[LIGHT_KEY] !== undefined || meta[SPELL_LIGHT_KEY] !== undefined || meta[VISION_KEY]?.dm?.seer === true) return false;
  // A darkvision on it (a preset, the slider): Smoke's ring on a torch depends on the order each
  // screen saw the keys in; ours then (visionDark "0").
  if (num(meta[K("visionDark")])) return false;
  if (lightingOf(ctx.lighting).auto && autoKind(item)) return false;
  return !underHiddenCharacter(item, ctx);
}

// The DM's invisible ambient light (docs/lights-darkness-spec.md "Hidden lights"): a native Smoke
// torch (isNativeTorch) that no player sees. Its Smoke keys stay as they are; it lights the overlay
// within its Smoke range on every screen, with no flame on non-GM screens. ctx as isNativeTorch
// (+ isSecret(item), else the item's own `visible` and its parents through ctx.byId).
export function isAmbientLight(item, ctx = {}) {
  if (!isNativeTorch(item, ctx)) return false;
  if (typeof ctx.isSecret === "function") return !!safe(() => ctx.isSecret(item), false);
  const parentOf = typeof ctx.parentOf === "function" ? ctx.parentOf : ctx.byId instanceof Map ? (id) => ctx.byId.get(id) : undefined;
  return isSecret(item, { parentOf });
}

// The light this token gives, or null: {kind, reach, from: "hand"|"spell"|"auto"|"smoke", magic?}.
// The DM's light (not "none") against a spell's: the bigger reach wins, the DM's wins a tie. The
// tombstone "none": only a spell counts. No LIGHT_KEY at all: the prop's own (autoKind, while the
// scene's auto lights are on), else a Smoke torch nobody adopted yet (a torch). A carrier (the
// child item that carries a goblin's torchlight for Smoke) is never a light itself.
export function effectiveLight(item, lighting = DEFAULT_LIGHTING) {
  const meta = item?.metadata;
  if (!isObj(meta) || meta[CARRIER_KEY]) return null;
  const s = meta[SPELL_LIGHT_KEY];
  const spell = isObj(s) && known(s.kind) ? { kind: s.kind, reach: reachOf(s.kind), from: "spell", magic: s.magic ?? null } : null;
  const hand = meta[LIGHT_KEY];
  // dm.reach: the DM's Smoke range on a torch of ours (a slider, a preset, an adopted Smoke torch's
  // own range): the reach; the kind gives only the look. A Smoke torch nobody adopted: its range.
  const own = num(meta[VISION_KEY]?.dm?.reach) || null;
  let base = null;
  if (isObj(hand) && (hand.kind === "none" || known(hand.kind))) {
    if (hand.kind !== "none") base = { kind: hand.kind, reach: own || reachOf(hand.kind), from: "hand" };
  } else {
    const auto = lightingOf(lighting).auto ? autoKind(item) : null;
    if (auto) base = { kind: auto, reach: own || reachOf(auto), from: "auto" };
    else if (smokeTorch(meta)) base = { kind: autoKind(item) || "torch", reach: own || num(meta[K("visionRange")]) || DEFAULT_RANGE, from: "smoke" };
  }
  if (base && spell) return spell.reach > base.reach ? spell : base;
  return base || spell;
}

// Compatibility for older callers that only have the metadata (no layer, so no auto light).
export const lightOf = (meta) => effectiveLight({ metadata: meta });

// ---- how a token sees ----

// VISION_KEY as it is: {dm, out}, both objects.
export function profileOf(meta) {
  const p = meta?.[VISION_KEY];
  return { dm: isObj(p?.dm) ? { ...p.dm } : {}, out: isObj(p?.out) ? { ...p.out } : {} };
}

const callPc = (ctx, item) => !!safe(() => ctx?.isPc?.(item), false);

// How this token sees: {seer, sight, dark, pc, where}. ctx: {isPc(item), senses(item) -> {dark} |
// null, lighting (SCENE_LIGHTING_KEY's value), regions (fx/darkness.js darknessCtx: the darkness
// under each point; without it, the scene's)}. Darkness comes from light (docs/lights-darkness-spec.md):
//   seer: a PC always; anything else when the DM gave it vision (dm.seer).
//   where: the darkness where it stands ("lit" | "dim" | "dark").
//   sight (feet): on ☀/🌒 everything in line of sight, min(dm.sight ?? LIT_SIGHT, LIT_SIGHT) (dm.sight
//     is only a sight LIMIT now: fog, mist); on 🌑 0 (only lights and darkvision show anything).
//   dark (darkvision, feet): the DM's, else the party sheet's (PCs), else 0.
export function visionOf(item, ctx = {}) {
  const { dm } = profileOf(item?.metadata);
  const pc = callPc(ctx, item);
  const where = ctx.regions ? regionAt(item?.position, ctx.regions) : lightingOf(ctx.lighting).darkness;
  const sight = where === "dark" ? 0 : Math.min(num(dm.sight) ?? LIT_SIGHT, LIT_SIGHT);
  const sensed = safe(() => ctx.senses?.(item));
  const dark = num(dm.dark) ?? num(sensed?.dark) ?? 0;
  return { seer: pc || dm.seer === true, sight, dark, pc, where };
}

// The Smoke keys this token should have (short names); a key left out = absent (removed if we
// wrote it). ctx as visionOf, plus isSecret(item) (hidden, itself or through what it hangs
// from, and not a PC: fx/lightmeta.js isSecret()).
export function smokeFor(item, ctx = {}) {
  if (!item || !isObj(item.metadata) || item.metadata[CARRIER_KEY] || !VISION_LAYERS.includes(item.layer)) return {};
  const v = visionOf(item, ctx);
  // R1: Smoke lights the fog around every GM-made vision token on every player's screen, hidden
  // or not, so a secret one gets nothing (its light is back when it's shown).
  if (!v.pc && safe(() => ctx.isSecret?.(item), false)) return {};
  const light = effectiveLight(item, ctx.lighting);
  const reach = light ? light.reach : 0;
  // A seer on ☀/🌒 sees by line of sight (its limit, if any); on 🌑 as far as its darkvision, its
  // own light, or the far edge of the farthest public light (ctx.lights: fx/darkness.js
  // darknessCtx), at most LIT_SIGHT. Our overlay blacks out the dark gap in between. Never under
  // SELF_SIGHT there: Smoke's fog would hide the PC's own mini, which our overlay leaves clear.
  if (v.seer) {
    const range = v.where === "dark"
      ? Math.min(LIT_SIGHT, Math.max(SELF_SIGHT, v.dark, reach, farLight(item, ctx.lights, ctx.pxPerFt)))
      : v.sight;
    return { hasVision: true, visionRange: String(range), visionDark: "0" };
  }
  if (light && item.layer !== "CHARACTER") return { hasVision: true, isTorch: true, visionRange: String(reach), visionDark: "0" };
  return {};
}

// ---- adopting the DM's edits in Smoke, and the migration from the first build ----

// Is this a token we look after? Ours already, a PC, lit (or put out), or given vision in Smoke.
function managed(item, meta, ctx) {
  if (!VISION_LAYERS.includes(item?.layer) || meta[CARRIER_KEY]) return false;
  return isObj(meta[VISION_KEY]) || meta[LIGHT_KEY] !== undefined || meta[SPELL_LIGHT_KEY] !== undefined
    || !!meta[K("hasVision")] || callPc(ctx, { ...item, metadata: meta })
    || !!effectiveLight({ ...item, metadata: meta }, ctx?.lighting);
}

// LIGHT_BASE_KEY (the first build, 2.305.0) -> VISION_KEY, once (handoff §3g). A token that
// already has a profile only loses the old key: its Smoke range is our own max() by now.
function migrate(meta, ctx) {
  if (meta[LIGHT_BASE_KEY] === undefined) return false;
  const base = meta[LIGHT_BASE_KEY];
  delete meta[LIGHT_BASE_KEY];
  if (isObj(meta[VISION_KEY]) || !isObj(base)) return true;
  // Every Smoke key there now is ours from here on (what the old build wrote, and what it kept).
  const out = {};
  for (const k of MANAGED) if (meta[K(k)] !== undefined && meta[K(k)] !== null) out[k] = meta[K(k)];
  const dm = {};
  if (base.sees === true) {
    if (meta[K("hasVision")] === true) dm.seer = true; // a PC drops it again (canonical)
    const d = num(meta[K("visionDark")]);
    if (d) dm.dark = d;
    const edited = Array.isArray(base.dm) && base.dm.includes("visionRange");
    // dm.sight is a sight LIMIT now (darkness comes from light): Smoke's default range is none.
    const s = num(edited ? meta[K("visionRange")] : base.prev?.visionRange);
    if (s !== null && s !== rangeDefaultOf(ctx?.rangeDefault)) dm.sight = s;
  }
  meta[VISION_KEY] = { dm, out };
  return true;
}

// Fold the DM's Smoke edits into the profile (mutates meta). A Smoke key whose value isn't what
// `out` says we wrote is the DM's (compared as strings), and from then on it's ours (in `out`):
//   visionRange -> dm.sight; visionDark (above 0) -> dm.dark;
//   hasVision gone: on a torch of ours (Smoke's Disable Torchlight/Vision) -> 🔥 None (tombstone);
//     on a PC -> put back (a PC always sees; noted); on anything else -> dm.seer off;
//   hasVision new: with isTorch (Enable Torchlight) -> a light of ours (LIGHT_KEY); else (Enable
//     Vision) -> dm.seer (a PC sees anyway).
// Smoke's defaults ("30", "0") carry no wish, and come out the same as no override.
function adoptInto(meta, item, ctx, notes) {
  if (!managed(item, meta, ctx)) return;
  const { dm, out } = profileOf(meta);
  const view = { ...item, metadata: meta };
  const pc = callPc(ctx, view);
  const name = String(item?.text?.plainText || item?.name || item?.id || "?");
  const hv = !!meta[K("hasVision")];
  if (out.hasVision === true && !hv) {
    if (out.isTorch === true) {
      meta[LIGHT_KEY] = { kind: "none" };
      notes?.push(`${name}: Smoke's torchlight turned off = 🔥 None`);
    } else if (pc) {
      notes?.push(`${name}: Smoke's Disable Vision undone (a PC always sees; use the 🔥 Lighting list)`);
    } else {
      dm.seer = false;
    }
    delete out.hasVision;
  } else if (hv && out.hasVision !== true) {
    if (meta[K("isTorch")] === true && out.isTorch !== true) {
      // Smoke's Enable Torchlight lights it: the prop's own light when it has one (no key needed),
      // else a torch; a 🔥 light it already has stays.
      const hand = meta[LIGHT_KEY];
      if (!isObj(hand) || !known(hand.kind)) {
        if (lightingOf(ctx?.lighting).auto && autoKind(view)) delete meta[LIGHT_KEY];
        else meta[LIGHT_KEY] = { kind: autoKind(view) || "torch" }; // the look by its name
      }
      out.isTorch = meta[K("isTorch")];
    } else if (!pc) {
      dm.seer = true;
    }
    out.hasVision = meta[K("hasVision")];
  }
  // On a torch of ours (a lit prop that doesn't see: Smoke's range there is its light's), the
  // DM's range is the light's reach (dm.reach, effectiveLight), whatever came first: a slider, a
  // preset, the range an adopted Smoke torch already had.
  const torch = item.layer !== "CHARACTER" && !pc && dm.seer !== true && !!effectiveLight(view, ctx?.lighting);
  for (const [k, field] of [["visionRange", torch ? "reach" : "sight"], ["visionDark", "dark"]]) {
    const v = meta[K(k)];
    if (v === undefined || v === null) {
      delete out[k]; // gone (written again below if it's wanted)
      continue;
    }
    if (k in out && norm(v) === norm(out[k])) continue;
    const n = num(v);
    // A value we never wrote (from before us) doesn't undo what the DM set in the 🔥 Lighting
    // list (a sight limit typed before the writer ever wrote this token): the typed one stays.
    if (!(k in out) && dm[field] !== undefined && dm[field] !== null) { out[k] = v; continue; }
    // Smoke's own default range on a seer carries no wish: no sight limit (only an adopted Smoke
    // value says this; a 30 typed in the 🔥 Lighting list is a limit, and canonDm keeps it).
    if (field === "sight" && n !== null && n === rangeDefaultOf(ctx?.rangeDefault)) delete dm.sight;
    else if (n !== null && (field === "sight" || n > 0)) dm[field] = n;
    out[k] = v;
  }
  if (meta[K("isTorch")] === undefined) delete out.isTorch;
  else if (out.isTorch === undefined) out.isTorch = meta[K("isTorch")]; // ours from now (never on a token)
  meta[VISION_KEY] = { dm, out };
}

// The DM's overrides with what says nothing left out, so equal wishes are equal keys whatever
// the order they came in: a PC's seer (always), seer false (the default). A sight limit is kept
// whatever it is (30 included: Smoke's default is dropped where it's adopted, adoptInto).
function canonDm(dm, view, ctx) {
  const out = {};
  const s = num(dm.sight), d = num(dm.dark);
  if (s !== null) out.sight = s;
  if (d !== null) out.dark = d;
  const r = num(dm.reach);
  if (r) out.reach = r; // a torch's range (effectiveLight); kept once set, so the order never matters
  if (dm.seer === true && !callPc(ctx, view)) out.seer = true;
  return out;
}

// Smoke's Enable Vision fills these when they aren't number strings (VTU:168-182, BSK:106-118):
// the scene's default (ctx.smokeDefaults, from fx/lightwriter.js planCtx), else these.
const ENABLE_DEFAULTS = [["visionSourceRange", "0"], ["visionFallOff", "0"], ["visionInAngle", "360"], ["visionOutAngle", "360"]];
export const SMOKE_DEFAULT_KEYS = { visionSourceRange: "visionSourceDefault", visionFallOff: "visionFallOffDefault",
  visionInAngle: "visionInAngleDefault", visionOutAngle: "visionOutAngleDefault" };

// The keys a light reads or writes on a token.
// (+ what Smoke's Enable Vision writes besides, which planItem writes for a new seer: ENABLE_DEFAULTS)
export const LIGHT_PART = [LIGHT_KEY, SPELL_LIGHT_KEY, LIGHT_BASE_KEY, VISION_KEY, ...MANAGED.map(K),
  ...ENABLE_DEFAULTS.map(([k]) => K(k))];

// Copy the light part of `next` (planItem's answer) onto `meta` (an Owlbear draft's metadata), so
// the other keys on the draft (Stat Bubbles' HP, a WHO mark) stay as they are now.
export function writeLightPart(meta, next) {
  for (const k of LIGHT_PART) {
    if (next?.[k] === undefined) delete meta[k];
    else meta[k] = clone(next[k]);
  }
  return meta;
}

// ---- the one function every writer calls ----

// The token's new metadata (a full copy), or null when nothing changes: the migration, the DM's
// Smoke edits adopted, then smokeFor's keys written (and `out` with them), and the keys `out`
// says we wrote that are no longer wanted removed (only while they still hold our value; a key
// we never wrote is left alone). planItem(planItem(x)) is null. `notes`: an array to push what
// the DM should hear about (a PC's Smoke vision put back).
export function planItem(item, ctx = {}, notes = null) {
  if (!item || !isObj(item.metadata) || item.metadata[CARRIER_KEY] || !isManaged(ctx.lighting)) return null;
  if (isNativeTorch(item, ctx)) return null; // the DM's own Smoke torch (an ambient light when hidden)
  const meta = clone(item.metadata);
  migrate(meta, ctx);
  adoptInto(meta, item, ctx, notes);
  const view = { ...item, metadata: meta };
  const want = smokeFor(view, ctx);
  const { dm, out } = profileOf(meta);
  // Giving a seer its vision: what Smoke's own Enable Vision writes besides (CMC:977-980), so the
  // token ends the same whichever came first, our write or the DM's click.
  if (want.hasVision && !want.isTorch && !meta[K("hasVision")]) {
    for (const [k, d] of ENABLE_DEFAULTS) {
      const v = meta[K(k)];
      if (!(typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))) meta[K(k)] = ctx.smokeDefaults?.[k] || d;
    }
  }
  for (const k of MANAGED) {
    if (k in want) {
      meta[K(k)] = want[k];
      out[k] = want[k];
    } else if (k in out) {
      if (norm(meta[K(k)]) === norm(out[k])) delete meta[K(k)];
      delete out[k];
    }
  }
  const keep = canonDm(dm, view, ctx);
  if (Object.keys(keep).length || Object.keys(out).length) meta[VISION_KEY] = { dm: keep, out };
  else delete meta[VISION_KEY];
  return stable(item.metadata) === stable(meta) ? null : meta;
}

// Only the adoption (and the migration): new metadata, or null when there's no edit to adopt.
export function adoptEdits(item, ctx = {}, notes = null) {
  if (!item || !isObj(item.metadata) || item.metadata[CARRIER_KEY] || !isManaged(ctx.lighting)) return null;
  if (isNativeTorch(item, ctx)) return null;
  const meta = clone(item.metadata);
  migrate(meta, ctx);
  adoptInto(meta, item, ctx, notes);
  if (isObj(meta[VISION_KEY])) {
    const p = profileOf(meta);
    if (!Object.keys(p.dm).length && !Object.keys(p.out).length && !isObj(item.metadata[VISION_KEY])) delete meta[VISION_KEY];
  }
  return stable(item.metadata) === stable(meta) ? null : meta;
}

// ---- the UI's only ways to change the inputs (mutate and return `meta`, an Owlbear draft's) ----

// The DM's light: a SOURCES kind, "none" (put out: a tombstone), or null (back to the prop's own
// light, or none). Unknown kinds count as null.
export function setLight(meta, kind) {
  if (!isObj(meta)) return meta;
  if (kind === "none") meta[LIGHT_KEY] = { kind: "none" };
  else if (known(kind)) meta[LIGHT_KEY] = { kind };
  else delete meta[LIGHT_KEY];
  return meta;
}

// A spell's light: {kind, magic} or null.
export function setSpellLight(meta, spell) {
  if (!isObj(meta)) return meta;
  if (isObj(spell) && known(spell.kind)) meta[SPELL_LIGHT_KEY] = { kind: spell.kind, magic: spell.magic ?? null };
  else delete meta[SPELL_LIGHT_KEY];
  return meta;
}

// The DM's overrides: {sight?, dark?, seer?}; a field given as null clears that override, one
// left out stays. Numbers in feet; seer a boolean.
export function setVision(meta, change = {}) {
  if (!isObj(meta)) return meta;
  const { dm, out } = profileOf(meta);
  for (const f of ["sight", "dark"]) {
    if (!(f in change)) continue;
    const n = num(change[f]);
    if (change[f] === null || n === null) delete dm[f];
    else dm[f] = n;
  }
  if ("seer" in change) {
    if (change.seer === null || change.seer === undefined) delete dm.seer;
    else dm.seer = !!change.seer;
  }
  meta[VISION_KEY] = { dm, out };
  return meta;
}

// Hand the token back to Smoke as it would be without us (the popover's "Release to Smoke"): a
// seer keeps its vision with visionRange = its sight and visionDark = its darkvision (Smoke draws
// its own ring again; a PC, or a token the DM gave vision, hidden or not); a torch of ours (a
// sconce, an adopted Smoke torch: `out` has isTorch) stays a plain Smoke torch at its reach, so it
// keeps revealing the fog; every other key we wrote goes; the profile goes. New metadata (a copy).
export function release(item, ctx = {}) {
  const meta = clone(isObj(item?.metadata) ? item.metadata : {});
  delete meta[LIGHT_BASE_KEY];
  const { out } = profileOf(meta);
  const v = visionOf(item, ctx);
  const light = safe(() => effectiveLight(item, ctx.lighting));
  for (const k of MANAGED) {
    if (k in out && norm(meta[K(k)]) === norm(out[k])) delete meta[K(k)];
  }
  if (v.seer) {
    // Smoke has no light on a token that sees: its own light's reach goes into its sight.
    meta[K("hasVision")] = true;
    meta[K("visionRange")] = String(Math.min(Math.max(num(v.sight) ?? 0, light?.reach ?? 0), LIT_SIGHT));
    meta[K("visionDark")] = String(num(v.dark) ?? 0);
  } else if (out.isTorch === true && item?.layer !== "CHARACTER") {
    const reach = light?.reach || num(out.visionRange) || num(meta[K("visionRange")]) || reachOf("torch");
    meta[K("hasVision")] = true;
    meta[K("isTorch")] = true;
    meta[K("visionRange")] = String(reach);
    meta[K("visionDark")] = "0";
  }
  delete meta[VISION_KEY];
  return meta;
}

// ---- compatibility with the first build's callers (the drawing and light.html, until they
// move to effectiveLight / setLight + planItem) ----

// applyLight(meta, {hand?, spell?}, {pc, secret}): the change, then planItem with what the caller
// knows (no party darkvision, the scene's defaults). Mutates and returns `meta`. An EMPTY change
// does nothing: the old torch guard in fx/lighting.js re-checks lit tokens that way, and the
// leader's writer (fx/lightwriter.js) does that job now.
// `layer`: the token's layer when the caller knows it (else CHARACTER: never a torch on a token).
export function applyLight(meta, change = {}, { pc = false, secret = false, layer = null } = {}) {
  if (!isObj(meta) || !isObj(change)) return meta;
  if (change.hand === undefined && change.spell === undefined) return meta;
  if (change.hand !== undefined) setLight(meta, change.hand === null ? "none" : change.hand);
  if (change.spell !== undefined) setSpellLight(meta, change.spell);
  const item = { layer: VISION_LAYERS.includes(layer) ? layer : "CHARACTER", metadata: meta };
  const next = planItem(item, { isPc: () => pc, isSecret: () => secret });
  if (next) writeLightPart(meta, next);
  return meta;
}

// Would applyLight() change this token's metadata? (An empty change: never.)
export function lightChanges(meta, change, opts) {
  if (!isObj(change) || (change.hand === undefined && change.spell === undefined)) return false;
  const now = {};
  for (const k of LIGHT_PART) if (meta?.[k] !== undefined) now[k] = meta[k];
  const after = applyLight(clone(now), change, opts);
  return stable(now) !== stable(after);
}

// ---- is a token secret? ----

// Would no player's screen show this token? Hidden itself, or through what it's attached to (an
// attachment is hidden with its parent unless its disableAttachmentBehavior has "VISIBLE"); a PC
// never is. `parentOf(id)`: the scene item with that id (undefined when it's gone: Owlbear
// deletes attachments with their parent, so nothing hides it then); `isPc(id)`. Attached deeper
// than 8 (or in a loop): secret, to be safe.
export function isSecret(item, { parentOf = () => undefined, isPc = () => false } = {}) {
  let i = item;
  for (let n = 0; n < 8; n++) {
    if (!i || isPc(i.id)) return false;
    if (i.visible === false) return true;
    const own = Array.isArray(i.disableAttachmentBehavior) && i.disableAttachmentBehavior.includes("VISIBLE");
    if (i.attachedTo == null || own) return false;
    i = parentOf(i.attachedTo);
  }
  return true;
}

// These items and everything they hang from (up their attachment chains), by id, for isSecret().
// One read per level, and none for tokens attached to nothing (most). `OBR` is passed in: this
// file imports nothing of Owlbear's.
export async function withParents(OBR, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  let level = items;
  for (let n = 0; n < 8; n++) {
    const up = [...new Set(level.map((i) => i.attachedTo).filter((id) => id != null && !byId.has(id)))];
    if (!up.length) break;
    level = await OBR.scene.items.getItems(up);
    for (const i of level) byId.set(i.id, i);
  }
  return byId;
}
