// The vision spike's popover. On a GM screen it is the control panel: every button goes to this
// screen's background (LOCAL broadcast), which broadcasts the settings to every screen, and the
// background answers with the live state (the screens table, the fog, the door picks) once a
// second. On a player's screen it only says what this is.
import OBR from "./obr-sdk.js?v=cfced8d";
import * as S from "./spike.js?v=cfced8d";

const $ = (id) => document.getElementById(id);
const send = (op, extra = {}) =>
  OBR.broadcast.sendMessage(S.CH.ui, { to: "bg", op, ...extra }, { destination: "LOCAL" }).catch(() => {});
let last = null;
let wantCopy = false;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const v = (x, unit = "") => (x === null || x === undefined ? "-" : `${x}${unit}`);

function setToggle(id, on, name) {
  const b = $(id);
  b.textContent = `${name}: ${on ? "ON" : "off"}`;
  b.classList.toggle("on", !!on);
}
function setRadio(name, value) {
  for (const r of document.querySelectorAll(`input[name=${name}]`)) r.checked = String(r.value) === String(value);
}

function render(st) {
  last = st;
  const s = st.settings;
  setToggle("meter", s.meter, "Meter");
  setToggle("lights", s.lights.on, "Lights");
  setToggle("walls", s.walls.on, "Walls");
  setToggle("doors", s.doors.on, "Handles");
  setRadio("sr", s.lights.sourceRadius);
  setRadio("scope", s.walls.scope);
  setRadio("sides", s.walls.sides);
  $("gmOpen").checked = s.walls.gmOpen;
  $("locked").checked = s.doors.locked;
  if (document.activeElement !== $("reach")) $("reach").value = s.lights.reachFt;
  $("phaseNow").textContent = st.phase || "(none)";
  $("hist").textContent = st.historyCount;
  $("panel").textContent = !st.leader ? "another GM posts" : st.panel === null ? "not tried" : st.panel ? "OK" : "unreachable (normal from Pages)";
  $("pcs").textContent = st.pcs;
  $("lines").textContent = `In this scene: ${st.linesInScene} Smoke lines, ${st.doorsInScene} doors.`;
  const f = st.fog || {};
  $("fogNow").textContent = `Now: fill ${f.filled === null ? "?" : f.filled ? "ON" : "off"}, colour ${f.color ?? "?"}`
    + (f.saved ? ` · saved to restore: fill ${f.saved.filled ? "on" : "off"}, ${f.saved.color}` : " · nothing saved yet");
  const rows = [];
  for (const sc of st.screens || []) {
    const r = sc.reading || {};
    const fresh = sc.readingAt && Date.now() - sc.readingAt < 6000;
    const t = sc.status || {};
    const lt = r.ltMs ?? r.bgLtMs;
    rows.push(`<tr class="${sc.age > 25 ? "stale" : ""}" title="${esc(`${sc.who.ua} · ${sc.who.screen} @${sc.who.dpr}x · ${sc.probes}`)}">`
      + `<td>${esc(sc.who.kind)} ${esc(sc.who.name)}${sc.who.touch ? " 📱" : ""}</td>`
      + `<td>${fresh ? v(r.fps) : "-"}</td><td>${fresh ? v(r.low10) : "-"}</td><td>${fresh ? v(r.worstMs) : "-"}</td>`
      + `<td>${fresh ? v(lt) : "-"}</td><td>${fresh ? v(r.lagP90) : "-"}</td>`
      + `<td>${v(t.lights)}</td><td>${v(t.walls)}${t.walls ? `/${t.wallSegs}s ${t.wallMaps}m` : ""}</td><td>${v(t.doors)}</td>`
      + `<td>${t.memory ? esc(t.memory.slice(0, 10)) : "-"}</td><td>${sc.age}</td></tr>`);
    const notes = [];
    if (sc.settingsAt !== s.at) notes.push("settings not caught up yet");
    if (t.meter && t.meter !== "measuring") notes.push(`meter: ${t.meter}`);
    if (t.memory && t.memory.length > 10) notes.push(`memory: ${t.memory}`);
    if (!t.scene) notes.push("no scene open");
    for (const e of t.errors || []) notes.push(e);
    if (notes.length) rows.push(`<tr><td class="err" colspan="11">${esc(notes.join(" · "))}</td></tr>`);
  }
  $("screens").innerHTML = rows.join("") || `<tr><td colspan="11">no screen has reported yet</td></tr>`;
  $("picks").innerHTML = (st.doors || []).slice().reverse().map((d) =>
    `<li>${S.clock(d.at)} door ${esc(d.door.slice(0, 6))} by ${esc(d.name)} (${esc(d.kind)}) via <b>${esc(d.via)}</b>${d.extra ? ` (${esc(d.extra)})` : ""}</li>`).join("")
    || "<li>no picks yet</li>";
  $("memNow").textContent = s.memory ? `On map ${s.memory.mapId.slice(0, 8)}… (each screen's result is in the table, "mem")`
    : "Select one map image (or none: the map in the middle of your view is used).";
  if (st.flushed && wantCopy) {
    wantCopy = false;
    copyResults(st.flushed);
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    // the iframe may not be allowed the clipboard: select it for Ctrl+C
  }
  const out = $("out");
  out.hidden = false;
  out.value = text;
  out.focus();
  out.select();
  try {
    if (document.execCommand("copy")) return "copied";
  } catch {
    // fall through
  }
  return "select the text below and press Ctrl+C";
}

async function copyResults(flushed) {
  let history = null;
  try { history = JSON.parse(localStorage.getItem(flushed.key) || "null"); } catch { history = null; }
  const text = Array.isArray(history) ? S.resultsText(history) : `${flushed.summary}\n\n(the full history couldn't be read here: summary only)`;
  $("copied").textContent = `${await copy(text)} (${text.split("\n").length} lines)`;
}

async function memAdd() {
  let mapId = null, how = "";
  try {
    const sel = (await OBR.player.getSelection()) || [];
    const maps = sel.length ? (await OBR.scene.items.getItems(sel)).filter(S.isMapImage) : [];
    if (maps.length === 1) {
      mapId = maps[0].id;
      how = `selected map "${maps[0].name}"`;
    } else if (maps.length > 1) {
      $("memNow").textContent = "More than one map selected: select one.";
      return;
    } else {
      const [w, h, dpi] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight(), OBR.scene.grid.getDpi()]);
      const p = await OBR.viewport.inverseTransformPoint({ x: w / 2, y: h / 2 });
      const all = await OBR.scene.items.getItems(S.isMapImage);
      mapId = S.mapAt(p, S.mapRects(all, dpi));
      const m = all.find((i) => i.id === mapId);
      how = m ? `the map in the middle of the view, "${m.name}"` : "";
    }
  } catch (e) {
    $("memNow").textContent = `Couldn't read the map: ${e?.message || e}`;
    return;
  }
  if (!mapId) {
    $("memNow").textContent = "No map selected and none in the middle of the view.";
    return;
  }
  $("memNow").textContent = `Adding on ${how}…`;
  send("memory", { mapId });
}

function wire() {
  $("meter").onclick = () => send("meter", { on: !last?.settings.meter });
  $("lights").onclick = () => send("lights", { set: { on: !last?.settings.lights.on } });
  $("walls").onclick = () => send("walls", { set: { on: !last?.settings.walls.on } });
  $("doors").onclick = () => send("doors", { set: { on: !last?.settings.doors.on } });
  for (const r of document.querySelectorAll("input[name=sr]")) r.onchange = () => send("lights", { set: { sourceRadius: Number(r.value) } });
  for (const r of document.querySelectorAll("input[name=scope]")) r.onchange = () => send("walls", { set: { scope: r.value } });
  for (const r of document.querySelectorAll("input[name=sides]")) r.onchange = () => send("walls", { set: { sides: r.value } });
  $("gmOpen").onchange = () => send("walls", { set: { gmOpen: $("gmOpen").checked } });
  $("locked").onchange = () => send("doors", { set: { locked: $("locked").checked } });
  $("setReach").onclick = () => send("lights", { set: { reachFt: Number($("reach").value) } });
  $("setPhase").onclick = () => send("phase", { label: $("phase").value.trim() });
  for (const b of document.querySelectorAll("[data-fog]")) b.onclick = () => send("fog", { what: b.dataset.fog });
  $("memAdd").onclick = memAdd;
  $("memOff").onclick = () => send("memory", { mapId: null });
  $("copy").onclick = () => { wantCopy = true; $("copied").textContent = "…"; send("flush"); };
  let armed = 0; // a second click within 4 s clears (no confirm(): Owlbear's iframes may not allow dialogs)
  $("clear").onclick = () => {
    if (Date.now() - armed < 4000) {
      armed = 0;
      $("clear").textContent = "Clear history";
      send("clearHistory");
    } else {
      armed = Date.now();
      $("clear").textContent = "Click again to clear";
      setTimeout(() => { $("clear").textContent = "Clear history"; }, 4000);
    }
  };
  $("forget").onclick = () => send("forgetScreens");
  $("clean").onclick = () => send("clean");
}

OBR.onReady(async () => {
  let role = "PLAYER", name = "";
  try { role = await OBR.player.getRole(); } catch { /* a player */ }
  try { name = await OBR.player.getName(); } catch { /* none */ }
  const kind = S.kindOf({ role, name, ua: navigator.userAgent });
  $("me").textContent = `This screen: ${kind} (${name || "?"})`;
  if (role !== "GM") {
    $("player").hidden = false;
    return;
  }
  $("gm").hidden = false;
  wire();
  OBR.broadcast.onMessage(S.CH.state, (ev) => { if (ev.data?.settings) render(ev.data); });
  send("get");
  setInterval(() => send("get"), 1000);
});
