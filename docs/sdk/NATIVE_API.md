# Native API

## Entry point

```c
#include "mh.h"

MH_EXPORT int MH_STDCALL MHModInit(const MHModContext *context)
{
    const MHAPI *mh;
    if (!context || !context->mh) return 0;
    mh = context->mh;
    if (mh->api_version != MH_API_VERSION) return 0;
    mh->runtime.log(context->mod.name);
    return 1;
}
```

`MHModContext.mod` provides `id`, `name`, `version`, `author`, `description`, and package `root`.

## Runtime/events

Subscribe with `mh->runtime.subscribe(mask, callback, context)`.

API 5 events:

```text
RUNTIME_READY
FRAME
MAP_LOADING
MAP_LOADED
GROUP_CHANGED
PLAYER_CHANGED
ENTITY_CREATED
ENTITY_DESTROYED
PLAYER_CELL_CHANGED
OPTION_CHANGED      event->option, event->value; sent for every mod's options
ACTION              event->option: an action option was run
DRAW                the frame is finished; mh->draw works now
DRAW_OVERLAY        after DRAW, for menus
LEVEL_COMPLETE      the level was won (exit or boss ending); the statistics screen follows
```

`MAP_LOADED` is delayed until the first normal frame after MAP initialization returns.

`PLAYER_CELL_CHANGED` comes from the engine-maintained current-cell pointer on the player actor. The event includes `cell_group`, `cell_layer`, `cell_x`, `cell_y`, `cell_definition`, and `cell_class`.

## Game

`mh->game.state()` returns the recovered mission/gameplay state without exposing globals directly:

```c
MHGameState state;
if (mh->game.state(&state)) {
    /* difficulty, access_mask, exit_ready, mission_complete,
       kills/rescues/items/secrets current + total */
}
```

Custom mission logic can use:

```text
set_exit_ready(bool)
set_mission_complete(bool)
grant_access(mask)
revoke_access(mask)
```

These operations manipulate the recovered native mission/access latches used by the retail engine.

## Maps

`mh->map` provides:

1. Loaded/current group state.
2. Group/layer counts and layer origin/size.
3. MAP-object enumeration and typed object state.
4. `object_set_enabled()`.
5. `object_spawn()` through the retail MAP-object spawner.
6. `cell_get()`.
7. `cell_set_definition()` while preserving upper runtime-state bits.
8. `entity_cell()` using the actor's engine-maintained current-cell pointer.

`MHMapObject` is valid only for the currently loaded MAP.

### Spawn policy

The supported reliable spawn primitive is an authored MAP object. Place/author the object in the map, optionally disabled, then enable/spawn it at runtime. This preserves the original engine's object ownership and cleanup path.

## Entities

`MHEntity` is an opaque actor-pool handle. Revalidate retained handles with `exists()` or `get()` because slots can be reused.

Current mutations:

```text
set_position
set_health
set_facing
despawn
```

`despawn()` refuses reserved player/network slots 0-7 and uses the retail world-actor cleanup path.

## Coordinates

One MAP cell = 256 MAP subunits = `MH_WORLD_ONE` (`0x01000000`) actor-position units.

```c
MH_WORLD_FROM_CELL(3)
MH_WORLD_TO_CELL(position.x)
```

## Sound

See `SOUND.md`.

The API distinguishes retail effects from package-owned WAV handles:

```text
retail_count / retail_get / retail_find
play_retail / play_retail_entity
load_wav / play / play_at / play_entity / stop / unload
```

`play_at()` uses `MHPosition` world units. `play_entity()` follows the selected
entity while the voice is active and stops the voice if the original actor
owner becomes stale.

## Resources/catalog

`mh->resources` exposes bounded DATA.ARC metadata lookup.

`mh->catalog` exposes the shared generated entity/stage/resource/sprite catalog consumed by runtime and browser tools.

Retail ambient-SFX profiles are part of the same catalog:

```c
MHU32 count = mh->catalog.ambient_profile_count(level);
MHAmbientProfileInfo profile;
if (mh->catalog.ambient_profile(level, selector, &profile)) {
    /* selector/mode/sound_id/sample_name/base_delay/random_range/retail_uses */
}
```

These are the recovered 10-byte per-level profiles selected by Type 39 MAP objects. Special/high-bit sound values remain numeric and do not receive fabricated sample names.

## Options, drawing, camera, input

`mh->options`, `mh->draw`, `mh->camera` and the `block` / `blocked` / `key_code` / `key_name` members of `mh->input` are declared with comments in `mh.h` and explained in `../MODDING.md`. In short:

```c
MHOption speed = mh->options.find(context->mod.id, "speed");   /* declared in mod.json */
MHI32 value = mh->options.get(speed);

mh->draw.text(4, 4, "HELLO", mh->draw.color(0xFFFFFF), 1);      /* inside a DRAW event */

MHCameraState view;
mh->camera.get(&view);                                          /* world units */
mh->camera.pan(MH_WORLD_ONE / 16, 0);                           /* a sixteenth of a cell to the right */
mh->camera.release();

mh->input.block(MH_CONTROLS_ALL);                               /* every frame a menu is open */
```

## The engine tier

`mh->engine` gives a native mod the retail executable itself:

```text
symbol(name) / constant(name)     addresses and offsets that already have names (see MHRuntime.c)
read / write                      guarded memory access
patch(address, expected, replacement, size)
detour(address, expected, size, hook, &original)
actor(slot) / player_actor()      addresses in the actor pool
dump(path, address, size)         write memory to a file
```

`patch` and `detour` compare `expected` with what is there and fail without writing on a mismatch. A second `detour` of an address is chained in front of the first: `*original` is then the earlier hook, which has the same signature as the game's function. A displaced `jmp rel32` thunk is re-aimed, so `*original` is callable for those too; any other displaced bytes must not be position dependent. `patch` follows code that a detour has moved into a trampoline.

Addresses are for the one supported executable (699,904 bytes). Use the public SDK services before accessing native memory directly.
