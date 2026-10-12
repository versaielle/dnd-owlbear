// Names and numbers the aim tool, its HUD and the player's popover share. Pure constants:
// no SDK import, so the offline checks (check_aim.mjs, check_player.mjs) load it as is.

// Owlbear ids. Every tool, mode and action is created in background.js's frame, because
// Owlbear sends a tool's events to the frame that created it.
export const TOOL_ID = "dnd-npc/aim";
export const MODE_PLACE = "dnd-npc/aim/place";
export const MODE_PICK = "dnd-npc/aim/pick";
export const ACTION_LOCK = "dnd-npc/aim/lock";
export const ACTION_CANCEL = "dnd-npc/aim/cancel";
export const HUD_ID = "dnd-npc/aim-hud";
// Where we go back to when the tool we interrupted is unknown (or was the aim tool itself).
export const FALLBACK_TOOL = "rodeo.owlbear.tool/move";

// Metadata on every local item the aim tool draws. Same text as keys.js AIM_KEY (T6 adds it
// there); kept here too so this folder never fails to load against an older keys.js.
export const AIM_KEY = "dnd-npc/aim";

// Broadcast channels this folder uses, exactly as bus.js names them (spec section 7.3). The
// background passes its own bus in; these are the fallback when it doesn't.
export const CH = {
  AIM_LOCKED: "dnd-npc/aim/locked",
  CAST_REQUEST: "dnd-npc/cast/request",
  CAST_WITHDRAW: "dnd-npc/cast/withdraw",
  CAST_STATUS: "dnd-npc/cast/status",
  ROSTER: "dnd-npc/roster",
  HELLO: "dnd-npc/hello",
  BRIDGE: "dnd-npc/bridge",
  LOCAL_AIM: "dnd-npc/local/aim",
  LOCAL_HUD: "dnd-npc/local/hud",
  LOCAL_STATE: "dnd-npc/local/state",
  LOCAL_ASK: "dnd-npc/local/ask",
};

// The look of the preview (spec section 10.3). Sizes in grid cells, converted per scene.
export const EPS_CELLS = 0.05; // "any part of its space": the token's space shrunk by this on every side
export const STROKE_CELLS = 0.06;
export const FILL_OPACITY = 0.18;
export const STROKE_OPACITY = 0.9;
export const HIGHLIGHT_SCALE = 1.15; // caught highlights: a ring 1.15 x the token's space
export const SECRET_OPACITY = 0.55; // hidden monsters' highlights (GM screens only), dashed
export const AMBER = "#ffb347"; // a player's request / out of range
export const DEFAULT_COLOR = "#9a7bff"; // "arcane", when the spec carries no colour

// Rotating a cube or square: [ ] (and the HUD's buttons) turn it 15 degrees, 45 with Shift.
export const ROT_STEP = 15;
export const ROT_STEP_SHIFT = 45;

export const DRAW_MS = 33; // preview updates at most ~30 times a second
export const FADE_MS = 300; // a cleared template fades this long
export const SHOW_TTL_MS = 10 * 60 * 1000; // a shown template left behind goes after 10 minutes (as the aim expires)

// The HUD popover (spec section 10.6).
export const HUD_WIDTH = 380;
export const HUD_HEIGHT = 72;
export const HUD_HEIGHT_PICK = 132;

// localStorage keys (bus.js's LS names, under the extension's prefix).
export const LS_ROSTER = "dnd-npc/roster/"; // + player id: the last roster entry, so a reload shows the list at once
