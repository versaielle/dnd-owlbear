// The vision spike's engine, on EVERY screen (the GM tabs, the projector's Cast receiver, phones).
// THROWAWAY test build for one evening (docs/vision-layer-spec.md section 12, checks S1-S7).
//
// Everything is OFF until the GM switches it on in the popover. The GM screen broadcasts one
// settings object; every screen then builds the same LOCAL items from the same shared scene:
//   light    one PRIMARY light per Spike-PC token (S3, S7)
//   wall     local walls from Smoke & Spectre's lines + an edge round each map (S3, S4, S7)
//   door     a handle at each Smoke door, with "Spike: door" on it (S6)
//   memory   the S2 pieces on the FOG layer over one map
// and, with the frame meter on, a small popover (meter.html) that measures requestAnimationFrame
// (S1, S7). Each screen reports what it built and its numbers; the GM screen keeps the history.
//
// The only SHARED writes, all from a GM screen: the fog fill and colour (the old values are kept
// on that screen and put back by Restore / Clean up) and the per-token mark PC_KEY.
import OBR, { buildImage, buildLight, buildPath, buildShape, buildWall } from "./obr-sdk.js?v=cfced8d";
import * as S from "./spike.js?v=cfced8d";

const { NS, LOCAL_KEY, DOOR_KEY, PC_KEY, CH } = S;
const VERSION = new URL(import.meta.url).search; // ?v=<build> on Pages, so our pages come from the same build
const here = (rel) => {
  const u = new URL(rel, import.meta.url);
  u.search = VERSION;
  return u.href;
};
const ICON = here("./icon.svg");
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
// The panel's log. A Pages copy can't reach this PC (probe P2): it only works when the spike is
// installed from http://localhost:7420/owlbear/spike/manifest.json. Fails quietly either way.
const PANEL = LOCAL_HOST ? location.origin : "http://127.0.0.1:7420";

const METER_ID = `${NS}/meter`;
const TOOL_ID = `${NS}/door-tool`;
const MODE_ID = `${NS}/door-mode`;
const HISTORY_MAX = 12000;
const SEEN_GM_MS = 15000;

const me = { conn: "", playerId: "", name: "", role: "PLAYER", kind: "player", touch: false, room: "" };
let settings = S.cleanSettings(null);
let sceneReady = false;
let items = [];
const grid = { dpi: 150, mult: 5 };
const status = { scene: false, pcs: 0, lights: 0, walls: 0, wallSegs: 0, wallMaps: 0, wallLines: 0, doors: 0,
                 memory: "", rebuilds: 0, buildMs: 0, meter: "", errors: [] };
let lastDoorPlan = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function errText(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 240);
  try { return JSON.stringify(e).slice(0, 240); } catch { return String(e).slice(0, 240); }
}
function noteError(where, e) {
  const t = `${where}: ${typeof e === "string" ? e : errText(e)}`;
  status.errors.push(t);
  if (status.errors.length > 6) status.errors.splice(0, status.errors.length - 6);
  console.warn("[vision spike]", t);
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* no storage */ } }

async function send(channel, data, destination = "REMOTE") {
  try {
    await OBR.broadcast.sendMessage(channel, data, { destination });
  } catch (e) {
    noteError(`broadcast ${channel.slice(NS.length + 1)}`, e);
  }
}

function who() {
  const ua = navigator.userAgent || "";
  return { conn: me.conn, playerId: me.playerId, name: me.name, role: me.role, kind: me.kind, touch: me.touch,
           dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
           screen: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
           ua: (ua.match(/CrKey[^ ]*|Android [^;)]*|Windows NT [^;)]*|Mac OS X [^;)]*|iPhone OS [^ ]*/) || [ua.slice(0, 40)])[0] };
}

// ---- settings ----

function adopt(next, { publish = false } = {}) {
  const s = S.cleanSettings(next);
  if (!S.newer(s, settings)) return false;
  settings = s;
  if (me.role === "GM") gm.logEvent({ ev: "settings", label: S.settingsLabel(s) });
  if (publish) send(CH.settings, s);
  apply();
  return true;
}

async function apply() {
  lastPlanSig = null; // check every probe against the screen now
  await meterSync();
  await doorToolSync();
  build();
  reportSoon();
}

// ---- the scene ----

async function readGrid() {
  try { grid.dpi = (await OBR.scene.grid.getDpi()) || 150; } catch { /* keep */ }
  try { grid.mult = (await OBR.scene.grid.getScale())?.parsed?.multiplier || 5; } catch { /* keep */ }
}

async function onSceneReady(ready) {
  sceneReady = !!ready;
  status.scene = sceneReady;
  lastPlanSig = null;
  if (!sceneReady) {
    items = [];
    return;
  }
  await readGrid();
  try { items = await OBR.scene.items.getItems(); } catch (e) { noteError("items", e); }
  build();
  reportSoon();
}

let soonTimer = null;
function soon() {
  if (soonTimer) return;
  soonTimer = setTimeout(() => { soonTimer = null; build(); }, 250);
}

// ---- building the local items ----

const tag = (probe, spec) => ({ [LOCAL_KEY]: { probe, key: spec.key, sig: spec.sig } });

function makeLight(w) {
  return buildLight()
    .name("Spike sight")
    .attachedTo(w.of)
    .position(w.position)
    .disableAttachmentBehavior(["VISIBLE", "SCALE"])
    .sourceRadius(w.sourceRadius)
    .attenuationRadius(w.attenuation)
    .lightType("PRIMARY")
    .zIndex(0)
    .locked(true)
    .disableHit(true)
    .metadata(tag("light", w))
    .build();
}

function makeWall(w) {
  return buildWall()
    .name(`Spike ${w.kind}`)
    .points(w.points)
    .position({ x: 0, y: 0 })
    .doubleSided(w.doubleSided)
    .blocking(w.blocking)
    .visible(w.visible)
    .zIndex(0)
    .locked(true)
    .disableHit(true)
    .metadata(tag("wall", w))
    .build();
}

function makeDoor(w) {
  return buildShape()
    .name("Spike door")
    .shapeType("CIRCLE")
    .width(w.size)
    .height(w.size)
    .position(w.position)
    .fillColor("#ff8c1a")
    .fillOpacity(0.9)
    .strokeColor("#ffffff")
    .strokeOpacity(1)
    .strokeWidth(3)
    .layer("PROP")
    .locked(w.locked)
    .metadata({ ...tag("door", w), [DOOR_KEY]: true })
    .build();
}

function makeMemory(w) {
  if (w.key === "copy") {
    const m = w.map;
    return buildImage({ ...m.image }, { ...m.grid })
      .name("Spike memory: map copy")
      .position({ ...m.position })
      .rotation(m.rotation || 0)
      .scale({ ...(m.scale || { x: 1, y: 1 }) })
      .layer("FOG")
      .zIndex(w.zIndex)
      .disableAutoZIndex(true)
      .locked(true)
      .disableHit(true)
      .metadata(tag("memory", w))
      .build();
  }
  return buildPath()
    .name(`Spike memory: ${w.key}`)
    .commands(w.commands)
    .fillRule(w.fillRule)
    .fillColor("#000000")
    .fillOpacity(w.opacity)
    .strokeColor("#000000")
    .strokeOpacity(0)
    .strokeWidth(0)
    .position({ x: 0, y: 0 })
    .layer("FOG")
    .zIndex(w.zIndex)
    .disableAutoZIndex(true)
    .locked(true)
    .disableHit(true)
    .metadata(tag("memory", w))
    .build();
}

const MAKERS = { light: makeLight, wall: makeWall, door: makeDoor, memory: makeMemory };

function plans() {
  const s = settings;
  const out = { light: [], wall: [], door: [], memory: [] };
  let wallInfo = { maps: [], lines: 0, segments: 0 };
  if (!sceneReady) return { out, wallInfo };
  if (s.lights.on) out.light = S.lightPlan(items, { sourceRadius: s.lights.sourceRadius, reachFt: s.lights.reachFt, dpi: grid.dpi, multiplier: grid.mult });
  if (s.walls.on) {
    const blocking = !(me.role === "GM" && s.walls.gmOpen);
    const p = S.wallPlan(items, { dpi: grid.dpi, scope: s.walls.scope, sides: s.walls.sides, blocking });
    out.wall = p.specs;
    wallInfo = p;
  }
  if (s.doors.on) out.door = S.doorPlan(items, { dpi: grid.dpi, locked: s.doors.locked });
  if (s.memory) out.memory = S.memoryPlan(items, s.memory.mapId, grid.dpi);
  return { out, wallInfo };
}

// Add and delete local items so this screen matches the plan for one probe. A batch Owlbear
// refuses is tried again one item at a time, so the report can say which piece it refused.
async function syncProbe(probe, have, want) {
  const h = have.map((i) => ({ id: i.id, key: i.metadata[LOCAL_KEY].key, sig: i.metadata[LOCAL_KEY].sig }));
  const { add, del } = S.diffByKey(h, want);
  const errors = [];
  let failed = 0;
  if (del.length) {
    try { await OBR.scene.local.deleteItems(del); } catch (e) { errors.push(`delete: ${errText(e)}`); }
  }
  const built = [];
  for (const w of add) {
    try { built.push(MAKERS[probe](w)); } catch (e) { failed++; errors.push(`${w.key}: ${errText(e)}`); }
  }
  if (built.length) {
    try {
      await OBR.scene.local.addItems(built);
    } catch (e) {
      for (const it of built) {
        try {
          await OBR.scene.local.addItems([it]);
        } catch (e2) {
          const key = it.metadata[LOCAL_KEY].key;
          if (Number.isFinite(it.zIndex) && !Number.isInteger(it.zIndex)) {
            try { // a z-index Owlbear won't take: try the nearest whole one
              await OBR.scene.local.addItems([{ ...it, zIndex: Math.round(it.zIndex) }]);
              errors.push(`${key}: zIndex ${it.zIndex} refused, used ${Math.round(it.zIndex)}`);
              continue;
            } catch { /* report the first error */ }
          }
          failed++;
          errors.push(`${key}: ${errText(e2)}`);
        }
      }
    }
  }
  for (const e of errors) noteError(probe, e);
  return { count: want.length - failed, errors };
}

let building = false, buildAgain = false, lastPlanSig = null, lastVerify = 0;
async function build() {
  if (building) { buildAgain = true; return; }
  building = true;
  try {
    do {
      buildAgain = false;
      await buildOnce();
    } while (buildAgain);
  } catch (e) {
    noteError("build", e);
  } finally {
    building = false;
  }
}

async function buildOnce() {
  const t0 = performance.now();
  const { out, wallInfo } = plans();
  status.pcs = items.filter(S.isSpikePc).length;
  const sig = S.PROBES.map((p) => `${p}:${out[p].map((w) => `${w.key}=${w.sig}`).join(",")}`).join(";");
  // Nothing changed since the last check: no Owlbear calls at all (a dragged token fires many
  // scene changes; its lights ride along as attachments). A full check every 10 s anyway.
  if (sig === lastPlanSig && Date.now() - lastVerify < 10000) return;
  lastPlanSig = sig;
  lastVerify = Date.now();
  let local = [];
  try {
    local = await OBR.scene.local.getItems((i) => !!i.metadata?.[LOCAL_KEY]);
  } catch (e) {
    noteError("local items", e);
    return;
  }
  const byProbe = { light: [], wall: [], door: [], memory: [] };
  const strays = [];
  for (const i of local) {
    const p = i.metadata[LOCAL_KEY]?.probe;
    if (byProbe[p]) byProbe[p].push(i);
    else strays.push(i.id);
  }
  if (strays.length) {
    try { await OBR.scene.local.deleteItems(strays); } catch (e) { noteError("strays", e); }
  }
  const before = JSON.stringify([status.lights, status.walls, status.doors, status.memory]);
  const r = {};
  for (const p of S.PROBES) r[p] = await syncProbe(p, byProbe[p], out[p]);
  status.lights = r.light.count;
  status.walls = r.wall.count;
  status.wallSegs = wallInfo.segments;
  status.wallMaps = wallInfo.maps.length;
  status.wallLines = wallInfo.lines;
  status.doors = r.door.count;
  lastDoorPlan = out.door;
  status.memory = !settings.memory ? "" : !out.memory.length ? "map not found"
    : r.memory.errors.length ? `${r.memory.count}/3 added; ${r.memory.errors.join("; ")}` : `${r.memory.count}/3 added`;
  status.rebuilds++;
  status.buildMs = Math.round(performance.now() - t0);
  if (JSON.stringify([status.lights, status.walls, status.doors, status.memory]) !== before) reportSoon();
}

// ---- reports ----

function statusSnapshot() {
  return { ...status, errors: status.errors.slice(-4) };
}

let reportTimer = null;
function reportSoon(ms = 500) {
  if (reportTimer) return;
  reportTimer = setTimeout(() => { reportTimer = null; report(); }, ms);
}

function report(extra = {}) {
  const msg = { who: who(), status: statusSnapshot(), probes: S.settingsLabel(settings), settingsAt: settings.at, at: Date.now(), ...extra };
  if (me.role === "GM") gm.onReport(msg);
  send(CH.report, msg);
}

// While anything is on, every screen says how it is every 10 s (so the GM's table shows it).
setInterval(() => {
  if (!OBR.isReady || !me.conn) return;
  const s = settings;
  if (s.meter) return; // the meter reports every 2 s anyway
  if (s.lights.on || s.walls.on || s.doors.on || s.memory) report();
}, 10000);

// ---- the frame meter (S1, S7) ----
// requestAnimationFrame never runs in this hidden background frame (probe P4/P5), so the meter is
// a small visible popover (meter.html) that counts frames and sends its numbers here every 2 s.
// This frame adds the event-loop lag (a 50 ms timer, how late it fires) and long tasks.

let meterOn = false, lagTimer = null, readingTimer = null, ltObserver = null;
let lags = [], bgLt = [], lastRaf = null, expected = 0;

async function meterSync() {
  if (settings.meter && !meterOn) {
    meterOn = true;
    status.meter = "starting";
    expected = performance.now() + 50;
    lagTimer = setInterval(() => {
      const now = performance.now();
      lags.push(Math.max(0, now - expected));
      expected = now + 50;
    }, 50);
    try {
      ltObserver = new PerformanceObserver((list) => { for (const e of list.getEntries()) bgLt.push(e.duration); });
      ltObserver.observe({ type: "longtask", buffered: false });
    } catch (e) {
      ltObserver = null;
    }
    readingTimer = setInterval(sendReading, S.WINDOW_MS);
    try {
      const vw = await OBR.viewport.getWidth();
      await OBR.popover.open({
        id: METER_ID, url: here("./meter.html"), width: 190, height: 26,
        anchorReference: "POSITION", anchorPosition: { left: Math.round(vw / 2), top: 4 },
        anchorOrigin: { horizontal: "CENTER", vertical: "TOP" }, transformOrigin: { horizontal: "CENTER", vertical: "TOP" },
        hidePaper: true, disableClickAway: true,
      });
      status.meter = "popover open";
    } catch (e) {
      status.meter = `popover failed: ${errText(e)}`;
      noteError("meter", e);
    }
  } else if (!settings.meter && meterOn) {
    meterOn = false;
    clearInterval(lagTimer);
    clearInterval(readingTimer);
    try { ltObserver?.disconnect(); } catch { /* gone */ }
    ltObserver = null;
    lags = [];
    bgLt = [];
    lastRaf = null;
    status.meter = "";
    try { await OBR.popover.close(METER_ID); } catch { /* closed */ }
  }
}

function sendReading() {
  const raf = lastRaf && Date.now() - lastRaf.at < S.WINDOW_MS * 1.5 ? lastRaf : null;
  lastRaf = null;
  const lag = S.lagStats(lags.splice(0));
  const lt = S.longTaskStats(bgLt.splice(0));
  if (!raf && status.meter === "popover open") status.meter = "popover open, no frames yet";
  else if (raf) status.meter = "measuring";
  const reading = {
    fps: raf?.fps ?? null, low10: raf?.low10 ?? null, worstMs: raf?.worstMs ?? null, frames: raf?.frames ?? 0,
    ltMs: raf ? raf.ltMs : null, ltN: raf ? raf.ltN : null, bgLtMs: lt.ltMs, bgLtN: lt.ltN, ...lag,
  };
  report({ reading });
}

// ---- doors (S6): who picked which handle, and how ----

async function reportDoor(line, via, extra = "") {
  const msg = { who: who(), door: String(line || "?"), via, extra, at: Date.now() };
  try { await OBR.notification.show(`Spike: door ${msg.door.slice(0, 6)} via ${via}${extra ? ` (${extra})` : ""}`, "INFO"); } catch { /* fine */ }
  if (me.role === "GM") gm.onDoor(msg);
  send(CH.door, msg);
}

let lastSel = "";
async function onSelection(selection) {
  const ids = Array.isArray(selection) ? selection : [];
  const key = ids.join(",");
  if (key === lastSel) return;
  lastSel = key;
  if (!settings.doors.on || !ids.length) return;
  try {
    const picked = (await OBR.scene.local.getItems(ids)).filter((i) => i.metadata?.[DOOR_KEY]);
    for (const i of picked) reportDoor(i.metadata[LOCAL_KEY]?.key, "select");
  } catch (e) {
    noteError("selection", e);
  }
}

let toolOn = false;
async function doorToolSync() {
  if (settings.doors.on && !toolOn) {
    toolOn = true;
    try {
      await OBR.tool.create({ id: TOOL_ID, icons: [{ icon: ICON, label: "Spike: door tool" }], defaultMode: MODE_ID });
      await OBR.tool.createMode({
        id: MODE_ID,
        icons: [{ icon: ICON, label: "Spike: tap a door handle", filter: { activeTools: [TOOL_ID] } }],
        onToolClick: (context, event) => {
          const t = event?.target;
          if (t?.metadata?.[DOOR_KEY]) {
            reportDoor(t.metadata[LOCAL_KEY]?.key, "tool");
          } else {
            const p = event?.pointerPosition;
            const near = p ? S.nearestDoor(p, lastDoorPlan, grid.dpi * 0.6) : null;
            if (near) reportDoor(near.line, "tool-no-target", t ? `target was ${t.type || "?"} on ${t.layer || "?"}` : "no target");
          }
          return false;
        },
      });
    } catch (e) {
      noteError("door tool", e);
    }
  } else if (!settings.doors.on && toolOn) {
    toolOn = false;
    try { await OBR.tool.removeMode(MODE_ID); } catch { /* gone */ }
    try { await OBR.tool.remove(TOOL_ID); } catch { /* gone */ }
  }
}

// ---- the GM side: the screens table, the history, the fog, the marks ----

const gm = {
  screens: new Map(), // conn -> {who, status, reading, probes, seen}
  doors: [], // the last door picks
  history: [],
  phase: "",
  savedFog: null, // {filled, color} before the spike first changed them
  saveTimer: null,
  gmSeen: new Map(), // GM conn -> last heard

  key(k) { return `${NS}/${k}/${me.room || "room"}`; },

  load() {
    try { this.history = JSON.parse(lsGet(this.key("history")) || "[]"); } catch { this.history = []; }
    if (!Array.isArray(this.history)) this.history = [];
    this.phase = lsGet(this.key("phase")) || "";
    try { this.savedFog = JSON.parse(lsGet(this.key("fog")) || "null"); } catch { this.savedFog = null; }
  },

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 10000);
  },

  saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    return lsSet(this.key("history"), JSON.stringify(this.history));
  },

  logEvent(e) {
    this.history.push({ t: Date.now(), phase: this.phase, ...e });
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.saveSoon();
  },

  onReport(msg) {
    const c = msg?.who?.conn;
    if (!c) return;
    const prev = this.screens.get(c) || {};
    this.screens.set(c, { who: msg.who, status: msg.status, probes: msg.probes, settingsAt: msg.settingsAt,
                          reading: msg.reading || prev.reading || null, readingAt: msg.reading ? Date.now() : prev.readingAt || 0,
                          seen: Date.now() });
    if (msg.who.role === "GM") this.gmSeen.set(c, Date.now());
    if (msg.reading) {
      const e = { ev: "reading", conn: c, kind: msg.who.kind, name: msg.who.name, r: msg.reading, probes: msg.probes,
                  s: { lights: msg.status?.lights, walls: msg.status?.walls } };
      this.logEvent(e);
      if (msg.who.kind === "table" && this.leader()) postPanel({ ...e, t: Date.now(), phase: this.phase });
    }
  },

  onDoor(msg) {
    const e = { conn: msg.who?.conn, name: msg.who?.name, kind: msg.who?.kind, door: msg.door, via: msg.via, extra: msg.extra, at: Date.now() };
    this.doors.push(e);
    if (this.doors.length > 50) this.doors.splice(0, this.doors.length - 50);
    this.logEvent({ ev: "door", name: e.name, kind: e.kind, door: e.door.slice(0, 8), via: e.via + (e.extra ? ` (${e.extra})` : "") });
  },

  leader() {
    const now = Date.now();
    const live = [me.conn, ...[...this.gmSeen].filter(([, t]) => now - t < SEEN_GM_MS).map(([c]) => c)];
    return S.leaderOf(live) === me.conn;
  },

  async fog(what) {
    let filled = null, color = null;
    try { [filled, color] = await Promise.all([OBR.scene.fog.getFilled(), OBR.scene.fog.getColor()]); } catch (e) { noteError("fog read", e); return; }
    if (what !== "restore" && !this.savedFog) {
      this.savedFog = { filled, color };
      lsSet(this.key("fog"), JSON.stringify(this.savedFog));
    }
    try {
      if (what === "fillOn") await OBR.scene.fog.setFilled(true);
      else if (what === "fillOff") await OBR.scene.fog.setFilled(false);
      else if (what === "black") await OBR.scene.fog.setColor("#000000");
      else if (what === "restore" && this.savedFog) {
        await OBR.scene.fog.setFilled(!!this.savedFog.filled);
        if (typeof this.savedFog.color === "string") await OBR.scene.fog.setColor(this.savedFog.color);
        this.savedFog = null;
        lsDel(this.key("fog"));
      }
      this.logEvent({ ev: "note", label: `fog ${what}` });
    } catch (e) {
      noteError(`fog ${what}`, e);
    }
  },

  async cleanup() {
    // all off: every screen takes its items away
    adopt({ at: Math.max(Date.now(), settings.at + 1), by: me.conn }, { publish: true });
    try {
      const marked = (await OBR.scene.items.getItems((i) => i.metadata?.[PC_KEY] !== undefined)).map((i) => i.id);
      if (marked.length) {
        await OBR.scene.items.updateItems(marked, (ds) => { for (const d of ds) delete d.metadata[PC_KEY]; });
      }
    } catch (e) {
      noteError("clean up marks", e);
    }
    await this.fog("restore");
    this.logEvent({ ev: "note", label: "clean up" });
  },

  async state(extra = {}) {
    let fog = { filled: null, color: null };
    try { fog = { filled: await OBR.scene.fog.getFilled(), color: await OBR.scene.fog.getColor() }; } catch { /* no scene */ }
    const now = Date.now();
    const screens = [...this.screens.values()].map((s) => ({ ...s, age: Math.round((now - s.seen) / 1000) }))
      .sort((a, b) => (a.who.kind + a.who.name).localeCompare(b.who.kind + b.who.name));
    return { me: who(), settings, label: S.settingsLabel(settings), screens, doors: this.doors.slice(-20),
             fog: { ...fog, saved: this.savedFog }, pcs: status.pcs, doorsInScene: S.visionLines(items).filter((l) => l.kind === "door").length,
             linesInScene: S.visionLines(items).length, historyCount: this.history.length, phase: this.phase,
             leader: this.leader(), panel: panelOk, ...extra };
  },

  async onUi(m) {
    if (!m || m.to !== "bg") return;
    const patch = (fn) => {
      const next = S.cleanSettings(settings);
      fn(next);
      next.at = Math.max(Date.now(), settings.at + 1);
      next.by = me.conn;
      adopt(next, { publish: true });
    };
    switch (m.op) {
      case "get": break;
      case "meter": patch((s) => { s.meter = !!m.on; }); break;
      case "lights": patch((s) => { Object.assign(s.lights, m.set || {}); }); break;
      case "walls": patch((s) => { Object.assign(s.walls, m.set || {}); }); break;
      case "doors": patch((s) => { Object.assign(s.doors, m.set || {}); }); break;
      case "memory": patch((s) => { s.memory = m.mapId ? { mapId: String(m.mapId) } : null; }); break;
      case "fog": await this.fog(m.what); break;
      case "clean": await this.cleanup(); break;
      case "phase":
        this.phase = String(m.label || "").slice(0, 80);
        lsSet(this.key("phase"), this.phase);
        this.logEvent({ ev: "phase", label: this.phase || "(none)" });
        break;
      case "clearHistory":
        this.history = [];
        this.saveNow();
        break;
      case "forgetScreens":
        this.screens.clear();
        this.doors = [];
        break;
      case "flush": {
        const ok = this.saveNow();
        send(CH.state, await this.state({ flushed: { ok, key: this.key("history"), summary: S.resultsText(this.history, { raw: false }) } }), "LOCAL");
        return;
      }
      default: return;
    }
    send(CH.state, await this.state(), "LOCAL");
  },
};

// POST one table reading to the panel's log. Silent on failure, and quiet for a minute after one.
let panelBackoff = 0, panelOk = null;
async function postPanel(e) {
  if (Date.now() < panelBackoff) return;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), 2000);
  try {
    const r = await fetch(`${PANEL}/api/map/log`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl?.signal,
      body: JSON.stringify({ what: "spike-fps", error: S.historyLine(e), detail: JSON.stringify(e) }),
    });
    panelOk = r.ok;
    if (!r.ok) panelBackoff = Date.now() + 60000;
  } catch {
    panelOk = false;
    panelBackoff = Date.now() + 60000;
  } finally {
    clearTimeout(timer);
  }
}

// ---- right-click menus ----

async function menus() {
  // On a CHARACTER token (GM only): mark it as a Spike-PC, or unmark it. Shared metadata.
  if (me.role === "GM") {
    const layer = { key: "layer", value: "CHARACTER" };
    await OBR.contextMenu.create({
      id: `${NS}/pc`,
      icons: [
        { icon: ICON, label: "Spike: PC on", filter: { roles: ["GM"], every: [layer, { key: ["metadata", PC_KEY], value: undefined }] } },
        { icon: ICON, label: "Spike: PC off", filter: { roles: ["GM"], every: [layer, { key: ["metadata", PC_KEY], value: true }] } },
      ],
      onClick: async (context) => {
        const list = context.items || [];
        const on = list.some((i) => i.metadata?.[PC_KEY] !== true);
        try {
          await OBR.scene.items.updateItems(list.map((i) => i.id), (ds) => {
            for (const d of ds) {
              if (on) d.metadata[PC_KEY] = true;
              else delete d.metadata[PC_KEY];
            }
          });
          gm.logEvent({ ev: "note", label: `Spike-PC ${on ? "on" : "off"}: ${list.map((i) => i.name).join(", ")}` });
        } catch (e) {
          noteError("Spike-PC mark", e);
        }
      },
    }).catch((e) => noteError("menu pc", e));
  }
  // On a door handle (a LOCAL item), on every screen (S6): does a right-click / long-press on a
  // local item reach an extension's menu at all?
  await OBR.contextMenu.create({
    id: `${NS}/door`,
    icons: [{ icon: ICON, label: "Spike: door", filter: { every: [{ key: ["metadata", DOOR_KEY], value: true }] } }],
    onClick: (context) => {
      const picked = (context.items || []).filter((i) => i.metadata?.[DOOR_KEY]);
      if (!picked.length) reportDoor("?", "menu", `${(context.items || []).length} items, none ours`);
      for (const i of picked) reportDoor(i.metadata[LOCAL_KEY]?.key, "menu");
    },
  }).catch((e) => noteError("menu door", e));
}

// ---- start ----

OBR.onReady(async () => {
  try { me.role = await OBR.player.getRole(); } catch { /* a player */ }
  try { me.playerId = OBR.player.id; } catch { /* not ready */ }
  try { me.name = await OBR.player.getName(); } catch { /* none */ }
  try { me.conn = await OBR.player.getConnectionId(); } catch { me.conn = `x${Math.random().toString(36).slice(2, 10)}`; }
  try { me.room = OBR.room.id || ""; } catch { /* none */ }
  try { me.touch = !!window.matchMedia?.("(pointer: coarse)")?.matches; } catch { /* no media */ }
  me.kind = S.kindOf({ role: me.role, name: me.name, ua: navigator.userAgent });

  OBR.broadcast.onMessage(CH.settings, (ev) => adopt(ev.data));
  OBR.broadcast.onMessage(CH.hello, () => {
    if (settings.at > 0) send(CH.settings, settings);
    reportSoon(300 + Math.random() * 700);
  });
  OBR.broadcast.onMessage(CH.raf, (ev) => {
    if (ev.data && typeof ev.data === "object") lastRaf = { ...ev.data, at: Date.now() };
  });
  if (me.role === "GM") {
    gm.load();
    OBR.broadcast.onMessage(CH.report, (ev) => gm.onReport(ev.data));
    OBR.broadcast.onMessage(CH.door, (ev) => gm.onDoor(ev.data));
    OBR.broadcast.onMessage(CH.ui, (ev) => gm.onUi(ev.data).catch((e) => noteError("ui", e)));
    window.addEventListener("pagehide", () => gm.saveNow());
  }
  OBR.player.onChange((p) => {
    if (p?.name && p.name !== me.name) {
      me.name = p.name;
      me.kind = S.kindOf({ role: me.role, name: me.name, ua: navigator.userAgent });
    }
    onSelection(p?.selection);
  });
  OBR.scene.items.onChange((list) => { items = list; soon(); });
  OBR.scene.grid.onChange(async () => { await readGrid(); lastPlanSig = null; soon(); });
  OBR.scene.onReadyChange(onSceneReady);
  await menus();
  if (await OBR.scene.isReady()) await onSceneReady(true);
  await send(CH.hello, { who: who() });
  reportSoon();
  await sleep(0);
});
