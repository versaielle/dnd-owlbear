// Sample FxEvents: one per archetype, plus a full Fireball (the "big" one that shakes the table
// screen). They're anchored to the middle of whoever's view plays them ({view: true}, with an
// offset in cells), so the popover's 🧪 test, the offline checks and the dev page can play them
// on any map. Shaped exactly like fx_events.py's events (spec 7.4), plus a short `name`.
//
// SAMPLES is a list of the events themselves (each with its `name` and `label`), and
// sample(name) hands out a fresh copy with an id of its own. The engine never plays the same
// part of the same event twice within a minute (so a public copy, a GM delta and a repeat can't
// double-draw); a test pressed twice must still play twice, so each copy gets a new id, and the
// engine never holds back an event whose id starts with "sample-" (the popover may play the
// same SAMPLES entry again).
//
// This file is published (R9): no campaign names in it, only spell and weapon names.

const V = (x = 0, y = 0) => ({ view: true, off: { x, y } });
let n = 0;
const ev = (label, parts, extra = {}) => ({ v: 1, id: null, seed: 7.3 + ++n, label, big: false, pcs: [],
  template: null, dur_ms: Math.max(...parts.map((p) => (p.start || 0) + (p.dur || 0))), parts, ...extra });
const tpl = (shape, size, at, rot = 0, extra = {}) => ({ shape, origin: at, rot, size_ft: size, width_ft: 5,
  from: "point", caster_token: null, dpi: 150, ft_per_cell: 5, ...extra });
// One sample: the event, named, with a stable id ("sample-fireball").
const S = (name, event) => ({ ...event, name, id: `sample-${name}` });

export const SAMPLES = [
  S("bolt", ev("Fire Bolt", [
    { arch: "bolt", from: V(-3, 0), to: V(3, 0), start: 0, dur: 570, hit: 0.47, color: "fire", power: 0.6, cue: "bolt.fire" },
    { arch: "impact", at: V(3, 0), start: 270, dur: 350, color: "fire", cue: "impact.fire" },
    { arch: "number", at: V(3, 0), start: 320, dur: 900, text: "−7", tone: "damage" },
  ])),
  S("ray", ev("Eldritch Blast", [
    { arch: "ray", from: V(-3, 0), to: V(3, 0), start: 0, dur: 900, hit: 0.18, color: "force", power: 0.6, params: { crackle: 0.6, hits: 1 }, cue: "ray.force" },
  ])),
  S("arrow", ev("Shortbow", [
    { arch: "arrow", from: V(-3, 0), to: V(3, 0), start: 0, dur: 467, hit: 0.75, color: "steel", power: 0.7, cue: "arrow.loose" },
  ])),
  S("burst", ev("Acid Splash", [
    { arch: "burst", at: { template: true }, start: 0, dur: 900, hit: 0.02, color: "acid", power: 0.6, params: { smoke: 0.3, shock: 0.4 }, cue: "boom.acid" },
  ], { template: tpl("sphere", 5, V(0, 0)) })),
  S("cone", ev("Cone of Cold", [
    { arch: "cone", at: { template: true }, start: 0, dur: 1100, hit: 0.25, color: "cold", power: 1.4, params: { jet: 0.4 } },
  ], { template: tpl("cone", 15, V(-1.5, 0), 0, { from: "self" }) })),
  S("line", ev("Lightning Bolt", [
    { arch: "line", at: { template: true }, start: 0, dur: 800, hit: 0.05, color: "lightning", power: 1.4, params: { jag: 1, strobes: 3 } },
  ], { template: tpl("line", 30, V(-3, 0), 0, { from: "self" }) })),
  S("cube", ev("Faerie Fire", [
    { arch: "cube", at: { template: true }, start: 0, dur: 1000, hit: 0.1, color: "faerie", power: 1.0, params: { sparkle: 1, shock: 0.3 }, cue: "sparkle" },
  ], { template: tpl("cube", 15, V(0, 0)) })),
  S("glow", ev("Healing Word", [
    { arch: "glow", at: V(0, 0), start: 0, dur: 1100, hit: 0.2, color: "heal", params: { ring_dir: 1, motes: 0.7 }, cue: "heal" },
  ])),
  S("smite", ev("Hellish Rebuke", [
    { arch: "smite", at: V(0, 0), start: 0, dur: 750, hit: 0.03, color: "fire", params: { rays: 6, flare: 0.8 } },
  ])),
  S("sparkle", ev("Druidcraft", [
    { arch: "sparkle", at: V(0, 0), start: 0, dur: 1000, hit: 0.15, color: "plant", cue: "sparkle" },
  ])),
  S("slash", ev("Greatsword", [
    { arch: "slash", from: V(-1, -0.5), at: V(0, 0), start: 0, dur: 450, hit: 0.25, color: "steel", power: 0.7, cue: "weapon.slash" },
  ])),
  S("thrust", ev("Rapier", [
    { arch: "thrust", from: V(-1, 0), at: V(0, 0), start: 0, dur: 450, hit: 0.3, color: "steel", power: 0.7 },
  ])),
  S("smash", ev("Shillelagh", [
    { arch: "smash", from: V(-1, 1), at: V(0, 0), start: 0, dur: 450, hit: 0.25, color: "shillelagh", power: 0.7 },
  ])),
  S("bite", ev("Wolf bite", [
    { arch: "bite", from: V(1, 0), at: V(0, 0), start: 0, dur: 500, hit: 0.3, color: "steel", power: 0.7, cue: "bite" },
  ])),
  S("impact", ev("Impact", [
    { arch: "impact", at: V(0, 0), start: 0, dur: 350, hit: 0, color: "force", params: { dir: 0, strength: 1 } },
  ])),
  S("resist", ev("Resisted", [
    { arch: "resist", from: V(-3, 0), at: V(0, 0), start: 0, dur: 600, hit: 0.1, color: "radiant", cue: "resist" },
    { arch: "number", at: V(0, 0), start: 50, dur: 900, text: "½ 6", tone: "half" },
  ])),
  S("death", ev("A goblin falls", [
    { arch: "death", at: V(0, 0), start: 0, dur: 1200, hit: 0.5, color: "down", params: { beats: 0 }, cue: "down.foe" },
  ])),
  S("death-pc", ev("A hero drops", [
    { arch: "death", at: V(0, 0), start: 0, dur: 1200, hit: 0.5, color: "down", params: { beats: 2 }, cue: "down.pc" },
  ])),
  S("flash", ev("Flash", [
    { arch: "flash", start: 0, dur: 250, color: "fire", params: { amt: 0.25 }, big_only: true },
  ], { big: true })),
  S("shake", ev("Shake", [
    { arch: "shake", start: 0, dur: 350, params: { amp: 10 }, big_only: true },
  ], { big: true })),
  S("number", ev("Numbers", [
    { arch: "number", at: V(-1.5, 0), start: 0, dur: 900, text: "−12", tone: "damage" },
    { arch: "number", at: V(0, 0), start: 100, dur: 900, text: "+5", tone: "heal" },
    { arch: "number", at: V(1.5, 0), start: 200, dur: 900, text: "miss", tone: "miss" },
  ])),
  S("fireball", ev("Fireball", [
    { arch: "bolt", from: V(-5, 2), to: { template: true }, start: 0, dur: 450, hit: 1.0, color: "fire", power: 1.0, params: { wobble: 0 }, cue: "bolt.fire" },
    { arch: "burst", at: { template: true }, start: 450, dur: 1400, hit: 0.02, color: "fire", power: 1.4, params: { smoke: 0.7, shock: 0.4 }, cue: "boom.fire" },
    { arch: "flash", start: 450, dur: 250, color: "fire", params: { amt: 0.25 }, big_only: true },
    { arch: "shake", start: 450, dur: 350, params: { amp: 10 }, big_only: true },
    { arch: "impact", at: V(1.5, 0.5), start: 480, dur: 350, color: "fire" },
    { arch: "number", at: V(1.5, 0.5), start: 530, dur: 900, text: "−24", tone: "damage" },
    { arch: "resist", from: { template: true }, at: V(-1.5, -1), start: 480, dur: 600, color: "fire", cue: "resist" },
    { arch: "number", at: V(-1.5, -1), start: 530, dur: 900, text: "½ 12", tone: "half" },
    { arch: "death", at: V(1.5, 0.5), start: 1000, dur: 1200, hit: 0.5, color: "down", params: { beats: 0 }, cue: "down.foe" },
  ], { big: true, template: tpl("sphere", 20, V(0, 0)) })),
];

let k = 0;
// A fresh copy of one sample, with an id no other event has; null for an unknown name.
export function sample(name) {
  const found = SAMPLES.find((e) => e.name === name);
  if (!found) return null;
  const copy = JSON.parse(JSON.stringify(found));
  copy.id = `sample-${name}-${Date.now().toString(36)}-${(++k).toString(36)}`;
  return copy;
}
