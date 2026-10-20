// The DM's door click (docs/vision-layer-b2b3.md section 4, fog/doors.js): which door icon a change
// of selection works. Pure: no Owlbear import, so the offline checks load it too.
//
//   clickedHandle(prev, next, handleOf, {gm, doorTap})  the one door icon a selection change works:
//                        {id, via: "ctrl/double-click" | "tap"} | null. prev, next: the selection before and
//                        after it (item ids); handleOf(id): this copy's door icon with that id
//                        ({held}: drawn as a locked item), or null; gm: a GM screen; doorTap: ctx.doorTap
//   clickedLine(prev, next, isDoorLine, {gm})  on a GM screen, the one door LINE a selection change
//                        newly takes when this copy draws an icon on it (isDoorLine(id) === true): its
//                        id, else null. Nothing is worked; the screen says what happened (LINE_PICKED)
//   LINE_PICKED          what a GM screen tells the DM then
//
// Why a selection: a tool mode's ToolEvent has ctrlKey and metaKey, but only an extension's own mode
// gets pointer events, never Owlbear's Move tool, and a selection change is ids alone (no keys). What
// Owlbear does give: a LOCKED item is selected only by a deliberate Ctrl+click (Cmd+click on a Mac;
// the DM's find, 2026-10-13) or a double-click (its docs: a locked image "can only be selected with a
// double click"), never by a plain click or a drag box. So a GM screen draws its door icons locked,
// and a selection that takes one of them is the DM's gesture. The rule:
//   - exactly one item newly selected, and it is one of this copy's door icons: several at once (a box,
//     a select-all) work nothing, and neither does a selection that only shrinks or stays the same;
//   - on a GM screen, an icon drawn locked: "ctrl/double-click" (a Ctrl+click and a double-click both
//     select a locked item, and a selection change can't tell which: the plan's decision 78); with
//     ctx.doorTap (a live-check flag), any select of an icon on any screen: "tap".
// A player's icon (unlocked) is otherwise left alone: a right-click or a long-press selects it too, and
// the menu that opens is the player's way to work a door.
//
// THE LINE ON TOP (review of the merge round, 2026-10-13). The shared door line is a hidden, locked
// CURVE on the POINTER layer (interiors.js wallItem), above the PROP-layer icon, and it runs through
// the icon's middle (the icon sits at the line's midpoint). On a GM screen hidden items can be hit and
// a Ctrl+click selects a locked item, so a Ctrl+click on the icon's centre may take the LINE instead
// (not checked live). That works nothing: the line's own menu (right-click) has Open / Close and Lock
// / Unlock, and the DM may select the line on purpose for it. So the screen only says what happened,
// instead of nothing at all.

export const LINE_PICKED = "🚪 That took the door's line, not its icon: right-click the line for Open / Close or Lock / Unlock,"
  + " or Ctrl+click the icon just off the line to open or close it";

// The ids a selection change newly takes (each once).
function newlyTaken(prev, next) {
  const before = new Set(Array.isArray(prev) ? prev : []);
  return [...new Set(Array.isArray(next) ? next : [])].filter((id) => !before.has(id));
}

export function clickedLine(prev, next, isDoorLine, opts = {}) {
  const { gm = false } = opts || {};
  if (!gm) return null;
  const added = newlyTaken(prev, next);
  if (added.length !== 1 || typeof isDoorLine !== "function") return null;
  return isDoorLine(added[0]) === true ? added[0] : null;
}

export function clickedHandle(prev, next, handleOf, opts = {}) {
  const { gm = false, doorTap = false } = opts || {};
  const added = newlyTaken(prev, next);
  if (added.length !== 1) return null;
  const h = typeof handleOf === "function" ? handleOf(added[0]) : null;
  if (!h) return null;
  if (gm && h.held === true) return { id: added[0], via: "ctrl/double-click" };
  if (doorTap) return { id: added[0], via: "tap" };
  return null;
}
