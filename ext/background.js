// The DND NPC map extension's background script. It runs in every Owlbear tab that loads
// the extension: the Dell's GM tab, the laptop's GM tab, the projector's Cast receiver and
// the players' phones. Since Step 36 it is served from the public Pages site, so every screen
// at the table can draw spell effects; only ONE GM tab on the Dell (the bridge, bridge.js)
// talks to the panel.
//
// The bridge, after every change on the map (a drop, a room drawn or marked) and every few
// seconds as a heartbeat, sends the panel (/api/map) each character token and which marked
// rooms it stands in. map_state.py turns that into who is where.
//
// It also carries out what the panel asks of the map (HP in Stat Bubbles, the hidden
// notes on monsters, 📍 rings), and reports which tokens wear a BLUE Colored Rings ring:
// the targets the DM marked for a spell, on the laptop or here.
//
// Every screen also listens to the bridge (bottom of this file): effects (fx/), the aim tool
// and the locked templates (aim/), and on a player's device their spells (player/). Those load
// with import() and may fail on their own: the map jobs, rings and HP keep working without them.
import OBR, { buildCurve, buildEffect, buildImage, buildLabel, buildPath, buildShape, buildText, Math2, MathM }
  from "./obr-sdk.js?v=0635c01";
import { contains, isRoom, size } from "./areas.js?v=0635c01";
import { checkPortals, describe, panelLog, setUpInteriors } from "./interiors.js?v=0635c01";
import { placeTownsfolk, rememberParty } from "./gather.js?v=0635c01";
import { BADGE_KEY, BADGE_URL, BUBBLES_KEY, BUBBLES_NAME_KEY, COND_KEY, CONDITIONS, DOWN_COLOR, GRIMOIRE_KEY, MARK_PREFIX, PLACE_KEY, RING_KEY, TARGET_COLOR, WHO_KEY } from "./keys.js?v=0635c01";
import { CH, DEFAULT_SETTINGS, LS, buildOf, forMe, here, isLocalOrigin, kindOf, lsGet, on as busOn, send as busSend,
  setConnection, setSceneWrite, startSceneReader, tierOf } from "./bus.js?v=0635c01";

const HEARTBEAT_MS = 10000;
const DEBOUNCE_MS = 250;
const TODO_MS = 1000; // how often the Dell's copy asks the panel for map jobs
const PING_MS = 3000; // how long 📍 rings a token
const GO_TO_KEY = "J"; // the key for 🎯 Go to PC ("jump")

let timer = null;

// A Stat Bubbles number (a number, or text typed as one), or null.
const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(+v) ? +v : null);

// Stat Bubbles' HP and AC on a token, when it tracks its HP (a max HP above 0).
function bubbles(i) {
  const b = i.metadata?.[BUBBLES_KEY];
  const max = num(b?.["max health"]);
  if (!b || !(max > 0)) return {};
  return { hp: num(b.health) ?? max, max_hp: max, temp_hp: num(b["temporary health"]) ?? 0,
           ac: num(b["armor class"]) || null };
}

async function fromGrimoire(items) {
  // One-time move to Stat Bubbles: a token GM's Grimoire tracks but Stat Bubbles doesn't yet
  // gets its HP, max HP, temp HP and AC copied over, hidden from the players like a monster's
  // should be. Once copied, Stat Bubbles has it, so this never touches that token again.
  const ids = items.filter((i) => i.layer === "CHARACTER" && typeof i.metadata?.[GRIMOIRE_KEY]?.hp === "number"
                                  && !(num(i.metadata?.[BUBBLES_KEY]?.["max health"]) > 0)).map((i) => i.id);
  if (!ids.length) return 0;
  await OBR.scene.items.updateItems(ids, (found) => {
    for (const i of found) {
      const g = i.metadata[GRIMOIRE_KEY];
      i.metadata[BUBBLES_KEY] = {
        ...(i.metadata[BUBBLES_KEY] || {}),
        health: g.hp,
        "max health": g.maxHp ?? g.hp,
        "temporary health": num(g.stats?.tempHp) ?? 0,
        "armor class": num(g.armorClass) ?? 0,
        hide: true,
      };
    }
  });
  return ids.length;
}

// ---- conditions: badges on the token's rim ----

const BADGE_PX = 256; // the badge images' size
const BADGE_OF_TOKEN = 0.36; // a badge's width, as a share of the token's
const BADGE_STEP = 42; // degrees between badges, from the bottom of the token outwards

function conditionsOf(i) {
  const on = i.metadata?.[COND_KEY];
  return Array.isArray(on) ? CONDITIONS.filter((c) => on.includes(c)) : [];
}

function tokenBox(t, dpi) {
  // The token's centre and width on the map, from its image (tokens are images).
  if (!t.image || !t.grid?.dpi) return null;
  const k = dpi / t.grid.dpi;
  const sx = Math.abs(t.scale?.x ?? 1), sy = Math.abs(t.scale?.y ?? 1);
  return {
    x: t.position.x + (t.image.width / 2 - (t.grid.offset?.x ?? t.image.width / 2)) * k * sx,
    y: t.position.y + (t.image.height / 2 - (t.grid.offset?.y ?? t.image.height / 2)) * k * sy,
    size: Math.min(t.image.width * sx, t.image.height * sy) * k,
  };
}

function badgeSpots(n, box) {
  // Badge centres on the rim, spread out from the bottom of the token.
  const step = n > 8 ? 360 / n : BADGE_STEP;
  const r = box.size * 0.46;
  return Array.from({ length: n }, (_, i) => {
    const a = ((90 + ((n - 1) / 2 - i) * step) * Math.PI) / 180; // left to right, in the menu's order
    return { x: box.x + r * Math.cos(a), y: box.y + r * Math.sin(a) };
  });
}

async function syncBadges(items) {
  // Make the badges on the map match each token's conditions. Only what's out of date is
  // changed, so running it after every change on the map costs nothing once it matches.
  const dpi = await OBR.scene.grid.getDpi();
  const tokens = new Map(items.filter((i) => i.layer === "CHARACTER").map((i) => [i.id, i]));
  const badges = items.filter((i) => i.metadata?.[BADGE_KEY]);
  const remove = badges.filter((b) => !tokens.has(b.attachedTo)).map((b) => b.id);
  const add = [];
  for (const t of tokens.values()) {
    const names = conditionsOf(t);
    const have = badges.filter((b) => b.attachedTo === t.id);
    const box = names.length ? tokenBox(t, dpi) : null;
    const sig = box ? `${names.join(",")}|${Math.round(box.size)}` : "";
    if (have.length === (box ? names.length : 0) && have.every((b) => b.metadata[BADGE_KEY].sig === sig)) continue;
    remove.push(...have.map((b) => b.id));
    if (!box) continue;
    const size = box.size * BADGE_OF_TOKEN;
    badgeSpots(names.length, box).forEach((spot, n) => {
      add.push(buildImage(
        { width: BADGE_PX, height: BADGE_PX, url: `${BADGE_URL}${names[n]}.png`, mime: "image/png" },
        { dpi: (BADGE_PX * dpi) / size, offset: { x: BADGE_PX / 2, y: BADGE_PX / 2 } },
      )
        .name(names[n])
        .position(spot)
        .attachedTo(t.id)
        .layer("ATTACHMENT")
        .locked(true)
        .disableHit(true)
        .disableAttachmentBehavior(["SCALE"])
        .metadata({ [BADGE_KEY]: { name: names[n], sig } })
        .build());
    });
  }
  if (remove.length) await OBR.scene.items.deleteItems(remove);
  if (add.length) await OBR.scene.items.addItems(add);
}

async function setCondition(ids, name, on) {
  // From the panel: switch a condition on or off on these tokens (the badges follow).
  if (!CONDITIONS.includes(name)) return;
  await OBR.scene.items.updateItems(ids, (items) => {
    for (const i of items) {
      const now = conditionsOf(i).filter((c) => c !== name);
      i.metadata[COND_KEY] = on ? CONDITIONS.filter((c) => c === name || now.includes(c)) : now;
    }
  });
}

async function summary() {
  // No map open: still report, so the panel knows the extension is there.
  if (!(await OBR.scene.isReady())) return { scene: false, grid: null, tokens: [], areas: [] };
  let items = await OBR.scene.items.getItems();
  const copied = await fromGrimoire(items);
  if (copied) items = await OBR.scene.items.getItems();
  await syncBadges(items);
  const scale = await OBR.scene.grid.getScale();
  // Colored Rings rings, by the token they're on: token id -> [colours].
  const rings = {};
  for (const i of items) {
    if (i.attachedTo && i.metadata?.[RING_KEY]?.enabled && i.style?.strokeColor) {
      (rings[i.attachedTo] ||= []).push(String(i.style.strokeColor).toLowerCase());
    }
  }
  const tokens = items
    .filter((i) => i.layer === "CHARACTER")
    .map((i) => {
      return {
        id: i.id,
        // Stat Bubbles' name tag first, then Owlbear's own label.
        label: String(i.metadata?.[BUBBLES_NAME_KEY] || "").trim() || i.text?.plainText || "",
        name: i.name,
        link: i.metadata?.[WHO_KEY] || "",
        visible: i.visible,
        position: i.position,
        rings: rings[i.id] || [],
        conditions: conditionsOf(i),
        // Stat Bubbles, when it tracks this token's HP.
        ...bubbles(i),
      };
    });
  const areas = items.filter(isRoom).map((room) => ({
    id: room.id,
    place: room.metadata?.[PLACE_KEY] || null,
    label: room.name,
    size: size(room),
    tokens: tokens.filter((t) => contains(room, t.position)).map((t) => t.id),
  }));
  return {
    scene: true,
    grid: {
      dpi: await OBR.scene.grid.getDpi(),
      multiplier: scale.parsed.multiplier,
      unit: scale.parsed.unit,
      measurement: await OBR.scene.grid.getMeasurement(),
      type: await OBR.scene.grid.getType(),
    },
    tokens,
    areas,
    ...(copied ? { copied } : {}),
  };
}

async function send() {
  timer = null;
  if (bridge) return bridge.report(); // to the panel the bridge found (nothing on a standby tab)
  if (!legacy) return; // not the Dell's tab: it never reports
  try {
    const body = await summary();
    await fetch("/api/map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // The voice system isn't running: try again on the next change or heartbeat.
  }
}

function soon() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(send, DEBOUNCE_MS);
}

// The 🗺 right-click menus open a small list (menu.html) at the top left.
function openMenu(kind, context) {
  const ids = context.items.map((i) => i.id).join(",");
  OBR.popover.open({
    id: "dnd-npc/menu",
    url: here(`./menu.html?kind=${kind}&ids=${encodeURIComponent(ids)}`, import.meta.url),
    width: 260,
    height: 360,
    anchorReference: "POSITION",
    anchorPosition: { left: 70, top: 70 },
    anchorOrigin: { horizontal: "LEFT", vertical: "TOP" },
    transformOrigin: { horizontal: "LEFT", vertical: "TOP" },
  });
}

// ---- jobs the panel asks of the map (the Dell's copy) ----

async function setHp(id, by) {
  // Stat Bubbles shows the change straight away, as if the DM had typed it there. Damage takes
  // temporary HP first, the way Stat Bubbles' own damage tool does; healing never adds to it.
  await OBR.scene.items.updateItems([id], (items) => {
    for (const i of items) {
      const b = i.metadata[BUBBLES_KEY];
      const { hp, max_hp, temp_hp } = bubbles(i);
      if (hp == null) continue;
      const soaked = by > 0 ? Math.min(temp_hp, by) : 0;
      i.metadata[BUBBLES_KEY] = { ...b, health: Math.max(0, Math.min(max_hp, hp - (by - soaked))),
                                  "temporary health": temp_hp - soaked };
    }
  });
}

async function seedStats(id, hp, ac) {
  // A player character's token gets their max HP and AC from party.yaml (Step 35), hidden from
  // the players like a monster's. Only when Stat Bubbles doesn't track it yet: after that the
  // DM's own numbers there win.
  await OBR.scene.items.updateItems([id], (items) => {
    for (const i of items) {
      if (bubbles(i).hp != null) continue;
      i.metadata[BUBBLES_KEY] = { ...(i.metadata[BUBBLES_KEY] || {}), health: hp, "max health": hp,
                                  "temporary health": 0, "armor class": ac, hide: true };
    }
  });
}

async function setMark(id, text) {
  // A note under a monster only the GM sees (hidden items don't show on the players' screens).
  const markId = MARK_PREFIX + id;
  const [token] = await OBR.scene.items.getItems([id]);
  const [mark] = await OBR.scene.items.getItems([markId]);
  if (!token || !text) {
    if (mark) await OBR.scene.items.deleteItems([markId]);
    return;
  }
  if (mark) {
    await OBR.scene.items.updateItems([markId], (items) => {
      for (const i of items) i.text.plainText = text;
    });
    return;
  }
  const dpi = await OBR.scene.grid.getDpi();
  await OBR.scene.items.addItems([
    // The SDK's text builder names these fillColor, strokeColor, strokeWidth and width.
    buildText()
      .id(markId)
      .plainText(text)
      .textType("PLAIN")
      .fontSize(Math.round(dpi / 5))
      .fontWeight(700)
      .fillColor("#ffd27a")
      .strokeColor("black")
      .strokeWidth(4)
      .position({ x: token.position.x - dpi, y: token.position.y + dpi * 0.45 })
      .width(dpi * 2)
      .attachedTo(id)
      .layer("TEXT")
      .visible(false)
      .locked(true)
      .disableHit(true)
      .build(),
  ]);
}

async function ping(id) {
  // 📍 from the panel: a ring around that token for a moment, so the DM sees which one a row
  // is. Hidden, so only the GM sees it (on the laptop too), never the projector.
  const [token] = await OBR.scene.items.getItems([id]);
  if (!token) return;
  const dpi = await OBR.scene.grid.getDpi();
  const ringId = `dnd-npc-ping-${id}-${Date.now()}`;
  await OBR.scene.items.addItems([
    buildShape()
      .id(ringId)
      .shapeType("CIRCLE")
      .width(dpi * 1.6)
      .height(dpi * 1.6)
      .position(token.position)
      .strokeColor("#ffd27a")
      .strokeWidth(dpi / 12)
      .fillOpacity(0)
      .attachedTo(id)
      .layer("ATTACHMENT")
      .visible(false)
      .locked(true)
      .disableHit(true)
      .build(),
  ]);
  setTimeout(() => OBR.scene.items.deleteItems([ringId]), PING_MS);
}

async function unring(ids, color = TARGET_COLOR) {
  // ✕ on the panel: the blue target rings (or the white ones) come off those tokens; other colours stay.
  const items = await OBR.scene.items.getItems(
    (i) => ids.includes(i.attachedTo) && i.metadata?.[RING_KEY]?.enabled
      && String(i.style?.strokeColor).toLowerCase() === String(color).toLowerCase(),
  );
  if (items.length) await OBR.scene.items.deleteItems(items.map((i) => i.id));
}

async function ringDown(id) {
  // 0 HP: the token's blue (target) ring turns red, a Colored Rings red Colored Rings itself
  // shows as picked. No ring at all: it gets a red one, built the way Colored Rings builds them.
  const [token] = await OBR.scene.items.getItems([id]);
  if (!token) return;
  const rings = await OBR.scene.items.getItems((i) => i.attachedTo === id && i.metadata?.[RING_KEY]?.enabled);
  const colour = (i) => String(i.style?.strokeColor).toLowerCase();
  const blue = rings.filter((i) => colour(i) === TARGET_COLOR);
  if (blue.length) {
    await OBR.scene.items.updateItems(blue.map((i) => i.id), (items) => {
      for (const i of items) i.style.strokeColor = DOWN_COLOR;
    });
    return;
  }
  if (rings.some((i) => colour(i) === DOWN_COLOR) || !token.image || !token.grid) return;
  const dpi = await OBR.scene.grid.getDpi();
  const scale = dpi / token.grid.dpi;
  const width = token.image.width * scale;
  const height = token.image.height * scale;
  const diameter = Math.min(width, height);
  await OBR.scene.items.addItems([
    buildShape()
      .width(diameter)
      .height(diameter)
      .position({
        x: token.position.x - (token.grid.offset.x / token.image.width) * width + width / 2,
        y: token.position.y - (token.grid.offset.y / token.image.height) * height + height / 2,
      })
      .fillOpacity(0)
      .strokeColor(DOWN_COLOR)
      .strokeOpacity(1)
      .strokeWidth(5)
      .shapeType("CIRCLE")
      .attachedTo(id)
      .locked(true)
      .name("Status Ring")
      .metadata({ [RING_KEY]: { enabled: true } })
      .layer("ATTACHMENT")
      .disableHit(true)
      .visible(token.visible)
      .build(),
  ]);
}

let busy = false;
async function todo() {
  if (busy) return;
  busy = true;
  try {
    const r = await fetch("/api/map/todo");
    const jobs = r.ok ? await r.json() : [];
    for (const job of jobs) {
      try {
        if (job.op === "hp") await setHp(job.id, job.damage);
        else if (job.op === "mark") await setMark(job.id, job.text);
        else if (job.op === "ping") await ping(job.id);
        else if (job.op === "unring") await unring(job.ids, job.color);
        else if (job.op === "cond") await setCondition(job.ids, job.name, job.on);
        else if (job.op === "down") await ringDown(job.id);
        else if (job.op === "stats") await seedStats(job.id, job.hp, job.ac);
      } catch (e) {
        console.warn("dnd-npc map job failed", job, e);
      }
    }
  } catch (e) {
    // The voice system isn't running.
  } finally {
    busy = false;
  }
}

// The 🗺 menus' ids. Owlbear's ids look room-wide rather than per extension, so the copy served
// by the panel on this PC uses its own: when it steps aside for the Pages copy on the same tab
// (the dual install) it can only ever remove its own menus, never the Pages copy's.
const MENU_IDS = { place: "dnd-npc/mark-place", who: "dnd-npc/this-is", cond: "dnd-npc/conditions",
                   goto: "dnd-npc/go-to-pc", bring: "dnd-npc/bring-pcs" };
const LOCAL_MENU_IDS = { place: "dnd-npc/local/mark-place", who: "dnd-npc/local/this-is", cond: "dnd-npc/local/conditions",
                         goto: "dnd-npc/local/go-to-pc", bring: "dnd-npc/local/bring-pcs" };
// 🎯 Go to PC's toolbar button and key (a tool action, removed with tool.removeAction).
const GOTO_KEY_ID = "dnd-npc/go-to-pc-key";
const LOCAL_GOTO_KEY_ID = "dnd-npc/local/go-to-pc-key";
// 🏘 and 👥 need interiors.json, which only the panel on this PC can hand over (far too big for
// the bridge's broadcasts): only the copy the panel serves makes these, even when it only relays
// on the Dell's tab (the Pages copy there can't reach the panel), and never removes them.
// (🧭 Bring PCs here is one of menus(): what it needs is on the map images, MAP_INFO_KEY.)
const THIS_PC_MENU_IDS = { interiors: "dnd-npc/local/interiors", portals: "dnd-npc/local/check-portals",
                           townsfolk: "dnd-npc/local/townsfolk" };
const ICON = here("./icon.svg", import.meta.url);

function menus(ids = MENU_IDS, gotoKeyId = GOTO_KEY_ID) {
  OBR.contextMenu.create({
    id: ids.place,
    icons: [{
      icon: ICON,
      label: "🗺 Mark as place",
      filter: { roles: ["GM"], every: [{ key: "layer", value: "DRAWING" }] },
    }],
    onClick: (context) => openMenu("place", context),
  });
  OBR.contextMenu.create({
    id: ids.who,
    icons: [{
      icon: ICON,
      label: "🗺 This is…",
      filter: { roles: ["GM"], every: [{ key: "layer", value: "CHARACTER" }] },
    }],
    onClick: (context) => openMenu("who", context),
  });
  // Like Stat Bubbles' Edit Stats: the condition badges to switch on and off, in the menu itself.
  OBR.contextMenu.create({
    id: ids.cond,
    icons: [{
      icon: ICON,
      label: "Conditions",
      filter: { roles: ["GM"], every: [{ key: "layer", value: "CHARACTER" }] },
    }],
    embed: { url: here("./conditions.html", import.meta.url), height: 176 },
  });
  // On anything at all: the list of PCs (menu.html), one tap pans the view to that one (goto.js).
  // It only needs the party's names (through the bridge when this copy can't reach the panel).
  OBR.contextMenu.create({
    id: ids.goto,
    icons: [{ icon: ICON, label: "🎯 Go to PC", filter: { roles: ["GM"] } }],
    onClick: (context) => openMenu("goto", context),
  });
  // On a map image, a room drawing or a token: move the PCs' tokens there (gather.js). The list
  // (menu.html) offers "All PCs" and each PC, one tap each. The first icon whose filter matches
  // shows. A building map's entry and furniture are on its image (MAP_INFO_KEY), so any copy can.
  OBR.contextMenu.create({
    id: ids.bring,
    icons: [
      [{ key: "layer", value: "MAP" }, { key: "type", value: "IMAGE" }],
      [{ key: "layer", value: "DRAWING" }],
      [{ key: "layer", value: "CHARACTER" }],
    ].map((every) => ({ icon: ICON, label: "🧭 Bring PCs here", filter: { roles: ["GM"], max: 1, every } })),
    onClick: (context) => openMenu("bring", context),
  });
  // ...and the same list from a key, with nothing selected: a button on every tool's bar.
  try {
    Promise.resolve(OBR.tool.createAction({
      id: gotoKeyId,
      shortcut: GO_TO_KEY,
      icons: [{ icon: ICON, label: `🎯 Go to PC (${GO_TO_KEY})`, filter: { roles: ["GM"] } }],
      onClick: () => openMenu("goto", { items: [] }),
    })).catch((e) => console.warn("dnd-npc: the Go to PC key", e));
  } catch (e) {
    console.warn("dnd-npc: the Go to PC key", e);
  }
}

// The copy served by this PC only (see THIS_PC_MENU_IDS).
function thisPcMenus() {
  // On the town map: lay the building maps out beside it and mark them up (interiors.js).
  OBR.contextMenu.create({
    id: THIS_PC_MENU_IDS.interiors,
    icons: [{
      icon: ICON,
      label: "🏘 Set up interiors",
      filter: { roles: ["GM"], max: 1, every: [{ key: "layer", value: "MAP" }, { key: "type", value: "IMAGE" }] },
    }],
    onClick: async (context) => {
      try {
        await setUpInteriors(context.items[0].id);
      } catch (e) {
        console.warn("dnd-npc interiors failed", e);
        OBR.notification.show(`🏘 Setting up interiors failed: ${describe(e)}`, "ERROR");
        // ...and the whole error to the panel's window, where it can be read
        panelLog({ what: "interiors", error: describe(e), stack: String(e?.stack || ""),
                   detail: JSON.stringify(e, Object.getOwnPropertyNames(e || {})).slice(0, 4000) });
      }
    },
  });
  // On the town map: each NPC of interiors.json's town.townsfolk to its room (gather.js).
  OBR.contextMenu.create({
    id: THIS_PC_MENU_IDS.townsfolk,
    icons: [{
      icon: ICON,
      label: "👥 Place townsfolk",
      filter: { roles: ["GM"], max: 1, every: [{ key: "layer", value: "MAP" }, { key: "type", value: "IMAGE" }] },
    }],
    onClick: async () => {
      try {
        await placeTownsfolk();
      } catch (e) {
        console.warn("dnd-npc townsfolk failed", e);
        OBR.notification.show(`👥 Placing townsfolk failed: ${describe(e)}`, "ERROR");
        panelLog({ what: "townsfolk", error: describe(e), stack: String(e?.stack || ""), detail: "" });
      }
    },
  });
  OBR.contextMenu.create({
    id: THIS_PC_MENU_IDS.portals,
    icons: [{
      icon: ICON,
      label: "🏘 Check portals",
      filter: { roles: ["GM"], max: 1, every: [{ key: "layer", value: "MAP" }, { key: "type", value: "IMAGE" }] },
    }],
    onClick: (context) => checkPortals(context.items[0].id).catch((e) =>
      OBR.notification.show(`🏘 Check failed: ${describe(e)}`, "ERROR")),
  });
}

// ---- Step 36: every screen, and the bridge on the Dell ----

// The map jobs from game night 1, for the bridge: the functions above, unchanged.
const JOBS = {
  hp: (job) => setHp(job.id, job.damage),
  mark: (job) => setMark(job.id, job.text),
  ping: (job) => ping(job.id),
  unring: (job) => unring(job.ids, job.color),
  cond: (job) => setCondition(job.ids, job.name, job.on),
  down: (job) => ringDown(job.id),
  stats: (job) => seedStats(job.id, job.hp, job.ac),
};

// The parts that load on their own (R4): a broken one is left out and the rest carry on.
// Literal paths, so the publisher can stamp each with the build.
const MODULES = {
  bridge: () => import("./bridge.js?v=0635c01"),
  fx: () => import("./fx/engine.js?v=0635c01"),
  samples: () => import("./fx/samples.js?v=0635c01"),
  aim: () => import("./aim/tool.js?v=0635c01"),
  geometry: () => import("./aim/geometry.js?v=0635c01"),
  rings: () => import("./aim/rings.js?v=0635c01"),
  player: () => import("./player/state.js?v=0635c01"),
};

const HELLO_MS = 30000; // each screen says hello this often, so the panel's screens list stays fresh
const NO_BRIDGE_MS = 15000; // a GM aimer that heard no bridge this long rings the targets itself
// A copy served by the panel on this PC waits at most this long, at start, to hear whether the
// Pages copy runs on this same tab too (the dual install). It asks at once and the Pages copy
// answers at once (or says hello as soon as it has started), so the wait only runs out when
// there is no Pages copy (game night 1, development); generous, for a slow first load of the
// Pages copy after a push. Meanwhile jobs simply wait in the panel's queue.
const DUAL_WAIT_MS = 5000;
const NOTE_VARIANTS = ["DEFAULT", "ERROR", "INFO", "SUCCESS", "WARNING"];

let bridge = null; // bridge.js on a GM tab (it decides whether this tab is THE bridge)
let legacy = false; // a localhost tab whose bridge.js didn't load: the game-night-1 loops

const sdk = { OBR, buildCurve, buildEffect, buildImage, buildLabel, buildPath, buildShape, buildText, Math2, MathM };

async function gridOf(O) {
  const scale = await O.scene.grid.getScale();
  return { dpi: await O.scene.grid.getDpi(), multiplier: scale?.parsed?.multiplier ?? 5, unit: scale?.parsed?.unit ?? "ft",
           measurement: await O.scene.grid.getMeasurement(), type: await O.scene.grid.getType() };
}

// Start this screen. `api` and `opts` (importer, origin, timers, fetchImpl) are only swapped
// by the offline check; in Owlbear it's the real SDK.
//
// The dual install (spec 14.5, A12): on game night the Dell's tabs run two copies of this file,
// the one the panel serves ("DND NPC (this PC)", host local) and the one from the Pages site
// ("DND NPC", host pages). They share the tab's Owlbear connection and hear each other's
// broadcasts. The local copy asks "who's here?" at start; if the Pages copy answers, the local
// copy only relays (ctx.relayOnly): the bridge's duties on a GM tab, nothing at all on a player's.
export async function boot(api = sdk, opts = {}) {
  const O = api.OBR;
  bridge = null;
  legacy = false;
  // Wrapped, never the bare functions: Chrome throws "Illegal invocation" for T.setInterval(...)
  // when setInterval itself sits on a plain object (Node doesn't, so only the live tab showed it).
  const T = opts.timers || {
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t), now: () => Date.now(),
  };
  const load = opts.importer || ((name) => MODULES[name]());
  const origin = opts.origin ?? globalThis.location?.origin ?? "";
  const local = isLocalOrigin(origin);
  const role = await O.player.getRole();
  const conn = await O.player.getConnectionId();
  setConnection(conn, local ? "local" : "pages");
  const ctx = {
    role, conn, playerId: O.player.id, name: await O.player.getName().catch(() => ""), origin,
    host: local ? "local" : "pages", build: buildOf(import.meta.url), kind: role === "GM" ? "gm" : "other",
    settings: { ...DEFAULT_SETTINGS }, pcTokens: new Set(), fx_ok: false,
    relayOnly: false, // the Pages copy on this same tab draws; this copy only relays
    sameTab: null, // what the other copy of the extension on this tab said in its HELLO
    log: (text) => console.log(`dnd-npc ${text}`),
  };
  const me = { role, playerId: ctx.playerId };
  const kindNow = () => kindOf({
    role, playerId: ctx.playerId, ua: globalThis.navigator?.userAgent || "",
    coarse: (() => { try { return !!globalThis.matchMedia?.("(pointer: coarse)")?.matches; } catch { return false; } })(),
    tableFlag: lsGet(LS.TABLE_SCREEN) === "1", settings: ctx.settings, name: ctx.name,
  });
  ctx.kind = kindNow();
  ctx.tool = ctx.kind !== "table"; // the Cast receiver shows templates but has no aim tool (aim/tool.js)

  // R1: a token is secret only when it's hidden AND not a player character. One this screen
  // hasn't seen yet (any layer) counts as secret until it has: fail closed.
  const visible = new Map(); // item id -> visible
  ctx.isPublic = (x, item) => {
    const id = typeof x === "string" ? x : x?.id;
    if (ctx.pcTokens.has(id)) return true;
    const it = item || (x && typeof x === "object" ? x : null);
    const vis = it && "visible" in it ? it.visible : visible.get(id);
    return vis !== undefined && vis !== false;
  };
  const remember = (items) => {
    visible.clear();
    for (const i of items || []) visible.set(i.id, i.visible);
  };

  // ---- the parts that may fail ----
  const errors = {};
  const tryLoad = async (name) => {
    try {
      return await load(name);
    } catch (e) {
      errors[name] = String(e?.message || e);
      console.warn(`dnd-npc: ${name} didn't load`, e);
      return null;
    }
  };
  const [bridgeMod, fxMod, aimMod, geometry, rings, playerMod] = await Promise.all([
    role === "GM" ? tryLoad("bridge") : null, tryLoad("fx"), tryLoad("aim"), tryLoad("geometry"), tryLoad("rings"),
    role === "GM" ? null : tryLoad("player"),
  ]);

  let fx = null;
  try {
    // Created on every copy: the bridge writes the zone outlines with it even when it only
    // relays. Nothing is drawn until start() (or ever, on a copy that only relays).
    fx = fxMod?.createFx ? fxMod.createFx(api, ctx) : null;
  } catch (e) {
    errors.fx = String(e?.message || e);
    console.warn("dnd-npc: effects didn't start", e);
  }
  ctx.fx_ok = !!fx;

  let started = false; // false until this copy knows whether it draws on this tab (start())
  const drawsHere = () => started && !ctx.relayOnly;
  let lastHb = null;
  let lastHbAt = T.now(); // as if heard at start: give the bridge 15 s before ringing here
  const shows = new Map(); // template id -> what AIM_SHOW said (the all and gm copies merged)
  const silent = new Set(); // aims this tab stops because someone else locked or the panel cancelled

  const silence = (id) => {
    silent.add(id);
    T.setTimeout(() => silent.delete(id), 2000);
  };

  async function gmLocked(result, info) {
    // How far the aim tool measured, for the panel's "⚠ too far" (the bridge passes it on).
    const feet = Number.isFinite(info?.feet) ? info.feet : null;
    busSend(api, CH.AIM_LOCKED, { ...result, feet, out_of_range: !!info?.out_of_range }, "ALL");
    if (bridge?.isBridge() || T.now() - lastHbAt <= NO_BRIDGE_MS) return; // the bridge rings them
    // No bridge for 15 s (the panel is down, or no Dell tab): ring the caught tokens from here,
    // so the DM's targets still show (any GM may write rings). Hidden ones too: this is a GM.
    if (!result?.template || !geometry?.computeCaught || !rings?.setTargetRings) return;
    try {
      const caught = await geometry.computeCaught(result.template, await O.scene.items.getItems(), await gridOf(O),
        { includeSecret: true, isPublic: ctx.isPublic, casterId: result.template.caster_token || null });
      if (!Array.isArray(caught)) return; // can't tell who's caught: leave the rings alone
      await rings.setTargetRings(api, caught.map((c) => c.id), { replace: true });
      ctx.log(`no bridge: rang ${caught.length} target(s) here`);
    } catch (e) {
      console.warn("dnd-npc: couldn't ring the targets here", e);
    }
  }

  let player = null;
  const hooks = {
    onLocked: (result, info) => (role === "GM" ? gmLocked(result, info) : player?.onLocked?.(result, info)),
    onCancelled: (id) => {
      if (silent.delete(id)) return;
      if (role === "GM") busSend(api, CH.AIM_LOCKED, { aim_id: id, template: null, target: null, cancel: true }, "ALL");
      else player?.onCancelled?.(id);
    },
    onState: (s) => player?.onAimState?.(s),
  };
  let aim = null;

  let fxSig = "";
  function applySettings(s, { quiet = false } = {}) {
    // The panel's settings (or this device's own choices) changed: maybe this screen's kind
    // too (the DM picked it as the table screen), and the effects tier with it. A copy that
    // only relays draws nothing here, whatever the panel says.
    ctx.settings = s || ctx.settings;
    const kind = kindNow();
    const moved = kind !== ctx.kind;
    ctx.kind = kind;
    const off = ctx.relayOnly;
    const next = { ...ctx.settings, kind, tier: off ? "off" : tierOf(ctx.settings, kind),
                   quality_override: off ? "off" : lsGet(LS.QUALITY) };
    const sig = JSON.stringify(next);
    if (sig !== fxSig) { // the heartbeat repeats them every 5 s: only pass on a change
      fxSig = sig;
      try {
        fx?.setSettings?.(next);
      } catch (e) {
        console.warn("dnd-npc: effects settings", e);
      }
    }
    if (moved && !quiet) hello();
    return moved;
  }

  function hello() {
    // need "hello" (only from a copy served by this PC): "is the Pages copy on this tab too?"
    busSend(api, CH.HELLO, { role, kind: ctx.kind, build: ctx.build, fx_ok: ctx.fx_ok, host: ctx.host,
                             name: ctx.name, need: local ? ["bridge", "hello"] : ["bridge"] }, "ALL");
  }

  // The scene-metadata fallback (bus.js) is only read when it's switched on: off by default,
  // since plain broadcasts cross between the two copies (probe P10).
  const sceneFallback = () => lsGet(LS.SCENE_BUS) === "1" || ctx.settings?.scene_bus === true;

  function onHeartbeat(hb, ev) {
    const isNew = hb.conn !== lastHb?.conn;
    lastHb = hb;
    lastHbAt = T.now();
    if (Array.isArray(hb.pc_tokens) && !ev?.self) {
      ctx.pcTokens.clear();
      for (const id of hb.pc_tokens) ctx.pcTokens.add(id);
    }
    const moved = hb.settings ? applySettings({ ...DEFAULT_SETTINGS, ...hb.settings,
      quality: { ...DEFAULT_SETTINGS.quality, ...(hb.settings.quality || {}) } }, { quiet: true }) : false;
    if (hb.scene_bus || sceneFallback()) startSceneReader(api, conn);
    // The bridge only reaches us through scene metadata: send our own messages that way too.
    if (hb.scene_bus && ev?.viaScene) setSceneWrite(api, conn, true);
    try { player?.onBridge?.(hb); } catch (e) { console.warn(e); }
    if ((isNew && !ev?.self) || moved) hello(); // a new bridge, or a new kind: tell it who we are
  }
  ctx.onHeartbeat = onHeartbeat;

  async function playTest() {
    // 🧪 in the popover: a sample effect on this screen only, at the middle of the view.
    if (ctx.relayOnly) return "This copy only relays here: use the “DND NPC” box (the Pages copy) to test effects.";
    if (!fx) return "Effects didn't load on this screen.";
    const mod = await tryLoad("samples");
    const all = mod?.SAMPLES;
    const list = Array.isArray(all) ? all : all && typeof all === "object" ? Object.values(all) : [];
    const pick = list.find((e) => /fireball/i.test(e?.label || "")) || list[0];
    if (!pick) return "No sample effect to play.";
    try {
      await fx.play(pick);
      return "";
    } catch (e) {
      return String(e?.message || e);
    }
  }

  function snapshot(note = "") {
    return {
      role, kind: ctx.kind, build: ctx.build, host: ctx.host, conn, name: ctx.name, note,
      opted_in: local || lsGet(LS.BRIDGE_HERE) === "1", aim_here: lsGet(LS.AIM_HERE) !== "0",
      table_screen: lsGet(LS.TABLE_SCREEN) === "1", quality: lsGet(LS.QUALITY) || "auto",
      scene_bus: lsGet(LS.SCENE_BUS) === "1", relay_only: ctx.relayOnly, started,
      same_tab: ctx.sameTab ? { host: ctx.sameTab.host, build: ctx.sameTab.build, fx_ok: ctx.sameTab.fx_ok } : null,
      bridge: bridge ? bridge.status()
        : { state: !started ? "starting" : legacy ? "legacy" : errors.bridge ? "failed" : "off", reason: errors.bridge || "" },
      heard: lastHb ? { conn: lastHb.conn, panel: lastHb.panel, build: lastHb.build, age_s: Math.round((T.now() - lastHbAt) / 1000) } : null,
      fx_ok: ctx.fx_ok, aim_ok: !!aim, errors, settings: ctx.settings,
    };
  }
  const pushState = () => { if (role === "GM") busSend(api, CH.LOCAL_STATE, snapshot(), "LOCAL"); };

  function stepAside() {
    // The Pages copy of the extension runs on this same tab: it draws the effects, aims and
    // shows the menus here, and this copy only relays between it and the panel.
    if (ctx.relayOnly) return;
    ctx.relayOnly = true;
    ctx.log("the Pages copy is on this tab too: this copy only relays");
    if (!started) {
      safeStart(); // heard before the wait ran out: start now, as a relay only
      return;
    }
    // It came late: this copy was already drawing here. Stop, without touching anything the
    // Pages copy made: Owlbear's tool and menu ids are room-wide, so the aim tool (same id in
    // both copies, the Pages copy's created last) is left in place, and only this copy's own
    // menus are removed.
    try { fx?.zones?.stop?.(); } catch (e) { console.warn("dnd-npc: zones", e); }
    try { fx?.clear?.(); } catch (e) { console.warn("dnd-npc: effects", e); }
    applySettings(ctx.settings, { quiet: true }); // tier off
    try {
      const id = aim?.current?.()?.id;
      if (aim?.isAiming?.()) {
        if (id) silence(id);
        aim.cancel(id);
      }
      for (const sid of shows.keys()) aim?.clearTemplate?.(sid, { fadeMs: 0 });
    } catch (e) {
      console.warn("dnd-npc: aim", e);
    }
    shows.clear();
    try { player?.stop?.(); } catch (e) { console.warn("dnd-npc: player", e); }
    player = null;
    if (role === "GM") {
      for (const id of Object.values(LOCAL_MENU_IDS)) Promise.resolve().then(() => O.contextMenu.remove(id)).catch(() => {});
      Promise.resolve().then(() => O.tool.removeAction(LOCAL_GOTO_KEY_ID)).catch(() => {});
    }
    bridge?.relayOnly?.();
    pushState();
  }

  // ---- what every screen hears ----
  busOn(api, CH.BRIDGE, (hb, ev) => onHeartbeat(hb, ev));
  busOn(api, CH.HELLO, (msg, ev) => {
    // The other copy of this extension on this same tab: same connection, the other host. The
    // copy served from this PC steps aside for the Pages copy, and the Pages copy answers the
    // other's "who's here?" at once, so neither has to wait for the 30 s hello.
    if (!ev || ev.local || ev.viaScene || ev.connectionId !== conn || !msg?.host || msg.host === ctx.host) return;
    ctx.sameTab = { host: msg.host, kind: msg.kind ?? "", build: msg.build ?? "", fx_ok: !!msg.fx_ok, at: T.now() };
    if (local && msg.host === "pages") stepAside();
    else if (!local && Array.isArray(msg.need) && msg.need.includes("hello")) hello();
  });
  busOn(api, CH.FX, (msg) => {
    if (!drawsHere() || !forMe(msg, me) || bridge?.isBridge() || !msg.event) return; // the bridge drew it already
    try {
      Promise.resolve(fx?.play(msg.event, msg.audience === "gm" ? { gmDelta: true } : {})).catch((e) => console.warn(e));
    } catch (e) {
      console.warn("dnd-npc fx failed", e);
    }
  });
  busOn(api, CH.AIM_START, (msg) => {
    if (!drawsHere() || !forMe(msg, me) || role !== "GM" || lsGet(LS.AIM_HERE) === "0" || !msg.aim) return;
    aim?.start(msg.aim);
  });
  busOn(api, CH.AIM_SHOW, (msg) => {
    if (!drawsHere() || !forMe(msg, me) || !msg.id || !aim?.showTemplate) return;
    const prev = shows.get(msg.id) || {};
    const show = { ...prev, ...msg, secret: [...new Set([...(prev.secret || []), ...(msg.secret || [])])] };
    shows.set(msg.id, show);
    aim.showTemplate(msg.id, show.template, show.style, show);
  });
  busOn(api, CH.AIM_CLEAR, (msg) => {
    if (!drawsHere() || !msg.id) return;
    shows.delete(msg.id);
    aim?.clearTemplate?.(msg.id, { fadeMs: msg.fade_ms ?? 300 });
  });
  busOn(api, CH.AIM_CANCEL, (msg) => {
    if (!drawsHere() || !forMe(msg, me) || !msg.id || !aim) return;
    silence(msg.id);
    aim.cancel(msg.id);
  });
  busOn(api, CH.AIM_LOCKED, (msg, ev) => {
    // Another GM screen locked this aim first: stop aiming it here.
    if (role !== "GM" || !drawsHere() || ev?.local || ev?.viaScene || ev?.connectionId === conn || !msg.aim_id
        || !aim?.isAiming?.()) return;
    silence(msg.aim_id);
    aim.cancel(msg.aim_id);
  });
  busOn(api, CH.NOTE, (msg) => {
    if (!drawsHere() || !forMe(msg, me) || !msg.text) return;
    O.notification.show(String(msg.text), NOTE_VARIANTS.includes(msg.variant) ? msg.variant : "DEFAULT");
  });
  busOn(api, CH.ROSTER, (msg) => {
    if (!drawsHere() || role === "GM" || msg.to !== ctx.playerId) return;
    player?.onRoster?.(msg.entry ?? null, msg);
  });
  busOn(api, CH.CAST_STATUS, (msg) => {
    if (!drawsHere() || role === "GM" || msg.to !== ctx.playerId) return;
    player?.onStatus?.(msg);
  });
  // Both copies' popovers on the Dell's tab hear every LOCAL message, so a popover tags what it
  // sends with its host, and each copy answers only its own (an untagged message, from a
  // popover that doesn't tag, only when this copy draws here).
  const mine = (msg) => (msg?.host ? msg.host === ctx.host : !ctx.relayOnly);
  busOn(api, CH.LOCAL_AIM, (msg) => {
    if (!drawsHere() || !mine(msg)) return;
    if (role === "GM") aim?.start(msg.spec ?? msg.item);
    else player?.startFromPopover?.(msg.item ?? msg.spec);
  });
  if (role === "GM") {
    // The GM popover asks; a player's popover talks to player/state.js instead.
    busOn(api, CH.LOCAL_ASK, async (msg) => {
      if (!mine(msg)) return;
      let note = "";
      if (msg.need === "find-panel") bridge?.retry();
      else if (msg.need === "force") await bridge?.force();
      else if (msg.need === "test") note = await playTest();
      else if (msg.need === "refresh") {
        applySettings(ctx.settings);
        if (sceneFallback()) startSceneReader(api, conn);
        bridge?.retry();
      }
      busSend(api, CH.LOCAL_STATE, snapshot(note), "LOCAL");
    });
  } else {
    // player/state.js answers its popover itself; this only says why when it didn't load.
    busOn(api, CH.LOCAL_ASK, (msg) => {
      if (!drawsHere() || player || !mine(msg)) return;
      busSend(api, CH.LOCAL_STATE, { role, host: ctx.host, error: errors.player || "not loaded" }, "LOCAL");
    });
  }

  // R1 needs each item's visibility; effects warm up once a scene is open.
  O.scene.items.onChange(remember);
  const ready = async (isReady) => {
    if (!isReady) return;
    try { remember(await O.scene.items.getItems()); } catch { /* next change */ }
    if (drawsHere()) {
      try { fx?.warm?.(); } catch (e) { console.warn(e); }
    }
  };
  O.scene.onReadyChange(ready);
  if (await O.scene.isReady()) await ready(true);
  if (sceneFallback()) startSceneReader(api, conn);
  applySettings(ctx.settings);

  function safeStart() {
    // A throw part-way through start() would leave this copy silent (no bridge, no reason):
    // keep the reason for the popover ("❌ The bridge failed to load: …").
    try {
      start();
    } catch (e) {
      errors.bridge = errors.bridge || `start: ${String(e?.stack || e?.message || e).slice(0, 400)}`;
      console.warn("dnd-npc: start failed", e);
      try { pushState(); } catch { /* the popover asks again */ }
    }
  }

  // Once at start, on the Dell's own copy: keep the party's names in the Owlbear room when the
  // panel answers (rememberParty compares first, so nothing is written when they're the same).
  // The laptop's Pages copy then matches PC tokens by name even without the Dell's bridge.
  function keepParty() {
    const get = opts.fetchImpl || ((url) => fetch(url));
    (async () => {
      const r = await get(`${origin}/api/map/catalog`);
      if (r?.ok) await rememberParty((await r.json())?.party, O);
    })().catch(() => { /* no panel yet: the 🗺 menus keep the party when they get it */ });
  }

  function start() {
    // From here this copy knows whether it draws on this tab. A copy that only relays starts
    // none of the drawing parts: no aim tool, no player's spells, no zone decorations, no menus.
    if (started) return;
    started = true;
    if (!ctx.relayOnly) {
      try {
        aim = aimMod?.installAim ? aimMod.installAim(api, ctx, hooks) : null;
      } catch (e) {
        errors.aim = String(e?.message || e);
        console.warn("dnd-npc: the aim tool didn't start", e);
      }
      try {
        // player/state.js sends with either send(ch, data, dest) or send(api, ch, data, dest).
        const sendFn = (a, b, c, d) => (typeof a === "string" ? busSend(api, a, b, c) : busSend(a, b, c, d));
        player = playerMod?.createPlayerState ? playerMod.createPlayerState(api, ctx, { aim, send: sendFn }) : null;
      } catch (e) {
        errors.player = String(e?.message || e);
        console.warn("dnd-npc: the player's spells didn't start", e);
      }
      try { fx?.zones?.start?.(); } catch (e) { console.warn("dnd-npc: zones", e); }
      O.scene.isReady().then((r) => {
        if (r && drawsHere()) fx?.warm?.();
      }).catch((e) => console.warn(e));
    }
    applySettings(ctx.settings, { quiet: true });

    // ---- the GM: menus, and the bridge (or the old loops) ----
    if (role === "GM") {
      if (!ctx.relayOnly) menus(local ? LOCAL_MENU_IDS : MENU_IDS, local ? LOCAL_GOTO_KEY_ID : GOTO_KEY_ID);
      if (local) thisPcMenus(); // 🏘 and 👥: on this copy even when it only relays (THIS_PC_MENU_IDS)
      if (local) keepParty();
      O.scene.items.onChange(soon);
      O.scene.grid.onChange(soon);
      O.scene.onReadyChange(soon);
      T.setInterval(send, HEARTBEAT_MS);
      if (bridgeMod?.startBridge) {
        ctx.onStatus = pushState;
        try {
          bridge = bridgeMod.startBridge(api, ctx, {
            fx, aim, rings, geometry, jobs: JOBS, summary, fetchImpl: opts.fetchImpl, timers: opts.timers,
          });
        } catch (e) {
          // Say why in the popover ("❌ The bridge failed to load: …"), and on a tab the panel
          // serves fall back to game night 1's loops rather than leave the map unheard.
          bridge = null;
          errors.bridge = String(e?.stack || e?.message || e).slice(0, 400);
          console.warn("dnd-npc: the bridge didn't start", e);
          if (local) {
            legacy = true;
            T.setInterval(todo, TODO_MS);
          }
        }
      } else if (local) {
        // bridge.js broke, but this tab is served by the panel itself: run game night 1's loops.
        legacy = true;
        T.setInterval(todo, TODO_MS);
      }
      soon();
      pushState();
    }
    T.setInterval(hello, HELLO_MS);
  }

  if (local) {
    hello(); // also "who's here?": the Pages copy on this tab, if any, answers at once
    T.setTimeout(safeStart, DUAL_WAIT_MS);
  } else {
    safeStart();
    hello();
  }
  return {
    ctx, snapshot, errors, stepAside,
    get started() { return started; }, get fx() { return fx; }, get aim() { return aim; }, get player() { return player; },
  };
}

OBR.onReady(() => boot());
