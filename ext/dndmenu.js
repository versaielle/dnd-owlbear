// 🎲 DND, the GM's one right-click entry, and 🏘 Map setup, the Dell copy's one entry on a map (the
// Owlbear regroup, R1). Nothing a button does changed: only where it is reached.
//
// 🎲 DND replaces the seven entries menus() made (🗺 This is…, Conditions, 🔥 Light, 🎯 Go to PC,
// 🧭 Bring PCs here, 📺 Projector here, 🗺 Mark as place). Its click opens one popover where the DM
// right-clicked, unfurling from the entry clicked (popoverAnchor below; dnd.html) with a tab for each
// of those that fits what was clicked: each tab keeps the old entry's filter word for word (TABS
// below), and each tab is the old page (conditions.html, light.html, menu.html) or, for 📺, one button
// in dnd.html. tabs.js draws the tab row.
// 🏘 Map setup replaces thisPcMenus()' three (Set up interiors, Place townsfolk, Check portals): its
// small page (mapsetup.html), opened the same way, asks this copy's background to run the job, as the
// old entry did.
//
// Pure: no SDK import, so the node checks import it (check_menus.mjs).

export const DND_MENU_ID = "dnd-npc/dnd"; // the Pages copy's entry
// The copy the panel on this PC serves has its own id (Owlbear's ids are room-wide): when it steps
// aside for the Pages copy on the same tab it removes only its own entry, never the Pages copy's.
export const LOCAL_DND_MENU_ID = "dnd-npc/local/dnd";
export const DND_POPOVER_ID = "dnd-npc/dnd";
export const DND_LABEL = "🎲 DND";
export const DND_WIDTH = 280;
export const TAB_ROW_H = 34; // tabs.js's row: 28 px with its line, and the 6 px gap under it
// Owlbear shows an entry when its filter matches. 📍 Go to PC is on anything for the GM, so the
// union of the seven old filters is just this: every item, GM screens only.
export const DND_FILTER = { roles: ["GM"] };

const GM = ["GM"];
const layer = (value, coordinator) => (coordinator ? { key: "layer", value, coordinator } : { key: "layer", value });
// 🧭 Bring PCs here and 📺 Projector here: a map image, a room drawing or a token, one at a time.
const ONE_MAP_ROOM_OR_TOKEN = () => [
  [{ key: "layer", value: "MAP" }, { key: "type", value: "IMAGE" }],
  [layer("DRAWING")],
  [layer("CHARACTER")],
].map((every) => ({ roles: GM, max: 1, every }));

// Each tab, in the order the panel picks its first: { key, emoji, name, page, kind (menu.html's
// list), height (the page's own, under the tab row), filters (the old entry's, one per icon; the
// tab shows when any matches, as Owlbear shows the first icon whose filter matches) }.
export const TABS = [
  // Like Stat Bubbles' Edit Stats: the condition badges to switch on and off. 190: the badges at 280 px wide.
  { key: "cond", emoji: "🩹", name: "Conditions", page: "./conditions.html", height: 190,
    filters: [{ roles: GM, every: [layer("CHARACTER")] }] },
  // ONE icon for any mix of these layers: every item is on one of them (an OR chain; no type test,
  // so a shape prop can be lit too, and our door icons and portal circles, on PROP, are offered it).
  { key: "light", emoji: "🔥", name: "Light", page: "./light.html", height: 182,
    filters: [{ roles: GM, every: [layer("CHARACTER", "||"), layer("PROP", "||"), layer("MOUNT", "||"), layer("ATTACHMENT")] }] },
  { key: "who", emoji: "🏷", name: "This is…", page: "./menu.html", kind: "who", height: 360,
    filters: [{ roles: GM, every: [layer("CHARACTER")] }] },
  { key: "place", emoji: "🗺", name: "Mark as place", page: "./menu.html", kind: "place", height: 360,
    filters: [{ roles: GM, every: [layer("DRAWING")] }] },
  { key: "goto", emoji: "📍", name: "Go to PC", page: "./menu.html", kind: "goto", height: 360,
    filters: [{ roles: GM }] },
  { key: "bring", emoji: "🧭", name: "Bring PCs here", page: "./menu.html", kind: "bring", height: 360,
    filters: ONE_MAP_ROOM_OR_TOKEN() },
  { key: "projector", emoji: "📺", name: "Projector here", page: "./dnd.html", height: 48,
    filters: ONE_MAP_ROOM_OR_TOKEN() },
];
const TAB = new Map(TABS.map((t) => [t.key, t]));

// ---- Owlbear's filter, as its context menu reads it ----

const valueAt = (item, key) => (Array.isArray(key) ? key : [key]).reduce((v, k) => (v == null ? undefined : v[k]), item);

// One item against a chain of key filters: left to right, each joined to the next by its
// `coordinator` ("&&" unless it says "||"); `operator` "==" unless it says "!=".
export function chainMatches(item, chain = []) {
  let out = null;
  let join = "&&";
  for (const f of chain) {
    const v = valueAt(item, f.key);
    const m = f.operator === "!=" ? v !== f.value : v === f.value;
    out = out === null ? m : join === "||" ? out || m : out && m;
    join = f.coordinator === "||" ? "||" : "&&";
  }
  return out ?? true;
}

// A context-menu filter ({roles, min, max, every, some}) against the clicked items. An `every`
// needs at least one item (a right-click always has one; with none there is nothing to act on).
export function filterMatches(filter, items = [], role = "GM") {
  if (!filter) return true;
  const list = Array.isArray(items) ? items : [];
  if (Array.isArray(filter.roles) && !filter.roles.includes(role)) return false;
  if (filter.min != null && list.length < filter.min) return false;
  if (filter.max != null && list.length > filter.max) return false;
  if (filter.every && !(list.length && list.every((i) => chainMatches(i, filter.every)))) return false;
  if (filter.some && !list.some((i) => chainMatches(i, filter.some))) return false;
  return true;
}

// The tabs 🎲 DND offers for these clicked items (Owlbear's context.items), in TABS order.
export function sectionsFor(items, role = "GM") {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i === "object") : [];
  return TABS.filter((t) => t.filters.some((f) => filterMatches(f, list, role))).map((t) => t.key);
}

// ---- where a popover opens ----

// A fixed spot near the window's top left: the J key's 📍 Go to PC list (a toolbar key, no menu entry
// to open from), and a right-click popover when Owlbear names no entry.
export const TOP_LEFT = {
  anchorReference: "POSITION",
  anchorPosition: { left: 70, top: 70 },
  anchorOrigin: { horizontal: "LEFT", vertical: "TOP" },
  transformOrigin: { horizontal: "LEFT", vertical: "TOP" },
};

// Where a right-click entry's popover opens (🎲 DND, 🏘 Map setup): on the entry clicked, the element
// Owlbear hands the entry's onClick (its second argument), so it unfurls from where the DM
// right-clicked (DM, 2026-10-19: "the right click menu needs to unfurl from where the right click
// context menu originated"). The popover's top-left corner sits on the entry's top-left corner and it
// opens down and to the right; Owlbear keeps it on the screen. No element named: TOP_LEFT, as before.
export function popoverAnchor(elementId) {
  if (typeof elementId !== "string" || !elementId) return { ...TOP_LEFT };
  return {
    anchorElementId: elementId,
    anchorReference: "ELEMENT",
    anchorOrigin: { horizontal: "LEFT", vertical: "TOP" },
    transformOrigin: { horizontal: "LEFT", vertical: "TOP" },
  };
}

// ---- the popover's address ----

const LAST_TAB_PREFIX = "dnd-npc/dnd-tab/";

// dnd.html's query: the clicked ids and the tabs offered (the router picks one and adds tab, kind, pop).
export function dndQuery(ids, tabs) {
  const p = new URLSearchParams();
  p.set("ids", (ids || []).filter((x) => typeof x === "string" && x).join(","));
  p.set("tabs", (tabs || []).filter((k) => TAB.has(k)).join(","));
  p.set("pop", DND_POPOVER_ID);
  return p.toString();
}

// What a page's address says: the clicked ids, the tabs offered (known ones, in TABS order), this
// tab, menu.html's kind, and the popover the page is in.
export function readParams(search) {
  let p;
  try {
    p = new URLSearchParams(typeof search === "string" ? search : "");
  } catch {
    p = new URLSearchParams();
  }
  const list = (name) => (p.get(name) || "").split(",").map((s) => s.trim()).filter(Boolean);
  const offered = new Set(list("tabs"));
  const tab = p.get("tab");
  return {
    ids: list("ids"),
    tabs: TABS.filter((t) => offered.has(t.key)).map((t) => t.key),
    tab: TAB.has(tab) ? tab : null,
    kind: p.get("kind"),
    pop: p.get("pop"),
  };
}

// The query for tab `key`: the page's own query with only our params changed (tab, kind, pop), so
// whatever Owlbear put there stays. The SDK finds its way back to Owlbear through `obrref` in it.
export function tabSearch(search, key) {
  const p = new URLSearchParams(typeof search === "string" ? search : "");
  const t = TAB.get(key);
  p.set("tab", key);
  if (t?.kind) p.set("kind", t.kind);
  else p.delete("kind");
  p.set("pop", DND_POPOVER_ID);
  return p.toString();
}

export const tabPage = (key) => TAB.get(key)?.page ?? "./menu.html";
export const tabOf = (key) => TAB.get(key) ?? null;
// The popover's height on that tab: the page's own plus the tab row.
export const heightOf = (key) => TAB_ROW_H + (TAB.get(key)?.height ?? 360);
// The localStorage key for the last tab used with this same set of tabs (on this screen).
export const lastTabKey = (tabs) => LAST_TAB_PREFIX + (tabs || []).join(",");
// The tab the router opens: the last one used with this set, else the first offered (📍 Go to PC
// when none is: it shows on anything).
export function pickTab(tabs, saved) {
  const list = (tabs || []).filter((k) => TAB.has(k));
  if (saved && list.includes(saved)) return saved;
  return list[0] || "goto";
}

// ---- 🏘 Map setup (the copy the panel on this PC serves) ----

export const MAP_SETUP_MENU_ID = "dnd-npc/local/map-setup";
export const MAP_SETUP_POPOVER_ID = "dnd-npc/local/map-setup";
export const MAP_SETUP_LABEL = "🏘 Map setup";
export const MAP_SETUP_NEED = "map-setup"; // its LOCAL_ASK to this copy's background
const ONE_MAP_IMAGE = () => ({ roles: GM, max: 1, every: [{ key: "layer", value: "MAP" }, { key: "type", value: "IMAGE" }] });
// The three old entries: each button keeps its label and its filter.
export const MAP_SETUP_JOBS = [
  { key: "interiors", label: "🏘 Set up interiors", filter: ONE_MAP_IMAGE() },
  { key: "townsfolk", label: "👥 Place townsfolk", filter: ONE_MAP_IMAGE() },
  { key: "portals", label: "🏘 Check portals", filter: ONE_MAP_IMAGE() },
];
// The union of the three: they're the same filter (one map image).
export const MAP_SETUP_FILTER = ONE_MAP_IMAGE();
export const MAP_SETUP_WIDTH = 260;
export const MAP_SETUP_HEIGHT = 150;

// The jobs offered for these clicked items, in order.
export const setupJobsFor = (items, role = "GM") =>
  MAP_SETUP_JOBS.filter((j) => filterMatches(j.filter, Array.isArray(items) ? items : [], role)).map((j) => j.key);

export function setupQuery(id, jobs) {
  const p = new URLSearchParams();
  p.set("ids", typeof id === "string" ? id : "");
  p.set("jobs", (jobs || []).filter((k) => MAP_SETUP_JOBS.some((j) => j.key === k)).join(","));
  return p.toString();
}
