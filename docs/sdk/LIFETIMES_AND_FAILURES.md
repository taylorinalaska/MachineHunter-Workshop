# Handle lifetimes and failure behavior

This API intentionally returns failure instead of exposing raw engine memory to
mods. Callers should still treat handles as scoped runtime references rather
than permanent IDs.

## `MHEntity`

An entity handle identifies one actor-pool slot. Actor slots are reused by the
retail engine. Revalidate retained handles with `entities.exists()` or
`entities.get()` before using them after destruction, death/restart, or a map
transition. Do not serialize entity handles into mod save/config data.

`entities.despawn()` refuses reserved player/network slots 0-7.

## `MHMapObject`

A map-object handle is valid only for the currently loaded MAP. Discard it on
`MAP_LOADING`/`MAP_LOADED`. Use map enumeration again after a restart or level
transition.

## `MHSound`

Custom sound handles are runtime-owned and generation-checked. `unload()`
invalidates the handle and stops/releases all of its voices. Reusing an old
handle fails rather than resolving a newly loaded sound in the same slot.

Package WAV paths are confined to the owning package's `assets/audio`
directory. Absolute paths, parent traversal, invalid Windows path characters,
and non-WAV extensions are rejected.

Positional custom WAV voices tied to an entity snapshot the retail actor owner
field. If the actor slot is destroyed/reused, that voice is stopped rather than
following the new actor.

## `MHResource`

DATA.ARC resource IDs are stable metadata for the supported retail executable.
They are read-only through the public API. Asset replacement is package-driven,
not arbitrary buffer mutation.

## Lua failure isolation

Each script package owns a separate Lua state. A callback error is logged and
that script package is disabled for the remainder of the run so an `on_frame`
error cannot flood the log every frame. Other packages continue running.

## Native-mod failure boundary

Native DLL mods execute in the game process and cannot be safely sandboxed from
access violations or arbitrary memory corruption. `MHModInit()` returning false
is isolated and reported, but a native DLL crash is inherently a process crash.
Lua is the recommended surface for ordinary gameplay scripting.

## Startup failures

Core hook/signature failures and the runtime API self-check are fatal to
`MHRuntimeInit`. The runtime refuses partial initialization when its required
frame/map/event infrastructure is unavailable.
