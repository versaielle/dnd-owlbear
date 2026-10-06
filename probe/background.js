// DND FX probe (Step 36, Stage 0). It answers, in a real room, the questions the FX build
// depends on (docs/spell-fx-spec.md section 3.2, P1-P13). Every client that loads it:
// - reports who it is (role, player, connection, UA, origin, which manifest) on
//   "dnd-probe/report", and runs the automatic probes (P3 shaders, P4/P5 uniform ticks,
//   P9 hidden-item counts, P10 cross-install broadcast, P2 localhost fetch on a GM);
// - registers the "Probe aim" tool (P6) and streams its events;
// - runs what the popover's buttons ask (P3 again, P7, P8, P9, P11, P12, P13, cleanup),
//   on this client or on every client (commands go out on "dnd-probe/cmd").
// GM clients collect every report, log each as one `[dnd-probe] {json}` console line and,
// when this PC's probe server answers (or the probe is served from localhost), POST them
// to /api/probe/log so they land in logs/probe/probe.jsonl.
//
// It only ever writes LOCAL items, except the one shared P7 circle (the cleanup button
// deletes it). It never changes a token.
import OBR, { buildEffect, buildShape, buildText } from "./obr-sdk.js";
import * as S from "./shaders.js";

const BUILD = "probe-1";
const SDK = "3.1.0 (bundled)";
const here = (rel) => new URL(rel, import.meta.url).href;
const ICON = here("./icon.svg");
const VARIANT = new URLSearchParams(location.search).get("m") || "unknown";
const ORIGIN = location.origin;
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const PROBE_SERVER = "http://localhost:7440";
const PANEL = "http://localhost:7420";

const CH_REPORT = "dnd-probe/report";
const CH_CMD = "dnd-probe/cmd";
const CH_LOAD = "dnd-probe/load";
const CH_LOCAL_TEST = "dnd-probe/local-test";
const CH_X = "dnd-npc/x";
const LOCAL_KEY = "dnd-probe/local"; // on every local item we add: {until}
const P7_KEY = "dnd-probe/p7"; // on the one shared item (the P7 circle)
const TOOL_ID = `dnd.probe.${VARIANT}/tool`;
const MODE_ID = `dnd.probe.${VARIANT}/aim`;
const TABLE_UA = /CrKey|Chromecast|GoogleTV|Android TV|AFT[A-Z]|BRAVIA|SMART-TV|Tizen|Web0S/i;

const me = { conn: "", role: "", playerId: "", name: "" };
const R = { errors: [], console: [] }; // this client's results, by probe
const reports = new Map(); // GM: connectionId -> {report, results}
const events = []; // GM: the merged event stream (last 300)
const seenCmds = new Set();
const mine = new Set(); // ids of local items this page added
let logBase = null; // GM: where /api/probe/log is (null = don't post)
const logQueue = [];

// ---------- small helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const now = () => new Date().toISOString();

function errText(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 300);
  try { return JSON.stringify(e).slice(0, 300); } catch { return String(e).slice(0, 300); }
}

function push(list, value, cap = 40) {
  list.push(value);
  if (list.length > cap) list.splice(0, list.length - cap);
}

function pct(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}
const mean = (list) => (list.length ? round(list.reduce((a, b) => a + b, 0) / list.length) : null);

// Our own iframe's warnings and errors (Owlbear's own console, where a shader error would
// show, is the top page's: read it in devtools).
for (const level of ["warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    push(R.console, `${level}: ${args.map((a) => (typeof a === "string" ? a : errText(a))).join(" ")}`.slice(0, 300), 30);
    orig(...args);
  };
}
window.addEventListener("error", (e) => push(R.errors, `error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => push(R.errors, `rejection: ${errText(e.reason)}`));

const ident = () => ({ conn: me.conn, role: me.role, playerId: me.playerId, name: me.name, variant: VARIANT, origin: ORIGIN });

function clientKind() {
  if (me.role === "GM") return "gm";
  if (TABLE_UA.test(navigator.userAgent)) return "table";
  if (matchMedia("(pointer: coarse)").matches) return "touch";
  return "other";
}

// ---------- local items: add, auto-delete, sweep ----------

function tag(builder, ms) {
  return builder.metadata({ [LOCAL_KEY]: { until: Date.now() + ms, v: VARIANT } }).locked(true).disableHit(true);
}

async function addLocal(items, ms) {
  const t0 = performance.now();
  await OBR.scene.local.addItems(items);
  const addMs = round(performance.now() - t0);
  const ids = items.map((i) => i.id);
  ids.forEach((id) => mine.add(id));
  setTimeout(() => delLocal(ids), ms + 150);
  return addMs;
}

function delLocal(ids) {
  ids.forEach((id) => mine.delete(id));
  return OBR.scene.local.deleteItems(ids).catch(() => {});
}

async function sweep(all = false) {
  try {
    const old = await OBR.scene.local.getItems((i) => {
      const m = i.metadata?.[LOCAL_KEY];
      return m && m.v === VARIANT && (all || !(m.until > Date.now() - 1000));
    });
    if (old.length) await delLocal(old.map((i) => i.id));
  } catch (e) {
    // no scene
  }
}

async function viewCentre() {
  try {
    const [w, h] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
    return await OBR.viewport.inverseTransformPoint({ x: w / 2, y: h / 2 });
  } catch (e) {
    push(R.errors, `viewCentre: ${errText(e)}`);
    return { x: 0, y: 0 };
  }
}

async function grid() {
  const dpi = await OBR.scene.grid.getDpi();
  const scale = await OBR.scene.grid.getScale();
  return { dpi, multiplier: scale?.parsed?.multiplier || 5, unit: scale?.parsed?.unit || "ft" };
}

// A STANDALONE effect centred on `c` (its position is its top-left corner).
function effectAt(c, w, h, sksl, uniforms, ms, { layer = "ATTACHMENT", name = "dnd-probe fx" } = {}) {
  return tag(buildEffect().effectType("STANDALONE").width(w).height(h)
    .position({ x: c.x - w / 2, y: c.y - h / 2 }).sksl(sksl).uniforms(uniforms)
    .layer(layer).disableAutoZIndex(true).name(name), ms).build();
}

function label(text, c, dpi, ms, layer = "TEXT") {
  const w = dpi * 2.4;
  return tag(buildText().plainText(text).textType("PLAIN").fontSize(Math.round(dpi / 5)).fontWeight(700)
    .fillColor("#ffffff").strokeColor("#000000").strokeWidth(3).textAlign("CENTER").width(w)
    .position({ x: c.x - w / 2, y: c.y }).layer(layer).name(`dnd-probe ${text}`), ms).build();
}

function mark(c, dpi, ms) {
  // A small ring where an effect's centre should be (shows whether position = top-left).
  return tag(buildShape().shapeType("CIRCLE").width(dpi / 4).height(dpi / 4).position(c)
    .fillOpacity(0).strokeColor("#00ffff").strokeWidth(dpi / 30).layer("RULER").name("dnd-probe centre"), ms).build();
}

// ---------- the report stream ----------

function bc() {
  // Same-origin channel to this install's popover (the variant keeps two installs apart).
  try { return new BroadcastChannel(`dnd-probe-${VARIANT}`); } catch { return null; }
}
const chan = bc();

let stateTimer = null;
function stateSoon() {
  // Tell this tab's popover (same origin) what we know.
  if (!chan || stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    try {
      chan.postMessage({ type: "state", conn: me.conn, me: ident(), kind: clientKind(), results: R,
                         reports: [...reports.values()], events: events.slice(-80), logBase });
    } catch (e) {
      push(R.errors, `state: ${errText(e)}`);
    }
  }, 250);
}

async function send(data, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await OBR.broadcast.sendMessage(CH_REPORT, data, { destination: "REMOTE" });
      return true;
    } catch (e) {
      push(R.errors, `send ${data.type}: ${errText(e)}`);
      await sleep(2500 * (i + 1));
    }
  }
  return false;
}

const AUTO = ["p2", "p3", "p4", "p6", "p9auto", "p10", "localBroadcast", "errors", "console"];

function fullReport(phase) {
  // Who this is plus the automatic results (button probes go out as their own "result").
  const results = Object.fromEntries(AUTO.filter((k) => R[k] !== undefined).map((k) => [k, R[k]]));
  const r = { type: "report", phase, t: now(), build: BUILD, from: ident(), kind: clientKind(), info: R.info, results };
  if (JSON.stringify(r).length > 15000) {
    // Broadcasts are capped at 16 KB.
    r.results = { ...results, console: R.console.slice(-5), p2: R.p2 && { ...R.p2, features: `${R.p2.features?.length} (cut)` } };
    if (JSON.stringify(r).length > 15000) r.info = { ...R.info, policy: undefined, uaData: undefined };
  }
  return r;
}

async function report(phase) {
  const r = fullReport(phase);
  collect(r, me.conn);
  await send(r);
}

async function result(probe, data) {
  // One probe's result: kept here, sent to the GMs.
  R[probe] = data;
  const r = { type: "result", probe, t: now(), from: ident(), kind: clientKind(), data };
  collect(r, me.conn);
  stateSoon();
  await send(r);
}

// Tool events are batched: at most two messages a second.
const evBuf = [];
function emit(ev) {
  ev.t = Math.round(performance.now());
  push(evBuf, ev, 60);
  push(R.events ||= [], ev, 30);
}
setInterval(() => {
  if (!evBuf.length || !me.conn) return;
  const batch = evBuf.splice(0, evBuf.length);
  const msg = { type: "events", t: now(), from: ident(), kind: clientKind(), events: batch };
  collect(msg, me.conn);
  send(msg, 1);
}, 500);

function collect(msg, via) {
  // Every client logs its own messages as one console line. A GM also keeps everyone's for
  // the popover, logs them, and posts them to disk.
  const conn = msg?.from?.conn || via;
  const own = conn === me.conn && msg?.from?.variant === VARIANT;
  if (me.role !== "GM") {
    if (own) {
      console.log(`[dnd-probe] ${JSON.stringify(msg)}`);
      stateSoon();
    }
    return;
  }
  // Owlbear stamps the sender's connectionId: does it match what the sender says?
  const line = { via, stampOk: via === conn, ...msg };
  console.log(`[dnd-probe] ${JSON.stringify(line)}`);
  queueLog(line);
  const key = `${conn}|${msg.from?.variant}`;
  const entry = reports.get(key) || { conn, from: msg.from, kind: msg.kind, results: {}, seen: 0 };
  entry.from = msg.from || entry.from;
  entry.kind = msg.kind || entry.kind;
  entry.seen = Date.now();
  if (msg.type === "report") entry.report = msg;
  else if (msg.type === "result") entry.results[msg.probe] = msg.data;
  else if (msg.type === "events") {
    for (const ev of msg.events) push(events, { conn, who: `${msg.from?.name}/${msg.kind}`, ...ev }, 300);
  }
  reports.set(key, entry);
  stateSoon();
}

function queueLog(rec) {
  push(logQueue, rec, 1000);
}

let flushing = false;
setInterval(async () => {
  if (!logBase || flushing || !logQueue.length) return;
  flushing = true;
  const batch = logQueue.splice(0, 100);
  try {
    const r = await fetch(`${logBase}/api/probe/log`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    push(R.errors, `log post: ${errText(e)}`);
    logQueue.unshift(...batch);
    logBase = null; // stop trying; P2 again (popover) re-enables it
  } finally {
    flushing = false;
  }
}, 1000);

// ---------- environment ----------

function gpu() {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return "no webgl";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const out = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return String(out).slice(0, 160);
  } catch (e) {
    return errText(e);
  }
}

async function permState(name) {
  try { return (await navigator.permissions.query({ name })).state; } catch (e) { return `n/a (${errText(e).slice(0, 80)})`; }
}

async function policy(full) {
  const fp = document.permissionsPolicy || document.featurePolicy;
  const api = document.permissionsPolicy ? "permissionsPolicy" : document.featurePolicy ? "featurePolicy" : null;
  const out = { api };
  if (fp?.allowedFeatures) {
    const all = fp.allowedFeatures();
    out.count = all.length;
    out.lna = all.filter((f) => /local|loopback|network/i.test(f));
    if (full) out.features = all;
  }
  for (const f of ["local-network-access", "local-network", "loopback-network"]) {
    try { out[`allows:${f}`] = fp?.allowsFeature ? fp.allowsFeature(f) : null; } catch { out[`allows:${f}`] = "err"; }
    out[`perm:${f}`] = await permState(f);
  }
  return out;
}

async function info() {
  const uad = navigator.userAgentData;
  let scene = { ready: false };
  try {
    if (await OBR.scene.isReady()) scene = { ready: true, ...(await grid()), type: await OBR.scene.grid.getType() };
  } catch (e) {
    scene.error = errText(e);
  }
  return {
    ua: navigator.userAgent,
    uaData: uad ? { brands: uad.brands?.map((b) => `${b.brand} ${b.version}`), mobile: uad.mobile, platform: uad.platform } : null,
    coarse: matchMedia("(pointer: coarse)").matches,
    hoverNone: matchMedia("(hover: none)").matches,
    touchPoints: navigator.maxTouchPoints,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    frame: `${innerWidth}x${innerHeight}`,
    visibility: document.visibilityState,
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory ?? null,
    gpu: gpu(),
    moduleUrl: import.meta.url,
    href: location.href.replace(/([?&])obrref=[^&]*/, "$1obrref=…"),
    sdk: { version: SDK, isAvailable: OBR.isAvailable, localUpdateItemsArity: OBR.scene.local.updateItems.length,
           buildEffect: typeof buildEffect, tool: typeof OBR.tool?.createMode },
    partySize: await OBR.party.getPlayers().then((p) => p.length).catch((e) => errText(e)),
    policy: await policy(false),
    scene,
  };
}

// ---------- P2: can this frame reach localhost? (GM only) ----------

async function hello(url) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: "no-store" });
    const body = (await r.text()).slice(0, 200);
    return { url, ok: r.ok, status: r.status, ms: round(performance.now() - t0), body };
  } catch (e) {
    return { url, ok: false, error: errText(e), ms: round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

async function p2(where = "background") {
  const out = { where, origin: ORIGIN, variant: VARIANT, isLocalOrigin: IS_LOCAL };
  out.probeServer = await hello(`${PROBE_SERVER}/api/map/hello`);
  out.panel = await hello(`${PANEL}/api/map/hello`);
  out.policy = await policy(true);
  out.features = out.policy.features;
  delete out.policy.features;
  // Where the GM's reports go on disk.
  if (IS_LOCAL) logBase = ORIGIN;
  else if (out.probeServer.ok && /"app"\s*:\s*"dnd-npc"/.test(out.probeServer.body || "")) logBase = PROBE_SERVER;
  out.logBase = logBase;
  await result("p2", out);
}

// ---------- P3: does an effect draw; what does a broken one do? ----------

async function p3(holdMs = 2000) {
  if (!(await OBR.scene.isReady())) return result("p3", { skipped: "no scene" });
  const c = await viewCentre();
  const { dpi } = await grid();
  const w = dpi * 2;
  const good = S.burstUniforms(0.4);
  const cases = [
    { label: "P3 good", sksl: S.BURST, uniforms: good },
    { label: "P3 broken SkSL", sksl: S.BROKEN, uniforms: [] },
    { label: "P3 missing colA", sksl: S.BURST, uniforms: good.filter((u) => u.name !== "colA") },
    { label: "P3 vec4 array", sksl: S.VEC4, uniforms: [{ name: "tint", value: [0.3, 0.8, 1.0, 1.0] }] },
  ];
  const out = { holdMs, at: { x: round(c.x), y: round(c.y) }, dpi, cases: [] };
  for (const [n, k] of cases.entries()) {
    const at = { x: c.x + (n - 1.5) * 2.4 * dpi, y: c.y };
    const fx = effectAt(at, w, w, k.sksl, k.uniforms, holdMs, { name: k.label });
    const items = [fx, label(k.label, { x: at.x, y: at.y + dpi * 1.1 }, dpi, holdMs), mark(at, dpi, holdMs)];
    const row = { label: k.label, declared: S.declared(k.sksl), sent: k.uniforms.map((u) => u.name) };
    try {
      row.addMs = await addLocal(items, holdMs);
      const [back] = await OBR.scene.local.getItems([fx.id]);
      row.inScene = !!back;
      row.ok = true;
    } catch (e) {
      row.ok = false;
      row.error = errText(e);
    }
    out.cases.push(row);
  }
  out.note = "Look at the map: each effect should be centred on its cyan ring. In devtools (top frame) look for 'RuntimeEffect' errors.";
  await result("p3", out);
}

// ---------- P4/P5: uniform ticks at 30 Hz, normal vs fast path, and rAF here ----------

async function animate(item, ms, { fast = false, uniforms = (p) => S.burstUniforms(p) } = {}) {
  const st = { done: 0, ticks: 0, skipped: 0, errors: 0, lat: [], gaps: [], iv: [], raf: 0, first: null, lastError: null };
  const t0 = performance.now();
  let pending = false;
  let lastTick = t0;
  let lastDone = t0;
  let rafOn = true;
  const rafLoop = () => {
    if (!rafOn) return;
    st.raf++;
    requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const t = performance.now();
      st.iv.push(t - lastTick);
      lastTick = t;
      if (t - t0 >= ms) {
        clearInterval(iv);
        resolve();
        return;
      }
      st.ticks++;
      if (pending) {
        st.skipped++;
        return;
      }
      pending = true;
      const p = (t - t0) / ms;
      OBR.scene.local.updateItems([item], (items) => {
        for (const it of items) it.uniforms = uniforms(p);
      }, fast)
        .then(() => {
          const e = performance.now();
          st.done++;
          st.lat.push(e - t);
          st.gaps.push(e - lastDone);
          if (st.first == null) st.first = e - t0;
          lastDone = e;
        })
        .catch((e) => {
          st.errors++;
          st.lastError = errText(e);
        })
        .finally(() => {
          pending = false;
        });
    }, 33);
  });
  rafOn = false;
  const secs = ms / 1000;
  let hostProgress = null;
  try {
    const [back] = await OBR.scene.local.getItems([item.id]);
    hostProgress = round(back?.uniforms?.find((u) => u.name === "progress")?.value, 3);
  } catch (e) {
    hostProgress = errText(e);
  }
  return {
    path: fast ? "fast" : "normal", ms, updatesPerSec: round(st.done / secs), attempted: st.ticks, skipped: st.skipped,
    errors: st.errors, lastError: st.lastError, latP50: pct(st.lat, 50), latP95: pct(st.lat, 95), maxGapMs: round(Math.max(0, ...st.gaps)),
    firstDoneMs: round(st.first), intervalMean: mean(st.iv), intervalP95: pct(st.iv, 95), intervalMax: round(Math.max(0, ...st.iv)),
    rafPerSec: round(st.raf / secs), hostProgressAfter: hostProgress, visibility: document.visibilityState,
  };
}

async function p4() {
  if (!(await OBR.scene.isReady())) return result("p4", { skipped: "no scene" });
  const c = await viewCentre();
  const { dpi } = await grid();
  const out = { fastArgSupported: OBR.scene.local.updateItems.length >= 3, runs: [] };
  for (const fast of [false, true]) {
    const fx = effectAt(c, dpi * 4, dpi * 4, S.BURST, S.burstUniforms(0), 3600, { name: `P4 ${fast ? "fast" : "normal"}` });
    const tx = label(`P4 ${fast ? "fastUpdate" : "normal"} path`, { x: c.x, y: c.y + dpi * 2.1 }, dpi, 3600);
    try {
      const addMs = await addLocal([fx, tx], 3600);
      out.runs.push({ addMs, ...(await animate(fx, 3000, { fast })) });
    } catch (e) {
      out.runs.push({ path: fast ? "fast" : "normal", error: errText(e) });
    }
    await delLocal([fx.id, tx.id]);
    await sleep(400);
  }
  out.note = "Did the fastUpdate burst grow and fade like the normal one? (hostProgressAfter ~1 means the item state followed)";
  await result("p4", out);
}

// ---------- P6: the "Probe aim" tool ----------

let lastMove = 0;
function evInfo(name, ev, context) {
  const o = { ev: name, keys: Object.keys(ev || {}).join(",") };
  if (context?.activeMode) o.mode = context.activeMode;
  if (ev?.pointerPosition) o.p = { x: Math.round(ev.pointerPosition.x), y: Math.round(ev.pointerPosition.y) };
  if (ev?.target) o.target = { id: ev.target.id, layer: ev.target.layer, type: ev.target.type, visible: ev.target.visible };
  for (const k of ["key", "code", "repeat", "transformer", "pointerType", "pointerId", "button", "buttons", "isPrimary"]) {
    if (ev && k in ev) o[k] = ev[k];
  }
  for (const k of ["altKey", "shiftKey", "ctrlKey", "metaKey"]) if (ev?.[k]) o[k] = true;
  return o;
}

function logEv(name, throttle = false) {
  return (context, ev) => {
    if (throttle) {
      const t = performance.now();
      if (t - lastMove < 250) return;
      lastMove = t;
    }
    emit(evInfo(name, ev, context));
  };
}

async function tool() {
  const out = { id: TOOL_ID, role: me.role };
  try {
    await OBR.tool.create({
      id: TOOL_ID,
      icons: [{ icon: ICON, label: `Probe aim (${VARIANT})` }],
      defaultMode: MODE_ID,
    });
    await OBR.tool.createMode({
      id: MODE_ID,
      icons: [{ icon: ICON, label: "Probe aim: log events", filter: { activeTools: [TOOL_ID] } }],
      cursors: [{ cursor: "crosshair" }],
      onActivate: (context) => emit({ ev: "activate", mode: context?.activeMode }),
      onDeactivate: (context) => emit({ ev: "deactivate", mode: context?.activeMode }),
      onKeyDown: logEv("keyDown"),
      onKeyUp: logEv("keyUp"),
      onToolClick: (context, ev) => {
        emit(evInfo("click", ev, context));
        return false; // don't select what was clicked
      },
      onToolDoubleClick: (context, ev) => {
        emit(evInfo("doubleClick", ev, context));
        return false;
      },
      onToolDown: logEv("down"),
      onToolUp: logEv("up"),
      onToolMove: logEv("move", true),
      onToolDragStart: logEv("dragStart"),
      onToolDragMove: logEv("dragMove", true),
      onToolDragEnd: logEv("dragEnd"),
      onToolDragCancel: logEv("dragCancel"),
    });
    out.created = true;
  } catch (e) {
    out.created = false;
    out.error = errText(e);
  }
  try {
    OBR.tool.onToolChange((id) => emit({ ev: "toolChange", id }));
    OBR.tool.onToolModeChange((id) => emit({ ev: "modeChange", id }));
  } catch (e) {
    out.watchError = errText(e);
  }
  out.note = "Pick the flask tool; press [ ] arrows Q; click, drag, pinch (phone). Does it show on a player's toolbar?";
  R.p6 = out;
}

// ---------- P7: a local ATTACHMENT effect on a shared PROP circle ----------

async function p7Create(at) {
  // GM: the one shared item the probe ever makes.
  const { dpi } = await grid();
  const circle = buildShape().shapeType("CIRCLE").width(dpi * 3).height(dpi * 3).position(at)
    .fillColor("#3a7bd5").fillOpacity(0.15).strokeColor("#ffd27a").strokeWidth(dpi / 20)
    .layer("PROP").name("dnd-probe P7 circle (drag me)").metadata({ [P7_KEY]: { by: me.conn, t: Date.now() } }).build();
  try {
    await OBR.scene.items.addItems([circle]);
    await result("p7", { created: circle.id, at: { x: round(at.x), y: round(at.y) } });
    await command({ op: "p7fx", circle: circle.id, to: "all" });
  } catch (e) {
    await result("p7", { created: false, error: errText(e) });
  }
}

async function p7Fx(circleId) {
  // Every client: its own local effect on the shared circle, for 2 minutes.
  const out = { circle: circleId };
  try {
    const [circle] = await OBR.scene.items.getItems([circleId]);
    out.circleFound = !!circle;
    const fx = tag(buildEffect().effectType("ATTACHMENT").sksl(S.ZONE).attachedTo(circleId).layer("ATTACHMENT")
      .disableAutoZIndex(true).name("dnd-probe P7 fx"), 120000).build();
    out.addMs = await addLocal([fx], 120000);
    out.bounds = await OBR.scene.local.getItemBounds([fx.id]).catch((e) => errText(e));
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = errText(e);
  }
  out.note = "Drag the circle from another client: do the stripes follow? Then P7b attaches it to a token.";
  await result("p7fx", out);
}

async function p7Attach() {
  // GM: attach the P7 circle to the one selected token (the circle changes, the token doesn't).
  const out = {};
  try {
    const sel = (await OBR.player.getSelection()) || [];
    const [token] = sel.length === 1 ? await OBR.scene.items.getItems(sel) : [];
    const circles = await OBR.scene.items.getItems((i) => i.metadata?.[P7_KEY]);
    if (!token || token.layer !== "CHARACTER") out.error = "select exactly one token first";
    else if (!circles.length) out.error = "no P7 circle: press P7 first";
    else {
      await OBR.scene.items.updateItems(circles.map((i) => i.id), (items) => {
        for (const i of items) {
          i.attachedTo = token.id;
          i.position = token.position;
        }
      });
      out.attachedTo = token.id;
      out.tokenVisible = token.visible;
      out.note = "Drag the token: do the circle and every client's stripes follow?";
    }
  } catch (e) {
    out.error = errText(e);
  }
  await result("p7b", out);
}

// ---------- P8: one item per layer, for looking at fog on a player ----------

const LAYER_COLOURS = { ATTACHMENT: [1, 0.3, 0.3], PROP: [0.3, 1, 0.3], TEXT: [0.4, 0.6, 1], RULER: [1, 0.9, 0.2] };

async function p8(at) {
  if (!(await OBR.scene.isReady())) return result("p8", { skipped: "no scene" });
  const { dpi } = await grid();
  const out = { at: { x: round(at.x), y: round(at.y) }, layers: {} };
  for (const [n, layer] of Object.keys(LAYER_COLOURS).entries()) {
    const c = { x: at.x + (n - 1.5) * 1.6 * dpi, y: at.y };
    const fx = effectAt(c, dpi, dpi, S.DISC, [{ name: "colA", value: S.v3(LAYER_COLOURS[layer]) }], 60000, { layer, name: `P8 ${layer}` });
    const tx = label(layer, { x: c.x, y: c.y + dpi * 0.6 }, dpi, 60000, layer);
    try {
      await addLocal([fx, tx], 60000);
      out.layers[layer] = "ok";
    } catch (e) {
      out.layers[layer] = errText(e);
    }
  }
  out.note = "On a player, with this spot under fog: which of ATTACHMENT / PROP / TEXT / RULER still show?";
  await result("p8", out);
}

// ---------- P9: what a client can read about hidden items ----------

async function hiddenCounts() {
  if (!(await OBR.scene.isReady())) return { scene: false };
  const items = await OBR.scene.items.getItems();
  const hidden = items.filter((i) => i.visible === false);
  const byLayer = {};
  for (const i of hidden) byLayer[i.layer] = (byLayer[i.layer] || 0) + 1;
  const metaKeys = new Set(hidden.flatMap((i) => Object.keys(i.metadata || {})));
  return {
    role: me.role, total: items.length, hidden: hidden.length, hiddenByLayer: byLayer,
    hiddenWithPosition: hidden.filter((i) => Number.isFinite(i.position?.x)).length,
    hiddenWithMetadata: hidden.filter((i) => Object.keys(i.metadata || {}).length).length,
    hiddenMetadataKeys: [...metaKeys].slice(0, 30),
  };
}

async function p9() {
  const out = await hiddenCounts();
  if (out.scene === false) return result("p9", out);
  // Local rings on up to 4 hidden tokens: one inherits the token's visibility, one doesn't.
  try {
    const { dpi } = await grid();
    const tokens = await OBR.scene.items.getItems((i) => i.layer === "CHARACTER" && i.visible === false);
    const rings = [];
    for (const t of tokens.slice(0, 4)) {
      for (const [kind, colour, k, off] of [["inherit", "#00e5ff", 1.3, false], ["noVISIBLE", "#ff3dff", 1.6, true]]) {
        let b = buildShape().shapeType("CIRCLE").width(dpi * k).height(dpi * k).position(t.position)
          .fillOpacity(0).strokeColor(colour).strokeWidth(dpi / 18).attachedTo(t.id).layer("ATTACHMENT")
          .name(`dnd-probe P9 ${kind}`);
        if (off) b = b.disableAttachmentBehavior(["VISIBLE"]);
        rings.push(tag(b, 30000).build());
      }
    }
    if (rings.length) await addLocal(rings, 30000);
    out.ringsOn = rings.length / 2;
    out.note = "Cyan ring = inherits the hidden token's visibility; magenta = VISIBLE behaviour off. Which show on a player?";
  } catch (e) {
    out.ringError = errText(e);
  }
  await result("p9", out);
}

// ---------- P10: does a broadcast cross from one install to another? ----------

function p10Start() {
  R.p10 = { selfEcho: 0, sameInstall: 0, foreign: {} };
  OBR.broadcast.onMessage(CH_X, (e) => {
    const d = e.data || {};
    if (e.connectionId === me.conn && d.origin === ORIGIN && d.variant === VARIANT) {
      R.p10.selfEcho++;
      return;
    }
    if (d.origin === ORIGIN && d.variant === VARIANT) {
      R.p10.sameInstall++;
      return;
    }
    const key = `${d.origin}|${d.variant}`;
    const f = (R.p10.foreign[key] ||= { count: 0, first: now() });
    f.count++;
    f.lastConn = e.connectionId;
    f.sameTab = e.connectionId === me.conn;
    if (f.count === 1) result("p10", R.p10);
  });
  const ping = () => OBR.broadcast.sendMessage(CH_X, { probe: 1, origin: ORIGIN, variant: VARIANT, conn: me.conn, t: Date.now() },
    { destination: "ALL" }).catch((e) => push(R.errors, `p10 send: ${errText(e)}`));
  ping();
  setInterval(ping, 5000);
}

// ---------- P11 / P13: fireball-size bursts and their cost here ----------

async function fireballSize() {
  const { dpi, multiplier } = await grid();
  const cells = 40 / (multiplier || 5); // 40 ft across
  return { dpi, diameter: cells * dpi, rect: cells * dpi * 1.2 }; // rect = 2.4 R (spec 11.6)
}

async function burstRun(at, sksl, ms = 1500, { prewarm = false } = {}) {
  const { dpi, rect } = await fireballSize();
  const run = {};
  if (prewarm) {
    const warm = effectAt(at, dpi * 2, dpi * 2, sksl, S.burstUniforms(0, { fade: 0 }), 150, { name: "P13 prewarm" });
    await addLocal([warm], 150);
    await sleep(400);
  }
  const fx = effectAt(at, rect, rect, sksl, S.burstUniforms(0), ms + 500, { name: "P11 burst" });
  try {
    run.addMs = await addLocal([fx], ms + 500);
    Object.assign(run, await animate(fx, ms));
    // add (compile happens when Owlbear builds the item) + the first uniform round trip.
    run.toFirstUpdateMs = run.firstDoneMs == null ? null : round(run.addMs + run.firstDoneMs);
  } catch (e) {
    run.error = errText(e);
  }
  await delLocal([fx.id]);
  return run;
}

async function p11(at) {
  if (!(await OBR.scene.isReady())) return result("p11", { skipped: "no scene" });
  const size = await fireballSize();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    runs.push(await burstRun(at, S.BURST, 1500));
    await sleep(300);
  }
  await result("p11", {
    kind: clientKind(), ua: navigator.userAgent.slice(0, 160), rectPx: round(size.rect), runs,
    avgUpdatesPerSec: mean(runs.map((r) => r.updatesPerSec || 0)),
    note: "updates/s and maxGapMs are what this iframe sees of Owlbear's main thread (a proxy, not the canvas fps).",
  });
}

async function p13(at) {
  if (!(await OBR.scene.isReady())) return result("p13", { skipped: "no scene" });
  const salt = () => Math.random() * 0.001 + 0.0001;
  const cold = S.burst({ salt: salt() });
  const out = { kind: clientKind(), coarse: matchMedia("(pointer: coarse)").matches };
  out.cold = await burstRun(at, cold);
  await sleep(300);
  out.warm = await burstRun(at, cold);
  await sleep(300);
  out.coldPrewarmed = await burstRun(at, S.burst({ salt: salt() }), 1500, { prewarm: true });
  await sleep(300);
  out.liteCold = await burstRun(at, S.burst({ lite: true, salt: salt() }));
  await sleep(300);
  out.full = await burstRun(at, S.BURST);
  await sleep(300);
  out.lite = await burstRun(at, S.BURST_LITE);
  const pick = (r) => r && { add: r.addMs, first: r.toFirstUpdateMs, gap: r.maxGapMs, ups: r.updatesPerSec };
  out.summary = { cold: pick(out.cold), warm: pick(out.warm), coldPrewarmed: pick(out.coldPrewarmed), full: pick(out.full), lite: pick(out.lite) };
  await result("p13", out);
}

// ---------- P12: broadcast size and rate limits ----------

const loadRx = new Map(); // burst id -> {from, count, sizes, timer}

function p12Listen() {
  OBR.broadcast.onMessage(CH_LOAD, (e) => {
    const d = e.data || {};
    const b = loadRx.get(d.burst) || { from: e.connectionId, count: 0, big: [], timer: null };
    b.count++;
    if (d.pad) b.big.push(d.pad.length);
    clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      result("p12rx", { burst: d.burst, from: b.from, received: b.count, bigSizes: b.big });
      loadRx.delete(d.burst);
    }, 4000);
    loadRx.set(d.burst, b);
  });
}

async function p12() {
  const burst = `${me.conn.slice(0, 6)}-${Date.now()}`;
  const out = { burst, big: [], small: { sent: 0, ok: 0, errors: {} } };
  for (const kb of [15, 20]) {
    const t0 = performance.now();
    try {
      await OBR.broadcast.sendMessage(CH_LOAD, { burst, i: -kb, pad: "x".repeat(kb * 1024) });
      out.big.push({ kb, ok: true, ms: round(performance.now() - t0) });
    } catch (e) {
      out.big.push({ kb, ok: false, error: errText(e), ms: round(performance.now() - t0) });
    }
  }
  const t0 = performance.now();
  const sends = [];
  for (let i = 0; i < 40; i++) {
    out.small.sent++;
    sends.push(OBR.broadcast.sendMessage(CH_LOAD, { burst, i })
      .then(() => out.small.ok++)
      .catch((e) => {
        const k = errText(e).slice(0, 120);
        out.small.errors[k] = (out.small.errors[k] || 0) + 1;
        out.small.firstErrorAt ??= i;
      }));
    await sleep(24);
  }
  await Promise.allSettled(sends);
  out.small.ms = round(performance.now() - t0);
  R.p12tx = out;
  stateSoon();
  await sleep(3000); // let any rate limit cool down before reporting
  await result("p12tx", out);
}

// ---------- commands (from this tab's popover or from another client) ----------

const NEEDS_AT = ["p7", "p8", "p11", "p13"];

async function command(cmd) {
  // Send a command to every client (others via Owlbear, this one directly). Map-placed
  // probes use the sender's view centre, so every screen draws at the same spot.
  cmd.id ||= `${me.conn}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  cmd.from = ident();
  if (!cmd.at && NEEDS_AT.includes(cmd.op)) cmd.at = await viewCentre();
  if (cmd.to === "all") {
    try {
      await OBR.broadcast.sendMessage(CH_CMD, cmd, { destination: "REMOTE" });
    } catch (e) {
      push(R.errors, `cmd ${cmd.op}: ${errText(e)}`);
    }
  }
  run(cmd, "self");
}

async function run(cmd, via) {
  if (!cmd?.op || seenCmds.has(cmd.id)) return;
  seenCmds.add(cmd.id);
  emit({ ev: "cmd", op: cmd.op, via });
  const at = cmd.at || (NEEDS_AT.includes(cmd.op) ? await viewCentre() : null);
  try {
    switch (cmd.op) {
      case "p2": if (me.role === "GM") await p2(cmd.where || "background"); break;
      case "p2popover":
        if (me.role === "GM" && !logBase && cmd.data?.some?.((r) => r.ok && r.url.startsWith(PROBE_SERVER))) logBase = PROBE_SERVER;
        await result("p2popover", cmd.data);
        break;
      case "p3": await p3(cmd.holdMs || 8000); break;
      case "p4": await p4(); break;
      case "p7": if (me.role === "GM") await p7Create(at); break;
      case "p7fx": await p7Fx(cmd.circle); break;
      case "p7b": if (me.role === "GM") await p7Attach(); break;
      case "p8": await p8(at); break;
      case "p9": await p9(); break;
      case "p11": await p11(at); break;
      case "p12": await p12(); break;
      case "p13": await p13(at); break;
      case "report": R.info = await info(); await report("asked"); break;
      case "cleanup": await cleanup(); break;
      default: break;
    }
  } catch (e) {
    push(R.errors, `${cmd.op}: ${errText(e)}`);
  }
  stateSoon();
}

async function cleanup() {
  await sweep(true);
  if (mine.size) await delLocal([...mine]);
  const out = { local: "swept" };
  if (me.role === "GM") {
    try {
      const shared = await OBR.scene.items.getItems((i) => i.metadata?.[P7_KEY]);
      if (shared.length) await OBR.scene.items.deleteItems(shared.map((i) => i.id));
      out.sharedDeleted = shared.length;
    } catch (e) {
      out.sharedError = errText(e);
    }
  }
  await result("cleanup", out);
}

function listen() {
  OBR.broadcast.onMessage(CH_CMD, (e) => run(e.data, "obr"));
  OBR.broadcast.onMessage(CH_REPORT, (e) => collect(e.data, e.connectionId));
  // Does a LOCAL broadcast from the popover reach this background frame?
  OBR.broadcast.onMessage(CH_LOCAL_TEST, (e) => {
    R.localBroadcast = { received: true, sameConn: e.connectionId === me.conn, at: now() };
    stateSoon();
  });
  if (chan) {
    // This tab's popover (another tab of the same browser profile has another connection).
    chan.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "get") stateSoon();
      else if (m.type === "cmd" && m.conn === me.conn && m.cmd) {
        if (m.cmd.op === "p2") {
          try { localStorage.removeItem("dnd-probe/no-p2"); } catch { /* storage blocked */ }
        }
        command(m.cmd);
      }
    };
  }
}

// ---------- start ----------

async function auto() {
  // The automatic probes, once a scene is open: P3 (2 s), then P4/P5 (2 x 3 s), then P9 counts.
  await sleep(1500);
  await p3(2000);
  await sleep(600);
  await p4();
  R.p9auto = await hiddenCounts().catch((e) => errText(e));
  R.info = await info();
  await report("auto");
}

OBR.onReady(async () => {
  me.conn = await OBR.player.getConnectionId();
  me.role = await OBR.player.getRole();
  me.playerId = OBR.player.id;
  me.name = await OBR.player.getName();
  listen();
  R.info = await info();
  await report("start");
  if (me.role === "GM") {
    // Players that loaded before this GM tab report again.
    OBR.broadcast.sendMessage(CH_CMD, { op: "report", id: `${me.conn}-hello`, to: "all", from: ident() }).catch(() => {});
    let skip = false;
    try { skip = localStorage.getItem("dnd-probe/no-p2") === "1"; } catch { /* storage blocked */ }
    if (!skip) p2("background");
  }
  await tool();
  p10Start();
  p12Listen();
  setInterval(() => sweep(false), 10000);
  await sweep(true);
  let started = false;
  const go = async (ready) => {
    if (!ready || started) return;
    started = true;
    await auto();
  };
  OBR.scene.onReadyChange(go);
  go(await OBR.scene.isReady());
  stateSoon();
});

window.addEventListener("pagehide", () => {
  // Best effort: Owlbear also drops an extension's local items and tools when it unloads it.
  try {
    if (mine.size) OBR.scene.local.deleteItems([...mine]).catch(() => {});
    OBR.tool.remove(TOOL_ID).catch(() => {});
  } catch {
    // not ready
  }
});
