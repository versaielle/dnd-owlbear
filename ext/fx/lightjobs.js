// The lights from spells cast on the panel (Light, Continual Flame, Dancing Lights, Produce
// Flame), written on the tokens. The panel sends the WHOLE list in effect each time:
// {op: "lights", lights: [{magic, id, kind, pc}]} (magic: the Magic-in-effect entry, id: the
// token that shines, pc: the panel thinks that token is a player character), so a light whose
// magic ended is simply missing from the list and goes out; an empty list puts them all out.
// Runs on the bridge tab (background.js JOBS); every screen then draws the flames from the tokens
// (fx/lighting.js). Each token is written through fx/lightmeta.js planItem(), the same pure
// function the leader's writer (fx/lightwriter.js) and the 🔥 menu use, so they never fight: a
// hidden token that isn't a PC gets its light but no Smoke keys (Smoke would show every player
// where it stands), a lit goblin's light goes on a carrier the leader makes. The DM's own light
// (LIGHT_KEY) is never touched here: a spell ending never puts out a torch.

import { SPELL_LIGHT_KEY } from "../keys.js?v=585985a-dc1dbb6";
import { lightChanges, planItem, reachOf, setSpellLight, stable, writeLightPart } from "./lightmeta.js?v=585985a-dc1dbb6";
import { planCtx } from "./lightwriter.js?v=585985a-dc1dbb6";
import { readGrid } from "./darkness.js?v=585985a-dc1dbb6";
import { SOURCES } from "./lights.js?v=585985a-dc1dbb6";
import { isPcToken } from "./pcs.js?v=585985a-dc1dbb6";

// lightChanges() lives in lightmeta.js; still offered here for older importers.
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

// Is this tab still the bridge? No check given: yes (the offline checks). A check that throws: no.
function holds(stillBridge) {
  if (typeof stillBridge !== "function") return true;
  try {
    return !!stillBridge();
  } catch {
    return false;
  }
}

// The newest list, applied again whenever a scene opens on this tab (see syncSpellLights): only
// while this tab still holds the bridge's lease (`stillBridge`, from background.js).
let last = null; // {job, stillBridge, isPc}
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
      syncSpellLights(OBR, last.job, { stillBridge: last.stillBridge, isPc: last.isPc })
        .catch((e) => console.warn("dnd-npc: spell lights", e));
    });
  } catch (e) {
    watching = false;
    console.warn("dnd-npc: spell lights", e);
  }
}

// What a token's metadata becomes for the list: its spell light set (or cleared), then planItem.
function planned(item, w, c) {
  const meta = JSON.parse(JSON.stringify(item.metadata || {}));
  setSpellLight(meta, w ? { kind: w.kind, magic: w.magic } : null);
  const view = { ...item, metadata: meta };
  return planItem(view, c) || (stable(meta) === stable(item.metadata || {}) ? null : meta);
}

// Bring the tokens in this scene in line with the list, in ONE write (Owlbear rate-limits
// bursts, and Smoke & Spectre redoes its vision on every screen after each write). Tokens not
// in this scene are left for when that scene opens again (watchScenes). A list that changes
// nothing writes nothing. `isPc(id, item)`: what this tab knows of PCs (background.js ctx.isPc);
// a token's WHO mark wins over it and over the job's own pc flags (fx/pcs.js).
// Returns {ok, set, cleared, missing: [ids], skipped}, or {ok: false, why}.
export async function syncSpellLights(OBR, job, { stillBridge, isPc } = {}) {
  if (!Array.isArray(job?.lights)) return { ok: false, why: "no list" }; // never put lights out on a garbled job
  last = { job, stillBridge, isPc };
  watchScenes(OBR);
  if (!(await OBR.scene.isReady())) return { ok: false, why: "no scene" };
  const { want, skipped } = wantedLights(job.lights);
  const [items, sm, rm, grid] = await Promise.all([
    OBR.scene.items.getItems(),
    Promise.resolve().then(() => OBR.scene.getMetadata?.()).catch(() => ({})),
    Promise.resolve().then(() => OBR.room?.getMetadata?.()).catch(() => ({})),
    readGrid(OBR),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const pcs = new Set([...want].filter(([, w]) => w.pc).map(([id]) => id)); // the PCs the job names
  const knows = (id, item) => { try { return typeof isPc === "function" && !!isPc(id, item); } catch { return false; } };
  const pcIds = (id) => pcs.has(id) || knows(id, byId.get(id));
  const c = planCtx(items, sm || {}, rm || {}, { pcTokens: pcIds, grid });
  const byRoom = c.isPc;
  c.isPc = (item) => isPcToken(item, { pcIds }) || byRoom(item); // the mark first, then the job and this tab, then the name
  const due = new Map(); // token id -> the job's entry or undefined
  let set = 0, cleared = 0;
  for (const i of items) {
    const w = want.get(i.id);
    if (!w && i.metadata?.[SPELL_LIGHT_KEY] === undefined) continue;
    if (!planned(i, w, c)) continue;
    due.set(i.id, w);
    if (w) set++;
    else cleared++;
  }
  const missing = [...want.keys()].filter((id) => !byId.has(id));
  if (due.size) {
    // A newer list came while this one was reading (a scene opening just as a job arrives): that
    // one writes what's wanted now, and this one would undo it. Or this tab dropped its list
    // meanwhile (no longer the bridge): stale too.
    if (last?.job !== job) return { ok: false, why: "a newer list" };
    await OBR.scene.items.updateItems([...due.keys()], (drafts) => {
      for (const d of drafts) {
        if (!due.has(d.id)) continue;
        const next = planned(d, due.get(d.id), c); // the draft as it is now
        if (next) writeLightPart(d.metadata, next);
      }
    });
  }
  return { ok: true, set, cleared, missing, skipped };
}
