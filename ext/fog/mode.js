// What a map's explored memory does when the party looks away (docs/vision-layer-spec.md section
// 6; from Phase 1, docs/vision-layer-2024.md section 6: remembered ground is ALWAYS dimmed, the
// DM's pick "Always dimmed, darker"). Pure: no Owlbear import, so the offline checks load it too.
//
//   "fog"    Fogs over      a seen area goes back under the fog
//   "dim"    Remembered     it stays visible but dimmed; creatures show only while in sight (the
//                           chip says "remembered"; the stored word stays "dim")
//   "lit"    (old)          B4's "stays lit". From Phase 1 it draws exactly like "dim" and is never
//                           given: a stored one is read as "dim" (fog/maps.js mapFogOf), and an
//                           override of "lit" here gives "dim" too. Kept in MODES so a stored one
//                           still validates
//   "clear"  Clear          the whole map shown, dimmed; creatures only in a PC's sight (only ever
//                           the DM's override)
//
//   resolveDarkness({dm, adventure, scene})      a map's darkness: the DM's mark, else the
//                        adventure's place, else the scene's, else "lit" (☀). A missing or junk
//                        value counts as not set.
//   fogMode({darkness, kind, remembered, override})
//                        darkness "lit" | "dim" | "dark"; kind "interior" | "outdoor" (anything
//                        else is outdoor: a map nobody marked Interior); remembered: its building
//                        is remembered; override: the DM's null | "fog" | "dim" | "clear" (a "lit"
//                        reads as "dim"). On 🌑 always "fog", whatever the override says
//   darkLocked(darkness) is this darkness 🌑 (so the map is fog only: the remembered and clear chips
//                        are greyed, and a stored override waits until the map is 🌒 or ☀ again)
//   fromGraphLighting(v) the graph's spelling: "bright" | "dim" | "dark" -> "lit" | "dim" | "dark"
//
// The table (on ☀ and 🌒 the override, when set, always wins; on 🌑 nothing does):
//   🌑 dark         any kind, any override        fog   darkness beats the interior rule, and the DM's
//                                                       remembered or clear (decided 2026-10-14, "Never:
//                                                       lock 🌑 to fog": remembered ground on a dark map
//                                                       showed the dark ground the party can't see)
//   ☀ lit / 🌒 dim  interior, not remembered      fog
//   ☀ lit / 🌒 dim  interior, remembered          dim
//   ☀ lit / 🌒 dim  outdoor                       dim   (B4 gave ☀ outdoor "lit": decision 69)

import { codeOf } from "../fx/darkness.js?v=2094e30";

export const MODES = ["fog", "dim", "lit", "clear"];

// The mode as it is drawn: a "lit" (B4's, stored before Phase 1) is "dim".
export const drawnMode = (mode) => (mode === "lit" ? "dim" : mode);

export function resolveDarkness({ dm = null, adventure = null, scene = null } = {}) {
  return codeOf(dm) ?? codeOf(adventure) ?? codeOf(scene) ?? "lit";
}

// 🌑: fog only (the table above).
export const darkLocked = (darkness) => codeOf(darkness) === "dark";

export function fogMode({ darkness = "lit", kind = "outdoor", remembered = false, override = null } = {}) {
  if (darkLocked(darkness)) return "fog";
  if (MODES.includes(override)) return drawnMode(override);
  if (kind === "interior") return remembered ? "dim" : "fog";
  return "dim";
}

const GRAPH = { bright: "lit", dim: "dim", dark: "dark" };

// The graph's lighting value as the extension's darkness code, or null when it isn't one.
export const fromGraphLighting = (v) => (typeof v === "string" && Object.hasOwn(GRAPH, v) ? GRAPH[v] : null);
