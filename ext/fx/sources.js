// D&D light sources: bright and dim reach in feet, the label the menus show, and the look that
// draws them (5e PHB/SRD numbers; the brazier is a house number, like a torch). No imports, so a
// module that needs only the kinds (interiors.js, which background.js loads) doesn't load the
// flames and their shaders; fx/lights.js re-exports it.
export const SOURCES = {
  candle:          { label: "Candle",            bright: 5,  dim: 5,  look: "candle" },
  torch:           { label: "Torch",             bright: 20, dim: 20, look: "torch" },
  lamp:            { label: "Lamp",              bright: 15, dim: 30, look: "lantern" },
  hooded_lantern:  { label: "Hooded lantern",    bright: 30, dim: 30, look: "lantern" },
  brazier:         { label: "Campfire / brazier", bright: 20, dim: 20, look: "brazier" },
  light:           { label: "Light (cantrip)",   bright: 20, dim: 20, look: "magic" },
  continual_flame: { label: "Continual Flame",   bright: 20, dim: 20, look: "torch" },
  dancing_lights:  { label: "Dancing Lights",    bright: 0,  dim: 10, look: "magic" },
  produce_flame:   { label: "Produce Flame",     bright: 20, dim: 20, look: "torch" },
};
