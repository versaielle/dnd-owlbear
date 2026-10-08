// What a light does to a token's metadata: our own keys, and Smoke & Spectre's vision keys set
// from the D&D numbers. Pure functions over a plain metadata object (an Owlbear draft's
// `metadata` in updateItems, or a test's object), no Owlbear import, so the offline checks
// load it too. The 🔥 Light menu (light.html) and the spell lights (fx/lightjobs.js) both write
// through applyLight(); every screen reads lightOf() to know which flame to draw.
//
// Two kinds of token:
//   - one that SEES (a PC, or anything Smoke already gives vision without being a torch):
//     a light it carries raises its own Smoke range to the light's reach. Never isTorch: that
//     would make its light SECONDARY, and it would stop revealing the fog for its player.
//   - anything else (a sconce, a brazier, a lamp on a table): it becomes a Smoke torch
//     (hasVision + isTorch, what Smoke's own "Enable Torchlight" writes) with the light's reach.
//     But not while it's SECRET (hidden, itself or through what it's attached to, and not a PC:
//     isSecret() below): Smoke lights the fog around every torch a GM made on every player's
//     screen, hidden or not, so a hidden goblin's torch would show where it stands. A secret one
//     gets no Smoke keys at all (the ones we wrote go back); our own keys stay, so its light
//     comes back once it is shown and written again.
// Smoke's values from before our first light are kept in LIGHT_BASE_KEY and put back when the
// last light goes, but only the ones still as we left them. A Smoke key the DM has changed
// since (in Smoke's own menu) is the DM's from then on: listed in LIGHT_BASE_KEY's `dm`, never
// written again while the token is lit, and left as the DM set it when the light goes.
// Smoke reads its values as strings ("40"), in the grid's units: feet on a 5 ft grid.
//
// LIGHT_BASE_KEY: {prev: {key: value or null}, sees, wrote: {key: value}, dm?: [keys]}

import { LIGHT_KEY, SPELL_LIGHT_KEY, LIGHT_BASE_KEY, SMOKE } from "../keys.js?v=b6b85c2-d73ac97";
import { SOURCES } from "./lights.js?v=b6b85c2-d73ac97";

const K = (name) => `${SMOKE}/${name}`;
// The Smoke keys we may write (and so may have to put back).
export const MANAGED = ["hasVision", "isTorch", "visionRange"];

// Smoke & Spectre's range for a token whose vision is on but has no visionRange (its default).
const SMOKE_RANGE = "30";

// Own keys only: "toString" or "__proto__" is not a light (SOURCES inherits them from Object).
const known = (kind) => typeof kind === "string" && Object.prototype.hasOwnProperty.call(SOURCES, kind);
export const reachOf = (kind) => (known(kind) ? SOURCES[kind].bright + SOURCES[kind].dim : 0);

// The light to draw for this token, or null: the bigger of the DM's light and a spell's (the
// DM's wins a tie). {kind, reach, from: "hand"|"spell", magic?}
export function lightOf(meta) {
  const hand = meta?.[LIGHT_KEY];
  const spell = meta?.[SPELL_LIGHT_KEY];
  const a = hand && known(hand.kind) ? { kind: hand.kind, reach: reachOf(hand.kind), from: "hand" } : null;
  const b = spell && known(spell.kind) ? { kind: spell.kind, reach: reachOf(spell.kind), from: "spell", magic: spell.magic ?? null } : null;
  if (a && b) return b.reach > a.reach ? b : a;
  return a || b;
}

// Does Smoke treat this token as one that sees (rather than a torch)?
function sees(meta, pc) {
  return !!pc || (meta[K("hasVision")] === true && meta[K("isTorch")] !== true);
}

// Two Smoke values the same? As strings (Smoke's own menu may write 40 where we wrote "40"),
// with a missing key and null alike.
const norm = (v) => (v === undefined || v === null ? null : String(v));
const same = (a, b) => norm(a) === norm(b);
const has = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

// Put one Smoke key back as it was before our first light (gone if it wasn't there).
function putBack(meta, k, prev) {
  const was = prev ? prev[k] : null;
  if (was === null || was === undefined) delete meta[K(k)];
  else meta[K(k)] = was;
}

// Which Smoke keys are still ours, and which the DM has taken: a key is the DM's once its value
// is no longer what we last left there (what we wrote, else what was there before our light).
// Returns {wrote: the ones still as we wrote them, dm: a Set of the DM's}.
function split(meta, base) {
  const wrote = {};
  const dm = new Set(Array.isArray(base.dm) ? base.dm.filter((k) => MANAGED.includes(k)) : []);
  for (const k of MANAGED) {
    if (dm.has(k)) continue;
    const ours = has(base.wrote, k);
    if (!same(meta[K(k)], ours ? base.wrote[k] : base.prev?.[k])) dm.add(k);
    else if (ours) wrote[k] = base.wrote[k];
  }
  return { wrote, dm };
}

// Change a token's lights and bring Smoke's keys in line. `change` is {hand?, spell?}:
//   hand:  a SOURCES kind, or null to put the DM's light out (undefined leaves it)
//   spell: {kind, magic} or null (undefined leaves it)
// `pc`: the token is a player character (it sees, whatever Smoke says now).
// `secret`: no player's screen shows the token (isSecret(): hidden, itself or through what it's
// attached to, and not a PC); it only matters for one that would be a torch.
// Mutates and returns `meta`. Unknown kinds count as null.
export function applyLight(meta, change = {}, { pc = false, secret = false } = {}) {
  if (!meta || typeof meta !== "object") return meta;
  if (change.hand !== undefined) {
    if (known(change.hand)) meta[LIGHT_KEY] = { kind: change.hand };
    else delete meta[LIGHT_KEY];
  }
  if (change.spell !== undefined) {
    const s = change.spell;
    if (s && known(s.kind)) meta[SPELL_LIGHT_KEY] = { kind: s.kind, magic: s.magic ?? null };
    else delete meta[SPELL_LIGHT_KEY];
  }

  const light = lightOf(meta);
  let base = meta[LIGHT_BASE_KEY];
  if (!light) {
    if (base && typeof base === "object") restore(meta, base);
    delete meta[LIGHT_BASE_KEY];
    return meta;
  }
  let wrote, dm;
  if (!base || typeof base !== "object") {
    // The first light on this token: remember Smoke's values, and how it sees.
    const prev = {};
    for (const k of MANAGED) prev[k] = meta[K(k)] === undefined ? null : meta[K(k)];
    base = { prev, sees: sees(meta, pc) };
    wrote = {};
    dm = new Set();
  } else {
    ({ wrote, dm } = split(meta, base));
    if (pc && !base.sees) base = { ...base, sees: true }; // recognised as a PC since: carry, never a torch
  }
  const prev = base.prev || {};
  const want = {};
  if (base.sees) {
    // Vision on with no range of its own: Smoke shows it at its default (a candle mustn't shrink it).
    const own = parseInt(prev.visionRange ?? (prev.hasVision === true ? SMOKE_RANGE : null), 10);
    want.visionRange = String(Math.max(Number.isFinite(own) ? own : 0, light.reach));
    if (meta[K("hasVision")] !== true) want.hasVision = true;
    if ("isTorch" in wrote) {
      // We made it a torch before it was known to see (a PC recognised since): put isTorch
      // back, or its light stays SECONDARY and never shows its player the map.
      putBack(meta, "isTorch", prev);
      delete wrote.isTorch;
    }
  } else if (secret) {
    // Hidden and not a PC: no Smoke torch (Smoke would light the fog where it stands on every
    // player's screen), and the Smoke keys we wrote while it was shown go back as they were.
    for (const k of Object.keys(wrote)) putBack(meta, k, prev);
    wrote = {};
  } else {
    want.hasVision = true;
    want.isTorch = true;
    want.visionRange = String(light.reach);
  }
  for (const [k, v] of Object.entries(want)) {
    if (dm.has(k)) continue; // the DM changed it since: theirs stays
    meta[K(k)] = v;
    wrote[k] = v;
  }
  // `dm` only once there is one, so a token lit before it existed isn't rewritten for nothing.
  const kept = { prev: base.prev, sees: base.sees, wrote };
  if (dm.size) kept.dm = MANAGED.filter((k) => dm.has(k));
  meta[LIGHT_BASE_KEY] = kept;
  return meta;
}

// Put Smoke's keys back as they were before our first light, each only if it still holds
// what we wrote (else the DM changed it since, and theirs stays).
function restore(meta, base) {
  const dm = Array.isArray(base.dm) ? base.dm : [];
  for (const k of MANAGED) {
    if (!has(base.wrote, k) || dm.includes(k)) continue;
    if (!same(meta[K(k)], base.wrote[k])) continue;
    putBack(meta, k, base.prev);
  }
}

// ---- would a write change anything? ----

// The keys a light reads or writes on a token: ours and the Smoke ones applyLight may change.
const KEYS = [LIGHT_KEY, SPELL_LIGHT_KEY, LIGHT_BASE_KEY, ...MANAGED.map(K)];

function lightPart(meta) {
  const out = {};
  for (const k of KEYS) if (meta?.[k] !== undefined) out[k] = meta[k];
  return out;
}

// JSON with every object's keys in order, so two equal values compare equal however they
// were built.
function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  if (x && typeof x === "object") {
    return `{${Object.keys(x).sort().filter((k) => x[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(",")}}`;
  }
  return JSON.stringify(x) ?? "null";
}

// Would applyLight() change this token's metadata? Tried on a copy, so a tap or a job that
// changes nothing writes nothing: every write to a scene item makes Smoke & Spectre redo its
// vision on every screen. The 🔥 Light menu (light.html) and the spell lights (lightjobs.js)
// both ask this before they write.
export function lightChanges(meta, change, opts) {
  const now = lightPart(meta);
  const after = applyLight(JSON.parse(JSON.stringify(now)), change, opts);
  return stable(now) !== stable(lightPart(after));
}

// ---- is a token secret? ----

// Would no player's screen show this token? Hidden itself, or through what it's attached to (an
// attachment is hidden with its parent unless its disableAttachmentBehavior has "VISIBLE"); a PC
// never is. `parentOf(id)`: the scene item with that id (undefined when it's gone: Owlbear
// deletes attachments with their parent, so nothing hides it then); `isPc(id)`. The same test
// as the torch guard in fx/lighting.js, so the menu, the spell lights and the guard never undo
// each other's Smoke keys. Attached deeper than 8 (or in a loop): secret, to be safe.
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
