# Lua scripting

A script package places `main.lua` beside `mod.json`. Every script package receives its own Lua state and `mh` table.

## Package context

```lua
mh.runtime.log(mh.mod.id)
mh.runtime.log(mh.mod.root)
```

## Services

```text
mh.runtime.log / frame / time / mods

mh.game.mission / level / level_name / state
mh.game.flow          the game's flow state: 1 menus, 10 playing, 12 paused
mh.game.set_exit_ready / set_mission_complete
mh.game.grant_access / revoke_access
mh.game.skip_startup

mh.map.loaded / group / group_count / layer_count / layer_get
mh.map.object_count / object_at / object_get
mh.map.object_set_enabled / object_spawn
mh.map.cell_get / cell_set_definition / entity_cell

mh.entities.capacity / count / at / from_slot / slot
mh.entities.player / exists / get
mh.entities.set_position / set_health / set_facing / despawn

mh.input.down / pressed / block / blocked / key_code / key_name

mh.options.get / set / add

mh.draw.size / color / text / text_width / rect / line / shade

mh.camera.get / set / pan / release / project

mh.sound.enabled
mh.sound.retail_count / retail_get / retail_find
mh.sound.play_retail / play_retail_entity
mh.sound.load_wav / play / play_at / play_entity / stop / unload

mh.resources.count / get / find

mh.catalog.entity_count / entity_type_at / entity_name
mh.catalog.stage_count / stage_resource_count / stage_resource
mh.catalog.stage_sprite_count / stage_sprite
mh.catalog.ambient_profile_count / ambient_profile
```

Retail Type 39 ambient profiles can be inspected without hard-coded tables:

```lua
local p = mh.catalog.ambient_profile(mh.game.level(), 0)
if p then
    mh.runtime.log(string.format("selector=%d mode=%d sound=%d sample=%s",
        p.selector, p.mode, p.sound_id, tostring(p.sample_name)))
end
```

A vanilla Type 39 selector references only the current retail stage's profile table. Arbitrary package WAV names use custom sound handles rather than being encoded into the MAP record.

Entity positions are presented to Lua in map-cell units. `set_position()` accepts map-cell units.

## Events

Define only the callbacks needed:

```lua
function on_runtime_ready(event) end
function on_frame(event) end
function on_map_loading(event) end
function on_map_loaded(event) end
function on_group_changed(event) end
function on_player_changed(event) end
function on_entity_created(event) end
function on_entity_destroyed(event) end
function on_player_cell_changed(event) end
function on_option_changed(event) end   -- event.key, event.value: this mod's options only
function on_action(event) end           -- event.key
function on_draw(event) end             -- mh.draw works here and in on_draw_overlay
function on_draw_overlay(event) end     -- for menus: drawn above everything else
function on_level_complete(event) end   -- the level was won (exit or boss ending)
```

Options, drawing, the camera and input blocking are explained with examples in `../MODDING.md`.

Cell-change events include:

```text
cell_group
cell_layer
cell_x
cell_y
cell_definition
cell_class
```

This is the intended scripting primitive for custom map triggers that should run when the player enters a specific cell.

## Custom WAV example

Package:

```text
my-mod/
  mod.json
  main.lua
  assets/audio/door.wav
```

Script:

```lua
local door_sound

function on_runtime_ready()
    door_sound = mh.sound.load_wav("door.wav")
end

function on_player_cell_changed(event)
    if event.cell_x == 10 and event.cell_y == 12 then
        mh.sound.play(door_sound)
    end
end
```

Custom author audio remains WAV. The runtime converts supported PCM WAV internally.

`mh.sound.play_at(sound, x, y)` uses the same map-cell coordinate units returned
by `mh.entities.get()`. `mh.sound.play_entity(sound, entity)` follows a moving
entity while that voice is active.

## Lua runtime

The bridge loads `game/lua54.dll`. Place the 32-bit Lua 5.4 DLL there to enable scripting. Failure to provision Lua does not block native runtime/mod loading; scripting is disabled and logged instead.
