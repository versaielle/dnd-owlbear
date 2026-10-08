// The lights from spells cast on the panel (Light, Continual Flame, Dancing Lights, Produce
// Flame), written on the tokens. The panel sends the WHOLE list in effect each time:
// {op: "lights", lights: [{magic, id, kind, pc}]} (magic: the Magic-in-effect entry, id: the
// token that shines, pc: that token is a player character), so a light whose magic ended is
// simply missing from the list and goes out; an empty list puts them all out. Runs on the
// bridge tab (background.js JOBS); every screen then draws the flames from the tokens
// (fx/lighting.js), and Smoke & Spectre's range follows in the same write (fx/lightmeta.js).
// The DM's own light (🔥 Light menu, LIGHT_KEY) is never touched here: a spell ending never
// puts out a torch. A hidden token that isn't a PC (or one attached to a hidden one) gets its
// light but no Smoke torch (lightmeta.js: Smoke would show every player where it stands).

import { SPELL_LIGHT_KEY } from "../keys.js?v=b6b85c2-d73ac97";
import { applyLight, isSecret, lightChanges, reachOf, withParents } from "./lightmeta.js?v=b6b85c2-d73ac97";
import { SOURCES } from "./lights.js?v=b6b85c2-d73ac97";

// lightChanges() lives in lightmeta.js now; still offered here for older importers.
export { lightChanges };

// A light we know how to draw (own keys only: "toString" is not a light).
const known = (kind) => typeof kind === "string" && Object.prototype.hasOwnProperty.call(SOURCES, kind);

// The light each token should have from the list: token id -> {kind, magic, pc}. Two spells on
// one token: the one that reaches further (the first of equals). Unknown kinds and entries
// with no token are left out (counted in `skipped`).
export function wantedLights(list) {
  const want = new Map();
  let skipped = 0;
  for (const l of list) {
    if (!l || l.id == null || l.id === "" || !known(l.kind)) {
      skipped++;
      continue;
    }
    const id = String(l.id);
    const had = want.get(id);
    if (!had || reachOf(l.kind) > reachOf(had.kind)) want.set(id, { kind: l.kind, magic: l.magic ?? null, pc: !!l.pc });
  }
  return { want, skipped };
}

// How a token is written: pc from the job (it only ever upgrades a token to one that sees),
// secret when no player's screen shows it (no Smoke torch for it): hidden, itself or through
// what it's attached to (`scene`: {parentOf, isPc} for lightmeta's isSecret()), and not a PC.
const optsFor = (item, w, scene) => {
  const pc = (w ? w.pc : false) || scene.isPc(item.id);
  return { pc, secret: !pc && isSecret(item, scene) };
};

// Is this tab still the bridge? No check given: yes (the offline checks). A check that throws: no.
function holds(stillBridge) {
  if (typeof stillBridge !== "function") return true;
  try {
    return !!stillBridge();
  } catch {
    return false;
  }
}

// The newest list, applied again whenever a scene opens on this tab: a list that came while
// no scene was ready isn't lost, and a scene the party comes back to gets its lights back
// (the panel only sends the list on a cast, an end or a new lease). A list that changes
// nothing writes nothing, so this is cheap. Only while this tab still holds the bridge's
// lease (`stillBridge`, from background.js): once another tab has it, this list is stale
// (the panel sends the new bridge the newest on its new lease) and writing it would undo
// that tab's, so it's dropped.
let last = null; // {job, stillBridge}
let watching = false;
function watchScenes(OBR) {
  if (watching) return;
  watching = true;
  try {
    OBR.scene.onReadyChange((ready) => {
      if (!ready || !last) return;
      if (!holds(last.stillBridge)) {
        last = null;
        return;
      }
      syncSpellLights(OBR, last.job, { stillBridge: last.stillBridge })
        .catch((e) => console.warn("dnd-npc: spell lights", e));
    });
  } catch (e) {
    watching = false;
    console.warn("dnd-npc: spell lights", e);
  }
}

// Bring the tokens in this scene in line with the list, in ONE write (Owlbear rate-limits
// bursts, and Smoke & Spectre redoes its vision on every screen after each write). Tokens not
// in this scene are left for when that scene opens again (watchScenes). `stillBridge`: a
// function that says whether this tab still holds the bridge's lease (for that re-sync).
// Returns a small summary: {ok, set, cleared, missing: [ids], skipped}, or {ok: false, why}.
// `isPc(id)`: the PC tokens this tab knows besides the job's own (the bridge's heartbeat list),
// so a light attached to a hidden PC is judged the way the 🔥 Light menu and the guard in
// fx/lighting.js judge it.
export async function syncSpellLights(OBR, job, { stillBridge, isPc } = {}) {
  if (!Array.isArray(job?.lights)) return { ok: false, why: "no list" }; // never put lights out on a garbled job
  last = { job, stillBridge };
  watchScenes(OBR);
  if (!(await OBR.scene.isReady())) return { ok: false, why: "no scene" };
  const { want, skipped } = wantedLights(job.lights);
  const items = await OBR.scene.items.getItems((i) => want.has(i.id) || i.metadata?.[SPELL_LIGHT_KEY] !== undefined);
  const byId = await withParents(OBR, items);
  const pcs = new Set([...want].filter(([, w]) => w.pc).map(([id]) => id)); // the PCs the job names
  const known = (id) => { try { return typeof isPc === "function" && !!isPc(id); } catch { return false; } };
  const scene = { parentOf: (id) => byId.get(id), isPc: (id) => pcs.has(id) || known(id) };
  const changes = new Map(); // token id -> [change, the job's entry or undefined]
  let set = 0, cleared = 0;
  for (const i of items) {
    const w = want.get(i.id);
    const change = w ? { spell: { kind: w.kind, magic: w.magic } } : { spell: null };
    if (!lightChanges(i.metadata, change, optsFor(i, w, scene))) continue;
    changes.set(i.id, [change, w]);
    if (w) set++;
    else cleared++;
  }
  const found = new Set(items.map((i) => i.id));
  const missing = [...want.keys()].filter((id) => !found.has(id));
  if (changes.size) {
    // A newer list came while this one was reading (a scene opening just as a job arrives): that
    // one writes what's wanted now, and this one would undo it. Or this tab dropped its list
    // meanwhile (no longer the bridge): stale too.
    if (last?.job !== job) return { ok: false, why: "a newer list" };
    await OBR.scene.items.updateItems([...changes.keys()], (drafts) => {
      for (const d of drafts) {
        const c = changes.get(d.id);
        if (c) applyLight(d.metadata, c[0], optsFor(d, c[1], scene)); // the draft's own `visible`, as it is now
      }
    });
  }
  return { ok: true, set, cleared, missing, skipped };
}
