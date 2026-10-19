// The right-click "obscured" marks on drawn shapes (docs/vision-layer-2024.md, "fog/obscuremenu.js";
// Area 3a of the plan). A STUB, written by step C (the contract) so the fog engine can call it before
// it's built: createObscureMenu makes no menu and writes nothing. F2 (the zone makers) fills it in.
//
//   OBSCURE_MENU             the menu ids, one per item: light, heavy, dark (magic darkness), clear
//   obscureMenuIds(host)     the ids this copy uses: Owlbear's menu ids are room-wide, so the copy served
//                            by this PC ("local") has its own, as fog/doors.js menuIds does
//   MARKS                    "light" | "heavy" | "dark" | "clear": what each item does
//   markFor(choice)          the whole OBSCURE_KEY value an item writes (rules2024.js obscureValue):
//                            light -> level "light"; heavy -> "heavy"; dark -> "heavy", magic, what "dark";
//                            clear -> level "none" (the mark stays, with no effect: never a deleted key).
//                            A drawn mark's what is "other" ("dark" for magic darkness), src "drawn".
//                            null for anything else
//   createObscureMenu(api, ctx) -> {start(), stop(), status()}
//                            api: background.js's sdk ({OBR, ...}); ctx: {host, isGm, log(text, kind)}.
//                            Built (F2): on a GM screen while 🌫 Our fog is on, start() creates the four
//                            items (GM only; DRAWING-layer shapes, lines and paths, never a triangle;
//                            "Clear obscured" only on a shape marked light or heavy); a click writes
//                            markFor(choice) whole to every selected shape in one updateItems, on the
//                            draft, skipping a shape that already holds it; stop() removes this copy's
//                            items. STUB: both resolve at once and do nothing; status() says so.
//
// Every write is whole and explicit; nothing here ever deletes a key.

import { obscureValue } from "../rules2024.js?v=d96a2d9";

export const OBSCURE_MENU = Object.freeze({
  light: "dnd-npc/fog/obscure-light", heavy: "dnd-npc/fog/obscure-heavy",
  dark: "dnd-npc/fog/obscure-dark", clear: "dnd-npc/fog/obscure-clear",
});
export const obscureMenuIds = (host) => (host === "local"
  ? Object.fromEntries(Object.entries(OBSCURE_MENU).map(([k, id]) => [k, id.replace("dnd-npc/", "dnd-npc/local/")]))
  : { ...OBSCURE_MENU });

export const MARKS = Object.freeze(["light", "heavy", "dark", "clear"]);
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

export function createObscureMenu(api = {}, ctx = {}) {
  return {
    start: async () => {},
    stop: async () => {},
    status: () => ({ stub: true, menus: 0 }),
  };
}
