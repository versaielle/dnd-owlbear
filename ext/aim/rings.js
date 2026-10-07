// BLUE target rings, written the way Owlbear's Colored Rings extension writes them, so the
// panel's ring reader (_take_target_pick) and the DM's own clicks treat them like any other.
// The bridge rings what a locked aim caught; a GM aimer does it itself when the bridge is gone.
import { RING_KEY, TARGET_COLOR } from "../keys.js?v=23059e2";
import { footprint } from "./geometry.js?v=23059e2";

let sdk = null;
async function shapeBuilder(api) {
  if (api.buildShape) return api.buildShape;
  sdk ||= import("../obr-sdk.js?v=23059e2");
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
      const diameter = Math.min(fp.w, fp.h);
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
