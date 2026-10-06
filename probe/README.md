# DND FX probe (Step 36, Stage 0)

A throwaway Owlbear Rodeo extension that answers the questions the spell-FX build depends on
(spec `docs/spell-fx-spec.md`, section 3.2, probes P1-P13). Plain ES modules, no build step.
The folder is self-contained (it carries its own copy of the Owlbear SDK 3.1.0), so it works
both from GitHub Pages (`https://versaielle.github.io/dnd-owlbear/probe/`) and from this PC
(`http://localhost:7440/probe/`).

It only adds **local** items (each deleted after a few seconds, and swept every 10 s), except
one shared item: the P7 circle, which the **Cleanup** button deletes. It never changes a token.

## Start the local server (Dell)

```
uv run python tools/probe_server.py          # serves owlbear/ on http://localhost:7440
```

It listens on 127.0.0.1 and ::1, answers CORS / Private Network preflights, answers
`GET /api/map/hello` with `{"app":"dnd-npc","probe":true}`, and appends whatever the GM tab
posts to `POST /api/probe/log` to `logs/probe/probe.jsonl`.

## Which manifest to install

Add one in Owlbear: *Extensions → Add custom extension → paste the URL*. Install **one at a
time** in a room (except for P10, which needs two installs at once).

| Manifest URL | Install it for |
|---|---|
| `http://localhost:7440/probe/manifest-local.json` | P3-P9, P12 on the Dell (no push needed). Also install A of P10. |
| `https://versaielle.github.io/dnd-owlbear/probe/manifest.json` | **P1 (absolute URLs)**, P2 baseline (no permissions), P10 install B, P11 (Cast receiver), P13 (phone) |
| `https://versaielle.github.io/dnd-owlbear/probe/manifest-root.json` | **P1 (root-relative URLs)**: does Owlbear resolve `/dnd-owlbear/probe/...` against the manifest's origin? |
| `https://versaielle.github.io/dnd-owlbear/probe/manifest-lna.json` | P2 with `"permissions": ["local-network-access", "loopback-network"]` (plain strings) |
| `https://versaielle.github.io/dnd-owlbear/probe/manifest-lna-obj.json` | P2 with `"permissions": [{"name": "local-network-access"}, {"name": "local-network"}, {"name": "loopback-network"}]` |

Each manifest tags its pages with `?m=<variant>` (`local`, `abs`, `root`, `lna`, `lnaobj`), so
every report says which install it came from.

Note from Owlbear's own code (room bundle): the iframe's `allow=` is built as
`manifest.permissions.map(p => p.name).join("; ")`, so the **plain-string** variant gives
`allow="undefined; undefined"` (no delegation) and only the **object** variant can delegate.
Owlbear may still refuse a permission name it doesn't know when the extension is added:
that refusal is part of P2's answer.

## Probes

Every client reports on start (role, player id and name, connection id, UA, pointer, GPU,
manifest origin, SDK, scene/grid) and again when the automatic probes finish. A GM client
collects every report into the popover's table, logs each as one console line
`[dnd-probe] {json}` (devtools of the Owlbear tab, the probe's background frame), and posts
them to the probe server (when the probe is served from localhost, or when P2 reached
`localhost:7440`).

| Probe | How it runs | What to look at |
|---|---|---|
| P1 | Install `manifest.json` and `manifest-root.json` | Does each install? Does its popover open and its report arrive? |
| P2 | **Automatic** on a GM: fetch `localhost:7440` and `localhost:7420` `/api/map/hello` (2 s timeouts), plus `document.permissionsPolicy` / `featurePolicy` features and `navigator.permissions` states. **P2 fetch here** (popover) repeats it with a click. "Skip P2 on this device" stops the automatic fetch (e.g. on the laptop). | Any Chrome "local network" prompt; the result per manifest variant |
| P3 | **Automatic** for 2 s at the view centre on every client; **P3 shaders** button holds it 8 s | 4 effects, each with a label and a cyan centre ring: good burst, broken SkSL, missing uniform `colA`, vec4 sent as an array. Black box, nothing, or the effect? Top-frame console for `RuntimeEffect` errors. Each burst should be centred on its ring (position = top-left). |
| P4/P5 | **Automatic**: 3 s at 30 Hz through `local.updateItems` normal, then 3 s with `fastUpdate=true`; **P4/P5 ticks** button repeats | `updatesPerSec`, `skipped`, latency, `maxGapMs`, `setInterval` cadence, `rafPerSec` in the background frame, `hostProgressAfter`. Did the fast burst visibly animate? |
| P6 | **Automatic** tool "Probe aim (variant)" (flask icon) on every client | Pick it; press `[` `]` `←` `→` `Q`, click, drag; on a phone tap, drag, pinch. Events stream to the GM. Is the tool on a player's / phone's toolbar? Do arrows nudge a selected token? |
| P7 | GM button **P7 attach test**: a shared PROP circle at the GM's view centre + every client's own local ATTACHMENT stripes on it (2 min). **P7b**: attach the circle to the one selected token | Drag the circle from another client, then the token: do the stripes follow everywhere? |
| P8 | **P8 layers** (pan the GM's view to a fogged spot, scope "every client"): a disc + label on ATTACHMENT, PROP, TEXT and RULER for 60 s | On a player: which stay hidden under fog? |
| P9 | Counts are **automatic** (`p9auto`); **P9 hidden** adds local rings on up to 4 hidden tokens for 30 s: cyan inherits the token's visibility, magenta has VISIBLE behaviour off | On a player: which rings show? Also P6 events show whether a hidden token can be `event.target`. |
| P10 | **Automatic**: every 5 s a ping on `dnd-npc/x` (destination ALL) | `p10.foreign` lists pings heard from a different install (origin + variant); `sameTab` = same connection. Needs two installs (local + Pages) in the room. |
| P11 | **P11 burst** (scope "every client"): a 40 ft fireball-size burst, 3 times | Each client reports its own updates/s and gaps; the report's UA/role identifies the Cast receiver |
| P12 | **P12 load** on one client: a 15 KB and a 20 KB broadcast, then 40 small ones in 1 s | Sender: errors per message (`RateLimitHit`? size?). Receivers: how many arrived (`p12rx`). |
| P13 | **P13 cold/warm** (on the phone, or "every client"): a never-seen shader, the same again, a new one prewarmed, then lite vs full | `add` (Owlbear builds the effect), `first` (add + first update round trip), `gap` (longest stall), updates/s |

**Report** re-sends every report (scope "every client" asks everyone). **Cleanup** deletes this
probe's local items (on every client with scope "every client") and, on a GM, the P7 circle.

### Measuring notes

- Owlbear's canvas frame rate can't be read from an extension iframe. `updatesPerSec`,
  `latP95` and `maxGapMs` are how fast Owlbear's main thread answered our uniform updates: a
  proxy for jank. For the real frame rate on the Dell, use devtools' FPS meter.
- Owlbear's renderer sets `time` to `performance.now() / 1000` (not Unix time), draws a
  STANDALONE effect from its position as the top-left corner, and flattens uniform values as
  number, `{x,y}`, `{x,y,z}` or an array as-is (so a vec4 goes as `[r, g, b, a]`).
- Results: `logs/probe/probe.jsonl` (one JSON record per line; `stampOk` says whether
  Owlbear's `connectionId` matched the sender's own), and the popover's "All as JSON".
