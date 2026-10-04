// The DND NPC map extension's background script. It runs in every Owlbear tab
// that loads the extension, but only a GM tab on the Dell reports: the
// projector's player view (and the laptop, which can't load it at all) stays out.
//
// After every change on the map (a drop, a room drawn or marked) and every few
// seconds as a heartbeat, it sends the panel (/api/map) each character token
// and which marked rooms it stands in. map_state.py turns that into who is where.
//
// Two copies of these files are installed in Owlbear:
//   - the one the panel serves on http://localhost (the Dell): it reports to the panel,
//     carries out what the panel asks of the map (HP in GM's Grimoire, the hidden notes
//     on monsters), and has the 🗺 marking menus;
//   - the online copy (GitHub Pages, made by owlbear/publish_online.py), which also loads
//     on the laptop: it only has 🎯 Target. A pick is saved on the scene, Owlbear shares
//     it with every open tab, and the Dell's copy reports it with everything else.
import OBR, { buildShape, buildText } from "./obr-sdk.js";
import { contains, isRoom, size } from "./areas.js";
import { HP_KEY, MARK_PREFIX, PLACE_KEY, TARGET_KEY, WHO_KEY } from "./keys.js";

const HEARTBEAT_MS = 10000;
const DEBOUNCE_MS = 250;
const TODO_MS = 1000; // how often the Dell's copy asks the panel for map jobs
const PING_MS = 3000; // how long 📍 rings a token
const LOCAL = location.hostname === "localhost"; // served by the panel, on the Dell

let timer = null;

async function summary() {
  // No map open: still report, so the panel knows the extension is there.
  if (!(await OBR.scene.isReady())) return { scene: false, grid: null, tokens: [], areas: [] };
  const items = await OBR.scene.items.getItems();
  const scale = await OBR.scene.grid.getScale();
  const tokens = items
    .filter((i) => i.layer === "CHARACTER")
    .map((i) => {
      const hp = i.metadata?.[HP_KEY];
      return {
        id: i.id,
        label: i.text?.plainText || "",
        name: i.name,
        link: i.metadata?.[WHO_KEY] || "",
        visible: i.visible,
        position: i.position,
        // GM's Grimoire, when it tracks this token.
        ...(hp && typeof hp.hp === "number" ? { hp: hp.hp, max_hp: hp.maxHp, ac: hp.armorClass ?? null } : {}),
      };
    });
  const areas = items.filter(isRoom).map((room) => ({
    id: room.id,
    place: room.metadata?.[PLACE_KEY] || null,
    label: room.name,
    size: size(room),
    tokens: tokens.filter((t) => contains(room, t.position)).map((t) => t.id),
  }));
  const target = (await OBR.scene.getMetadata())[TARGET_KEY] || null;
  return {
    scene: true,
    target,
    grid: {
      dpi: await OBR.scene.grid.getDpi(),
      multiplier: scale.parsed.multiplier,
      unit: scale.parsed.unit,
      measurement: await OBR.scene.grid.getMeasurement(),
      type: await OBR.scene.grid.getType(),
    },
    tokens,
    areas,
  };
}

async function send() {
  timer = null;
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
    url: `/owlbear/menu.html?kind=${kind}&ids=${encodeURIComponent(ids)}`,
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
  // GM's Grimoire shows the change straight away, as if the DM had typed it there.
  await OBR.scene.items.updateItems([id], (items) => {
    for (const i of items) {
      const d = i.metadata[HP_KEY];
      if (d && typeof d.hp === "number") d.hp = Math.max(0, Math.min(d.maxHp ?? d.hp - by, d.hp - by));
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
    buildText()
      .id(markId)
      .plainText(text)
      .textType("PLAIN")
      .fontSize(Math.round(dpi / 5))
      .fontWeight(700)
      .textFillColor("#ffd27a")
      .textStrokeColor("black")
      .textStrokeWidth(4)
      .position({ x: token.position.x - dpi, y: token.position.y + dpi * 0.45 })
      .textWidth(dpi * 2)
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

// ---- 🎯 Target (the online copy, on the laptop and the Dell) ----

function targetMenu() {
  OBR.contextMenu.create({
    id: "dnd-npc/target",
    icons: [{
      icon: new URL("./icon.svg", import.meta.url).href,
      label: "🎯 Target",
      filter: { roles: ["GM"], every: [{ key: "layer", value: "CHARACTER" }] },
    }],
    onClick: async (context) => {
      const ids = context.items.map((i) => i.id);
      await OBR.scene.setMetadata({ [TARGET_KEY]: { ids, n: Date.now() } });
      const names = context.items.map((i) => i.text?.plainText || i.name);
      OBR.notification.show(`🎯 Target: ${names.join(", ")}`);
    },
  });
}

function menus() {
  OBR.contextMenu.create({
    id: "dnd-npc/mark-place",
    icons: [{
      icon: "/owlbear/icon.svg",
      label: "🗺 Mark as place",
      filter: { roles: ["GM"], every: [{ key: "layer", value: "DRAWING" }] },
    }],
    onClick: (context) => openMenu("place", context),
  });
  OBR.contextMenu.create({
    id: "dnd-npc/this-is",
    icons: [{
      icon: "/owlbear/icon.svg",
      label: "🗺 This is…",
      filter: { roles: ["GM"], every: [{ key: "layer", value: "CHARACTER" }] },
    }],
    onClick: (context) => openMenu("who", context),
  });
}

OBR.onReady(async () => {
  if ((await OBR.player.getRole()) !== "GM") return;
  if (!LOCAL) {
    targetMenu();
    return;
  }
  menus();
  OBR.scene.items.onChange(soon);
  OBR.scene.grid.onChange(soon);
  OBR.scene.onReadyChange(soon);
  OBR.scene.onMetadataChange(soon); // a 🎯 Target pick, from this tab or the laptop
  setInterval(send, HEARTBEAT_MS);
  setInterval(todo, TODO_MS);
  soon();
});
