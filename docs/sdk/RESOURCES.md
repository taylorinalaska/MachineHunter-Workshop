# Resources and loose asset overrides

`mh.resources` exposes the retail `DATA.ARC` directory by stable archive ID/name metadata. The runtime owns the generic archive seam plus the specialized terrain-BIN, sprite-slot, and BMP paths, so package assets and `.mhproject` assets share one resource subsystem.

## Package convention

Decoded loose overrides live under:

```text
game/mods/<id>/assets/archive/<DATA.ARC filename>
```

Example:

```text
game/mods/my-textures/
  mod.json
  assets/
    archive/
      MARS.PAL
      MARS.PLT
      MARS.RMP
      MARS.BRT
```

`mod.json` remains metadata-only. Files under `assets/archive` are discovered by convention.

The path is always `assets/archive/<retail DATA.ARC name>`, for example `assets/archive/MARS.PAL`.

## Supported overrides

The package path is shared across generic and specialized decoded resource classes. The generic reader currently supports:

1. `.MAP` — non-empty, maximum `0x50000` bytes.
2. `.PAL` — exactly 1024 bytes.
3. `.PLT` — exactly 1024 bytes.
4. `.RMP` — exactly 65536 bytes.
5. `.BRT` — exactly 73728 bytes.
6. `.LMP` — non-empty, maximum `0x5000` bytes.

Override files contain the **decoded resource payload**, not the compressed DATA.ARC member representation.

Terrain `.BIN` is supported through the recovered specialized terrain loader. A terrain BIN must contain 1..1024 64x64 indexed tiles (the unmodified engine holds 128; the runtime moves the engine's tile-pointer table at start-up to make room, and falls back to 128 if the executable is not the one it knows) using the recovered decoded structure: one tile count, one payload-relative offset per tile, then exactly `count * 4096` bytes of tile pixels. The offsets must be `0, 0x1000, 0x2000, ...`.

Retail-named sprite `.B` containers are also supported. A package may provide, for example:

```text
assets/archive/HO_MARS.B
assets/archive/DROID1.B
```

The runtime waits for the retail stage asset loader to populate the normal sprite slots, then replaces matching stage bindings using the same recovered `resource name -> runtime slot` table exposed through `mh.catalog`. A `.B` file must pass the recovered container parser and must contain at least as many frames as the retail container with that name because inspected renderer paths do not bounds-check frame indices. The runtime copies accepted loose sprite payloads into a bounded sprite arena that remains resident for the level.

`.mhproject` explicit sprite-slot overrides are applied after ordinary package sprite replacements and therefore remain authoritative for that active project. BMP briefings and audio still use separate engine contracts and are not yet available as ordinary loose package overrides.

## Bitmap overrides

Retail BMP resources can be replaced by retail archive name, for example:

```text
assets/archive/MARS.BMP
assets/archive/PCPANEL.BMP
```

The runtime uses the original BMP-loading seam but validates replacement files before copying them into the caller-provided destination. The current contract requires an uncompressed 8-bit Windows BMP with a 256-entry palette and the **same width and height as the retail resource name being replaced**. Matching the original dimensions prevents an override from overflowing a destination buffer sized by retail code.

The same central bitmap service is used by custom `.mhproject` briefing images. Active map-project assets have higher priority than ordinary package overrides.

## Precedence

Resource resolution is deterministic:

```text
retail DATA.ARC
  -> loose mod package assets/archive overrides
  -> loose retail-named sprite .B stage-slot overrides
  -> explicitly embedded active .mhproject sidecar/terrain/sprite-slot overrides
```

Package IDs are sorted case-insensitively. When multiple ordinary mod packages override the same archive member, the later package ID wins. An active `.mhproject` explicitly carrying the same sidecar has higher priority than ordinary package overrides.

This ordering is runtime-owned. Individual mods do not install archive hooks.

## API metadata

Native:

```c
MHResource id = mh->resources.find("MARS.PAL");
MHResourceInfo info;
if (id != MH_INVALID_RESOURCE && mh->resources.get(id, &info)) {
    mh->runtime.log(info.name);
}
```

Lua:

```lua
local id = mh.resources.find("MARS.PAL")
local info = id and mh.resources.get(id)
if info then mh.runtime.log(info.name) end
```

The public resource API remains read-only metadata. Asset replacement is package-driven so native code, Lua, the map editor and the asset viewer all use the same package filesystem contract.
