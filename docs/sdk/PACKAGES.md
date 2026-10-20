# Mod packages

A mod is one directory under `game/mods`. The directory name and manifest `id` must match exactly.

```text
game/mods/example-mod/
  mod.json
  mod.dll                 optional native code
  main.lua                optional Lua code
  maps/                    optional map projects
  assets/                  optional package assets
    archive/                decoded DATA.ARC overrides
    audio/                  custom/mod-authored PCM WAV files
```

The manifest is metadata only:

```json
{
  "format": "mhmod-1",
  "id": "example-mod",
  "name": "Example Mod",
  "version": "0.1.0",
  "author": "Example Author",
  "description": "Example package"
}
```

`format`, `id`, and `name` are required. Code, scripts, maps, and assets are discovered from their conventional locations. They are intentionally not repeated in `mod.json`, so package metadata cannot become inconsistent with package contents. Keys the runtime does not know are ignored.

`options` is the one other key the runtime reads: the settings the mod offers. See `../MODDING.md` for the fields. Values live in `game/mods/settings.cfg`, one `[mod-id]` section per mod, with a `disabled = id, id` line at the top naming the mods that are switched off. A disabled mod is left out of the registry entirely.

The shared schema is `gamedata/mod.schema.json`. The Workshop writes manifests through `modManifest()` in `packages/core/src/pkg/mhproject.ts` and reads them, and `settings.cfg`, through `packages/core/src/pkg/mods.ts`.

## Loose archive assets

Decoded resource overrides use `assets/archive/<DATA.ARC filename>`. The runtime currently accepts bounded MAP/PAL/PLT/RMP/BRT/LMP replacements, validated terrain `.BIN` banks, validated retail-named sprite `.B` containers, and retail-compatible 8-bit `.BMP` resources through the central resource service. See `RESOURCES.md` for structural contracts and precedence.

## Custom audio

Mod-authored sounds use `assets/audio/*.wav`. RAW is an original-game internal
format and is not an authoring format. Supported WAV input is uncompressed PCM,
mono/stereo, 8/16-bit, 8-48 kHz, up to 60 seconds. The runtime normalizes it to
22,050 Hz mono 8-bit PCM internally.

Package WAVs can either replace a retail RAW by basename (`MS_RLOAD.wav` ->
`MS_RLOAD.RAW`) or be loaded as independent custom handles through
`mh.sound.load_wav()`.
