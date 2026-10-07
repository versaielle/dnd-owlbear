// The extension's message bus: the broadcast channel names every part of the extension
// shares (bridge, effects, aim tool, player popover), and small helpers around Owlbear's
// broadcast API. Pure JavaScript with no SDK import, so the offline checks can load it.
//
// Every message carries v: 1 (receivers ignore other versions) and an id ("mid"), so a
// message that arrives twice (Owlbear echoing a LOCAL send back to the frame that sent it,
// or the scene-metadata fallback below delivering a copy) is handled only once.

export const CH = {
  FX: "dnd-npc/fx",                     // bridge → others: {audience:"all"|"gm", event}
  AIM_START: "dnd-npc/aim/start",       // bridge → GM clients: {audience:"gm", aim: AimSpec}
  AIM_SHOW: "dnd-npc/aim/show",         // bridge → all/gm: locked or request template display
  AIM_CLEAR: "dnd-npc/aim/clear",       // bridge → all: {id, fade_ms}
  AIM_CANCEL: "dnd-npc/aim/cancel",     // bridge → GM aimers: {audience:"gm", id}
  AIM_LOCKED: "dnd-npc/aim/locked",     // GM aimer → bridge (ALL): AimResult; other GM aimers stop
  CAST_REQUEST: "dnd-npc/cast/request", // player → bridge: {req, character, key, template|null, target|null}
  CAST_WITHDRAW: "dnd-npc/cast/withdraw", // player → bridge: {req}
  CAST_STATUS: "dnd-npc/cast/status",   // bridge → player: {to, req, status, note}
  ROSTER: "dnd-npc/roster",             // bridge → player: {to, entry: RosterEntry}
  HELLO: "dnd-npc/hello",               // any → bridge: {role, kind, build, fx_ok, need:["roster","bridge"]}
  BRIDGE: "dnd-npc/bridge",             // bridge → all, every 5 s (below)
  NOTE: "dnd-npc/note",                 // bridge → audience: {audience, text, variant}
  RPC: "dnd-npc/rpc",                   // laptop GM → bridge: {id, path} (allowlist: /api/map/catalog, /api/map/check)
  RPC_REPLY: "dnd-npc/rpc/reply",       // bridge → GM: {id, status, body}
  LOCAL_AIM: "dnd-npc/local/aim",       // popover → background (LOCAL): {spec}
  LOCAL_HUD: "dnd-npc/local/hud",       // HUD ↔ background (LOCAL): {cmd} / {state}
  LOCAL_STATE: "dnd-npc/local/state",   // background → popovers (LOCAL): snapshot
  LOCAL_ASK: "dnd-npc/local/ask",       // popover → background (LOCAL): {need:"state"|"find-panel"|"test"}
};
export const MAX_BYTES = 15000;         // send() refuses anything larger (logs, returns false)

// LOCAL_* messages reach every frame of this client, the other copy of the extension on the
// Dell's tab included (the dual install), so a popover also sends `host` ("local" | "pages")
// and each copy's background answers only its own popover (background.js).
//
// RPC also carries `key` (the asker's one-time public key) and RPC_REPLY may carry `sealed`
// ({epk, iv, ct}) in place of `body`, or `error` (text for the DM): see rpc() below.

export const V = 1;
// The panel's ports (config.PANEL_PORT and the 9 after it, when one is taken).
export const PANEL_PORTS = [7420, 7421, 7422, 7423, 7424, 7425, 7426, 7427, 7428, 7429];
// Only these panel routes may be asked for over RPC (the laptop GM's 🗺 menus and map check).
export const RPC_PATHS = ["/api/map/catalog", "/api/map/check"];

// localStorage keys (per device and browser profile; each Owlbear extension origin has its own).
export const LS = {
  BRIDGE_HERE: "dnd-npc/bridge-here",   // "1": this PC runs the DND panel (popover checkbox)
  PANEL_BASE: "dnd-npc/panel-base",     // where the panel answered last time, e.g. http://localhost:7420
  AIM_HERE: "dnd-npc/aim-here",         // "0": don't open the aim tool on this tab (default on)
  TABLE_SCREEN: "dnd-npc/table-screen", // "1": this player browser is on the table's screen
  QUALITY: "dnd-npc/quality",           // auto | full | lite | off (this device's effects)
  SCENE_BUS: "dnd-npc/scene-bus",       // "1": the bridge also mirrors messages into scene metadata
  roster: (pid) => `dnd-npc/roster/${pid}`, // a player's last roster entry
};

// What every client assumes until the bridge's first heartbeat brings the panel's settings.
export const DEFAULT_SETTINGS = {
  fx: true, style: "shader", zones: true, sfx: true, player_casts: true, shake: true,
  quality: { gm: "full", table: "full", touch: "lite", other: "full" },
  table_players: [], uniform_path: "normal",
};

export const QUALITIES = ["auto", "full", "lite", "off"];

// ---- small helpers ----

export function lsGet(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null; // storage blocked (private window, partitioned iframe): behave as unset
  }
}

export function lsSet(key, value) {
  try {
    if (value === null || value === undefined) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

// An absolute URL for a file next to this one. Owlbear keeps only the origin of a relative
// URL it is given, so every popover, embed, tool, action and menu icon goes through this.
export const here = (rel, base) => new URL(rel, base).href;

// The build stamp the publisher put on this file's URL (?v=abc1234), or "dev" when served
// from the panel on this PC.
export function buildOf(url) {
  try {
    return new URL(url).searchParams.get("v") || "dev";
  } catch {
    return "dev";
  }
}

// Served by the panel on this PC (http://localhost:742x), rather than from the public Pages site.
export function isLocalOrigin(origin) {
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const bytes = (s) => (typeof TextEncoder === "function" ? new TextEncoder().encode(s).length : s.length);

// Is this message for me? me = {role, playerId}. `audience` is "all" (or missing), "gm" (GM
// role only) or "player:<id>"; a `to` field names one player. Players drop the rest unread.
export function forMe(msg, me) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.to !== undefined && msg.to !== null && msg.to !== me?.playerId) return false;
  const a = msg.audience;
  if (a === undefined || a === null || a === "all") return true;
  if (a === "gm") return me?.role === "GM";
  if (typeof a === "string" && a.startsWith("player:")) return a.slice(7) === me?.playerId;
  return false;
}

// ---- client kind (section 4.3): gm, table (the projector), touch (phones) or other ----

export const TABLE_UA = /CrKey|Chromecast|GoogleTV|Android TV|AFT[A-Z]|BRAVIA|SMART-TV|Tizen|Web0S/i;

// The rule itself, from plain facts, so it can be checked offline.
// Owlbear's Cast receiver joins the room as a player named "Cast Receiver" (seen live 2026-10-06;
// its user agent matched none of TABLE_UA).
export const CAST_RECEIVER_NAME = /^cast receiver$/i;

export function kindOf({ role, playerId, ua = "", coarse = false, tableFlag = false, settings = {}, name = "" } = {}) {
  if (role === "GM") return "gm";
  const tablePlayers = Array.isArray(settings?.table_players) ? settings.table_players : [];
  if (TABLE_UA.test(ua || "") || CAST_RECEIVER_NAME.test(String(name || "").trim())
      || (playerId && tablePlayers.includes(playerId)) || tableFlag) return "table";
  if (coarse) return "touch";
  return "other";
}

export async function clientKind(api, settings = {}) {
  const OBR = api?.OBR ?? api;
  let role = "PLAYER", playerId = null, name = "";
  try { role = await OBR.player.getRole(); } catch { /* not ready: a player */ }
  try { playerId = OBR.player.id; } catch { /* not ready */ }
  try { name = await OBR.player.getName(); } catch { /* not ready */ }
  let coarse = false;
  try { coarse = !!globalThis.matchMedia?.("(pointer: coarse)")?.matches; } catch { /* no window */ }
  return kindOf({ role, playerId, ua: globalThis.navigator?.userAgent || "", coarse,
                  tableFlag: lsGet(LS.TABLE_SCREEN) === "1", settings, name });
}

// The effects tier on this device: the popover's own choice, else the panel's for this kind.
export function tierOf(settings, kind, override = lsGet(LS.QUALITY)) {
  if (override && override !== "auto" && QUALITIES.includes(override)) return override;
  return settings?.quality?.[kind] || DEFAULT_SETTINGS.quality[kind] || "full";
}

// ---- send and receive ----

// Handlers registered in this frame, per channel, so a send that includes this client
// (LOCAL or ALL) reaches them exactly once, whether or not Owlbear echoes it back.
const handlers = new Map();
const seen = new Map(); // mid -> when, newest last
const SEEN_MAX = 500;

function markSeen(mid) {
  if (!mid) return false;
  if (seen.has(mid)) return true;
  seen.set(mid, Date.now());
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  return false;
}

function deliver(ch, data, event) {
  for (const fn of handlers.get(ch) || []) {
    try {
      const r = fn(data, event);
      if (r && typeof r.catch === "function") r.catch((e) => console.warn("dnd-npc bus handler failed", ch, e));
    } catch (e) {
      console.warn("dnd-npc bus handler failed", ch, e);
    }
  }
}

// Send one message. dest: "LOCAL" (this device's frames), "REMOTE" (every other device) or
// "ALL". Returns false (and sends nothing) when it is too big; never throws.
export function send(api, ch, data, dest = "ALL") {
  const OBR = api?.OBR ?? api;
  const msg = { ...(data || {}), v: V, mid: data?.mid || newId() };
  let text;
  try {
    text = JSON.stringify(msg);
  } catch (e) {
    console.warn("dnd-npc bus: can't send", ch, e);
    return false;
  }
  const size = bytes(text);
  if (size > MAX_BYTES) {
    console.warn(`dnd-npc bus: ${ch} is ${size} bytes (over ${MAX_BYTES}), not sent`);
    return false;
  }
  try {
    const p = OBR?.broadcast?.sendMessage(ch, msg, { destination: dest });
    if (p && typeof p.catch === "function") p.catch((e) => console.warn("dnd-npc bus: send failed", ch, e));
  } catch (e) {
    console.warn("dnd-npc bus: send failed", ch, e);
  }
  if (dest === "LOCAL" || dest === "ALL") {
    // This frame's own handlers, after the current task (never re-entrantly).
    markSeen(msg.mid);
    const self = { connectionId: sceneBus.conn, local: true };
    queueMicrotask(() => deliver(ch, msg, self));
  }
  if (dest !== "LOCAL" && sceneBus.write) sceneQueue(ch, msg, dest);
  return true;
}

// Listen on a channel. fn(data, event) gets each message once; event.connectionId is the
// sender's connection, stamped by Owlbear. Returns a function that stops listening.
export function on(api, ch, fn) {
  const OBR = api?.OBR ?? api;
  if (!handlers.has(ch)) {
    handlers.set(ch, new Set());
    try {
      OBR?.broadcast?.onMessage(ch, (event) => {
        const data = event?.data;
        if (!data || data.v !== V || markSeen(data.mid)) return;
        deliver(ch, data, event);
      });
    } catch (e) {
      console.warn("dnd-npc bus: can't listen on", ch, e);
    }
  }
  handlers.get(ch).add(fn);
  return () => handlers.get(ch)?.delete(fn);
}

// For the offline checks: forget every handler and seen id.
export function _reset() {
  handlers.clear();
  seen.clear();
  if (sceneBus.timer) clearTimeout(sceneBus.timer);
  Object.assign(sceneBus, fresh());
}

// ---- asking the panel from a popover (menus, map check) ----

// Where this frame may fetch this PC's panel itself (e.g. http://localhost:7420), or null: when
// served from localhost, or on a copy that ticked "🖥 This PC runs the DND panel" and found it.
// Also the only way to the routes too big for a broadcast (🏘 interiors.json is ~95 KB, over
// MAX_BYTES), so those menus are only on the copy served by this PC (background.js).
export function directBase(origin = globalThis.location?.origin) {
  return isLocalOrigin(origin) ? origin : lsGet(LS.BRIDGE_HERE) === "1" ? lsGet(LS.PANEL_BASE) : null;
}

// GET a loopback panel route. This device fetches it itself only when it may talk to this
// PC's panel (served from localhost, or ticked "🖥 This PC runs the DND panel" and found it);
// any other GM asks the bridge over broadcast. Players never reach the panel.
//
// The answers name the adventure's places and NPCs, hidden ones included (R2), and a broadcast
// can't be sent to one device only. So the bridge answers the other copy of the extension on
// its own tab (the Dell's Pages copy, same connection) with LOCAL, which never leaves the Dell;
// and any other GM device (the laptop) gets the answer sealed with a one-time key only that
// device holds (ECDH P-256 + AES-GCM, WebCrypto): every other device in the room sees noise.
export async function ask(api, path, { timeoutMs = 4000, origin = globalThis.location?.origin } = {}) {
  const direct = directBase(origin);
  if (direct) {
    try {
      const r = await fetch(direct + path);
      if (r.ok) return await r.json();
    } catch { /* fall through to the bridge */ }
  }
  return rpc(api, path, timeoutMs);
}

export function rpc(api, path, timeoutMs = 4000) {
  const id = newId();
  return new Promise((resolve, reject) => {
    let stop = () => {};
    let done = false;
    const fail = (text, status) => {
      const e = new Error(text);
      if (status) e.status = status;
      reject(e);
    };
    const timer = setTimeout(() => {
      done = true;
      stop();
      fail("no bridge: the DND panel isn't reachable from here");
    }, timeoutMs);
    (async () => {
      let keys = null;
      try {
        keys = await rpcKeys();
      } catch {
        keys = null; // no WebCrypto here: the bridge only answers what's safe to send in the clear
      }
      if (done) return;
      stop = on(api, CH.RPC_REPLY, async (msg) => {
        if (msg.id !== id || done) return;
        done = true;
        clearTimeout(timer);
        stop();
        if (!(msg.status >= 200 && msg.status < 300)) {
          fail(typeof msg.error === "string" && msg.error ? msg.error : `the panel answered ${msg.status}`, msg.status);
        } else if (msg.sealed) {
          try {
            if (!keys) throw new Error("no key");
            resolve(await unseal(msg.sealed, keys.priv, id));
          } catch {
            fail("couldn't read the bridge's answer");
          }
        } else {
          resolve(msg.body);
        }
      });
      send(api, CH.RPC, { id, path, ...(keys ? { key: keys.pub } : {}) }, "ALL");
    })();
  });
}

// ---- sealing an RPC answer for one device ----

const ECDH = { name: "ECDH", namedCurve: "P-256" };
const subtle = () => globalThis.crypto?.subtle ?? null;
const toB64 = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));

async function sharedKey(priv, theirPub) {
  const S = subtle();
  const pub = await S.importKey("raw", fromB64(theirPub), ECDH, false, []);
  return S.deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// The asker's one-time key pair: {priv (never leaves this frame), pub (base64, sent in the RPC)},
// or null when this browser has no WebCrypto.
export async function rpcKeys() {
  const S = subtle();
  if (!S) return null;
  const pair = await S.generateKey(ECDH, false, ["deriveKey"]);
  return { priv: pair.privateKey, pub: toB64(await S.exportKey("raw", pair.publicKey)) };
}

export const canSeal = () => !!subtle();

// The bridge: `body` readable only by the holder of the private half of `theirPub`, bound to
// this request id. Throws on a bad key.
export async function seal(body, theirPub, id = "") {
  const S = subtle();
  const pair = await S.generateKey(ECDH, false, ["deriveKey"]);
  const key = await sharedKey(pair.privateKey, theirPub);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await S.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(String(id)) }, key,
                             new TextEncoder().encode(JSON.stringify(body ?? null)));
  return { epk: toB64(await S.exportKey("raw", pair.publicKey)), iv: toB64(iv), ct: toB64(ct) };
}

export async function unseal(sealed, priv, id = "") {
  const S = subtle();
  const key = await sharedKey(priv, sealed.epk);
  const pt = await S.decrypt({ name: "AES-GCM", iv: fromB64(sealed.iv), additionalData: new TextEncoder().encode(String(id)) },
                             key, fromB64(sealed.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---- fallback transport: scene metadata (section 14.5, only if broadcasts can't cross
// between the localhost copy and the Pages copy of the extension) ----
//
// Off by default: probe P10 showed plain broadcasts do cross, so nothing writes or reads these
// keys unless the popover's Advanced box (or the panel's scene_bus setting) switches it on.
//
// The writer keeps its last 8 messages (at most 12 KB) under its own scene-metadata key,
// dnd-npc/bus/<connection id>.<local|pages>, so writers never overwrite each other (the two
// copies of the extension on the Dell's tab share a connection, hence the host). A client that
// switched it on watches those keys and hands newer messages (by seq, which starts at the clock
// so a reloaded writer still counts up) to the same handlers as broadcasts, deduplicated by mid,
// marked viaScene. Readers skip what was already there when they started. The sender's
// connection id comes from the key, which any client can write, so it proves nothing: the
// bridge ignores every viaScene message sent up to it (aim locks, cast requests, RPC, hello).

export const SCENE_BUS_PREFIX = "dnd-npc/bus/";
export const SCENE_RING = 8;
export const SCENE_MAX_BYTES = 12000;
const fresh = () => ({ api: null, conn: null, host: "pages", write: false, reading: false, ring: [], seq: Date.now(),
                       timer: null, writing: false, last: new Map() });
const sceneBus = fresh();

export function sceneBusState() {
  return { write: sceneBus.write, reading: sceneBus.reading, queued: sceneBus.ring.length };
}

const sceneKey = () => `${SCENE_BUS_PREFIX}${sceneBus.conn}.${sceneBus.host}`;

// Start (or stop) mirroring this client's sends into scene metadata.
export function setSceneWrite(api, conn, on_) {
  sceneBus.api = api;
  sceneBus.conn = conn ?? sceneBus.conn;
  sceneBus.write = !!on_;
}

// This device's Owlbear connection (stamped on its own messages), and where this copy of the
// extension is served from.
export function setConnection(conn, host = sceneBus.host) {
  sceneBus.conn = conn;
  sceneBus.host = host;
}

function sceneQueue(ch, msg, dest) {
  sceneBus.ring.push({ seq: ++sceneBus.seq, ch, data: msg, dest });
  while (sceneBus.ring.length > SCENE_RING) sceneBus.ring.shift();
  while (sceneBus.ring.length > 1 && bytes(JSON.stringify(sceneBus.ring)) > SCENE_MAX_BYTES) sceneBus.ring.shift();
  if (bytes(JSON.stringify(sceneBus.ring)) > SCENE_MAX_BYTES) {
    console.warn("dnd-npc bus: a message is too big for the scene fallback", ch);
    sceneBus.ring = [];
    return;
  }
  if (!sceneBus.timer) sceneBus.timer = setTimeout(sceneFlush, 50); // one write for a burst
}

async function sceneFlush() {
  sceneBus.timer = null;
  if (sceneBus.writing) {
    sceneBus.timer = setTimeout(sceneFlush, 50);
    return;
  }
  const OBR = sceneBus.api?.OBR ?? sceneBus.api;
  if (!OBR?.scene || !sceneBus.conn) return;
  sceneBus.writing = true;
  try {
    if (await OBR.scene.isReady()) {
      await OBR.scene.setMetadata({ [sceneKey()]: { seq: sceneBus.seq, items: sceneBus.ring } });
    }
  } catch (e) {
    console.warn("dnd-npc bus: scene fallback write failed", e);
  } finally {
    sceneBus.writing = false;
  }
}

function sceneRead(meta, deliverNew) {
  for (const [key, value] of Object.entries(meta || {})) {
    if (!key.startsWith(SCENE_BUS_PREFIX) || key === sceneKey()) continue; // not ours to read
    const name = key.slice(SCENE_BUS_PREFIX.length);
    const from = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    const last = sceneBus.last.get(key) ?? -Infinity;
    let top = last;
    for (const item of Array.isArray(value?.items) ? value.items : []) {
      const data = item?.data;
      if (!(item?.seq > last) || !data || data.v !== V) continue;
      top = Math.max(top, item.seq);
      if (markSeen(data.mid)) continue; // it came by broadcast as well
      if (deliverNew) deliver(item.ch, data, { connectionId: from, viaScene: true });
    }
    sceneBus.last.set(key, top);
  }
}

// Watch the fallback keys (background.js calls this only once the fallback is switched on).
export async function startSceneReader(api, conn) {
  const OBR = api?.OBR ?? api;
  if (sceneBus.reading || !OBR?.scene?.onMetadataChange) return;
  sceneBus.reading = true;
  sceneBus.api = sceneBus.api || api;
  sceneBus.conn = conn ?? sceneBus.conn;
  const baseline = async () => {
    try {
      if (await OBR.scene.isReady()) sceneRead(await OBR.scene.getMetadata(), false); // skip what's there
    } catch { /* no scene yet */ }
  };
  await baseline();
  OBR.scene.onMetadataChange((meta) => sceneRead(meta, true));
  // Another scene opened: its old messages are history too.
  OBR.scene.onReadyChange?.((ready) => { if (ready) baseline(); });
}
