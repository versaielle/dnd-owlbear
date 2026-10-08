// "🎯 Go to PC" (GM only): the DM's view pans to a PC's token, zoomed so about a dozen squares
// fit across (or kept as it is when already closer), and the token is selected. Offered from
// the right-click menu on anything (menu.html, kind=goto), the toolbar button's box
// (popover.html) and a key (background.js). The PC tokens are gather.js's.
import OBR from "./obr-sdk.js?v=585985a-dc1dbb6";
import { findPcs, partyNames, tokenBox } from "./gather.js?v=585985a-dc1dbb6";

const SQUARES = 12; // squares across the screen after the jump

// The view that puts scene point `point` in the middle of the screen: {position, scale}.
// Owlbear's viewport position is where the scene's origin is on the screen.
export function viewOn(point, { dpi, width, height, scale, squares = SQUARES }) {
  const s = Math.max(scale || 0, width / (squares * dpi));
  return { position: { x: -point.x * s + width / 2, y: -point.y * s + height / 2 }, scale: s };
}

// The PC tokens in the scene, by name ([{item, name}]; hidden ones too), and the party's names
// they were matched with (the room's remembered ones when the panel can't be reached).
export async function scenePcs() {
  // Party names only help match tokens by name: "This is…" (pc:<name>) works without the game.
  const party = await partyNames();
  if (!(await OBR.scene.isReady())) return { pcs: [], party };
  return { pcs: findPcs(await OBR.scene.items.getItems(), party), party };
}

export const pcLabel = ({ item, name }) => (item.visible ? name : `${name} (hidden)`);

export async function goToPc(id) {
  const [token] = await OBR.scene.items.getItems([id]);
  if (!token) return;
  const dpi = await OBR.scene.grid.getDpi();
  const [width, height, scale] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight(), OBR.viewport.getScale()]);
  const box = tokenBox(token, dpi);
  await OBR.player.select([id], true);
  await OBR.viewport.animateTo(viewOn(box, { dpi, width, height, scale }));
}
