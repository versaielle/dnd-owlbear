// "🔥 Lighting" in the GM's 🗺 DND NPC box (popover.html): the one place to set up the lights of
// the scene, with no panel needed (tools/owlbear_only.py is enough). Lights redo,
// docs/lights-redo-spec.md.
//
//   Scene        "This scene" ☀ lit / 🌒 dim / 🌑 dark (SCENE_LIGHTING_KEY.darkness; unmarked = ☀) and
//                "Props light themselves" (.auto: a sconce, torch, brazier, candle… by name/picture);
//                "Maps here": each MAP-layer image ☀/🌒/🌑/as scene (MAP_DARKNESS_KEY on it;
//                docs/lights-darkness-spec.md: darkness comes from light, per point); while 🌫 Our
//                fog is on, also its explored-memory controls (fog/mapui.js, docs/vision-layer-b4.md
//                section 6, docs/vision-layer-2024.md section 6): the mode (auto (→ what auto is
//                now) / fog / remembered / clear; "remembered" writes "dim"), 🏠 / 🌳, "Forget
//                explored (40%)" (the explored share; two taps), and for an interior "Remember
//                building" / "Forget building". Each tap writes a whole value from this GM screen
//                and goes to the 🪵 Live log (this device's background, LOCAL_ASK "fog-log")
//   PCs          each PC token in the scene: its sight limit (blank = none: fog, mist), its
//                darkvision (blank = the sheet's, shown greyed), its light (chips)
//   Lit objects  everything else with a light (incl. the ones lit by their name: "auto"), chips + None
//   Screens      the screens this GM copy heard (kind, build, lights) and what to do about them
//   Release      gives every token we manage back to plain Smoke & Spectre (two taps)
//   🌫 Our fog    (at the top) the scene switch for our own vision layer (fog/fog.js: FOG_KEY.on; two
//                taps to switch on, one off), with a warning while Smoke & Spectre's vision is on in
//                the same scene, and what this GM screen draws for it (the background's fog status).
//                While on, the "Memory shade" row (lighter 0.55 / medium 0.65 / darker 0.75): how
//                dark remembered ground and "clear" maps are on every screen (FOG_LOOK_KEY, whole).
//                A tap asks this device's background to write the whole switch (fog.js setOn: the
//                fill, prev, Smoke's door state) at once; with no answer in SWITCH_WAIT_MS this box
//                writes it itself (fog.js writeSwitch)
//   🪵 Live log   (right under it, startLiveLog) every screen's fog and door log lines, newest first,
//                each with the screen it came from, and a Copy button (fog/livelog.js)
//
// Every change goes through lightmeta.js's setLight / setVision, then planItem for Smoke's keys
// with the lights writer's own ctx, in one write (fx/lightwriter.js writeNow): the writer's next
// pass plans nothing more. Any control here that changes an input takes a scene released to
// Smoke back (SCENE_LIGHTING_KEY.managed true); "Release lights to Smoke" sets it false.
import { FOG_KEY, MAP_DARKNESS_KEY, PARTY_KEY, SCENE_LIGHTING_KEY } from "./keys.js?v=af4de9c";
import { SOURCES } from "./fx/lights.js?v=af4de9c";
import { isMap, mapDarkness, readGrid, sceneDarkness } from "./fx/darkness.js?v=af4de9c";
import { writeNow } from "./fx/lightwriter.js?v=af4de9c";
import { cleanParty } from "./gather.js?v=af4de9c";
import { DARKNESS, applyMeta, autoKind, carriers, describe, editFor, lightingOf, lightingRows, managed, releaseItem,
         screenLine, screenWarnings, uiCtx } from "./lightui.js?v=af4de9c";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const COMMON = ["candle", "torch", "lamp", "hooded_lantern", "brazier"].filter((k) => SOURCES[k]);
export const SWITCH_WAIT_MS = 3000; // the background didn't answer the 🌫 tap by then: this box writes it
// Darkness comes from light (docs/lights-darkness-spec.md): the scene's, and each map's own
// (lightui.js DARKNESS: the same words as the 🔥 menu).
const DARK_CHIPS = DARKNESS;
// The PC rows' "sees N ft" on 🌑 ground (fx/lightmeta.js seerReachFt). The fog opens a whole circle
// that far round the PC (ruling (a): lit ground in line of sight is seen from the dark), so the unlit
// ground inside it is blacked by our overlay only, and what is drawn above the overlay (Stat Bubbles'
// HP bars) still shows there (review of dark-fix, 2026-10-14: the tooltip must not promise more).
export const DARK_SEES_TITLE = "On dark ground: how far the fog opens all round it (its darkvision, its own light, or the far edge of a light on its own map)."
  + " Lights on other maps never count. Unlit ground inside that circle is blacked by our overlay only, so a creature standing there"
  + " can still show its HP bar: hide it until a light or darkvision reaches it";
const short = (k) => (k === "hooded_lantern" ? "Lantern" : k === "brazier" ? "Brazier" : SOURCES[k]?.label || k);

export const LIGHTING_CSS = `
  #lighting .chips { display: flex; flex-wrap: wrap; gap: 3px; margin: 2px 0 4px; }
  #lighting .chip { margin: 0; padding: 2px 8px; border: 2px solid transparent; border-radius: 999px; font-size: 11px;
                    background: rgba(255,255,255,.08); opacity: .7; }
  #lighting .chip:hover { opacity: 1; background: rgba(255,255,255,.18); }
  #lighting .chip.on { opacity: 1; border-color: #d9a441; background: rgba(217,164,65,.22); }
  #lighting .row { margin: 6px 0 2px; }
  #lighting .who { font-weight: 600; }
  #lighting .tag { font-size: 10px; opacity: .7; margin-left: 4px; }
  #lighting input[type=number] { width: 52px; font: inherit; color: inherit; background: rgba(255,255,255,.12); border: 0;
                                 border-radius: 5px; padding: 2px 4px; }
  #lighting input[type=number]::placeholder { color: rgba(255,255,255,.45); }
  #lighting .fields { display: flex; gap: 10px; align-items: center; font-size: 11px; margin: 2px 0; }
  #lighting .fields label { display: inline-flex; gap: 4px; align-items: center; margin: 0; }
  #lighting select { font-size: 11px; padding: 1px 4px; }
  #lighting .chips.fm { gap: 2px; margin: 0 0 2px; }
  #lighting .chips.fm .chip { font-size: 10px; padding: 1px 6px; }
  #lighting .chip:disabled { opacity: .3; cursor: default; background: rgba(255,255,255,.05); }
  #lighting .chip.arm { opacity: 1; border-color: #f08a7b; }
  #lt-said { min-height: 15px; margin: 4px 0; }
  #livelog .ll-line { font: 10px/1.35 ui-monospace, Consolas, monospace; margin: 1px 0; word-break: break-word; opacity: .9; }
  #livelog .ll-line.error { color: #f08a7b; opacity: 1; }
  #livelog .ll-line.switch, #livelog .ll-line.answerer { color: #9cd3ff; }
  #livelog #ll-lines { max-height: 260px; overflow-y: auto; margin-top: 4px; }
  #livelog #ll-copy { font-size: 11px; padding: 3px 10px; margin: 2px 0 0; }
  #livelog textarea { width: 100%; height: 120px; font: 10px ui-monospace, Consolas, monospace; color: inherit;
                      background: rgba(0,0,0,.35); border: 0; border-radius: 5px; }
`;

// 🪵 Live log (popover.html, right under 🔥 Lighting): every screen's fog and door lines, as the
// background sends them ({kind, text}, newest first: fog/livelog.js lineText), and a Copy button.
// el: {lines, copy, said} elements. -> {show(lines, error)}
export function startLiveLog(el) {
  let shown = [];
  const say = (text, cls = "dim") => {
    if (!el.said) return;
    el.said.className = `small ${cls}`;
    el.said.textContent = text;
  };
  function show(lines, error = "") {
    shown = Array.isArray(lines) ? lines.filter((l) => l && typeof l.text === "string") : [];
    el.lines.innerHTML = "";
    if (!shown.length) {
      el.lines.innerHTML = `<p class="dim small">${error ? `🌫 Our fog didn't load here: ${esc(error)}`
        : "Nothing yet: door requests, answers, door writes, the 🌫 switch and errors from every screen show here."}</p>`;
      return;
    }
    for (const l of shown) {
      const p = document.createElement("div");
      p.className = `ll-line ${/^[a-z]+$/.test(l.kind || "") ? l.kind : ""}`;
      p.textContent = l.text;
      el.lines.append(p);
    }
  }
  // Copy: the clipboard when the box may write it, else a selected text box to copy by hand.
  async function copy() {
    const text = shown.map((l) => l.text).join("\n");
    if (!text) return say("Nothing to copy yet");
    try {
      await navigator.clipboard.writeText(text);
      return say(`Copied ${shown.length} line(s)`, "ok");
    } catch { /* this frame may not write the clipboard */ }
    const box = document.createElement("textarea");
    box.value = text;
    box.readOnly = true;
    el.lines.prepend(box);
    box.focus?.();
    box.select?.();
    let done = false;
    try { done = document.execCommand("copy"); } catch { done = false; }
    say(done ? `Copied ${shown.length} line(s)` : "Press Ctrl+C (⌘C) to copy the selected lines", done ? "ok" : "warn");
  }
  if (el.copy) el.copy.onclick = () => { copy().catch((e) => say(`Couldn't copy: ${e?.message || e}`, "bad")); };
  show([]);
  return { show };
}

// el: {scene, pcs, lit, screens, said, release, fog?} elements; OBR: the SDK. ask(need, extra): a
// LOCAL_ASK to this device's own background (popover.html), for the 🌫 switch.
export function startLighting(OBR, el, { build = "", ask = null } = {}) {
  let ctx = null, items = [], sceneMeta = {}, roomMeta = {}, ready = false;
  let screens = null, myBuild = build, armed = 0, writer = null;
  // 🌫 Our fog: fog/fog.js, loaded on its own (the rest of the list works without it); the
  // background's fog status on this screen (its LOCAL_STATE); the switch-on tap waiting for a second;
  // the tap the background is writing ({id, on, timer}).
  let fogMod = null, fogErr = "", fogStatus = null, fogArmed = 0, fogAsked = null;
  // The maps' explored-memory controls (fog/mapui.js, loaded on its own as fog.js is), the scene grid
  // load() reads (mapRows needs its dpi), and the "Forget explored" tap waiting for a second ({id, at}).
  let mapUi = null, sceneGrid = null, forgetArmed = null;
  let pcIds = null; // the bridge heartbeat's PC ids (the background's snapshot), as the writer has them

  const say = (text, cls = "ok") => {
    el.said.className = `small ${cls}`;
    el.said.textContent = text;
  };

  async function load() {
    ready = await OBR.scene.isReady().catch(() => false);
    roomMeta = (await OBR.room.getMetadata().catch(() => ({}))) || {};
    if (!ready) {
      items = [];
      sceneMeta = {};
      ctx = uiCtx({ roomMeta, party: cleanParty(roomMeta?.[PARTY_KEY]), pcIds });
      return;
    }
    let grid;
    [items, sceneMeta, grid] = await Promise.all([OBR.scene.items.getItems(), OBR.scene.getMetadata(), readGrid(OBR)]);
    sceneGrid = grid;
    ctx = uiCtx({ byId: new Map(items.map((i) => [i.id, i])), sceneMeta: sceneMeta || {}, roomMeta,
                  party: cleanParty(roomMeta?.[PARTY_KEY]), pcIds, grid });
  }
  const opts = () => ({ party: ctx?.party, pcTokens: pcIds });

  // The scene's lighting as it is, its darkness "lit" when unmarked (fx/darkness.js), so a write
  // of another field never marks an unmarked scene dim.
  const curLighting = () => ({ ...lightingOf(sceneMeta), darkness: sceneDarkness(sceneMeta) });

  // A control here changed an input: a scene released to Smoke is ours again (spec). Returns
  // whether it was released.
  async function takeBack() {
    const cur = curLighting();
    if (cur.managed) return false;
    await OBR.scene.setMetadata({ [SCENE_LIGHTING_KEY]: { ...cur, managed: true } });
    sceneMeta = { ...(sceneMeta || {}), [SCENE_LIGHTING_KEY]: { ...cur, managed: true } };
    return true;
  }

  // One write for these items (writeNow): each changed by `change(item)` ({light} / {vision}),
  // Smoke's keys planned at once with the writer's ctx. Says what it did for one item.
  async function write(ids, change) {
    await load();
    const back = await takeBack();
    const r = await writeNow(OBR, ids, editFor(change), opts());
    await load();
    const done = items.filter((x) => ids.includes(x.id));
    const tail = back ? " · lights are ours again in this scene" : "";
    if (done.length === 1) say(describe(done[0], ctx) + (r.wrote.length ? "" : " (already so)") + tail);
    else say(`${r.wrote.length} changed${tail}`);
    render();
  }

  // After the scene's darkness or "props light themselves" changed: every token's Smoke keys at
  // once (the writer would too, a moment later; same rules, same write).
  async function replanAll() {
    await load();
    const r = await writeNow(OBR, items.map((i) => i.id), null, opts());
    return r.wrote.length;
  }

  // 🌑 is fog only, and the DM's stored remembered or clear waits there (fog/mode.js fogMode): a
  // darkness tap that lifts a map off 🌑 draws that pick again with no other prompt (review of
  // dark-fix, 2026-10-14: a clear set on a dark map during the live test came back at moonrise). So
  // such a tap says which maps' picks are drawn again, in the box and the 🪵 Live log. waitingPicks:
  // the rows (while 🌫 Our fog is on) on 🌑 holding a stored remembered or clear, by id, as drawn now.
  // Neither ever stops the darkness write: a failure here only leaves the line out.
  const waitingPicks = () => {
    try { return new Map(mapRowsNow().filter((r) => r.darkLocked && r.override && r.override !== "fog").map((r) => [r.id, r])); } catch { return new Map(); }
  };
  const drawnAgain = (before) => {
    try {
      return mapRowsNow().filter((r) => before.has(r.id) && !r.darkLocked && r.override === before.get(r.id).override)
        .map((r) => ` · ${r.name || "Map"}: your ${word(r.override)} is drawn again (tap auto to drop it)`).join("");
    } catch { return ""; }
  };
  // The darkness tap's line: logged too when a stored pick came back, else only said.
  const darkSaid = (text, before) => {
    const again = before.size ? drawnAgain(before) : "";
    return again ? note(text + again, "warn") : say(text);
  };

  async function setScene(patch) {
    if (!ready) return say("Open a scene first", "warn");
    const cur = curLighting();
    const waiting = waitingPicks();
    const next = { ...cur, ...patch, managed: true };
    await OBR.scene.setMetadata({ [SCENE_LIGHTING_KEY]: next });
    const n = await replanAll();
    const d = DARK_CHIPS.find((x) => x.value === next.darkness);
    darkSaid(`${d.icon} Scene ${d.label}${"auto" in patch ? ` · props ${next.auto ? "light themselves" : "stay as you set them"}` : ""}`
      + (n ? ` · ${n} token(s) updated` : "") + (cur.managed ? "" : " · lights are ours again in this scene"), waiting);
    render();
  }

  // One map's own darkness: "lit" | "dim" | "dark", or null (as the scene: written as an explicit
  // null, never a deleted key: a JSON-patch "remove" of a key another screen lacks desyncs it, live
  // 2026-10-12). Then every token's Smoke keys at once (a seer's range depends on where it stands).
  async function setMap(id, code) {
    if (!ready) return say("Open a scene first", "warn");
    const value = code || null;
    const waiting = waitingPicks();
    await OBR.scene.items.updateItems([id], (drafts) => {
      for (const d of drafts) {
        if ((d.metadata?.[MAP_DARKNESS_KEY] ?? null) === value) continue; // already so (missing = as the scene)
        if (!d.metadata) d.metadata = {};
        d.metadata[MAP_DARKNESS_KEY] = value;
      }
    });
    await load();
    const back = await takeBack();
    const n = await replanAll();
    const m = items.find((i) => i.id === id);
    const d = DARK_CHIPS.find((x) => x.value === code);
    darkSaid(`${m?.name || "Map"}: ${d ? `${d.icon} ${d.label}` : "as the scene"}${n ? ` · ${n} token(s) updated` : ""}${back ? " · lights are ours again in this scene" : ""}`, waiting);
    render();
  }

  const chip = (label, on, title, onclick) => {
    const b = document.createElement("button");
    b.className = `chip${on ? " on" : ""}`;
    b.textContent = label;
    b.title = title || "";
    b.onclick = () => Promise.resolve(onclick()).catch((e) => say(`Couldn't: ${e?.error?.message || e?.message || e}`, "bad"));
    return b;
  };

  // ---- 🌫 the maps' explored memory (fog/mapui.js; GM only, only while 🌫 Our fog is on) ----
  const fogIsOn = () => !!fogMod && fogMod.fogOn(sceneMeta);
  const mapRowsNow = () => (ready && mapUi && fogIsOn() ? mapUi.mapRows({ items, grid: sceneGrid, sceneMeta }) : []);
  const rowOf = (id) => mapRowsNow().find((r) => r.id === id) || null;
  const word = (mode) => (mapUi?.modeWord ? mapUi.modeWord(mode) : mode); // "dim" is said "remembered"
  const modeSaid = (r) => (!r ? "" : r.darkLocked && r.override && r.override !== "fog"
    ? `fog (🌑 dark map: fog only; your ${word(r.override)} is kept for when it's 🌒 or ☀)`
    : r.override ? `${word(r.override)} (set by you)` : `auto → ${word(r.auto)}`);
  // What a fog tap did: the box's one line, and the 🪵 Live log (this device's background logs it
  // with this screen's name, so every GM screen's log shows it).
  function note(text, cls = "ok") {
    say(text, cls);
    try { if (typeof ask === "function") ask("fog-log", { kind: "map", text }); } catch { /* the log is optional */ }
  }
  async function fogWrite(fn) {
    if (!ready) return say("Open a scene first", "warn");
    if (!mapUi) return say("🌫 The map controls didn't load", "bad");
    await load();
    if (!fogIsOn()) {
      render();
      return say("🌫 Our fog is off: switch it on first", "warn");
    }
    await fn();
    await load();
    render();
  }
  const setFogMode = (row, mode) => fogWrite(async () => {
    // 🌑 is fog only: a remembered or clear tap there (a chip drawn before the map went dark) writes nothing
    const now = rowOf(row.id);
    if (now?.darkLocked && (mode === "dim" || mode === "clear")) {
      return say(`${row.name || "Map"}: ${mapUi.DARK_ONLY_TITLE ?? "dark map: fog only"} (nothing written)`, "warn");
    }
    const r = await mapUi.setMapFog(OBR, row.id, { mode });
    await load();
    note(`${row.name || "Map"}: fog mode ${word(mode)}${r.wrote ? "" : " (already so)"} · now ${modeSaid(rowOf(row.id))}`);
  });
  const setFogKind = (row, kind) => fogWrite(async () => {
    const r = await mapUi.setMapFog(OBR, row.id, { kind });
    await load();
    const now = rowOf(row.id);
    note(`${row.name || "Map"}: ${kind === null ? `as painted (${now?.kind || "outdoor"})` : kind === "interior" ? "🏠 interior" : "🌳 outdoor"}`
      + `${r.wrote ? "" : " (already so)"} · now ${modeSaid(now)}`);
  });
  // The explored share as the chip says it ("40%"), from the smooth memory (never the old squares).
  const shareSaid = (r) => (mapUi?.sharePct ? mapUi.sharePct(r?.explored) : "");
  const forgetMap = (row) => fogWrite(async () => {
    const cur = rowOf(row.id);
    if (!cur?.explored) return say(`${row.name || "Map"}: nothing explored to forget`, "dim");
    if (!forgetArmed || forgetArmed.id !== row.id || Date.now() - forgetArmed.at > mapUi.FORGET_ARM_MS) {
      forgetArmed = { id: row.id, at: Date.now() };
      setTimeout(() => {
        if (forgetArmed && Date.now() - forgetArmed.at >= mapUi.FORGET_ARM_MS) {
          forgetArmed = null;
          render();
        }
      }, mapUi.FORGET_ARM_MS + 100);
      return say(`${row.name || "Map"}: tap again to forget its explored memory (${shareSaid(cur)})`, "warn");
    }
    forgetArmed = null;
    const r = await mapUi.forgetExplored(OBR, row.id, sceneGrid?.dpi || 150);
    note(r.wrote ? `${row.name || "Map"}: explored memory (${shareSaid(cur)}) forgotten · what the party sees now comes back within 5 s`
      : `${row.name || "Map"}: nothing to forget (already so)`);
  });
  // The memory shade, for the whole scene (FOG_LOOK_KEY whole; every screen redraws at once).
  const setShade = (c) => fogWrite(async () => {
    const r = await mapUi.setShade(OBR, c.shade);
    note(`Memory shade: ${c.label} (${c.shade})${r.wrote ? "" : " (already so)"} · remembered ground and "clear" maps on every screen in this scene`);
  });
  const setBuilding = (row, on) => fogWrite(async () => {
    const r = await mapUi.setRemembered(OBR, row.buildingKey, on);
    await load();
    const now = rowOf(row.id);
    note(`${row.building}: ${on ? "remembered" : "forgotten"}${r.wrote ? "" : " (already so)"} · its ${r.maps} map(s) `
      + (now ? `now ${modeSaid(now)}` : on ? "stay dimmed" : "fog over"));
  });

  // The fog controls under one map's darkness chips: the mode chips, then kind / forget / remember.
  function fogMapControls(row) {
    const c = mapUi.chipsFor(row);
    const modes = document.createElement("div");
    modes.className = "chips fm";
    for (const m of c.modes) {
      const b = chip(m.label, m.on, m.title, () => setFogMode(row, m.mode));
      b.disabled = !!m.disabled; // 🌑: remembered and clear greyed ("dark map: fog only")
      modes.append(b);
    }
    const more = document.createElement("div");
    more.className = "chips fm";
    for (const k of c.kinds) more.append(chip(k.label, k.on, k.title, () => setFogKind(row, k.kind)));
    const armed = forgetArmed?.id === row.id && Date.now() - forgetArmed.at < mapUi.FORGET_ARM_MS;
    const f = chip(armed ? `Tap again: forget explored (${c.forget.pct})` : c.forget.label, false, c.forget.title, () => forgetMap(row));
    if (armed) f.className += " arm";
    f.disabled = c.forget.disabled;
    more.append(f);
    if (c.remember) more.append(chip(c.remember.label, row.remembered, c.remember.title, () => setBuilding(row, c.remember.on)));
    return [modes, more];
  }

  // The light chips for one item: None, the common kinds, the rest in a list; "auto" back when
  // it has a light by its name the DM overrode.
  function lightChips(row, { pc }) {
    const box = document.createElement("div");
    box.className = "chips";
    const cur = row.kind === "none" ? "" : row.kind || (row.eff && row.eff.from !== "spell" ? row.eff.kind : "");
    box.append(chip("None", !cur, pc ? "Carries no light" : "Put out (a prop lit by its name stays out)",
      () => write([row.id], () => ({ light: pc && !row.kind ? null : "none" }))));
    for (const k of COMMON) {
      box.append(chip(short(k), cur === k, `${SOURCES[k].label}: ${SOURCES[k].bright}/${SOURCES[k].dim} ft`,
        () => write([row.id], () => ({ light: k }))));
    }
    const rest = Object.keys(SOURCES).filter((k) => !COMMON.includes(k));
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">more…</option>` + rest.map((k) => `<option value="${k}"${cur === k ? " selected" : ""}>${esc(SOURCES[k].label)}</option>`).join("");
    sel.onchange = () => sel.value && write([row.id], () => ({ light: sel.value })).catch((e) => say(String(e?.message || e), "bad"));
    box.append(sel);
    if (!pc && row.kind && autoKind(items.find((i) => i.id === row.id))) {
      box.append(chip("↺ auto", false, "Back to the light its name gives it", () => write([row.id], () => ({ light: null }))));
    }
    return box;
  }

  function feetInput(value, placeholder, title, disabled, onset) {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = "0";
    inp.max = "1000";
    inp.step = "5";
    inp.value = value ?? "";
    inp.placeholder = placeholder;
    inp.title = title;
    inp.disabled = !!disabled;
    inp.onchange = () => {
      const raw = inp.value.trim();
      const n = raw === "" ? null : Math.round(Number(raw));
      if (n !== null && (!Number.isFinite(n) || n < 0 || n > 1000)) return say("Feet from 0 to 1000, or blank", "warn");
      onset(n).catch((e) => say(String(e?.message || e), "bad"));
    };
    return inp;
  }

  // 🌫 Our fog: the switch, the Smoke warning, and what this screen draws for it.
  function renderFog() {
    if (!el.fog) return;
    el.fog.innerHTML = "";
    if (!ready) return;
    if (!fogMod) {
      if (fogErr) el.fog.innerHTML = `<p class="bad small">🌫 Our fog didn't load: ${esc(fogErr)}</p>`;
      return;
    }
    const f = fogMod.cleanFog(sceneMeta?.[FOG_KEY]);
    const box = document.createElement("div");
    box.className = "chips";
    const arming = !f.on && Date.now() - fogArmed < 5000;
    box.append(chip(f.on ? "✓ 🌫 Our fog" : arming ? "🌫 Tap again: on for every screen" : "🌫 Our fog", f.on,
      f.on ? "Our own vision layer is on in this scene. Tap to switch it off (the scene's own fog fill comes back)"
        : "Our own vision layer (not for game night until rehearsed): party sight, walls and doors on every screen; the fog goes on in the scene's own colour",
      () => toggleFog(!f.on)));
    el.fog.append(box);
    const line = (cls, text, title = "") => {
      const p = document.createElement("p");
      p.className = `small ${cls}`;
      p.textContent = text;
      if (title) p.title = title;
      el.fog.append(p);
      return p;
    };
    if (!f.on) return line("dim", "Off: our fog draws nothing in this scene (the scene's own fog fill shows as it is).");
    // The memory shade (fog/mapui.js shadeChips; FOG_LOOK_KEY): one value for the whole scene.
    if (mapUi?.shadeChips) {
      const head = document.createElement("div");
      head.className = "small dim";
      head.textContent = "Memory shade";
      head.title = "How dark remembered ground and \"clear\" maps are drawn, on every screen in this scene (the projector too)";
      const shades = document.createElement("div");
      shades.className = "chips fm";
      for (const c of mapUi.shadeChips(sceneMeta)) shades.append(chip(c.label, c.on, c.title, () => setShade(c)));
      el.fog.append(head, shades);
    }
    // Smoke & Spectre RUNNING on this screen with its vision on: this screen's fog.js looks at Smoke's
    // own local items (its leftover sceneId or a token's hasVision never count; its local leftovers
    // after a switch-off may, until the tab reloads: fog.js SMOKE_LEFTOVERS).
    if (fogStatus?.smoke?.on) {
      line("warn", "⚠ Smoke & Spectre is running here with its vision on, so both draw fog: switch on “Disable Vision” in Smoke's settings, or switch Smoke off."
        + ` ${fogMod.SMOKE_LEFTOVERS || ""}`);
    }
    const s = fogStatus;
    if (!s) return line("dim", "This screen: waiting for the extension's status…");
    if (!s.running) return line("warn", "This copy doesn't draw here (the other copy on this tab does, or it didn't start).");
    const n = (x, k) => Number(x?.[k]) || 0;
    const a = s.answerer;
    // F4 (decision 79): door handles go only on the maps a PC stands on (fog/doors.js), so the count
    // is of the party's maps, never the scene's doors.
    line(s.error ? "warn" : "dim", `This screen: ${n(s.sight, "lights")} sight light(s) · ${n(s.walls, "walls")} wall(s)`
      + ` on ${(s.walls?.maps || []).length} map(s) · ${n(s.doors, "handles")} door handle(s) on the party's map(s)`
      + `${a ? (a.here ? " · this screen answers the players' doors" : ` · players' doors: ${a.name}`) : ""}`
      + ` · explored memory drawn on ${n(s.memory, "maps")} map(s)`
      + `${s.seen?.writer ? ` · this screen writes the explored memory (${n(s.seen, "writes")} write(s))` : ""}`
      + `${s.error ? ` · ⚠ ${s.error}` : ""}`,
    "Door handles go only on maps a PC stands on, so doors on the other maps aren't counted (or clickable) until a PC is there");
    // This device's "dnd-npc/fog-dim" test flag beats the scene's shade here (only here: the table's
    // screens follow the shade), so the DM isn't misled when a shade tap changes nothing on this screen.
    const flag = s.memory?.flag;
    if (typeof flag === "number") {
      line("warn", `This screen draws remembered ground at its own test shade ${flag} (the dnd-npc/fog-dim flag on this device),`
        + " not the scene's memory shade; the table's screens follow the shade above.");
    }
  }

  // On takes two taps (it changes every screen at once); off takes one. This device's background
  // writes the whole switch at once (fog.js setOn); with no answer in SWITCH_WAIT_MS, this box does.
  async function toggleFog(on) {
    if (!ready) return say("Open a scene first", "warn");
    if (!fogMod) return say("🌫 Our fog didn't load", "bad");
    if (on && Date.now() - fogArmed > 5000) {
      fogArmed = Date.now();
      renderFog();
      setTimeout(() => { if (Date.now() - fogArmed >= 5000) renderFog(); }, 5100);
      return;
    }
    fogArmed = 0;
    if (fogAsked) return say("🌫 Still switching…", "dim");
    if (typeof ask === "function") {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      fogAsked = { id, on, timer: setTimeout(() => switchHere(on, id), SWITCH_WAIT_MS) };
      say(on ? "🌫 Switching on…" : "🌫 Switching off…", "dim");
      ask("fog-switch", { on, id });
      return;
    }
    await switchHere(on, null);
  }

  // The background didn't answer (or there is none to ask): this box writes the switch itself.
  async function switchHere(on, id) {
    if (id && fogAsked?.id !== id) return; // answered meanwhile
    if (fogAsked) clearTimeout(fogAsked.timer);
    fogAsked = null;
    try {
      const res = await fogMod.writeSwitch(OBR, on, Date.now());
      say(on ? "🌫 Our fog is on: the fog's fill is on, every screen draws the party's sight, walls and doors"
        : `🌫 Our fog is off: ${fogMod.offWords(res?.filled ?? null)}`);
    } catch (e) {
      say(`🌫 The switch failed: ${e?.error?.message || e?.message || e}`, "bad");
    }
    await load();
    render();
  }

  // The background's answer to this box's tap (its LOCAL_STATE fog_said).
  function switched(said) {
    if (!fogAsked || !said || said.id !== fogAsked.id) return;
    clearTimeout(fogAsked.timer);
    fogAsked = null;
    say(said.text || (said.ok ? "🌫 Done" : "🌫 The switch failed"), said.ok ? "ok" : "bad");
    refresh();
  }

  function render() {
    if (!ctx) return;
    renderFog();
    // Scene
    el.scene.innerHTML = "";
    if (!ready) {
      el.scene.innerHTML = `<p class="dim small">No scene open.</p>`;
    } else {
      const l = ctx.lighting;
      const here = sceneDarkness(sceneMeta);
      const head = document.createElement("div");
      head.className = "small dim";
      head.textContent = "This scene";
      const box = document.createElement("div");
      box.className = "chips";
      for (const d of DARK_CHIPS) box.append(chip(`${d.icon} ${d.label}`, here === d.value, d.about, () => setScene({ darkness: d.value })));
      box.append(chip(l.auto ? "✓ Props light themselves" : "Props light themselves", l.auto,
        "Sconces, torches, braziers, candles, lanterns and lamps light by their name or picture",
        () => setScene({ auto: !l.auto })));
      el.scene.append(head, box);
      // Maps here: each MAP-layer image's own darkness (a 🌑 cellar inside a ☀ town scene)
      const maps = items.filter(isMap);
      if (maps.length) {
        const mh = document.createElement("div");
        mh.className = "small dim";
        mh.textContent = "Maps here";
        el.scene.append(mh);
        const fogRows = new Map(mapRowsNow().map((r) => [r.id, r])); // 🌫 on: each map's memory facts
        for (const m of maps) {
          const own = mapDarkness(m);
          const fr = fogRows.get(m.id);
          const row = document.createElement("div");
          row.className = "row";
          const tags = fr ? [fr.kind === "interior" ? `🏠${fr.building ? ` ${fr.building}` : ""}` : "🌳 outdoor",
            fr.remembered && "remembered", fr.darkLocked && "🌑 fog only", fr.hidden && "hidden: nothing drawn"].filter(Boolean) : [];
          row.innerHTML = `<span class="who">${esc(m.name || "Map")}</span>${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}`;
          const chips = document.createElement("div");
          chips.className = "chips";
          for (const d of DARK_CHIPS) chips.append(chip(`${d.icon}`, own === d.value, `${d.label}: ${d.about}`, () => setMap(m.id, d.value)));
          chips.append(chip("as scene", !own, "Follow the scene's darkness", () => setMap(m.id, null)));
          row.append(chips);
          if (fr) row.append(...fogMapControls(fr));
          el.scene.append(row);
        }
      }
      if (!l.managed) {
        const p = document.createElement("p");
        p.className = "warn small";
        p.textContent = "Released to Smoke: Smoke draws vision and darkvision here (our flames still show). Any control here takes it back.";
        el.scene.append(p);
      }
    }
    // Not while the DM is typing feet or picking from a list (tokens moving redraw often): once they leave it.
    const active = document.activeElement;
    if (active && /^(INPUT|SELECT)$/.test(active.tagName) && (el.pcs.contains(active) || el.lit.contains(active))) {
      active.onblur = () => setTimeout(refresh, 0);
      renderScreens();
      return;
    }
    const { pcs, lit } = lightingRows(items, ctx);
    // PCs
    el.pcs.innerHTML = "";
    if (ready && !pcs.length) {
      el.pcs.innerHTML = `<p class="warn small">No PC tokens in this scene. Name a token after its PC, or right-click → 🗺 This is…</p>`;
    }
    for (const p of pcs) {
      const row = document.createElement("div");
      row.className = "row";
      // On 🌑 ground "sees" is how far the fog opens for it (darkvision, its own light, or the far edge of
      // a light on its own map; fx/lightmeta.js seerReachFt); DARK_SEES_TITLE says what that leaves open.
      const seesTitle = p.where === "dark" ? ` title="${esc(DARK_SEES_TITLE)}"` : "";
      row.innerHTML = `<span class="who">${esc(p.name)}</span><span class="tag"${seesTitle}>sees ${p.seesFt >= 1000 ? "all" : `${p.seesFt} ft`}`
        + `${p.darkFt ? ` · darkvision ${p.darkFt} ft` : ""}</span>`;
      const f = document.createElement("div");
      f.className = "fields";
      const sightL = document.createElement("label");
      sightL.append("Sight limit", feetInput(p.sight, "none",
        "Blank = no limit (it sees by line of sight where it's lit). A number: how far it sees at most (fog, mist)", false,
        (n) => write([p.id], () => ({ vision: { sight: n } }))));
      const darkL = document.createElement("label");
      darkL.append("Darkvision", feetInput(p.dark, p.sheetDark != null ? String(p.sheetDark) : "0",
        p.sheetDark != null ? `Blank = the sheet's ${p.sheetDark} ft` : "Blank = none (the sheet's isn't known here)", false,
        (n) => write([p.id], () => ({ vision: { dark: n } }))));
      f.append(sightL, darkL);
      row.append(f, lightChips(p, { pc: true }));
      el.pcs.append(row);
    }
    // Lit objects
    el.lit.innerHTML = lit.length ? "" : (ready ? `<p class="dim small">No lit objects. Right-click one → 🔥 Light.</p>` : "");
    for (const o of lit) {
      const row = document.createElement("div");
      row.className = "row";
      const tags = [o.auto && "auto", o.smoke && "Smoke torch", o.spell && "✨ spell", o.hidden && "hidden", o.kind === "none" && "put out"]
        .filter(Boolean);
      row.innerHTML = `<span class="who">${esc(o.name)}</span>${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}`;
      row.append(lightChips(o, { pc: false }));
      el.lit.append(row);
    }
    renderScreens();
  }

  function renderScreens() {
    if (!screens) {
      el.screens.innerHTML = `<p class="dim small">Listening for screens…</p>`;
      return;
    }
    const warn = screenWarnings(screens, { ref: myBuild });
    // This copy's lights writer (fx/lightwriter.js): who writes Smoke's keys, or why nobody does.
    const w = writer && writer.state && writer.state !== "off"
      ? `<div class="small ${writer.state === "leader" ? "ok" : writer.state === "blocked" ? "bad" : "dim"}">✍ Lights writer here: `
        + `${esc(writer.state === "leader" ? "this tab writes the lights" : writer.state)}${writer.why ? ` — ${esc(writer.why)}` : ""}</div>` : "";
    el.screens.innerHTML = screens.map((s) => `<div class="small">${esc(screenLine(s))}</div>`).join("") + w
      + warn.map((w) => `<div class="small warn">⚠ ${esc(w)}</div>`).join("");
  }

  // "Release lights to Smoke": the scene is marked released FIRST (managed false: the writer and
  // every 🔥 write stop writing Smoke's keys here, and the screens stop drawing our darkvision),
  // then every token we manage goes back to plain Smoke and our carriers go. Any control above
  // takes the scene back.
  el.release.onclick = async () => {
    await load();
    if (!ready) return say("Open a scene first", "warn");
    const list = managed(items), kids = carriers(items);
    const wasManaged = lightingOf(sceneMeta).managed;
    if (!list.length && !kids.length && !wasManaged) return say("This scene's lights are Smoke's already", "dim");
    if (Date.now() - armed > 5000) {
      armed = Date.now();
      el.release.textContent = `Really release ${list.length} token(s)? Tap again`;
      setTimeout(() => { if (Date.now() - armed >= 5000) el.release.textContent = "Release lights to Smoke"; }, 5100);
      return;
    }
    armed = 0;
    el.release.textContent = "Release lights to Smoke";
    await OBR.scene.setMetadata({ [SCENE_LIGHTING_KEY]: { ...curLighting(), managed: false } });
    const plans = new Map();
    for (const i of list) {
      const next = releaseItem(i, ctx);
      if (next) plans.set(i.id, { before: i.metadata || {}, after: next });
    }
    if (plans.size) {
      await OBR.scene.items.updateItems([...plans.keys()], (drafts) => {
        for (const d of drafts) {
          const p = plans.get(d.id);
          if (p) applyMeta(d, p.before, p.after);
        }
      });
    }
    if (kids.length) await OBR.scene.items.deleteItems(kids.map((i) => i.id));
    say(`Released ${plans.size} token(s) to Smoke & Spectre (their sight and darkvision are in Smoke's own panel now;`
      + " flames still show; any control above takes the scene back)");
    await load();
    render();
  };

  // Redraw on any change (one at a time; one more after a change meanwhile).
  let busy = false, again = false;
  async function refresh() {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        await load();
        render();
      } while (again);
    } catch (e) {
      console.warn("dnd-npc: 🔥 Lighting", e);
    } finally {
      busy = false;
    }
  }

  import("./fog/fog.js?v=af4de9c").then((m) => { fogMod = m; render(); }, (e) => { fogErr = String(e?.message || e); renderFog(); });
  import("./fog/mapui.js?v=af4de9c").then((m) => { mapUi = m; render(); }, (e) => console.warn("dnd-npc: 🌫 map controls", e));
  OBR.scene.items.onChange(() => refresh());
  OBR.scene.onMetadataChange?.(() => refresh());
  OBR.scene.onReadyChange?.(() => refresh());
  OBR.room.onMetadataChange?.(() => refresh());
  refresh();

  return {
    refresh,
    // The background's snapshot (LOCAL_STATE): the screens its bridge.js heard.
    state(s) {
      if (s?.build) myBuild = s.build;
      if (s?.fog_said) switched(s.fog_said);
      if (s && "fog" in s) {
        const sig = JSON.stringify(s.fog ?? null);
        if (sig !== renderFog.sig) {
          renderFog.sig = sig;
          fogStatus = s.fog ?? null;
          renderFog();
        }
      }
      if (Array.isArray(s?.pc_tokens)) pcIds = s.pc_tokens.map(String);
      if (!Array.isArray(s?.bridge?.screen_list)) return;
      writer = s.writer && typeof s.writer === "object" ? { state: s.writer.state, why: s.writer.why || s.writer.error || "" } : null;
      const sig = JSON.stringify([s.bridge.screen_list.map(({ at, ...x }) => x), writer]);
      if (sig === renderScreens.sig) return;
      renderScreens.sig = sig;
      screens = s.bridge.screen_list;
      renderScreens();
    },
  };
}
