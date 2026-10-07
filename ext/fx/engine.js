// The FX engine: draws an FxEvent (built by fx_events.py on the panel) on this screen, with
// LOCAL items only (OBR.scene.local), so nothing it draws is saved in the room or seen by
// another screen, and nothing fires scene.items.onChange. Every screen runs its own copy: the
// Dell's bridge tab, the laptop, the Cast receiver, the phones.
//
//   const fx = createFx(api, {role, kind, isPublic, log, quality});
//   fx.play(event, {gmDelta})   never rejects; resolves to the number of parts scheduled
//   fx.setSettings(settings)    the panel's ✨ Effects settings (style, quality per kind, shake...)
//   fx.warm()                   compile every shader once, invisibly (on scene ready)
//   fx.clear()                  take everything off this screen
//   fx.clear({stop: true})      ...and stop decorating zones here until zones.start() again
//                               (a copy of the extension that only relays: nothing comes back)
//   fx.zones                    {sync(specs) (bridge only), reconcile(), start(), stop()}
//
// What it keeps to (spec section 11): one-shot effects are STANDALONE effects placed at the
// token's footprint when the event starts (no attaching, so a hidden parent can't hide them);
// a part anchored on a token this screen may not show is skipped (the second guard after the
// panel's own split); ONE 30 Hz timer moves every live effect's progress in ONE batched update;
// every item is deleted at its deadline whatever happened to its add or updates, and a sweep
// catches anything left behind; a screen never has more than 12 live effects (6 in lite).
import { ALIASES, ARCHETYPES, PALETTE, SPEC, TIMING, colors, defaultDur, defaultHit, hostFor, maxDur, uniformValues } from "./archetypes.js?v=07c06cc";
import { fallbackItem } from "./fallback.js?v=07c06cc";
import { numberItem } from "./numbers.js?v=07c06cc";
import { finite, footprint, fromBounds, gridOf, rotate } from "./place.js?v=07c06cc";
import { customUniforms, fillUniforms, shaderFor } from "./shaders.js?v=07c06cc";
import { createZones, setZoneBuilder } from "./zones.js?v=07c06cc";

export const FX_KEY = "dnd-npc/fx"; // on every one-shot item: {until} (wall-clock ms), for the sweep
export const CAP = { full: 12, lite: 6 };
const TICK_MS = 33;
const SWEEP_MS = 10000;
const GRACE_MS = 150;
const MAX_PARTS = 32;
const MAX_BEAMS = 4;
const FX_Z = 3e12; // above rings and badges on the ATTACHMENT layer (auto z-indexes are timestamps)

export const DEFAULT_SETTINGS = {
  fx: true, style: "shader", uniform_path: "normal", zones: true, shake: true, delay_ms: 0,
  quality: { gm: "full", table: "full", touch: "lite", other: "full" },
};

const TIERS = ["full", "lite", "off"];
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

function defaultClock() {
  const perf = globalThis.performance;
  return {
    now: () => (perf ? perf.now() : Date.now()),
    wall: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (f, ms) => setInterval(f, ms),
    clearInterval: (h) => clearInterval(h),
  };
}

// The FxEvent this screen plays: the public event plus, on a GM screen, the GM-only parts.
export function mergeEvents(pub, gm) {
  const a = pub && typeof pub === "object" ? pub : null;
  const b = gm && typeof gm === "object" ? gm : null;
  if (!a && !b) return null;
  if (!b) return a;
  if (!a) return b;
  return {
    ...a,
    template: b.template || a.template || null,
    pcs: [...new Set([...(a.pcs || []), ...(b.pcs || [])])],
    parts: [...(a.parts || []), ...(b.parts || [])],
    dur_ms: Math.max(a.dur_ms || 0, b.dur_ms || 0),
  };
}

export function createFx(api = {}, ctx = {}) {
  const clock = api.clock || defaultClock();
  const log = typeof ctx.log === "function" ? ctx.log : (...a) => console.log(...a);
  // each message at most once every 10 s, so a failing update at 30 Hz can't flood the console
  const warned = new Map();
  const warn = (msg, err) => {
    const key = String(msg);
    const t = clock.now();
    if (warned.has(key) && t - warned.get(key) < 10000) return;
    warned.set(key, t);
    try { console.warn(msg, err || ""); } catch (e) { /* no console */ }
    try { log(err ? `${msg}: ${err?.message || err}` : msg); } catch (e) { /* ignore */ }
  };
  let settings = { ...DEFAULT_SETTINGS, quality: { ...DEFAULT_SETTINGS.quality } };
  let palette = PALETTE;
  let timing = TIMING;
  let lastError = null;

  // ---- the Owlbear API: injected (the bridge passes the one it already loaded), or loaded here.
  // A literal path, so the Pages publisher stamps it with the same ?v= as background.js's own
  // import: both then resolve to the one SDK module (two stamps would load the SDK twice).
  let full = null;
  const ready = (async () => {
    const need = ["buildEffect", "buildShape", "buildText"];
    if (api.OBR && need.every((k) => typeof api[k] === "function")) return api;
    const sdk = await import("../obr-sdk.js?v=07c06cc");
    return { OBR: sdk.default, buildEffect: sdk.buildEffect, buildShape: sdk.buildShape, buildText: sdk.buildText,
      buildLabel: sdk.buildLabel, buildImage: sdk.buildImage, Math2: sdk.Math2, MathM: sdk.MathM, ...api };
  })().then((a) => {
    full = a;
    setZoneBuilder(a.buildShape); // so zoneItem() with no builder of its own makes a real item
    return a;
  });
  const getApi = () => ready;

  // palette.json and timing.json sit next to this file; the built-in copies stand in until
  // (or unless) they load.
  const loadJson = api.loadJson || (async (url) => {
    const r = await fetch(url);
    return r.ok ? r.json() : null;
  });
  (async () => {
    try { const p = await loadJson(new URL("./palette.json?v=07c06cc", import.meta.url).href); if (p && typeof p === "object") palette = { ...PALETTE, ...p }; } catch (e) { /* built-in copy */ }
    try { const t = await loadJson(new URL("./timing.json?v=07c06cc", import.meta.url).href); if (t && typeof t === "object") timing = { ...TIMING, ...t }; } catch (e) { /* built-in copy */ }
  })();

  const val = (v) => (typeof v === "function" ? v() : v);
  const role = () => val(ctx.role) || "PLAYER";
  const kind = () => val(ctx.kind) || (role() === "GM" ? "gm" : "other");
  const style = () => (settings.fx === false ? "off" : settings.style || "shader");
  // This screen's tier: ctx.quality (this device's own choice) when set, else what the extension
  // worked out and passed in the settings (quality_override: the popover's choice; tier: that or
  // the panel's quality for this kind of screen, and "off" on a copy that only relays), else the
  // panel's quality for this kind.
  function tier() {
    if (settings.fx === false || style() === "off") return "off";
    let o = null;
    try { o = typeof ctx.quality === "function" ? ctx.quality() : ctx.quality; } catch (e) { o = null; }
    if (TIERS.includes(o)) return o;
    if (TIERS.includes(settings.quality_override)) return settings.quality_override;
    if (TIERS.includes(settings.tier)) return settings.tier;
    const q = settings.quality?.[kind()];
    return TIERS.includes(q) ? q : "full";
  }

  // ---- live items and the one ticker ----
  const live = new Map(); // item id -> entry
  const timers = new Set();
  let ticker = null;
  let pending = false;
  let pendingSince = 0;
  let generation = 0;
  let zIndex = FX_Z;

  function later(fn, ms) {
    const h = clock.setTimeout(() => { timers.delete(h); fn(); }, Math.max(0, ms));
    timers.add(h);
    return h;
  }

  function ensureTicker() {
    if (ticker == null) ticker = clock.setInterval(tick, TICK_MS);
  }

  function stopTicker() {
    if (ticker != null) clock.clearInterval(ticker);
    ticker = null;
  }

  function tick() {
    const now = clock.now();
    // skip a tick while the last update is still on its way (but never wait on a lost one forever)
    if (pending && now - pendingSince < 1000) return;
    const due = [];
    let anyTicking = false;
    for (const e of live.values()) {
      if (!e.ticking) continue;
      anyTicking = true;
      if (!e.added) continue;
      if (e.every && now - e.last < e.every) continue;
      due.push(e);
    }
    if (!anyTicking) { stopTicker(); return; }
    if (!due.length || !full) return;
    pending = true;
    pendingSince = now;
    const byId = new Map(due.map((e) => [e.id, e]));
    let p;
    try {
      p = full.OBR.scene.local.updateItems(due.map((e) => e.item), (drafts) => {
        for (const d of drafts) {
          const e = byId.get(d.id);
          if (!e) continue;
          e.last = now;
          try { e.frame(d, now); } catch (err) { warn("fx: frame failed", err); }
        }
      }, settings.uniform_path === "fast");
    } catch (err) {
      p = Promise.reject(err);
    }
    Promise.resolve(p).catch((err) => warn("fx: update failed", err)).finally(() => { pending = false; });
  }

  function remove(id) {
    const e = live.get(id);
    live.delete(id);
    if (e?.kind === "zone") return; // the outline's deletion takes its decoration with it
    if (!full) return;
    Promise.resolve().then(() => full.OBR.scene.local.deleteItems([id])).catch((err) => warn("fx: delete failed", err));
  }

  function track(entry) {
    const had = live.get(entry.id);
    live.set(entry.id, { ...entry, added: entry.added ?? had?.added ?? true });
    ensureTicker();
  }
  function untrack(id) {
    const e = live.get(id);
    if (e) e.ticking = false;
    if (e?.kind === "zone") live.delete(id);
  }

  const countsToCap = (e) => e.kind === "fx" || e.kind === "shape";

  // Room for one more effect: true, or false to skip it. Over the cap the most expendable
  // older effect goes first (sparkle, then resist, then impacts...), never one that matters more.
  function makeRoom(entry) {
    if (!countsToCap(entry)) return true;
    const cap = CAP[tier()] || CAP.full;
    const effects = [...live.values()].filter(countsToCap);
    if (effects.length < cap) return true;
    let victim = null;
    for (const e of effects) {
      if (e.rank >= entry.rank) continue;
      if (!victim || e.rank < victim.rank || (e.rank === victim.rank && e.t0 < victim.t0)) victim = e;
    }
    if (!victim) return false;
    remove(victim.id);
    return true;
  }

  // ---- the sweep: anything of ours whose deadline has passed ----
  async function sweep() {
    try {
      const a = await getApi();
      const now = clock.wall();
      const old = await a.OBR.scene.local.getItems((i) => {
        const m = i.metadata?.[FX_KEY];
        return !!m && typeof m.until === "number" && m.until < now;
      });
      const ids = old.map((i) => i.id).filter((id) => !live.has(id) || !live.get(id).ticking);
      for (const id of ids) live.delete(id);
      if (ids.length) await a.OBR.scene.local.deleteItems(ids);
    } catch (e) { /* the scene isn't ready */ }
  }
  later(sweep, 0);
  const sweeper = clock.setInterval(sweep, SWEEP_MS);

  // ---- anchors ----
  async function gridNow(a) {
    const dpi = await a.OBR.scene.grid.getDpi();
    let mult = null;
    try { mult = (await a.OBR.scene.grid.getScale())?.parsed?.multiplier; } catch (e) { /* default 5 ft */ }
    return gridOf(dpi, mult);
  }

  function anchorIds(ev) {
    const ids = new Set();
    for (const p of ev.parts || []) {
      for (const k of ["at", "from", "to"]) if (p?.[k]?.token) ids.add(String(p[k].token));
    }
    if (ev.template?.caster_token) ids.add(String(ev.template.caster_token));
    return [...ids];
  }

  async function resolveAll(a, ev, G) {
    const ids = anchorIds(ev);
    const items = new Map();
    if (ids.length) for (const it of await a.OBR.scene.items.getItems(ids)) items.set(it.id, it);
    const feet = new Map();
    for (const [id, it] of items) {
      let fp = footprint(it, G.dpi);
      if (!fp) {
        try { fp = fromBounds(await a.OBR.scene.items.getItemBounds([id])); } catch (e) { fp = null; }
      }
      if (!fp && it.position) fp = { x: it.position.x, y: it.position.y, w: G.dpi, h: G.dpi };
      if (fp) feet.set(id, fp);
    }
    let view = null;
    const wantsView = (ev.parts || []).some((p) => ["at", "from", "to"].some((k) => p?.[k]?.view)) || ev.template?.origin?.view;
    if (wantsView) {
      try {
        const w = await a.OBR.viewport.getWidth(), h = await a.OBR.viewport.getHeight();
        view = await a.OBR.viewport.inverseTransformPoint({ x: w / 2, y: h / 2 });
      } catch (e) { view = null; }
    }
    return { items, feet, view };
  }

  // ---- play ----
  // The parts already played, per event (its id and seed: Python's "fx-N" counter starts again
  // when the agent restarts, but each event gets a new random seed), for a minute.
  const seen = new Map(); // "id|seed" -> {at, keys:Set}

  async function playInner(event, opts) {
    const ev = mergeEvents(event, opts?.gmDelta);
    if (!ev || !Array.isArray(ev.parts) || (ev.v != null && ev.v !== 1)) return 0;
    const t = tier();
    if (t === "off") return 0;
    const shapes = style() === "shape";
    const gm = role() === "GM";
    const startAt = clock.now() + (Number(settings.delay_ms) || 0);
    const gen = generation;

    // which parts this screen draws, each once (a sample, the popover's test, every time it's pressed)
    const now = clock.wall();
    for (const [k, v] of seen) if (now - v.at > 60000) seen.delete(k);
    const test = String(ev.id ?? "").startsWith("sample-");
    const evKey = ev.id != null && !test ? `${ev.id}|${ev.seed ?? ""}` : null;
    const done = evKey ? (seen.get(evKey) || { at: now, keys: new Set() }) : { keys: new Set() };
    if (evKey) seen.set(evKey, done);
    const table = kind() === "table" && settings.shake !== false;
    const parts = [];
    for (const raw of ev.parts.slice(0, MAX_PARTS)) {
      if (!raw || typeof raw !== "object") continue;
      const arch = ALIASES[raw.arch] || raw.arch;
      if (!ARCHETYPES.includes(arch)) { warn(`fx: unknown archetype ${raw.arch}`); continue; }
      if (raw.big_only && !table) continue;
      if (shapes && (arch === "flash" || arch === "shake")) continue;
      const key = stable(raw);
      if (done.keys.has(key)) continue;
      done.keys.add(key);
      parts.push({ raw, arch });
    }
    if (!parts.length) return 0;

    const a = await getApi();
    const G = await gridNow(a);
    const { items, feet, view } = await resolveAll(a, ev, G);
    const pcs = new Set((ev.pcs || []).map(String));
    const isPublic = (id) => {
      if (gm) return true;
      const it = items.get(id);
      if (!it) return false;
      if (it.visible !== false || pcs.has(id)) return true;
      try { return !!ctx.isPublic?.(id, it); } catch (e) { return false; }
    };
    const point = (p, off) => (p && finite(p.x, p.y)
      ? { x: p.x + (off?.x || 0) * G.dpi, y: p.y + (off?.y || 0) * G.dpi, w: 0, h: 0 } : null);
    // the template, with its origin resolved and the caster's footprint (an emanation grows by it).
    // R2's second guard: a template centred on a caster this screen may not show (an emanation,
    // or any shape cast from:self) isn't drawn at all; fx_events.split() should have dropped it.
    let templ = null;
    if (ev.template && typeof ev.template === "object") {
      const o = ev.template.origin;
      const origin = o?.view ? point(view, o.off) : point(o);
      if (origin) {
        const ct = ev.template.caster_token != null ? String(ev.template.caster_token) : null;
        const casterShown = !ct || isPublic(ct);
        const onCaster = ev.template.from === "self" || ev.template.shape === "emanation";
        if (casterShown || !onCaster) {
          templ = { ...ev.template, origin, casterFp: ct && casterShown ? feet.get(ct) || null : null };
        }
      }
    }
    // an anchor -> footprint {x, y, w, h}; null when missing; "blocked" when not for this screen
    function anchor(an) {
      if (!an || typeof an !== "object") return null;
      if (an.token != null) {
        const id = String(an.token);
        if (!isPublic(id)) return "blocked";
        const fp = feet.get(id);
        return fp ? { ...fp, id, x: fp.x + (an.off?.x || 0) * G.dpi, y: fp.y + (an.off?.y || 0) * G.dpi } : null;
      }
      if (an.point) return point(an.point, an.off);
      if (an.template) return templ ? point(templ.origin, an.off) : null;
      if (an.view) return point(view, an.off);
      return null;
    }
    // where a blow came from: the travel part that ends on this token, if any
    const travelFrom = new Map();
    for (const { raw, arch } of parts) {
      if (["bolt", "ray", "arrow"].includes(arch) && raw.to?.token != null && raw.from) travelFrom.set(String(raw.to.token), raw.from);
    }

    const seed0 = Number.isFinite(ev.seed) ? ev.seed : 1;
    const plan = [];
    parts.forEach(({ raw, arch }, i) => {
      const at = anchor(raw.at), from = anchor(raw.from), to = anchor(raw.to);
      if (at === "blocked" || from === "blocked" || to === "blocked") return;
      // a part whose anchor is missing here is skipped (a travel part needs both of its ends)
      if (raw.at && !at) return;
      if (["bolt", "ray", "arrow"].includes(arch) && (!from || !to)) return;
      const src = !from && raw.at?.token != null && travelFrom.has(String(raw.at.token)) ? anchor(travelFrom.get(String(raw.at.token))) : null;
      const anchors = { at, from: from || (src !== "blocked" ? src : null), to, template: templ };
      const part = { ...raw, _seed: seed0 + i * 1.37, _look: raw.arch };
      // never longer than the archetype allows (a screen shake 0.4 s at most), whatever the event says
      const dur = Math.min(finite(part.dur) && part.dur > 0 ? part.dur : defaultDur(arch, timing), maxDur(arch));
      const start = finite(part.start) && part.start >= 0 ? Math.min(part.start, 20000) : 0;
      if (arch === "number") {
        const fp = at && at !== "blocked" ? at : null;
        if (!fp) return;
        plan.push({ kind: "number", arch, part, start, dur: finite(raw.dur) ? dur : timing.number?.dur || 900, rank: 9, fp, tokenId: raw.at?.token });
        return;
      }
      const beams = arch === "ray" ? Math.max(1, Math.min(MAX_BEAMS, Math.round(Number(raw.params?.hits) || 1))) : 1;
      for (let b = 0; b < beams; b++) {
        plan.push({ kind: "fx", arch, part, anchors, start: start + b * (timing.ray?.stagger || 120), dur,
          rank: SPEC[arch]?.rank ?? 5, beam: beams > 1 ? b - (beams - 1) / 2 : 0, seed: seed0 + i * 1.37 + b * 0.71 });
      }
    });
    if (!plan.length) return 0;

    for (const entry of plan) later(() => { if (gen === generation) begin(entry, G, t, shapes, ev); }, startAt + entry.start - clock.now());
    return plan.length;
  }

  function effectBuilt(entry, G, t) {
    const { arch, part, anchors } = entry;
    const host = hostFor(arch, part, anchors, G);
    if (!host) return null;
    if (entry.beam && !host.viewport) {
      const off = rotate({ x: 0, y: entry.beam * G.dpi * 0.14 }, host.rot || 0);
      host.position = { x: host.position.x + off.x, y: host.position.y + off.y };
    }
    const spec = SPEC[arch] || {};
    const col = colors(part.color || spec.color, palette);
    const sksl = shaderFor(arch, t);
    if (!sksl) return null;
    const decl = customUniforms(sksl);
    const effects = [...live.values()].filter(countsToCap).length;
    const extra = {
      fade: 1, colA: col.colA, colB: col.colB, seed: ((entry.seed % 97) + 97) % 97,
      power: finite(part.power) ? Math.max(0.3, Math.min(2, part.power)) : 1,
      hit: finite(part.hit) ? part.hit : defaultHit(arch, timing),
    };
    if (arch === "death" && (t === "lite" || effects >= (CAP[t] || 12) - 2)) extra.smoke = 0;
    if (arch === "sparkle" && t === "lite") extra.dens = 0.5;
    const values = (p) => uniformValues(arch, part, host.uniforms, { ...extra, progress: p });
    const until = clock.wall() + entry.dur + GRACE_MS + 500;
    let b = full.buildEffect()
      .effectType(host.viewport ? "VIEWPORT" : "STANDALONE")
      .sksl(sksl)
      .uniforms(fillUniforms(decl, values(0), warn))
      .layer(spec.layer || "ATTACHMENT")
      .locked(true)
      .disableHit(true)
      .disableAutoZIndex(true)
      .zIndex(zIndex++)
      .name(`dnd-npc fx ${arch}`)
      .metadata({ [FX_KEY]: { until } });
    if (!host.viewport) {
      if (!finite(host.w, host.h, host.position.x, host.position.y) || host.w <= 0 || host.h <= 0) return null;
      b = b.width(Math.min(host.w, 40000)).height(Math.min(host.h, 40000)).position(host.position).rotation(host.rot || 0);
    }
    const item = b.build();
    return { item, frame: (d, p) => { d.uniforms = fillUniforms(decl, values(p)); } };
  }

  function shapeBuilt(entry, G) {
    const { arch, part, anchors } = entry;
    const host = hostFor(arch, part, anchors, G);
    const col = colors(part.color || SPEC[arch]?.color, palette);
    const until = clock.wall() + entry.dur + GRACE_MS + 500;
    return fallbackItem(full, arch, { ...part, hit: finite(part.hit) ? part.hit : defaultHit(arch, timing) }, anchors, host, G, col.hexA,
                        { z: zIndex++, metadata: { [FX_KEY]: { until } } });
  }

  function begin(entry, G, t, shapes, ev) {
    if (!full) return;
    let built = null, kind = entry.kind;
    try {
      if (entry.kind === "number") {
        const stack = [...live.values()].filter((e) => e.kind === "number" && e.tokenId != null && e.tokenId === entry.tokenId).length;
        built = numberItem(full, entry.part, entry.fp, G, { stack, until: clock.wall() + entry.dur + GRACE_MS + 500, key: FX_KEY, z: zIndex++ });
      } else if (shapes) {
        built = shapeBuilt(entry, G);
        kind = "shape";
      } else {
        built = effectBuilt(entry, G, t);
      }
    } catch (err) {
      warn(`fx: ${entry.arch} could not be built, using a shape`, err);
      lastError = String(err?.message || err);
      try { built = shapeBuilt(entry, G); kind = "shape"; } catch (e2) { built = null; }
    }
    if (!built?.item) return;
    const e = { id: built.item.id, item: built.item, kind, arch: entry.arch, rank: entry.rank, tokenId: entry.tokenId,
      t0: clock.now(), dur: entry.dur, ticking: true, added: false, every: 0, last: 0 };
    if (!makeRoom(e)) { warn(`fx: over the live-effect budget, skipped ${entry.arch}`); return; }
    e.frame = (d, now) => built.frame(d, Math.min(1, Math.max(0, (now - e.t0) / e.dur)));
    live.set(e.id, e);
    ensureTicker();
    // the deadline is armed first, so the item goes whatever happens to its add or updates
    later(() => remove(e.id), e.dur + GRACE_MS);
    Promise.resolve()
      .then(() => full.OBR.scene.local.addItems([e.item]))
      .then(() => { e.added = true; })
      .catch((err) => { lastError = String(err?.message || err); warn("fx: add failed", err); });
  }

  async function play(event, opts = {}) {
    try {
      return await playInner(event, opts || {});
    } catch (err) {
      lastError = String(err?.message || err);
      warn("fx: play failed", err);
      return 0;
    }
  }

  // Compile every shader this screen may use, invisibly: each as a small effect at fade 0 in the
  // middle of the view, 50 ms apart, gone after 150 ms. (Not the screen shake: it needs the
  // post-process layer's picture, and isn't worth the risk.)
  async function warm() {
    try {
      const t = tier();
      if (t === "off" || style() !== "shader") return 0;
      const a = await getApi();
      const G = await gridNow(a);
      const w = await a.OBR.viewport.getWidth(), h = await a.OBR.viewport.getHeight();
      const c = await a.OBR.viewport.inverseTransformPoint({ x: w / 2, y: h / 2 });
      const names = [...ARCHETYPES.filter((x) => x !== "number" && x !== "shake"), "zone:motes", "zone:light", "zone:cloud", "zone:strands", "zone:flame"];
      const gen = generation;
      names.forEach((name, i) => later(() => {
        if (gen !== generation || !full) return;
        try {
          const sksl = shaderFor(name, t);
          const S = 2 * G.dpi;
          const item = full.buildEffect().effectType("STANDALONE").sksl(sksl)
            .uniforms(fillUniforms(customUniforms(sksl), { ...(SPEC[name]?.params || {}), fade: 0, progress: 0, colA: { x: 1, y: 1, z: 1 }, colB: { x: 1, y: 1, z: 1 }, seed: 1, power: 1, cell: G.dpi, shape: 1, ofs: { x: 0, y: 0 }, density: 1, hit: 0.5 }, warn))
            .width(S).height(S).position({ x: c.x - S / 2, y: c.y - S / 2 })
            .layer("ATTACHMENT").locked(true).disableHit(true).disableAutoZIndex(true).zIndex(zIndex++)
            .name("dnd-npc fx warm-up").metadata({ [FX_KEY]: { until: clock.wall() + 1000 } }).build();
          live.set(item.id, { id: item.id, item, kind: "warm", rank: 0, t0: clock.now(), ticking: false, added: false });
          later(() => remove(item.id), 150);
          Promise.resolve().then(() => full.OBR.scene.local.addItems([item])).catch((err) => warn("fx: warm-up failed", err));
        } catch (err) { warn("fx: warm-up failed", err); }
      }, i * 50));
      return names.length;
    } catch (err) {
      warn("fx: warm-up failed", err);
      return 0;
    }
  }

  // Everything off this screen: scheduled parts, live effects and zone decorations. With
  // {stop: true} zones also stop being decorated here (no more scene subscription, and no
  // decoration comes back on a later change or settings) until zones.start() runs again.
  async function clear(opts = {}) {
    generation++;
    if (opts?.stop) zones.stop();
    for (const h of timers) clock.clearTimeout(h);
    timers.clear();
    const ids = [...live.values()].filter((e) => e.kind !== "zone").map((e) => e.id);
    for (const id of ids) live.delete(id);
    stopTicker();
    try {
      const a = await getApi();
      if (ids.length) await a.OBR.scene.local.deleteItems(ids);
    } catch (err) { warn("fx: clear failed", err); }
    try { await zones.clear(); } catch (err) { /* nothing to clear */ }
  }

  function setSettings(s) {
    if (!s || typeof s !== "object") return;
    const before = `${tier()}|${style()}|${settings.zones}`;
    // tier and quality_override are worked out afresh for each call, never kept from an older one
    settings = { ...settings, ...s, quality: { ...settings.quality, ...(s.quality || {}) },
      tier: s.tier, quality_override: s.quality_override };
    const after = `${tier()}|${style()}|${settings.zones}`;
    if (before !== after) {
      if (tier() === "off") clear();
      zones.reconcile().catch(() => {});
    }
  }

  const zones = createZones({
    getApi, clock, warn, track, untrack, remove,
    role, tier, style, settings: () => settings, palette: () => palette,
  });

  function status() {
    return { ok: true, tier: tier(), style: style(), kind: kind(), role: role(), live: [...live.values()].filter(countsToCap).length,
      error: lastError };
  }

  function destroy() {
    clear({ stop: true });
    clock.clearInterval(sweeper);
  }

  return { play, setSettings, warm, clear, zones, status, destroy, settings: () => ({ ...settings }) };
}
