// What a map's explored memory does when the party looks away (docs/vision-layer-spec.md section
// 6, the DM's table in docs/planning/2026-10-11-vision-layer-decisions.md). Pure: no Owlbear
// import, so the offline checks load it too.
//
//   "fog"    Fogs over      a seen area goes back under the fog
//   "dim"    Stays dimmed   it stays visible but dimmed; creatures show only while in sight
//   "lit"    Stays lit      it stays at full brightness; creatures show only while in sight
//   "clear"  Clear          no fog on the map at all (only ever the DM's override)
//
//   resolveDarkness({dm, adventure, scene})      a map's darkness: the DM's mark, else the
//                        adventure's place, else the scene's, else "lit" (☀). A missing or junk
//                        value counts as not set.
//   fogMode({darkness, kind, remembered, override})
//                        darkness "lit" | "dim" | "dark"; kind "interior" | "outdoor" (anything
//                        else is outdoor: a map nobody marked Interior); remembered: its building
//                        is remembered; override: the DM's null | "fog" | "dim" | "lit" | "clear"
//   fromGraphLighting(v) the graph's spelling: "bright" | "dim" | "dark" -> "lit" | "dim" | "dark"
//
// The table (the override, when set, always wins):
//   🌑 dark         any kind                      fog   darkness beats the interior rule
//   ☀ lit / 🌒 dim  interior, not remembered      fog
//   ☀ lit / 🌒 dim  interior, remembered          dim
//   🌒 dim          outdoor                       dim
//   ☀ lit           outdoor                       lit

import { codeOf } from "../fx/darkness.js?v=3fa571c";

export const MODES = ["fog", "dim", "lit", "clear"];

export function resolveDarkness({ dm = null, adventure = null, scene = null } = {}) {
  return codeOf(dm) ?? codeOf(adventure) ?? codeOf(scene) ?? "lit";
}

export function fogMode({ darkness = "lit", kind = "outdoor", remembered = false, override = null } = {}) {
  if (MODES.includes(override)) return override;
  const d = codeOf(darkness) ?? "lit";
  if (d === "dark") return "fog";
  if (kind === "interior") return remembered ? "dim" : "fog";
  return d;
}

const GRAPH = { bright: "lit", dim: "dim", dark: "dark" };

// The graph's lighting value as the extension's darkness code, or null when it isn't one.
export const fromGraphLighting = (v) => (typeof v === "string" && Object.hasOwn(GRAPH, v) ? GRAPH[v] : null);
