# Machine Hunter Modding SDK

**Start with [`../MODDING.md`](../MODDING.md).** This folder is the longer reference behind it.

This SDK targets the single retail Windows build used by this project. It is pre-release: the runtime, C header, Lua bridge, map editor, asset viewer, generators and package tools are maintained as one system.

## Architecture

```text
MACHHUNT.EXE
  -> MHRuntime.dll
       -> package registry
       -> typed game integration
       -> one public MHAPI (mh.h)
       -> mod.dll / main.lua / maps / assets

gamedata/contract.json + recovered analysis data
  -> generated C definitions
  -> generated browser catalog/contract
  -> runtime + map editor + asset viewer
```

Lua and most native mods use the named services below. Native mods that need to change the game itself use `mh->engine`, the unsafe tier: named addresses, memory access, checked byte patches and detours.

## Package layout

```text
game/mods/my-mod/
  mod.json
  mod.dll                 optional native code
  main.lua                optional Lua code
  maps/                    optional .mhproject files
  assets/                  canonical package asset namespace
    archive/                decoded DATA.ARC/resource overrides
    audio/                  custom/mod-authored WAV files
```

The folder name must exactly match `mod.json:id`. `mod.json` is metadata only; package contents are discovered by convention.

## Public services

Native code receives `MHModContext`, whose `mh` member points to the unified API and whose `mod` member describes the current package.

```text
mh.runtime     logging, frame count, time, events, the loaded mods
mh.game        mission/stage identity, mission counters/latches and access control
mh.map         groups/layers, map objects, cells, cell mutation and entity-cell lookup
mh.entities    live actor enumeration, typed mutations and guarded world-actor despawn
mh.input       key state/edge queries, blocking the game's controls
mh.options     the options mods declare; what a menu lists
mh.draw        text, rectangles and lines over the finished frame
mh.camera      read, move and project through the game's view
mh.engine      native only: addresses, memory, patches, detours
mh.sound       retail effects plus package-local custom WAV handles
mh.resources   DATA.ARC metadata and centralized package overrides
mh.catalog     recovered entity names and retail stage resource bindings
```

Lua exposes the same vocabulary under the global `mh` table.

## Shared coordinates

The recovered coordinate pipeline is explicit in `gamedata/contract.json`:

1. One map cell = 256 MAP subunits.
2. Runtime actor coordinates store MAP subunits shifted by 16 bits.
3. Therefore one map cell = `0x01000000` runtime world units.
4. Facing angles wrap at 2048.

Use `MH_WORLD_ONE`, `MH_WORLD_FROM_CELL`, or the Lua cell-unit conversions rather than embedding scale constants.

## Build

```powershell
npm run runtime:build          # builds MHRuntime.dll and every mod in mods\, and installs them into game\
```

Lua scripting needs the 32-bit Lua 5.4 DLL as `game/lua54.dll` (headers for native embedding are under `runtime/third_party/lua54`).

A package is a folder under `game/mods/` with a `mod.json`. Start from `../MODDING.md`, which is the guide, and from the mods in `mods/`, which are the examples. The files in this folder are the longer reference.

API 5 is current. It added options (declared in `mod.json`, stored in `mods/settings.cfg`), drawing over the frame, the camera, input blocking, and the engine tier (`mh->engine`: addresses, memory, patches and detours) that lets a native mod change the game itself.

- `../MODDING.md` - start here.
- `NATIVE_API.md` — native C surface.
- `SCRIPTING.md` — Lua surface and events.
- `SOUND.md` — retail effects and custom WAV handles.
