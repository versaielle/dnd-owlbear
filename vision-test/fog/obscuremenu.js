// The "obscured" marks on drawn shapes (docs/vision-layer-2024.md section 7, "The zone makers"; Area 3a
// of the plan). The DM draws a shape, right-clicks it, opens 🎲 DND's ☁ Obscured tab (obscure.html;
// dndmenu.js TABS "obscure", V2: it was four right-click rows of their own) and taps one of four
// buttons. The mark is OBSCURE_KEY on the shape; the fog engine (fog/zoneread.js) reads it into a zone,
// and the zone hides things only while the scene's "☁ Obscured" switch is on (🔥 Lighting list). The tab
// is there whatever that switch (or 🌫 Our fog) says, so the DM can mark ahead.
//
//   MARKS                    "light" | "heavy" | "dark" | "clear": what each button does
//   MARK_LABELS              {light: "☁ Lightly obscured", heavy: "☁ Heavily obscured",
//                            dark: "🌑 Magic darkness", clear: "Clear obscured"}: the buttons' words
//   markFor(choice)          the whole OBSCURE_KEY value a button writes (rules2024.js obscureValue):
//                            light -> level "light"; heavy -> "heavy"; dark -> "heavy", magic, what "dark";
//                            clear -> level "none" (the mark stays, with no effect: never a deleted key).
//                            A drawn mark's what is "other" ("dark" for magic darkness), src "drawn".
//                            null for anything else
//   SHAPE_TYPES              the SHAPE kinds that can be marked: RECTANGLE, CIRCLE, HEXAGON (a triangle's
//                            outline is unknown: areas.js, the live test of 2026-10-02)
//   markable(item)           can this item be marked: a DRAWING-layer rectangle, circle or hexagon, a
//                            curve (the polygon tool, the brush) or a path; never a triangle, a straight
//                            line, text, or a wall line (ours or Smoke's: a wall is no area)
//   markedLevel(item)        "light" | "heavy" | "none" | null (no mark at all), as obscureOf reads it
//   wantsMark(item, choice)  would this choice write anything on this item: markable, a known choice,
//                            "clear" only on a shape marked light or heavy, and not already holding
//                            exactly that whole value (a second identical tap changes nothing)
//   applyMark(draft, choice) writes markFor(choice) whole, a fresh object, onto an updateItems draft
//                            when wantsMark says so; true when it wrote
//   NOT_MARKABLE             what the tab says when none of the shapes right-clicked can be marked
//   markText(choice, n, {zonesOn, skipped})  the line the tab says and the 🪵 log line after a tap
//   tabView(items)           what the tab shows for the items right-clicked: {n: the markable ones, on:
//                            the mark every one of them holds ("light" | "heavy" | "dark"; null for none,
//                            a mix, or nothing markable), clear: whether Clear would change any}
//   markShapes(OBR, ids, choice) -> {wrote: [ids], text, bad}: one tap. It reads the shapes right-clicked
//                            (ids), writes markFor(choice) to every one that wants it in ONE updateItems,
//                            decided on the draft (another DM browser may have got there first), and asks
//                            nothing of Owlbear when none does. text: markText, "<label>: already so",
//                            NOT_MARKABLE, or the refused write's words (bad true)
//
// Every write is whole and explicit; nothing here ever deletes a key.

import { OBSCURE_KEY, WALL_KEY } from "../keys.js?v=9a30147";
import { obscureOf, obscureValue, rulesOf } from "../rules2024.js?v=9a30147";
import { SMOKE_LINE } from "./lineread.js?v=9a30147";

export const MARKS = Object.freeze(["light", "heavy", "dark", "clear"]);
export const MARK_LABELS = Object.freeze({
  light: "☁ Lightly obscured", heavy: "☁ Heavily obscured", dark: "🌑 Magic darkness", clear: "Clear obscured",
});
const MARK = {
  light: { level: "light", magic: false, what: "other" },
  heavy: { level: "heavy", magic: false, what: "other" },
  dark: { level: "heavy", magic: true, what: "dark" },
  clear: { level: "none", magic: false, what: "other" },
};

export function markFor(choice) {
  const m = typeof choice === "string" && Object.hasOwn(MARK, choice) ? MARK[choice] : null;
  return m ? obscureValue({ ...m, src: "drawn" }) : null;
}

// ---- which items, and what a tap writes (pure) ----

export const SHAPE_TYPES = Object.freeze(["RECTANGLE", "CIRCLE", "HEXAGON"]);
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const describe = (e) => e?.error?.message || e?.message || String(e);

export function markable(item) {
  if (!isObj(item) || item.layer !== "DRAWING") return false;
  const meta = isObj(item.metadata) ? item.metadata : {};
  if (meta[SMOKE_LINE.line] === true || isObj(meta[WALL_KEY])) return false; // a wall line is no area
  if (item.type === "SHAPE") return SHAPE_TYPES.includes(item.shapeType);
  return item.type === "CURVE" || item.type === "PATH";
}

export const markedLevel = (item) => obscureOf(item)?.level ?? null;

export function wantsMark(item, choice) {
  const value = markFor(choice);
  if (!value || !markable(item)) return false;
  const level = markedLevel(item);
  if (choice === "clear" && level !== "light" && level !== "heavy") return false;
  return JSON.stringify(item.metadata?.[OBSCURE_KEY] ?? null) !== JSON.stringify(value);
}

export function applyMark(draft, choice) {
  if (!wantsMark(draft, choice)) return false;
  if (!isObj(draft.metadata)) draft.metadata = {};
  draft.metadata[OBSCURE_KEY] = markFor(choice); // a fresh, whole value
  return true;
}

// ---- the words after a tap ----

const shapes = (n) => `${n} shape${n === 1 ? "" : "s"}`;
export const NOT_MARKABLE = "☁ Only a drawn rectangle, circle, hexagon, polygon or brush shape can be marked";

export function markText(choice, n, { zonesOn = null, skipped = 0 } = {}) {
  const label = MARK_LABELS[choice] ?? String(choice);
  let s = choice === "clear" ? `${label}: ${shapes(n)} no longer obscured` : `${label}: ${shapes(n)}`;
  if (skipped > 0) s += ` (${skipped} left as they were)`;
  if (choice !== "clear" && zonesOn === false) s += " · ☁ Obscured is off in the 🔥 Lighting list, so it hides nothing yet";
  return s;
}

// ---- the tab (obscure.html) ----

// A shape's mark as the tab's buttons name it: magic darkness is a heavy mark with magic; none or cleared: null.
const markOf = (item) => {
  const o = obscureOf(item);
  if (!o || (o.level !== "light" && o.level !== "heavy")) return null;
  return o.level === "heavy" && o.magic ? "dark" : o.level;
};

export function tabView(items) {
  const list = (Array.isArray(items) ? items : []).filter(markable);
  const marks = new Set(list.map(markOf));
  return { n: list.length, on: list.length && marks.size === 1 ? [...marks][0] : null, clear: list.some((i) => wantsMark(i, "clear")) };
}

export async function markShapes(O, ids, choice) {
  const label = MARK_LABELS[choice] ?? String(choice);
  const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id);
  const picked = list.length ? ((await O.scene.items.getItems(list)) || []).filter(isObj) : [];
  // Asked of Owlbear only when some shape wants it; whether each one does is decided again on the draft.
  const want = picked.filter((i) => wantsMark(i, choice)).map((i) => i.id);
  if (!want.length) return { wrote: [], text: picked.some(markable) ? `${label}: already so` : NOT_MARKABLE, bad: false };
  const wrote = [];
  try {
    await O.scene.items.updateItems(want, (drafts) => {
      for (const d of drafts) if (applyMark(d, choice)) wrote.push(d.id);
    });
  } catch (e) {
    return { wrote: [], text: `☁ The mark could not be written: ${describe(e)}`, bad: true };
  }
  if (!wrote.length) return { wrote, text: `${label}: already so`, bad: false }; // another DM browser got there first
  let zonesOn = null;
  try { zonesOn = rulesOf(await O.scene.getMetadata()).zones; } catch { /* unknown: said nothing about it */ }
  return { wrote, text: markText(choice, wrote.length, { zonesOn, skipped: picked.length - wrote.length }), bad: false };
}
