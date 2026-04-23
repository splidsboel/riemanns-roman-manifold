# UI changes — `ui-start` branch

Initial design pass for the semantic-search pane. Pure black + white,
typewriter-aesthetic, algorithmic. Built directly on top of the empty
`ui/index.html` + `ui/main.js` scaffold that was on `main`.

## What was added

| File | Status | Purpose |
|---|---|---|
| `index.html` | rewritten | Layout shell with all UI panels (search, global cube, settings, crosshair, HUD, overlay) |
| `style.css` | new | Black/white algorithmic palette, JetBrains Mono, angular boxes, round points |
| `main.js` | rewritten | Three.js scene, search-flow animation, global cube minimap, settings, crosshair picking |

No backend wiring yet — the UI falls back to a generated demo cloud
(6 clusters × 250 points) when `/visualization/status` is unreachable, so
you can run it standalone via any static file server.

## Visual design (vs. the original `samplevec` visualizer)

| Element | Before (samplevec) | After (riemanns-roman-manifold) |
|---|---|---|
| **Palette** | Catppuccin dark (`#11111b` bg, blue/green accents, HSL cluster colors) | Pure white background, black foreground, single red accent (`#d40000`) for global-world markers only |
| **Font** | SF Mono / Fira Code | JetBrains Mono (typewriter, weight 500/700) |
| **Boxes** | Rounded 6–8px corners, semi-transparent dark fills | Angular 1px black borders on white, no rounding |
| **Points** | Star sprites with 4 cross-spikes, additive blending, per-cluster HSL color | Round black anti-aliased discs on white, no cluster colors |
| **Cluster info** | Encoded in point color | Dropped visually (still used for layout, no longer rendered) |
| **Hover tooltip** | Floating tooltip following cursor | Crosshair-style: small black dot at screen center, label appears beneath when a point sits on the crosshair |
| **Search bar** | Top-left, rounded dark pill | Bottom-left, angular box, label `SEMANTIC SEARCH` above input |
| **Settings** | Top-right gear (⚙) | Top-right `[ * ]` button, panel matches new white/angular style |
| **HUD** | Bottom-left, lowercase casual | Bottom-left, uppercase, bracket-delimited tokens (`[ wasd ]`) |

## New element: global-world cube (bottom-right)

A 1×1×1 wireframe cube rendered into its own canvas. Constant slow
rotation around the Y-axis with a fixed pitch of 0.35 rad gives the
"spatial feel". Mappings:

- **Current location** — red sphere, position derived from the local
  camera each frame via `localToGlobal()` (normalises against
  `baseMaxDist * worldScale`).
- **Destination** — red sphere, only present during a search (created in
  `setGlobalDestination()`, removed on arrival).
- **Travel line** — black `THREE.Line` from current → destination. Same
  lifetime as the destination marker.

Label `NEIGHBORHOOD` sits below the cube in its own bordered box, matching
the wireframe (`GLOBAL WORLD` label from the sketch maps to the cube
itself; the panel below is the local-world neighborhood label).

## New search flow (3 phases)

`doSearch()` runs:

1. **Gimbal** (`runGimbal`, 600 ms) — camera stays in place, rotation
   eased toward target via `lookAt` of a temp object. Yaw is wrapped to
   the nearest equivalent angle so we never spin the long way round.
2. **Illuminate** (`runIlluminate`, 1000 ms) — matched points pulse via
   `aIllum` per-vertex attribute. Shader uses this to grow the disc
   slightly *and* radiate a thin black ring outward, so "lighting up"
   stays inside the B/W palette.
3. **Travel** (`runTravel`, 1500 ms) — camera lerps to the centroid of
   the matches with a small offset. `setGlobalDestination()` is called
   *at the start* of this phase, so the local fly-in and the
   global-world marker/line appear simultaneously.

After arrival, the destination marker + line are removed and the
illumination is cleared. `searchStatus` shows `arrived · N results`.

Both the local fly-in and the global-world line have the same duration,
so the parallel arrival "feels" synchronised — they share the
`PHASE.TRAVEL_MS` constant.

## Crosshair (always on)

Replaces the cursor-following tooltip from the original. The center dot
is always rendered (CSS `position: fixed; top: 50%; left: 50%`). A
ray from screen center through the camera is cast every frame in
`updateCrosshair()`; when it hits a point, the filename appears in the
small box below the dot.

This works correctly under pointer lock, where the OS cursor doesn't
move but the user is "aiming" with mouse-look.

## Controls (unchanged from the user's request)

| Key | Action |
|---|---|
| `W` / `↑` | forward |
| `S` / `↓` | back |
| `A` / `←` | strafe left |
| `D` / `→` | strafe right |
| `Space` | up |
| `Shift` | down |
| `Esc` | release pointer |
| Scroll | speed adjust |
| Click canvas | capture pointer |

## Settings (top-right `[ * ]`)

Same five sliders as the original, restyled to the new palette:
`WORLD SCALE`, `CLUSTER DENSITY`, `POINT SIZE`, `MOVE SPEED`, `FOG`.
All values mutate the same state variables and trigger the same
recompute paths as the inspiration repo.

## ui-fixes branch — spatial + targeting tweaks

- **Bigger perceived world**: `worldScale` default 24 → 40 and camera-start
  offset 1.3 × → 2.0 × so clusters occupy more of the visible cube without
  distorting the global minimap.
- **Cluster-targeted travel**: `runTravel` now takes an `offset` arg;
  `doSearch` passes `radius * 0.3` of the matched cluster so the camera
  actually lands *inside* the cluster instead of parking outside it.
- **Dynamic global travel line**: the line's "from" vertex is updated
  every frame in `updateGlobalScene` from the current marker's position,
  so the line visibly shrinks as the user approaches the destination
  and is auto-removed at <0.04 cube-units distance.
- **Destination cloud after gimbal**: black radial-gradient sprite
  (`fog: false`) shows where the search is aimed; removed on arrival.
- **Post-arrival expand**: point size lerps 1.7 → 2.1 over 500 ms once
  inside the cluster, then slow FPV auto-rotation kicks in (killed by
  any movement, mouse-look, or new search).
- **Chat-like search**: `<input>` → `<textarea rows="4">` with
  Enter=submit, Shift+Enter=newline.
- **Global view angle**: position (0, 0.3, 3.0) + tilt 0.08 gives a more
  side-on view of the cube (was corner-isometric at (2.4, 2.4, 2.4)).

## Future: three-pane shell

The `main.js` header now carries a comment about the planned three-pane
layout (ProducerPal, Ableton, Semantic Search). Goal: one fixed shell
where the three panes are linked, so a user does not adjust each window
individually. To make that easy later, the search pane keeps its DOM
flat — every element lives directly under `<body>`, but they all use
`position: fixed`. The migration to a shell layout will need to:

- Wrap the entire pane in a single `#search-root` container.
- Drop `position: fixed` on the children and switch to a relative grid.
- The Three.js renderers already accept a target canvas, so the scenes
  themselves don't need to change — only the CSS layout does.

## Backend contract (currently expected)

The UI calls these endpoints — they don't exist yet on the API side:

| Method | Endpoint | Used by |
|---|---|---|
| `GET`  | `/visualization/status` | bootstrap polling |
| `GET`  | `/visualization/layout` | initial point cloud `{points: [...]}` |
| `POST` | `/search` | `{query, k}` → `{results: [{path, ...}]}` |
| `GET`  | `/audio/{id}` | stream a sample's audio file for in-browser playback |

Until those exist, the demo fallback in `generateDemoData()` keeps the
scene populated for design iteration.

## Audio preview

Aim the crosshair at a point and press **E** (or left-click while pointer
is locked) to play that sample. A single `<audio>` element is reused, so
starting a new preview stops the previous one. Audio is fetched from
`/audio/{id}` on the same origin as the UI, which lets playback work
through the Cloudflare tunnel without any host/IP plumbing on the client.

---

# UI changes — `jse/multiplayer` branch

Shared-world multiplayer presence. Everything new is gated behind a
WebSocket connection to `/ws` (served by `api/realtime.py`). Works
through the Cloudflare tunnel unchanged.

## Handle + presence HUD

- **`#handle-modal`** — opens on first load when `localStorage` has no
  `handle`. Saves to localStorage on submit. Re-open via the `[ name ]`
  chip in the top-right button row.
- **`#presence-indicator`** chip — `[ offline ] / [ solo ] / [ N online ]`.
  Clicking it (when connected) toggles `#players-panel`, a dropdown
  listing connected handles. Clicking a handle calls `teleportTo(id)`
  which places the camera a short distance behind that avatar and
  `lookAt`s it, cancelling any in-flight gimbal/travel animation.

## Remote avatars

Added in `createAvatar(handle)` and pushed into the existing `scene`:

| Element | Purpose |
|---|---|
| `sphere` (MeshBasicMaterial) | body, radius `MP_AVATAR_R = 0.9` |
| `halo` (Sprite, additive in dark mode) | soft glow, `5×` sphere radius |
| `beacon` (Line, ±120 units on Y) | low-opacity locator visible from far away |
| `fwdLine` (Line, length `3.0`) | shows look direction |
| `label` (Sprite with canvas texture) | `[ HANDLE ]` in uppercase, `depthTest: false` so it reads through points |
| `miniDot` | small white sphere in `globalGroup` (the minimap cube) |

`avatarScale` multiplier is applied to the avatar `group.scale` so the
new **PLAYER SIZE** slider (0.3–50×) scales every piece at once.
Remotes are excluded from the crosshair raycast because the existing
picker only queries `pointCloud`.

## Pose + search sync

- `sendPose()` is called inside `animate()` right after
  `updateMovement(dt)`. Throttled to `MP_POSE_HZ = 20` and skipped when
  neither position nor rotation moved past `1e-4` / `1e-3`. Idle ping
  every `MP_PING_MS = 5000` ms.
- `updateRemotes(dt)` does a one-frame-buffered lerp toward the latest
  pose, shortest-path yaw, and applies fog fade mirroring the point
  cloud's `uFogNear`/`uFogFar` (opacity floor `0.4`).
- `doSearch()` calls `sendSearch(target, radius*0.3)` right before the
  gimbal phase. On the receiver, `startRemoteSearchAnim` replays gimbal
  → hold → travel over the same `PHASE.*_MS` durations on that remote's
  avatar. Illumination is deliberately **not** replicated.

## Theme

`applyTheme()` now iterates remotes and updates sphere/halo/beacon
colours + rebuilds the label canvas. Guarded with try/catch because the
initial boot call happens while `remotes` is still in TDZ.

## Debug

`window.__mp = { socket, remotes, sendPing() }` is exposed for DevTools.
Console logs `[mp] ws open/close/error` on lifecycle events.
