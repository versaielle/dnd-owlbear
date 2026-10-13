// Where the extension keeps its links in Owlbear (item metadata, saved with the room).
export const PLACE_KEY = "dnd-npc/place"; // on a drawing: the narrator's place key
export const WHO_KEY = "dnd-npc/who"; // on a token: "pc:<character name>" or "npc:<persona slug>"
// Owlbear's own "Colored Rings" extension: a ring is a circle attached to a token, tagged
// with this key, its colour in style.strokeColor. A BLUE ring marks a spell's target.
export const RING_KEY = "rodeo.owlbear.colored-rings/metadata";
export const TARGET_COLOR = "#1a6aff"; // Colored Rings' blue
export const DOWN_COLOR = "#ff4d4d"; // Colored Rings' red: the creature is down at 0 HP
export const CHOOSE_COLOR = "#ffffff"; // Colored Rings' white: show this token's conditions on the panel
// D&D conditions on a token: the list is kept on the token itself (its metadata), and the
// extension shows each as a round badge on the token's rim (an image attached to it).
export const COND_KEY = "dnd-npc/conditions"; // on a token: ["prone", "restrained"]
export const BADGE_KEY = "dnd-npc/badge"; // on a badge image: {name, sig}
export const CONDITIONS = ["blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained", "stunned",
  "unconscious"];
// Every screen loads the badges (the laptop and the projector can't reach this PC), so they're
// on the public page. owlbear/conditions/make_badges.py makes them.
export const BADGE_URL = "https://versaielle.github.io/dnd-owlbear/conditions/";
// On everything "🏘 Set up interiors" made (rooms, walls, portals): {map, kind}. A re-run deletes it all.
export const INTERIOR_KEY = "dnd-npc/interior";
// On each map image "🏘 Set up interiors" lays out (the building maps and the town): what 🧭 Bring
// PCs here needs from interiors.json, so it works on a copy that can't reach the panel (the
// laptop's Pages copy). {v: 1, w: the file's width in px, entry: [x, y] | null, stairs: [x, y] |
// null, props: [[x0, y0, x1, y1], ...]}, in that file's image pixels, only furniture that blocks.
// Numbers only, never a name (the room's metadata reaches every device).
export const MAP_INFO_KEY = "dnd-npc/map";
export const MARK_PREFIX = "dnd-npc-mark-"; // + token id: the hidden note on a monster ("Hexed · hurt")
// GM's Grimoire on a token: {hp, maxHp, armorClass, stats: {tempHp}}. Only read once, to copy
// a monster's HP and AC over to Stat Bubbles (the DM switched to Stat Bubbles on 2026-10-03).
export const GRIMOIRE_KEY = "com.bitperfect-software.hp-tracker/data";
// "Stat Bubbles for D&D": its name tag (shown instead of Owlbear's own label) is kept on the token here.
export const BUBBLES_NAME_KEY = "com.owlbear-rodeo-bubbles-extension/name";
// ...and its stats: {"health", "max health", "temporary health", "armor class", "hide" (GM only)}.
// HP and AC are read from here, and the panel's damage is written here.
export const BUBBLES_KEY = "com.owlbear-rodeo-bubbles-extension/metadata";
// Spell effects (Step 36). Local effect items carry FX_KEY ({until}), so a sweep can find and
// delete any left behind; a living zone's shared outline carries ZONE_KEY ({id, zid, spell, look,
// color, power, seed}); the aim tool's preview items carry AIM_KEY.
export const FX_KEY = "dnd-npc/fx";
export const ZONE_KEY = "dnd-npc/zone";
export const AIM_KEY = "dnd-npc/aim";
// Lights (candles, torches, magic light; fx/lights.js). On a token or a light-source item:
// LIGHT_KEY {kind} is the light the DM gave it (right-click 🔥 Light), SPELL_LIGHT_KEY
// {kind, magic} one from a spell cast on the panel (kept apart, so a spell ending never puts
// out a torch the PC carries). LIGHT_BASE_KEY keeps Smoke & Spectre's own values from before
// our first light, to put back when the last one goes (fx/lightmeta.js). Our local flame and
// darkvision items carry LIGHT_FX_KEY {source, host, part}. Kinds and numbers only: players
// can read every item's metadata.
export const LIGHT_KEY = "dnd-npc/light";
export const SPELL_LIGHT_KEY = "dnd-npc/spell-light";
export const LIGHT_BASE_KEY = "dnd-npc/light-base";
export const LIGHT_FX_KEY = "dnd-npc/fx-light";
// Lights redo (docs/lights-redo-spec.md). LIGHT_KEY {kind: "none"} is the DM's tombstone: put out
// (stops an auto or adopted light; a spell light still shows). VISION_KEY on a token:
// {dm: {sight?, dark?, seer?}, out: {<Smoke key short name>: value}}: the DM's overrides, and the
// Smoke keys we last wrote (to tell a DM's Smoke edit from ours, and what to remove).
// CARRIER_KEY {of: <parent id>} on the invisible child item that carries a lit NPC's torchlight.
// SCENE_LIGHTING_KEY on the scene: {darkness: "lit"|"dim"|"dark", auto: bool, managed: bool}
// (missing = lit, auto, managed). managed false = "Release lights to Smoke": no Smoke key writes
// in that scene (our own keys still); any 🔥 Lighting control that changes inputs sets it true.
// PARTY_SENSES_KEY on the room: {<nameKey(name)>: {dark: feet}} (numbers only), from party.yaml.
export const VISION_KEY = "dnd-npc/vision";
export const CARRIER_KEY = "dnd-npc/carrier";
export const SCENE_LIGHTING_KEY = "dnd-npc/lighting";
export const PARTY_SENSES_KEY = "dnd-npc/party-senses";
// On a MAP-layer image: "lit" | "dim" | "dark", that map's own light (a 🌑 cellar inside a ☀ town
// scene). The topmost marked map under a point decides; else the scene's darkness; else lit
// (fx/darkness.js, docs/lights-darkness-spec.md). Removed = "as the scene".
export const MAP_DARKNESS_KEY = "dnd-npc/darkness";
// Smoke & Spectre's metadata prefix: "<SMOKE>/visionRange" etc. on tokens, "<SMOKE>/isDarkVision"
// on its own local darkvision rings.
export const SMOKE = "com.battle-system.smoke";
// The party's names, kept in the Owlbear ROOM's metadata (an array of names), so every copy of
// the extension (the laptop's Pages copy too) can match PC tokens by name without the panel.
// A GM copy writes it whenever it gets the party from the panel and it differs (gather.js).
export const PARTY_KEY = "dnd-npc/party";
// 📺 The view the projector holds, on the SCENE (views.js): {v: 1, on: true, x, y, w, h, at}, the
// scene rectangle it shows (scene pixels; the projector fits it to its own screen), or {v: 1, on:
// false, at} once unlocked. Numbers only: every screen can read a scene's metadata.
export const PROJECTOR_KEY = "dnd-npc/projector";
// 🌫 Our own vision layer (docs/vision-layer-spec.md; the builders' contract is
// docs/vision-layer-b2b3.md). FOG_KEY on the SCENE is the switch "🌫 Our fog": {v: 1, on, at,
// prev?: {filled}}. Off or missing = our layer adds nothing, writes nothing, and Smoke & Spectre
// works as before. Any GM screen writes `on` (the DM's click); the leader GM screen then turns the
// fog's fill on and leaves its colour as the scene has it (like Smoke), keeping the fill it found
// in `prev`, and puts that fill back (and drops `prev`) when it goes off. (An older build's prev
// also held a colour: read fine, never written.) Every screen reads it: flags and a time only.
export const FOG_KEY = "dnd-npc/fog";
// On a wall line (a CURVE, as 🏘 Set up interiors draws them, or one the DM marked): {kind: "wall"
// | "door" | "window", open?: true, locked?: true} (open and locked only on a door, never both;
// missing = false). Smoke & Spectre's own line keys (isVisionLine, isDoor, isWindow, doorOpen,
// disabled, isDoorLocked, blocking, doubleSided) are still read (fog/lines.js); on a line that has
// both, this key wins. A secret door nobody has found is a plain "wall": nothing in the scene says
// it's special (every player screen can read it).
export const WALL_KEY = "dnd-npc/wall";
// On every LOCAL item the vision layer adds on a screen: {kind: "sight" | "wall" | "handle", key,
// sig, host} (key: what it was made for, a PC token's id, a line's id or "edge:<map id>"; sig:
// what it was made from; host: "local" | "pages", so each copy on the Dell's tab sweeps only its
// own). A door handle also carries {line, open, locked}: the door it works and how that door
// stands, for the right-click menu's filters.
export const FOG_LOCAL_KEY = "dnd-npc/fog-local";
// Door requests, broadcast through bus.js send/on: any screen -> the leader GM screen, {req, op:
// "open" | "close" | "lock" | "unlock", line, token, by, dm}; and the leader's answer, {audience:
// "player:<id>" | "gm", req, line, op, ok, state: {open, locked}, why}.
export const FOG_DOOR_CH = "dnd-npc/fog/door";
export const FOG_DOOR_REPLY_CH = "dnd-npc/fog/door/reply";
