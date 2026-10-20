# Architecture

```text
            your game files                               this repository
   ┌──────────────────────────────┐        ┌────────────────────────────────────────────┐
   │ game/DATA/DATA.ARC           │──read──▶ packages/core      formats · compiler · pkg │
   │ retail/MACHHUNT_ORIGINAL.EXE │──read──▶        ▲                                     │
   └──────────────────────────────┘        │        │ imported as source                 │
                                           │ apps/workshop      UI + local file server   │
   ┌──────────────────────────────┐        │        │                                     │
   │ game/mods/<id>/maps/*.mhproject ◀─────┼────────┘ "Play" writes a package             │
   │ game/MHRuntime.dll           │◀─build─│ runtime/           C sources of the DLL      │
   │ game/MACHHUNT.EXE            │◀─patch─│ scripts/patch-exe.ts + runtime/patch         │
   └──────────────────────────────┘        └────────────────────────────────────────────┘
```

## Principles

1. **Read the game, do not copy it.** Textures, sprites, level tables, briefing text, animation records and fonts are decoded from the user's own `DATA.ARC` and executable at run time. The repository stores only what cannot be read mechanically: names, classifications and notes (`gamedata/`).
2. **One implementation of each format.** `packages/core` is the only code that knows the MAP, sprite, terrain, palette, archive and package layouts. The Workshop UI, the scripts and the tests all go through it.
3. **The preview is the compiler.** The 3D view does not have its own idea of what a wall looks like. It asks the same `ProjectComposer` the compiler uses for each cell's definition and draws that with the renderer's own texture and lighting rules.
4. **Prove it on the real data.** Corpus tests run every retail map and asset through the codecs. Anything touching the engine is checked in the game with `scripts/smoke-game.ps1`.

## packages/core

Pure TypeScript with no DOM or Node dependencies, consumed as source.

| Folder | Contents |
| --- | --- |
| `archive/` | `DATA.ARC` directory (`earc.ts`) and RNC ProPack decompression (`rnc.ts`). |
| `gfx/` | Palettes and the `.BRT`/`.RMP` generators, terrain banks, sprite containers, 8-bit BMP. |
| `exe/` | A PE reader and readers for the recovered executable tables: levels, sprite bindings, briefings, sounds, entity descriptors, animation records. |
| `map/` | The native MAP model, parser and writer, the `.LMP` automap writer, and the decoded view of a cell definition's collision/behavior bytes. |
| `authoring/` | The editable project model, the composer that turns authored content into cell definitions, the compiler, project (de)serialisation, and import of native maps. |
| `pkg/` | Stored-ZIP reading/writing and the `.mhproject` package. |

### The map model in one paragraph

A map has up to three **areas** (the engine's "groups": separate spaces linked only by teleporters). An area stacks **layers** one cell apart. A layer is a grid; each cell names one shared **cell definition**: a small mesh, a collision profile (ground bit, 4x4 mask, diagonal half or ramp band) and optional behavior (teleporter, exit, hazard, trigger…). Objects hang off each layer row in ascending X.

### From project to game

A project keeps what the author did, not what the engine wants:

- **surfaces** per cell (floor, split floor, ramp, ramp landing),
- **walls** per grid edge or cell diagonal,
- **props**: ready-made definitions imported from a retail level,
- **behaviors** per cell, **entities**, **lighting**.

`ProjectComposer` decides which cell each wall belongs to, builds one definition per distinct combination (`compose.ts`), and de-duplicates. Shapes that need a cut texture (triangular floor halves, the sloped sides of ramps) get a generated tile appended to the map's terrain bank. `writeMap` then lays the file out from scratch. `buildMhproject` wraps the compiled level together with the editable project in one `.mhproject`.

## apps/workshop

React for the panels, three.js for the viewport, zustand for state.

| Folder | Contents |
| --- | --- |
| `server/` | `api.mjs`, the only code that touches the disk (loopback only, same-origin only, path-jailed to `game/`, `retail/`, `projects/`, plus `.mhproject` files the user picks in the Windows Open and Save As dialogs, handled by `files.mjs` with the recent list and autosaves), and `serve.mjs`, the stand-alone server. The Vite dev server mounts the same API. |
| `src/game/` | `GameData`: the loaded archive and executable with caches; the game font; the API client. |
| `src/state/` | `app.ts` (screen, toasts, game data) and `editor.ts` (the open project, tools, undo). |
| `src/editor/` | `mapview.ts` (viewport), `terrain-material.ts` (indexed-color shader), `layer-mesh.ts`, `ops.ts` (pure editing operations), `tools.ts` (pointer input to edits). |
| `src/panels/`, `src/screens/` | The UI. |

The project object is mutated in place because it holds large typed arrays; a `revision` counter tells views to refresh, and whole-project snapshots give undo.

The terrain shader keeps tiles as 8-bit indices in a texture array and resolves color through a 256x32 table built from the level's `.BRT` and `.PLT`, so lighting is the game's palette lighting, not a multiply.

## runtime

`MHRuntime.dll` is 32-bit C with no C runtime. The patched executable's entry stub loads it and calls `MHRuntimeInit`.

The runtime is a mod loader and nothing else: it finds the packages in `game/mods`, runs their code, loads their maps and assets, and offers one API. What a player would call a feature (the in-game menu, high-resolution rendering, the free camera, the debug overlays) is a mod under `mods/`, built against that API and removable without affecting the others.

| Folder | Contents |
| --- | --- |
| `sdk/include/` | `mh.h`, the public mod API, and the generated `mh_contract.h`. |
| `src/host/` | Process setup, the log, guarded memory access, detours, key state, the once-per-frame hook, freestanding memory helpers. `mh_host.h` is the internal interface the other parts use. |
| `src/sdk/` | The implementation of the public API, the mod package registry, mod settings and options (`MHOptions.c`), native mod loading and the Lua bridge. |
| `src/engine/` | Resource overrides, the sound system, and the engine services mods share: camera, input blocking, startup skipping (`MHGameSystems.c`) and drawing over the frame (`MHDrawSystem.c`). |
| `src/maps/` | The MAPS menu and the `.mhproject` loader. |
| `src/generated/` | Headers generated from `gamedata/` by `scripts/gen-runtime-headers.ts`. |
| `patch/patches.json` | The byte patches and loader section applied by `scripts/patch-exe.ts`. |

Every detour is installed against an expected byte signature and refuses to install on a mismatch, so a different executable fails loudly at startup rather than corrupting the game. The host keeps a table of them: a second detour of the same address is chained in front of the first, a displaced `jmp` thunk is re-aimed so its trampoline can be called, and a byte patch aimed at code a detour has moved is applied to the trampoline's copy. That is what lets independent mods change the same function.

Two things the runtime does beyond loading mods are worth knowing about:

- **More terrain tiles.** The engine keeps tile pointers in a 128-entry table. At start-up `MHResourceSystem.c` re-points the eight instructions that use it at a 1,024-entry table inside the DLL, after checking each one; if any does not match, nothing is changed and the limit stays at 128. Banks larger than 128 tiles live in the runtime's own buffer instead of the level arena.
- **A map's own sounds.** A package may list `sounds` in its runtime manifest: WAV entries with a position, an area and a delay. `MHMapsMenu.c` loads them into the sound system from memory when the map is armed and plays each one on its own timer, positioned in the world, while the player is in that area.
- **Direct start.** When the environment variable `MH_AUTOSTART_MAP` names a `.mhproject` (relative to the game folder), `MHMapsMenu.c` presses the launcher dialog's default button, the runtime's startup skip is switched on for that run (whether or not the Skip Intros mod is installed), and the map is started from the main menu through the same path as a MAPS selection. The Workshop's Play button and `scripts/smoke-game.ps1 -Map` use this.

## mods

```text
mods/mod-menu/       mod.c     the in-game menu; public API only
mods/hd-rendering/   mod.c     world at the render size, everything else at 320x240 scaled up; engine tier
mods/dev-tools/      mod.c, trace.c   overlays and test switches; engine tier
mods/free-camera/    main.lua  on the camera and input services
mods/skip-intros/    main.lua  one call
```

`runtime/build.ps1` compiles each folder that has `.c` files into `mod.dll` and copies `mod.json`, `main.lua` and `assets/` to `game/mods/<id>/`.

How they stay independent:

- **Options are data.** A mod declares its options in `mod.json`. The registry hands them to `MHOptions.c`, which holds the values, reads and writes `game/mods/settings.cfg`, and raises `OPTION_CHANGED` and `ACTION` events. The Workshop reads the same declarations and edits the same file (`packages/core/src/pkg/mods.ts` mirrors the C parser, and a test checks the shipped manifests against it).
- **The Mod Menu owns nothing.** It enumerates the options of whatever is loaded, draws them with `mh->draw`, and calls `options.step`. Remove it and every option still works from the Workshop or the file; install a different menu and it sees the same list.
- **Shared engine hooks live in the runtime.** The camera, the input snapshot and the startup movies are each hooked once, in `MHGameSystems.c`, and exposed as `mh.camera`, `mh.input.block` and `mh.game.skip_startup`. Mods that need hooks of their own install them through `mh->engine`, which chains.
- **A menu announces itself by blocking input.** `input.block(ALL)` each frame hides the controls from the game; `input.blocked()` tells other mods that their hotkeys are not theirs right now.

## Testing in the game

`scripts/game-test.ps1` is the harness; `scripts/game-checks.ts` builds its map; `runtime/tests/game-checks/main.lua` is the checking script, installed as a temporary mod. The script runs as a coroutine resumed every frame, so a check reads as straight-line code with waits in it. It cannot press keys, so it writes `[CHECK] KEYS <vk> <ms>` to the runtime log, the harness (tailing the log) presses them, and the script watches the key go down and up through `mh.input.down`. `[CHECK] SHOT` asks for a screenshot, `[CHECK] PASS`/`FAIL` report, `[CHECK] DONE` ends a run. A phase file in the mod folder tells the script which run it is in.

Two things the engine does that a check has to allow for: actors exist only while the player is near them (about seven cells, judging by what the checks saw) and come back with a new handle; and the player and map stay loaded on the statistics screen, so the end of a level is detected with `on_level_complete`.

## The package contract

A mod is a folder `game/mods/<id>/` with a `mod.json`. By convention it may hold `mod.dll` (native), `main.lua`, `maps/*.mhproject` and `assets/`. A `.mhproject` is a stored ZIP:

```text
manifest.json            format "mhproject-v2", project entry + CRC, runtime entry or build_error
project.json             the editable project
runtime/manifest.json    format 1: base level, map, initial group, assets, exit rule, briefing
runtime/level.map        compiled MAP
runtime/level.lmp        automap companion
runtime/terrain.bin      only when the terrain bank differs from the base level's
runtime/briefing.bmp     only with a custom briefing picture
```

The writer is `packages/core/src/pkg/mhproject.ts`; the reader is `runtime/src/maps/MHMapsMenu.c`. The runtime's small JSON reader only understands plain escapes, so briefing text is restricted to printable ASCII by the writer.
