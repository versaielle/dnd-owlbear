// The tab row on top of 🎲 DND's popover (dndmenu.js): an emoji per tab offered, the open one lit,
// and its name. A tap opens that tab's page in the same popover, with the same clicked items. The
// pages are the old ones (conditions.html, light.html, menu.html; 📺 in dnd.html), each drawing this
// row at its top when it's open in the 🎲 DND popover and nothing new otherwise.
// It remembers the last tab used with the same set of tabs (this screen's localStorage, which may be
// missing or refuse: then the first tab offered opens).
// No SDK import: the pages pass their OBR, and the node checks import this (check_menus.mjs).
import { DND_POPOVER_ID, TABS, heightOf, lastTabKey, pickTab, readParams, tabPage, tabSearch } from "./dndmenu.js?v=c5ec1d6";

// The items the DM right-clicked (the page's `ids`), else [] (the page then uses the selection).
export const clickedIds = (search) => readParams(search).ids;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
export function savedTab(tabs) {
  try {
    return storage()?.getItem(lastTabKey(tabs)) || null;
  } catch {
    return null;
  }
}
export function saveTab(tabs, key) {
  try {
    storage()?.setItem(lastTabKey(tabs), key);
  } catch {
    // no storage on this screen: the first tab opens next time
  }
}

// The address of tab `key` from this page's (only our own params change).
export const tabHref = (search, key) => `${tabPage(key)}?${tabSearch(search, key)}`;

// dnd.html, opened with no tab yet: open the last tab used with this set, else the first offered.
export function route(loc) {
  const { tabs } = readParams(loc.search);
  const key = pickTab(tabs, savedTab(tabs));
  loc.replace(tabHref(loc.search, key));
  return key;
}

const STYLE = `
.dnd-tabs { display: flex; align-items: center; gap: 2px; box-sizing: border-box; height: 28px; margin: 0 0 6px; padding: 0 0 2px;
            border-bottom: 1px solid rgba(255, 255, 255, .15); font: 13px/1 system-ui, sans-serif; color: #fff; }
.dnd-tab { flex: none; padding: 4px 5px; border-radius: 6px; cursor: pointer; opacity: .55; user-select: none; }
.dnd-tab:hover, .dnd-tab:focus-visible { opacity: .9; background: rgba(255, 255, 255, .15); outline: none; }
.dnd-tab.on { opacity: 1; background: rgba(217, 164, 65, .3); box-shadow: inset 0 -2px #d9a441; cursor: default; }
.dnd-name { flex: 1; min-width: 0; margin-left: 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
            font-size: 12px; font-weight: 600; }
`;

// Draws the row at the top of the page and sets the popover's height for this tab. Only in the
// 🎲 DND popover (its `pop` and a `tab` in the address): elsewhere it does nothing and returns null.
// Returns this tab's key.
export function showTabs(OBR, doc, loc) {
  const p = readParams(loc?.search);
  if (p.pop !== DND_POPOVER_ID || !p.tab) return null;
  const tabs = p.tabs.includes(p.tab) ? p.tabs : [...p.tabs, p.tab];
  saveTab(tabs, p.tab);
  if (doc?.body && !doc.querySelector?.(".dnd-tabs")) {
    const style = doc.createElement("style");
    style.textContent = STYLE;
    doc.head?.append(style);
    const row = doc.createElement("div");
    row.className = "dnd-tabs";
    row.setAttribute?.("role", "tablist");
    for (const key of tabs) {
      const t = TABS.find((x) => x.key === key);
      const tab = doc.createElement("span");
      tab.className = key === p.tab ? "dnd-tab on" : "dnd-tab";
      tab.textContent = t.emoji;
      tab.title = t.name;
      tab.setAttribute?.("role", "tab");
      tab.setAttribute?.("aria-selected", String(key === p.tab));
      tab.setAttribute?.("aria-label", t.name);
      if (key !== p.tab) {
        tab.tabIndex = 0;
        const go = () => {
          saveTab(tabs, key);
          loc.replace(tabHref(loc.search, key));
        };
        tab.onclick = go;
        tab.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault?.();
            go();
          }
        };
      }
      row.append(tab);
    }
    const name = doc.createElement("span");
    name.className = "dnd-name";
    name.textContent = TABS.find((x) => x.key === p.tab).name;
    row.append(name);
    doc.body.prepend(row);
  }
  try {
    const set = OBR?.popover?.setHeight?.(DND_POPOVER_ID, heightOf(p.tab));
    set?.catch?.(() => {});
  } catch {
    // an older Owlbear without setHeight: the popover keeps the height it opened with
  }
  return p.tab;
}
