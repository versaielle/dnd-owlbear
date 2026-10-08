// "🔥 Lighting" in the GM's 🗺 DND NPC box (popover.html): the one place to set up the lights of
// the scene, with no panel needed (tools/owlbear_only.py is enough). Lights redo,
// docs/lights-redo-spec.md.
//
//   Scene        "This scene" ☀ lit / 🌒 dim / 🌑 dark (SCENE_LIGHTING_KEY.darkness; unmarked = ☀) and
//                "Props light themselves" (.auto: a sconce, torch, brazier, candle… by name/picture);
//                "Maps here": each MAP-layer image ☀/🌒/🌑/as scene (MAP_DARKNESS_KEY on it;
//                docs/lights-darkness-spec.md: darkness comes from light, per point)
//   PCs          each PC token in the scene: its sight limit (blank = none: fog, mist), its
//                darkvision (blank = the sheet's, shown greyed), its light (chips)
//   Lit objects  everything else with a light (incl. the ones lit by their name: "auto"), chips + None
//   Screens      the screens this GM copy heard (kind, build, lights) and what to do about them
//   Release      gives every token we manage back to plain Smoke & Spectre (two taps)
//
// Every change goes through lightmeta.js's setLight / setVision, then planItem for Smoke's keys
// with the lights writer's own ctx, in one write (fx/lightwriter.js writeNow): the writer's next
// pass plans nothing more. Any control here that changes an input takes a scene released to
// Smoke back (SCENE_LIGHTING_KEY.managed true); "Release lights to Smoke" sets it false.
import { MAP_DARKNESS_KEY, PARTY_KEY, SCENE_LIGHTING_KEY } from "./keys.js?v=585985a-dc1dbb6";
import { SOURCES } from "./fx/lights.js?v=585985a-dc1dbb6";
import { isMap, mapDarkness, readGrid, sceneDarkness } from "./fx/darkness.js?v=585985a-dc1dbb6";
import { writeNow } from "./fx/lightwriter.js?v=585985a-dc1dbb6";
import { cleanParty } from "./gather.js?v=585985a-dc1dbb6";
import { DARKNESS, applyMeta, autoKind, carriers, describe, editFor, lightingOf, lightingRows, managed, releaseItem,
         screenLine, screenWarnings, uiCtx } from "./lightui.js?v=585985a-dc1dbb6";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const COMMON = ["candle", "torch", "lamp", "hooded_lantern", "brazier"].filter((k) => SOURCES[k]);
// Darkness comes from light (docs/lights-darkness-spec.md): the scene's, and each map's own
// (lightui.js DARKNESS: the same words as the 🔥 menu).
const DARK_CHIPS = DARKNESS;
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
  #lt-said { min-height: 15px; margin: 4px 0; }
`;

// el: {scene, pcs, lit, screens, said, release} elements; OBR: the SDK.
export function startLighting(OBR, el, { build = "" } = {}) {
  let ctx = null, items = [], sceneMeta = {}, roomMeta = {}, ready = false;
  let screens = null, myBuild = build, armed = 0, writer = null;
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

  async function setScene(patch) {
    if (!ready) return say("Open a scene first", "warn");
    const cur = curLighting();
    const next = { ...cur, ...patch, managed: true };
    await OBR.scene.setMetadata({ [SCENE_LIGHTING_KEY]: next });
    const n = await replanAll();
    const d = DARK_CHIPS.find((x) => x.value === next.darkness);
    say(`${d.icon} Scene ${d.label}${"auto" in patch ? ` · props ${next.auto ? "light themselves" : "stay as you set them"}` : ""}`
      + (n ? ` · ${n} token(s) updated` : "") + (cur.managed ? "" : " · lights are ours again in this scene"));
    render();
  }

  // One map's own darkness: "lit" | "dim" | "dark", or null (as the scene: the key goes). Then
  // every token's Smoke keys at once (a seer's range depends on where it stands).
  async function setMap(id, code) {
    if (!ready) return say("Open a scene first", "warn");
    await OBR.scene.items.updateItems([id], (drafts) => {
      for (const d of drafts) {
        d.metadata = d.metadata || {};
        if (code) d.metadata[MAP_DARKNESS_KEY] = code;
        else delete d.metadata[MAP_DARKNESS_KEY];
      }
    });
    await load();
    const back = await takeBack();
    const n = await replanAll();
    const m = items.find((i) => i.id === id);
    const d = DARK_CHIPS.find((x) => x.value === code);
    say(`${m?.name || "Map"}: ${d ? `${d.icon} ${d.label}` : "as the scene"}${n ? ` · ${n} token(s) updated` : ""}${back ? " · lights are ours again in this scene" : ""}`);
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

  function render() {
    if (!ctx) return;
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
        for (const m of maps) {
          const own = mapDarkness(m);
          const row = document.createElement("div");
          row.className = "row";
          row.innerHTML = `<span class="who">${esc(m.name || "Map")}</span>`;
          const chips = document.createElement("div");
          chips.className = "chips";
          for (const d of DARK_CHIPS) chips.append(chip(`${d.icon}`, own === d.value, `${d.label}: ${d.about}`, () => setMap(m.id, d.value)));
          chips.append(chip("as scene", !own, "Follow the scene's darkness", () => setMap(m.id, null)));
          row.append(chips);
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
      row.innerHTML = `<span class="who">${esc(p.name)}</span><span class="tag">sees ${p.seesFt >= 1000 ? "all" : `${p.seesFt} ft`}`
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
