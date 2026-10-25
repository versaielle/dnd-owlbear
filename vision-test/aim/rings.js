// BLUE (party) and YELLOW (NPC / monster) target rings, written the way Owlbear's Colored Rings extension writes them, so the
// panel's ring reader (_take_target_pick) and the DM's own clicks treat them like any other.
// The bridge rings what a locked aim caught; a GM aimer does it itself when the bridge is gone.
import { DOWN_COLOR, FOE_COLOR, RING_KEY, TARGET_COLOR, onTokenLayer } from "../keys.js?v=9a30147";
import { footprint } from "./geometry.js?v=9a30147";

const NEST_STEP = 0.14; // a ring on top of another of ours is this much smaller (of the token's diameter)
const NEST_MIN = 0.55;

let sdk = null;
async function shapeBuilder(api) {
  if (api.buildShape) return api.buildShape;
  sdk ||= import("../obr-sdk.js?v=9a30147");
  return (await sdk).buildShape;
}

export async function setTargetRings(api, ids, { replace = true, color = TARGET_COLOR } = {}) {
  // Make exactly these tokens wear a ring of this colour: one delete (with replace, the rings
  // of that colour on every other token) and one add (only tokens that lack one), so a second
  // run changes nothing. Other colours are never touched. Returns {added: [token ids],
  // removed: [ring ids]}.
  const OBR = api.OBR;
  const want = new Set((ids || []).map(String));
  const col = String(color).toLowerCase();
  const out = { added: [], removed: [] };
  const rings = await OBR.scene.items.getItems(
    (i) => !!i.attachedTo && i.metadata?.[RING_KEY]?.enabled && String(i.style?.strokeColor).toLowerCase() === col,
  );
  const ringed = new Set(rings.map((r) => r.attachedTo));
  // A token wearing two of our colours (blue on a red or a yellow, C11) must show both, so a ring that
  // goes on top of another of ours is drawn smaller, the way Colored Rings nests its own. Sizes come in
  // steps: the full size (step 0), then NEST_STEP smaller (step 1), and so on down to NEST_MIN. A new ring
  // takes the largest step NOT already worn by one of our rings (blue, yellow, red) on that token, so after
  // a ring is taken off and put back, no two rings share a size. A lone ring, and a ring on a token with
  // none of ours, keeps the old full size. White rings aren't counted.
  const ours = new Set([TARGET_COLOR, FOE_COLOR, DOWN_COLOR]);
  const worn = {}; // token id -> widths of our rings already on it
  if (want.size) {
    const all = await OBR.scene.items.getItems(
      (i) => !!i.attachedTo && want.has(i.attachedTo) && i.metadata?.[RING_KEY]?.enabled && ours.has(String(i.style?.strokeColor).toLowerCase()),
    );
    // The size a ring is DRAWN at: its width times its own scale (a token scaled after a ring went on carries
    // the scale to the ring), the same basis footprint() gives `full` below.
    for (const r of all) (worn[r.attachedTo] ||= []).push(r.width * Math.abs(Number.isFinite(r.scale?.x) ? r.scale.x : 1));
  }
  const remove = replace ? rings.filter((r) => !want.has(r.attachedTo)).map((r) => r.id) : [];
  const need = [...want].filter((id) => !ringed.has(id));
  const add = [];
  if (need.length) {
    const tokens = await OBR.scene.items.getItems(need);
    const dpi = await OBR.scene.grid.getDpi();
    const buildShape = await shapeBuilder(api);
    for (const t of tokens) {
      if (!want.has(t.id) || ringed.has(t.id) || !t.image || !t.grid) continue;
      // ringDown's recipe (background.js), with the token's scale and turn taken into account.
      const fp = footprint(t, dpi);
      if (!fp) continue;
      const full = Math.min(fp.w, fp.h);
      const taken = new Set((worn[t.id] || []).map((w) => (Number.isFinite(w) && full > 0 ? Math.max(0, Math.round((1 - w / full) / NEST_STEP)) : 0)));
      let step = 0;
      while (taken.has(step) && 1 - NEST_STEP * step > NEST_MIN) step++;
      const diameter = full * Math.max(NEST_MIN, 1 - NEST_STEP * step);
      add.push(buildShape()
        .width(diameter)
        .height(diameter)
        .position({ x: fp.cx, y: fp.cy })
        .fillOpacity(0)
        .strokeColor(color)
        .strokeOpacity(1)
        .strokeWidth(5)
        .shapeType("CIRCLE")
        .attachedTo(t.id)
        .locked(true)
        .name("Status Ring")
        .metadata({ [RING_KEY]: { enabled: true } })
        .layer("ATTACHMENT")
        .disableHit(true)
        .visible(t.visible)
        .build());
      out.added.push(t.id);
      ringed.add(t.id);
    }
  }
  if (remove.length) {
    await OBR.scene.items.deleteItems(remove);
    out.removed = remove;
  }
  if (add.length) await OBR.scene.items.addItems(add);
  return out;
}

export async function toggleTargetRing(api, color, { selection } = {}) {
  // The 9 (blue) and 0 (yellow) keys: put this colour on the selected tokens, or take it off.
  // If every selected token already wears the colour it comes off them all; otherwise it goes on
  // the rest (a mix: all get it). Only rings of THIS colour are touched: the red (down) and white
  // (conditions) rings, and the other target colour, stay. Fails closed: with nothing usable
  // selected it writes nothing. Returns {action: "on" | "off" | "none", ids, why?}.
  const OBR = api.OBR;
  const col = String(color).toLowerCase();
  const sel = selection ?? (await OBR.player.getSelection());
  if (!Array.isArray(sel) || !sel.length) return { action: "none", ids: [], why: "nothing selected" };
  const items = await OBR.scene.items.getItems(sel);
  const ids = items.filter((i) => onTokenLayer(i) && i.image && i.grid).map((i) => i.id); // a mount too (keys.js)
  if (!ids.length) return { action: "none", ids: [], why: "no token selected" };
  const rings = await OBR.scene.items.getItems(
    (i) => !!i.attachedTo && ids.includes(i.attachedTo) && i.metadata?.[RING_KEY]?.enabled
      && String(i.style?.strokeColor).toLowerCase() === col,
  );
  const ringed = new Set(rings.map((r) => r.attachedTo));
  if (ids.every((id) => ringed.has(id))) {
    await OBR.scene.items.deleteItems(rings.map((r) => r.id));
    return { action: "off", ids };
  }
  const out = await setTargetRings(api, ids, { replace: false, color });
  if (!out.added.length) return { action: "none", ids: [], why: "couldn't ring those tokens" };
  return { action: "on", ids: out.added };
}
