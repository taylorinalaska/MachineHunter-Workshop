# Sound API

API 4 exposes both the original retail effect system and package-owned custom WAV audio.

## Retail effects

The recovered retail executable contains 461 ordinary effect descriptors (`0..460`) mapped to `.RAW` sample names.

Retail RAW is an internal original-game format: headerless mono 22,050 Hz 8-bit PCM.

Native C:

```c
MHU32 id = mh->sound.retail_find("MS_RLOAD.RAW");
if (id != MH_INVALID_INDEX) {
    mh->sound.play_retail(id);
}
```

Entity-owned retail playback:

```c
mh->sound.play_retail_entity(id, mh->entities.player());
```

Lua:

```lua
local id = mh.sound.retail_find("MS_RLOAD.RAW")
if id then mh.sound.play_retail(id) end
```

## Retail sample replacement using WAV

A package can replace a retail RAW sample with a same-basename WAV:

```text
assets/audio/MS_RLOAD.wav
```

The existing retail effect IDs and call sites remain unchanged.

## Arbitrary custom WAV handles

Custom sounds do not need to consume a retail sample slot.

Native C:

```c
MHSound sound = mh->sound.load_wav(context->mod.id, "door.wav");
if (sound != MH_INVALID_SOUND) {
    mh->sound.play(sound);
    mh->sound.stop(sound);
    mh->sound.unload(sound);
}
```

Lua automatically scopes loading to the current package:

```lua
local sound = mh.sound.load_wav("door.wav")
mh.sound.play(sound)
mh.sound.stop(sound)
mh.sound.unload(sound)
```

Custom WAV handles also support positional playback:

```lua
-- Coordinates use the same cell-space numbers returned by mh.entities.get().
mh.sound.play_at(sound, 12.5, 40.5)

-- Follows a moving entity while the voice is active.
mh.sound.play_entity(sound, mh.entities.player())
```

Native C uses world-unit positions for `play_at()`:

```c
MHPosition p = { MH_WORLD_FROM_CELL(12), MH_WORLD_FROM_CELL(40), 0 };
mh->sound.play_at(sound, &p);
mh->sound.play_entity(sound, mh->entities.player());
```

The runtime mirrors the recovered retail positional behavior: a sound must
start within the retail source range, pan is derived from horizontal listener
offset, attenuation follows the retail distance calculation, and moving entity
sources are updated every frame. If an entity owner becomes stale while a
custom voice is active, that voice is stopped rather than following a reused
actor slot.

Package location:

```text
assets/audio/<name>.wav
```

Supported input:

```text
uncompressed PCM WAV
mono or stereo
8-bit or 16-bit
8-48 kHz
maximum 60 seconds
```

The runtime normalizes supported WAV to the game's native 22,050 Hz mono 8-bit PCM buffer format.

Custom handles are bounded, generation-checked and package-relative. Multiple playback voices are maintained per custom sound so rapid repeated playback does not require a new load.

## Type 39 and future custom emitters

Retail Type 39 emitters continue to use their native per-stage ambient selector
profiles. The future editor custom-WAV emitter mode can use `play_at()` or
`play_entity()` without consuming or overloading retail Type 39 selector bits.
The editor UI for that authoring mode remains deferred; see `../tracking/EDITOR_TODO.md`.
