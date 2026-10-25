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
//   describe(item, ctx)            "Ana carries a torch (20 + 20 ft)", "Sconce put out — won't relight by itself"
//   feetSaid(kind, reach), lightTitle(kind)   a light's numbers as the DM reads them ("20 + 20 ft")
//   lightingRows(items, ctx)       the list's PCs (sight and all four senses), lit objects, and every NPC (lit or not)
//   pcSensesSaid(row, rules)       a PC row's line: "sees 60 ft · darkvision 60 ft · blindsight 10 ft"
//   ruleChips / ruleTap / allOnTap / allOffTap / ruleSaid   the 2024 switch row (RULES_KEY, rules2024.js)
//   weatherChips / weatherTap / weatherSaid         the weather row (WEATHER_KEY, rules2024.js)
//   lightingNow, takenBack, sceneNext, mapDarkEdit, mapDarkSaid, sceneSaid, picksWaiting, picksDrawnAgain
//                                  the scene's and each map's darkness chips and "Props light themselves",
//                                  as the list's "This scene" and ▸ Maps and 🎲 DND's ☀ Scene lights tab
//                                  (maplight.html) write and say them
//   screenLine(s), screenWarnings(screens, opts)   the screens heard, and what to do about them
//
// Everything the inputs change goes through lightmeta.js's setLight / setVision, then planItem
// with the writer's ctx, in ONE write (fx/lightwriter.js writeNow): the same pure function on the
// same inputs as the leader's writer, so a tap writes once and the writer's next pass plans
// nothing for that token. The 2024 switches and the weather are whole scene values
// (docs/vision-layer-2024.md sections 2 and 7, "The Lighting list (U)"): a tap that changes nothing
// writes nothing.
import * as LM from "./fx/lightmeta.js?v=9a30147";
import { planCtx } from "./fx/lightwriter.js?v=9a30147";
import { CONES_BUILT, SOURCES } from "./fx/lights.js?v=9a30147";
import { CARRIER_KEY, LIGHT_KEY, MAP_DARKNESS_KEY, RULES_KEY, SCENE_LIGHTING_KEY, SMOKE, SPELL_LIGHT_KEY, VISION_KEY,
         WEATHER_KEY } from "./keys.js?v=9a30147";
import { pcName, tokenLabel } from "./fx/pcs.js?v=9a30147";
import { sceneDarkness } from "./fx/darkness.js?v=9a30147";
import { ALL_RULES_OFF, ALL_RULES_ON, RULE_LABELS, RULE_NAMES, WEATHER_CHOICES, effectiveRules, rulesOf, rulesValue,
         weatherOf, weatherValue } from "./rules2024.js?v=9a30147";

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
// wrote meanwhile is kept). `before`: the metadata planWrite started from. A key `after` lacks is
// written as an explicit null, never deleted: an Owlbear JSON-patch "remove" of a key another
// screen lacks throws OPERATION_PATH_UNRESOLVABLE there and leaves that screen's items stale (live,
// 2026-10-12). Every reader takes null as missing: lightmeta.js (VISION_KEY, LIGHT_BASE_KEY and
// Smoke's hasVision / isTorch / visionRange / visionDark), and Smoke itself for its vision.
export function applyMeta(draft, before, after) {
  draft.metadata = draft.metadata || {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = JSON.stringify(before?.[k]), b = JSON.stringify(after?.[k]);
    if (a === b) continue;
    if (after?.[k] === undefined) {
      if (draft.metadata[k] !== null) draft.metadata[k] = null;
    } else draft.metadata[k] = clone({ v: after[k] }).v;
  }
}

// ---- what it says ----

const SPELLISH = new Set(["light", "continual_flame", "dancing_lights", "produce_flame", "daylight"]);
export function lightName(kind) {
  const s = SOURCES[kind];
  if (!s) return String(kind || "a light");
  if (SPELLISH.has(kind)) return s.label;
  const l = s.label.toLowerCase();
  return `${/^[aeiou]/.test(l) ? "an" : "a"} ${l}`;
}

// A light's numbers as the DM reads them (2024 rules: a bright part, then a dim ring): "20 + 20 ft",
// "10 ft dim" (no bright part, Dancing Lights), "5 ft bright" (no dim ring). A reach that isn't the
// kind's own (the DM's Smoke range on an adopted torch: half bright, half dim) is one number, "25 ft".
// `src`: the light table (fx/lights.js SOURCES; the checks pass their own).
export function feetSaid(kind, reach = null, src = SOURCES) {
  const s = src && Object.prototype.hasOwnProperty.call(src, kind) ? src[kind] : null;
  const full = s ? s.bright + s.dim : 0;
  const r = Number.isFinite(reach) ? reach : full;
  if (!s || r !== full) return `${r} ft`;
  if (!s.bright) return `${s.dim} ft dim`;
  if (!s.dim) return `${s.bright} ft bright`;
  return `${s.bright} + ${s.dim} ft`;
}
const feet = (kind) => feetSaid(kind);

// The tooltip of a light's chip (the 🔥 menu, the Lighting list): "Torch: 20 ft bright, 20 ft dim",
// plus what's special about the 2024 newcomers (they show only once fx/lights.js has them).
const LIGHT_NOTES = {
  bullseye_lantern: "a cone the way its token faces while 🔦 Cones and 💡 Dim light are on; otherwise a circle",
  hooded_lantern_low: "the hood down: a dim glow only",
  daylight: "the spell: sunlight",
};
// Until the cone is drawn (fx/lights.js CONES_BUILT false), the bullseye is a circle on every screen,
// whatever 🔦 says, and its tooltip says so (`built`: the checks pass it).
const BULLSEYE_UNBUILT = "a circle all round its bearer: the cone isn't built yet, whatever 🔦 Cones says";
export function lightTitle(kind, src = SOURCES, built = CONES_BUILT) {
  const s = src && Object.prototype.hasOwnProperty.call(src, kind) ? src[kind] : null;
  if (!s) return "";
  const note = kind === "bullseye_lantern" && !built ? BULLSEYE_UNBUILT : LIGHT_NOTES[kind];
  return `${s.label}: ${s.bright} ft bright, ${s.dim} ft dim${note ? ` (${note})` : ""}`;
}

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
    s = `${name} ${pc || item.layer === "CHARACTER" ? "carries" : "gives off"} ${lightName(eff.kind)} (${feetSaid(eff.kind, eff.reach)})`;
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
    const f = sensesFt(item, ctx);
    for (const [k, word] of SENSE_WORDS) if (f[k] > 0) s += ` · ${word} ${f[k]} ft`;
  }
  return s;
}

// ---- a PC's senses ----

const SENSE_WORDS = [["dark", "darkvision"], ["blind", "blindsight"], ["truesight", "truesight"], ["tremor", "tremorsense"]];
const feetOrNull = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// A PC's four senses as the list reads them: {over: the DM's override per sense (feet or null),
// sheet: the party file's (feet or null), used: what counts (feet)}. The DM's override wins over the
// party file (docs/vision-layer-2024.md, "Vision overrides"). `used` is fx/lightmeta.js visionOf's
// own number where it gives one (all four, from L's build on); where it gives none yet, the same
// rule here, so the row says the same thing either way. Darkvision and the sight limit as today.
function senseParts(item, ctx, v = visionOf(item, ctx)) {
  const dm = item?.metadata?.[VISION_KEY]?.dm || {};
  let sheet = null;
  try { sheet = ctx.senses?.(item) || null; } catch { sheet = null; }
  const over = { dark: feetOrNull(dm.dark), blind: feetOrNull(dm.blind), truesight: feetOrNull(dm.truesight), tremor: null };
  const fromSheet = { dark: feetOrNull(sheet?.dark), blind: feetOrNull(sheet?.blind), truesight: feetOrNull(sheet?.truesight),
                      tremor: feetOrNull(sheet?.tremor) };
  const used = {};
  for (const [k] of SENSE_WORDS) used[k] = feetOrNull(v?.[k]) ?? over[k] ?? fromSheet[k] ?? 0;
  return { over, sheet: fromSheet, used };
}
const sensesFt = (item, ctx) => senseParts(item, ctx).used;

// A PC row's line: "sees 60 ft · darkvision 60 ft · blindsight 10 ft" (a sense of 0 isn't said), and
// its tooltip: blindsight and truesight are drawn only while 🦇 Senses is on (and through fog only
// with 🧱 too); tremorsense is never drawn (it isn't sight). `rules`: rules2024.js rulesOf.
export function pcSensesSaid(row, rules = {}) {
  const r = effectiveRules(rules);
  const said = [`sees ${row.seesFt >= 1000 ? "all" : `${row.seesFt} ft`}`];
  if (row.darkFt > 0) said.push(`darkvision ${row.darkFt} ft`);
  if (row.blindFt > 0) said.push(`blindsight ${row.blindFt} ft`);
  if (row.truesightFt > 0) said.push(`truesight ${row.truesightFt} ft`);
  if (row.tremorFt > 0) said.push(`tremorsense ${row.tremorFt} ft`);
  const extra = row.blindFt > 0 || row.truesightFt > 0;
  const title = [];
  if (extra) {
    title.push(r.senses ? `🦇 Senses is on: blindsight and truesight are drawn${r.pierce ? ", and see through fog (🧱)" : " (not through fog: 🧱 is off)"}`
      : "🦇 Senses is off: blindsight and truesight aren't drawn (the 👁 badge still counts them)");
  }
  if (row.tremorFt > 0) title.push("Tremorsense isn't sight: nothing is drawn for it");
  return { text: said.join(" · ") + (extra && !r.senses ? " (🦇 off)" : ""), title: title.join(". ") };
}

// ---- the 2024 switch row and the weather row (scene values, rules2024.js) ----

// What each switch does, for its chip's tooltip (the plan's switch table).
export const RULE_ABOUT = Object.freeze({
  dim: "2024 lights: a bright circle, then a dimmer ring (a torch 20 + 20 ft). Off: today's shader and radii",
  cones: "The bullseye lantern lights a cone the way its token faces (works only with 💡 Dim light on). Off: a 60 + 60 ft circle",
  darkvision: "2024 darkvision: darkness in range looks dim (grey), dim light looks bright (colour). Off: today's grey",
  zones: "Heavily obscured shapes and spell clouds block sight like a wall (tokens still walk through); a PC inside sees 5 ft. Off: no zone changes sight (the marks stay)",
  weather: "The weather row below limits sight on maps marked 🌳 Outdoor. Off: the weather changes nothing on screen",
  senses: "Blindsight and truesight circles in the dark, and Blinded limits a PC to 5 ft. Off: none of it",
  pierce: "Blindsight sees through fog and magical darkness, truesight through magical darkness (works only with 🦇 Senses on). Off: every zone blocks every sense",
});
// A switch that works only with another on (rules2024.js effectiveRules).
export const RULE_NEEDS = Object.freeze({ cones: "dim", pierce: "senses" });
const iconOf = (name) => String(RULE_LABELS[name] || "").split(" ")[0];
// The switches that work through 🌫 Our fog (its sight): with the fog off they change nothing on screen.
const THROUGH_FOG = new Set(["zones", "weather", "pierce"]);

// 🔦 while the cone isn't drawn (fx/lights.js CONES_BUILT false): the chip says so, shows dashed, and
// a tap on writes nothing (a tap off still clears a stored on). The bullseye stays a 60 + 60 ft
// circle on every screen, and the memory and the 👁 badge treat it the same (fx/darkness.js lightShape).
export const CONES_UNBUILT = "Not built yet: the bullseye lantern is a 60 + 60 ft circle all round its bearer whatever this chip says, "
  + "so a tap on writes nothing (the cone needs its own shader copy, not in this build)";
const conesIdle = (name, conesBuilt) => name === "cones" && !conesBuilt;

// One chip per switch, in RULE_NAMES order: {name, label, on (stored on), idle (on, but its other
// switch is off, so it does nothing yet; 🔦 always, while the cone isn't built), title}.
// opts.conesBuilt: fx/lights.js CONES_BUILT (the checks pass it).
export function ruleChips(sceneMeta, { conesBuilt = CONES_BUILT } = {}) {
  const r = rulesOf(sceneMeta), e = effectiveRules(r);
  return RULE_NAMES.map((name) => {
    if (conesIdle(name, conesBuilt)) return { name, on: r[name], idle: true, label: `${RULE_LABELS[name]} (not built)`, title: CONES_UNBUILT };
    const idle = r[name] && !e[name];
    const need = RULE_NEEDS[name];
    return { name, on: r[name], idle, label: idle ? `${RULE_LABELS[name]} (needs ${iconOf(need)})` : RULE_LABELS[name],
             title: `${RULE_ABOUT[name]}${idle ? `. Does nothing until ${RULE_LABELS[need]} is on too` : ""}` };
  });
}

// What a switch chip's tap writes: {key, value, changed}. `want` is the state the DM asked for (the
// chip as it was shown, flipped), so a second tap before the list redraws changes nothing. value is
// always whole (rulesValue: all seven, from the scene's switches now); changed is false when the
// scene's switches already read that way (missing reads as off), and then nothing is written.
// 🔦 on while the cone isn't built: no change (ruleSaid says why).
export function ruleTap(sceneMeta, name, want, { conesBuilt = CONES_BUILT } = {}) {
  const asked = RULE_NAMES.includes(name) && typeof want === "boolean" && !(want && conesIdle(name, conesBuilt));
  const patch = asked ? { [name]: want } : {};
  const value = rulesValue(sceneMeta, patch);
  return { key: RULES_KEY, value, changed: LM.stable(rulesOf(sceneMeta)) !== LM.stable(rulesOf({ [RULES_KEY]: value })) };
}

// "All 2024 off": all seven off, whole (ALL_RULES_OFF); nothing written when they already are. The
// explored memory, its shade and everything else in the scene are other keys: never touched.
export function allOffTap(sceneMeta) {
  const value = { ...ALL_RULES_OFF };
  return { key: RULES_KEY, value, changed: RULE_NAMES.some((n) => rulesOf(sceneMeta)[n]) };
}

// "All 2024 on" (V2: the game's setup taps it once per scene; the code defaults stay off): all seven
// on, whole (ALL_RULES_ON); while the cone isn't built 🔦 stays as stored. Nothing written when they
// already are.
export function allOnTap(sceneMeta, { conesBuilt = CONES_BUILT } = {}) {
  const value = { ...ALL_RULES_ON };
  if (!conesBuilt) value.cones = rulesOf(sceneMeta).cones;
  return { key: RULES_KEY, value, changed: LM.stable(rulesOf(sceneMeta)) !== LM.stable(rulesOf({ [RULES_KEY]: value })) };
}

// What the list says after a switch tap. `after`: the scene's metadata after the write; `fogOn`:
// 🌫 Our fog is on in this scene. name "all": All 2024 on (want true) or off.
export function ruleSaid(name, want, { changed = true, after = {}, fogOn = true, conesBuilt = CONES_BUILT } = {}) {
  if (name === "all" && want) {
    if (!changed) return "All 2024 rules are on already";
    return `All 2024 rules on: dim light, ${conesBuilt ? "cones, " : ""}2024 darkvision, obscured shapes, weather, senses and `
      + `senses through fog, on every screen in this scene${fogOn ? "" : " · ☁, 🌦 and 🧱 work through 🌫 Our fog, which is off in this scene"}`;
  }
  if (name === "all") {
    return changed ? "All 2024 rules off: lights, darkvision and sight as before the 2024 rules, on every screen (the explored memory is untouched)"
      : "All 2024 rules are off already";
  }
  if (want && conesIdle(name, conesBuilt)) {
    return `${RULE_LABELS.cones} isn't built yet: the bullseye lantern stays a 60 + 60 ft circle all round its bearer · nothing written`;
  }
  const e = effectiveRules(rulesOf(after));
  const need = RULE_NEEDS[name];
  let s = `${RULE_LABELS[name] || name} ${want ? "on" : "off"}${changed ? "" : " (already so)"} · every screen in this scene`;
  if (want && need && !e[name]) s += ` · it works only with ${RULE_LABELS[need]} on too`;
  if (want && THROUGH_FOG.has(name) && !fogOn) s += " · it works through 🌫 Our fog, which is off in this scene";
  return s;
}

// The weather row: WEATHER_CHOICES with {on, title}. The stored weather reads safely (weatherOf:
// missing = clear, a junk fog = Fog 300).
const WEATHER_ABOUT = {
  clear: "Clear: nothing changes on screen",
  rain: "Rain: nothing changes on screen (its 1-mile limit is beyond what anyone sees here)",
  snow: "Snow: nothing changes on screen (as rain)",
  heavy_rain: "Heavy rain: maps marked 🌳 Outdoor are lightly obscured (−5 Perception in the panel's 👁 badge); nothing changes on screen. Torches and the like go out: tap them out yourself",
  heavy_snow: "Heavy snow: maps marked 🌳 Outdoor are lightly obscured (−5 Perception in the panel's 👁 badge); nothing changes on screen",
};
export function weatherChips(sceneMeta) {
  const w = weatherOf(sceneMeta);
  return WEATHER_CHOICES.map((c) => ({
    kind: c.kind, fog_ft: c.fog_ft, label: c.label, on: c.kind === w.kind && c.fog_ft === w.fog_ft,
    title: c.kind === "fog"
      ? `Fog: on maps marked 🌳 Outdoor everyone sees at most ${c.fog_ft} ft (while 🌦 Weather is on), and it's lightly obscured (−5 in the 👁 badge)`
      : WEATHER_ABOUT[c.kind] || c.label,
  }));
}

// What a weather chip's tap writes: {key, value, changed} (weatherValue: whole; nothing written when
// the scene's weather already reads that way).
export function weatherTap(sceneMeta, choice) {
  const value = weatherValue(choice?.kind, choice?.fog_ft);
  const now = weatherOf(sceneMeta);
  return { key: WEATHER_KEY, value, changed: now.kind !== value.kind || now.fog_ft !== value.fog_ft };
}

// What the list says after a weather tap, and the line under the row (what the weather does now).
export function weatherSaid(choice, { changed = true, after = {}, fogOn = true } = {}) {
  return `Weather: ${choice?.label || "Clear"}${changed ? "" : " (already so)"}${weatherNote(after, { fogOn }) ? ` · ${weatherNote(after, { fogOn })}` : ""}`;
}
export function weatherNote(sceneMeta, { fogOn = true } = {}) {
  const w = weatherOf(sceneMeta);
  if (w.kind !== "fog") return w.obscured ? "lightly obscured outdoors: the 👁 badge counts it; nothing changes on screen" : "";
  if (!rulesOf(sceneMeta).weather) return "🌦 Weather is off: the fog changes nothing on screen yet (the 👁 badge still counts it)";
  if (!fogOn) return "it works through 🌫 Our fog, which is off in this scene";
  return `everyone sees at most ${w.fog_ft} ft on maps marked 🌳 Outdoor`;
}

// ---- the 🔥 Lighting list ----

// {pcs: [...], lit: [...], npcs: [...]} for the scene's items: every PC token (roots only: a ring
// under a mini follows its parent) with its sight, its four senses and light; every other item with a
// light (the DM's, a spell's, one lit by its name, an adopted Smoke torch), by name; and npcs: every
// CHARACTER token that isn't a PC, lit or not (the box's ▸ NPCs & monsters), its row the same fields as
// a lit one's, a token attached under another CHARACTER left out (it follows its parent, as a ring
// under a PC's mini does). A lit NPC is in both lit and npcs. A PC row's senses
// (docs/vision-layer-2024.md, "The Lighting list (U)"): dark, blind, truesight: the DM's override
// (feet or null); sheetDark, sheetBlind, sheetTruesight, sheetTremor: the party file's (feet or
// null); darkFt, blindFt, truesightFt, tremorFt: what counts (feet). seesFt: how far the fog opens
// for it (fx/lightmeta.js seerReachFt, the same number as its sight light with every 2024 switch
// off: on 🌑 ground its darkvision, its own light or the far edge of a light on its OWN map, never
// another map's); where: the darkness under it.
export function lightingRows(items, ctx) {
  const pcs = [], lit = [], npcs = [];
  for (const i of items || []) {
    if (!i?.id || (i.layer && !["CHARACTER", "PROP", "MOUNT", "ATTACHMENT"].includes(i.layer))) continue;
    if (i.metadata?.[CARRIER_KEY]) continue; // our invisible carrier child: its NPC is listed
    const eff = effectiveLight(i, ctx.lighting);
    const hand = i.metadata?.[LIGHT_KEY]?.kind;
    if (ctx.isPc(i)) {
      if (i.attachedTo && ctx.isPc(ctx.byId?.get?.(i.attachedTo))) continue;
      const dm = i.metadata?.[VISION_KEY]?.dm || {};
      const v = visionOf(i, ctx);
      const s = senseParts(i, ctx, v);
      pcs.push({ id: i.id, name: nameOf(i, ctx), sight: dm.sight ?? null, dark: dm.dark ?? null,
                 blind: s.over.blind, truesight: s.over.truesight,
                 sheetDark: s.sheet.dark, sheetBlind: s.sheet.blind, sheetTruesight: s.sheet.truesight, sheetTremor: s.sheet.tremor,
                 seesFt: LM.seerReachFt(i, ctx, v), where: v.where,
                 darkFt: v.dark, blindFt: s.used.blind, truesightFt: s.used.truesight, tremorFt: s.used.tremor,
                 kind: known(hand) ? hand : hand === "none" ? "none" : "", eff });
      continue;
    }
    const row = () => ({ id: i.id, name: nameOf(i, ctx), kind: known(hand) ? hand : hand === "none" ? "none" : "", eff,
                         auto: eff?.from === "auto", smoke: eff?.from === "smoke", spell: eff?.from === "spell",
                         hidden: !!ctx.isSecret?.(i), layer: i.layer || "" });
    if (eff || hand === "none") lit.push(row());
    if (i.layer === "CHARACTER" && !(i.attachedTo && ctx.byId?.get?.(i.attachedTo)?.layer === "CHARACTER")) npcs.push(row());
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { pcs: pcs.sort(byName), lit: lit.sort(byName), npcs: npcs.sort(byName) };
}

// The items "Release lights to Smoke" gives back: every token we manage (VISION_KEY on it).
export const managed = (items) => (items || []).filter((i) => i?.metadata?.[VISION_KEY] && !i.metadata[CARRIER_KEY]);
// The carriers we made for lit NPCs (fx/lightwriter.js): released scenes don't keep them.
export const carriers = (items) => (items || []).filter((i) => i?.metadata?.[CARRIER_KEY]);

// ---- the scene's and each map's darkness: the 🔥 Lighting list (lightpanel.js "This scene" and ▸ Maps)
// and 🎲 DND's ☀ Scene lights tab (maplight.html) write them the same way, from these ----

// The scene's lighting as it is, its darkness "lit" when unmarked (fx/darkness.js), so a write of
// another field never marks an unmarked scene dim.
export const lightingNow = (sceneMeta) => ({ ...lightingOf(sceneMeta), darkness: sceneDarkness(sceneMeta) });

// A control changed an input: a scene released to Smoke is ours again (spec). The scene's lighting to
// write (managed true), or null when the scene is ours already.
export function takenBack(sceneMeta) {
  const cur = lightingNow(sceneMeta);
  return cur.managed ? null : { ...cur, managed: true };
}

// The scene's lighting after a "This scene" tap (`patch`: {darkness} or {auto}): whole, ours (managed).
export const sceneNext = (sceneMeta, patch) => ({ ...lightingNow(sceneMeta), ...patch, managed: true });

// The scene's "Props light themselves" switch (SCENE_LIGHTING_KEY.auto): its words and tooltip.
export const propsLabel = (auto) => (auto ? "✓ Props light themselves" : "Props light themselves");
export const PROPS_TITLE = "Sconces, torches, braziers, candles, lanterns and lamps light by their name or picture";
// Said while the scene is released to Smoke.
export const RELEASED_SAID = "Released to Smoke: Smoke draws vision and darkvision here (our flames still show). Any control here takes it back.";

// One map's own darkness, as one updateItems' edit: "lit" | "dim" | "dark", or null (as the scene:
// written as an explicit null, never a deleted key: a JSON-patch "remove" of a key another screen lacks
// desyncs it, live 2026-10-12). A map already so is left alone (missing = as the scene).
export function mapDarkEdit(code) {
  const value = code || null;
  return (drafts) => {
    for (const d of drafts) {
      if ((d.metadata?.[MAP_DARKNESS_KEY] ?? null) === value) continue; // already so (missing = as the scene)
      if (!d.metadata) d.metadata = {};
      d.metadata[MAP_DARKNESS_KEY] = value;
    }
  };
}

const OURS_AGAIN = " · lights are ours again in this scene";
// What a tap says. A map's: "Cellar: 🌑 dark · 3 token(s) updated · lights are ours again in this scene"
// (n: the tokens whose Smoke keys changed; back: the scene was released and is ours again).
export function mapDarkSaid(name, code, n, back) {
  const d = DARKNESS.find((x) => x.value === code);
  return `${name || "Map"}: ${d ? `${d.icon} ${d.label}` : "as the scene"}${n ? ` · ${n} token(s) updated` : ""}${back ? OURS_AGAIN : ""}`;
}
// The scene's: "☀ Scene lit · props light themselves · 2 token(s) updated" (wasManaged: before the tap).
export function sceneSaid(next, patch, n, wasManaged) {
  const d = DARKNESS.find((x) => x.value === next.darkness);
  return `${d.icon} Scene ${d.label}${"auto" in patch ? ` · props ${next.auto ? "light themselves" : "stay as you set them"}` : ""}`
    + (n ? ` · ${n} token(s) updated` : "") + (wasManaged ? "" : OURS_AGAIN);
}

// 🌑 is fog only, and the DM's stored remembered or clear waits there (fog/mode.js fogMode): a darkness
// tap that lifts a map off 🌑 draws that pick again with no other prompt (review of dark-fix,
// 2026-10-14), so such a tap says which maps' picks are drawn again, and the 🪵 Live log gets it.
// picksWaiting(rows): the maps (fog/mapui.js mapRows, while 🌫 Our fog is on) on 🌑 holding a stored
// remembered or clear, by id, before the tap. picksDrawnAgain(before, rows, word): after it, one
// " · Inn: your clear is drawn again (tap auto to drop it)" for each drawn again (word: mapui modeWord).
export const picksWaiting = (rows) =>
  new Map((rows || []).filter((r) => r.darkLocked && r.override && r.override !== "fog").map((r) => [r.id, r]));
export const picksDrawnAgain = (before, rows, word = (m) => m) =>
  (rows || []).filter((r) => before.has(r.id) && !r.darkLocked && r.override === before.get(r.id).override)
    .map((r) => ` · ${r.name || "Map"}: your ${word(r.override)} is drawn again (tap auto to drop it)`).join("");

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
