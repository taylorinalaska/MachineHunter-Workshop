# Making mods for Machine Hunter

A mod is a folder. The game loads every folder in `game/mods` that has a `mod.json`, and nothing a mod can do is reserved for the mods that ship with the Workshop: the Mod Menu, HD Rendering, Free Camera, Skip Intros and Developer Tools are ordinary mods built on what is described here. Their sources are in `mods/` and are the best examples to copy from.

No mod is required by another. Each works on its own, and they find each other through the runtime, not through each other.

## A mod folder

```text
game/mods/my-mod/
  mod.json            required: what the mod is, and the options it offers
  main.lua            optional: a script
  mod.dll             optional: native code
  maps/*.mhproject    optional: maps, listed under MAPS in the game
  assets/archive/     optional: replacements for files in DATA.ARC, by name
  assets/audio/       optional: WAV files for the mod's own sounds
```

The folder name must be the mod's `id`. To share a mod, zip the folder; **Mods → Add a mod…** in the Workshop installs a zip or a folder.

## mod.json

```json
{
  "format": "mhmod-1",
  "id": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "author": "You",
  "description": "One or two sentences shown in the Workshop.",
  "options": []
}
```

`format`, `id` and `name` are required. Keys the game does not know are ignored, so you can keep notes of your own in the file.

## Options: the Workshop and the Mod Menu

Declare what a player can change in `"options"`. That is all it takes for an option to

- appear on the mod's page in the Workshop,
- appear in the in-game Mod Menu, if that mod is installed,
- be saved in `game/mods/settings.cfg`.

```json
"options": [
  { "key": "enabled",  "label": "Show the counter", "type": "toggle", "default": true },
  { "key": "corner",   "label": "Corner",           "type": "choice", "choices": ["Left", "Right"], "default": "Left" },
  { "key": "size",     "label": "Text size",        "type": "number", "min": 1, "max": 4, "default": 1 },
  { "key": "hotkey",   "label": "Show / hide key",  "type": "key",    "default": "F6" },
  { "key": "log",      "label": "Write it to the log", "type": "action" }
]
```

| Field | Meaning |
| --- | --- |
| `key` | The option's name in code and in `settings.cfg`. Letters, digits, `_`, `-`, `.`. |
| `type` | `toggle`, `choice`, `number`, `key` (a keyboard key) or `action` (something to run; it has no value). |
| `label` | What the player sees. Keep it under about 26 characters for the Mod Menu. |
| `section` | A heading for a group of the mod's options. Every mod has one Mod Menu page of its own, titled with its name, so adding or removing a mod never changes another mod's page; when a mod's options are in more than one section, each section is a heading on that page. The Workshop's Mods page groups them the same way. |
| `default` | `true`/`false`, one of the `choices`, a number, or a key name (`"F3"`, `"UP"`, `"A"`, `"NONE"`). |
| `choices`, `min`, `max`, `step` | For `choice` (up to 16) and `number`. |
| `help` | A sentence shown under the option in the Workshop. |
| `restart` | `true` if a change only takes effect the next time the game starts. The Mod Menu marks it. |
| `saved` | `false` for a switch that should go back to its default every launch. It is offered in the Mod Menu only. |
| `hidden` | `true` to keep it out of in-game menus. It can still be set in the Workshop. |
| `unique` | For `key` options: a group name. Options of the mod in the same group never share a key. Choosing a key another one has moves it there and leaves the other with no key; a `settings.cfg` that gives two of them one key leaves it with the one declared first. The game, the Mod Menu and the Workshop all follow these rules, so the mod never sees a clash (`mods/controls` uses it). |

`settings.cfg` is plain text and can be edited by hand:

```ini
disabled = some-mod, another-mod

[my-mod]
corner = Right
hotkey = F7
```

A mod listed under `disabled` is skipped completely: no code, maps or assets of it are used. An option that was never changed is not in the file.

## A Lua mod

Put a `main.lua` next to `mod.json`. It needs `game/lua54.dll` (32-bit Lua 5.4), which the Workshop's game folder already has. Each mod gets its own Lua state; the game is reached through the global `mh`.

A complete mod that shows the level's kill count on screen, using the options above:

```lua
local function count()
    local state = mh.game.state()
    return state and (state.kills .. "/" .. state.kills_total) or "-"
end

function on_action(event)                      -- an "action" option was run
    if event.key == "log" then mh.runtime.log("kills: " .. count()) end
end

function on_frame()
    if mh.input.blocked() then return end      -- a menu has the keyboard
    if mh.input.pressed(mh.options.get("hotkey")) then
        mh.options.set("enabled", not mh.options.get("enabled"))
    end
end

function on_draw()
    if not mh.options.get("enabled") or not mh.map.loaded() then return end
    local width = mh.draw.size()
    local size = mh.options.get("size")
    local text = "KILLS " .. count()
    local x = mh.options.get("corner") == "Left" and 4 or width - mh.draw.text_width(text, size) - 4
    mh.draw.text(x, 4, text, mh.draw.color(255, 220, 80), size)
end
```

The top level of the script runs while the game is starting. Define only the callbacks you need:

| Callback | When |
| --- | --- |
| `on_runtime_ready` | Once, after every mod has loaded. |
| `on_frame` | Every frame. |
| `on_draw`, `on_draw_overlay` | Every frame, when the picture is finished: the only time `mh.draw` works. Menus draw in `on_draw_overlay` so they end up on top. |
| `on_map_loading`, `on_map_loaded` | A level starts. |
| `on_group_changed`, `on_player_changed`, `on_player_cell_changed` | The player changes area, body or cell. `event.cell_x`, `event.cell_y` say where. |
| `on_entity_created`, `on_entity_destroyed` | `event.entity`. |
| `on_level_complete` | The level was won: the player reached an exit, or a boss ending finished. The statistics screen follows. |
| `on_option_changed` | One of *this mod's* options changed, from any menu: `event.key`, `event.value`. |
| `on_action` | One of this mod's `action` options was run: `event.key`. |

What `mh` offers (positions are in map cells):

| | |
| --- | --- |
| `mh.options` | `get(key)`, `set(key, value)`, `add{...}`. With two names, `get("other-mod", key)` reads another mod's option. |
| `mh.draw` | `size()`, `color(r, g, b)`, `text(x, y, text, color [, scale])`, `text_width(text [, scale])`, `rect(x, y, w, h, color)`, `line(x0, y0, x1, y1, color)`, `shade(x, y, w, h [, percent])`. |
| `mh.input` | `down(key)`, `pressed(key)`, `block()` / `block("move")`, `blocked()`, `key_code(name)`, `key_name(code)`. |
| `mh.camera` | `get()`, `set(x, y [, zoom])`, `pan(right, down)`, `release()`, `project(x, y, z)` → screen x, y. |
| `mh.entities` | `player()`, `count()`, `at(i)`, `get(e)`, `exists(e)`, `set_position`, `set_health`, `set_facing`, `despawn`. |
| `mh.map` | `loaded()`, `group()`, `cell_get`, `cell_set_definition`, `entity_cell(e)`, `object_count`, `object_at`, `object_get`, `object_set_enabled`, `object_spawn`. |
| `mh.game` | `level()`, `level_name()`, `state()`, `set_exit_ready`, `set_mission_complete`, `grant_access`, `revoke_access`, `skip_startup(movies, title)`. |
| `mh.sound` | `load_wav(file)`, `play(s)`, `play_at(s, x, y)`, `play_entity(s, e)`, `stop(s)`, `retail_find(name)`, `play_retail(id)`. |
| `mh.runtime` | `log(text)`, `frame()`, `time()` (milliseconds), `mods()` (the loaded mods, by id). |
| `mh.resources`, `mh.catalog` | Look up the game's files, entity names and level data. |
| `mh.mod` | This mod's `id`, `name`, `version`, `root`. |

Three rules keep mods polite to each other:

- **Check `mh.input.blocked()` before reading keys.** It is true while a menu is open.
- **Call `mh.input.block()` every frame while your own menu or tool has the keyboard**, so the game ignores the keys. `block("move")` hides only the four directions.
- **Hand the camera back** with `mh.camera.release()` when you are done with it.

`mods/free-camera/main.lua` (60 lines) uses all of this; `mods/skip-intros/main.lua` is a mod in one line.

### Adding an option from code

An option that only makes sense once the game is running can be added then. It shows up in the Mod Menu like any other, but not in the Workshop, which only reads `mod.json`:

```lua
mh.options.add{ key = "target", label = "Follow", section = "Camera",
                type = "choice", choices = { "Player", "Nearest robot" }, default = "Player", saved = false }
```

## A native mod

`mod.dll` is a 32-bit DLL that exports one function. It gets the same API as Lua, as a struct of function pointers declared in `runtime/sdk/include/mh.h`:

```c
#include "mh.h"

static const MHAPI *mh;
static MHOption g_enabled;

static void MH_STDCALL on_event(const MHAPI *api, const MHEvent *event, void *context)
{
    (void)api; (void)context;
    if (event->type == MH_EVENT_DRAW && mh->options.get(g_enabled))
        mh->draw.text(4, 4, "HELLO", mh->draw.color(0xFFDC50), 1);
}

MH_EXPORT int MH_STDCALL MHModInit(const MHModContext *context)
{
    if (!context || context->mh->api_version != MH_API_VERSION) return 0;
    mh = context->mh;
    g_enabled = mh->options.find(context->mod.id, "enabled");
    return mh->runtime.subscribe(MH_EVENT_MASK_DRAW, on_event, 0) != MH_INVALID_SUBSCRIPTION;
}
```

Build it as x86 and export `MHModInit`:

```bat
cl /LD /O2 /I runtime\sdk\include mod.c /link /MACHINE:X86 /EXPORT:MHModInit=_MHModInit@4 /OUT:mod.dll
```

A mod kept in this repository's `mods/` folder is compiled and installed by `npm run runtime:build`. Native code sees every option change, not only its own: compare `event->option` with the handles you looked up. In C, positions are world units (`MH_WORLD_ONE` to a cell) and `mh->options.step(option, ±1)` is what a menu calls to change a value.

`mods/mod-menu/mod.c` is a whole menu written against this API and nothing else.

### Changing the game itself

`mh->engine` is the unsafe tier, for mods that alter what the retail executable does: `symbol` and `constant` for the addresses and offsets already named, `read` and `write` for memory, `patch` to replace bytes, `detour` to put a function of yours in front of one of the game's.

```c
static void (__cdecl *original_update)(void);
static void __cdecl my_update(void) { /* ... */ original_update(); }

static const MHU8 expected[5] = { 0xE9, 0xBC, 0x52, 0x02, 0x00 };   /* the bytes being replaced */
mh->engine.detour(0x0040240F, expected, 5, (void *)my_update, (void **)&original_update);
```

Every patch and detour names the bytes it expects and fails without touching anything if they differ, so a different executable is refused rather than corrupted. Two mods may detour the same function: the second is put in front of the first. `patch` still works on code a detour has moved. The SDK reference describes the supported services; use the public API where possible.

`mods/hd-rendering/mod.c` (patches and detours at startup) and `mods/dev-tools/mod.c` (reading the game's structures every frame) are the examples.

## Replacing game files and adding sounds

A file in `assets/archive/` replaces the file of the same name in `DATA.ARC`: maps, palettes, terrain banks (`.BIN`), sprites (`.B`) and pictures (`.BMP`). Export the originals from the Workshop's Assets page to see the formats; `docs/sdk/RESOURCES.md` has the size limits.

A WAV in `assets/audio/` named after a game sound replaces it (`MS_RLOAD.wav` for `MS_RLOAD.RAW`); any other WAV can be played by the mod with `mh.sound.load_wav`. Use uncompressed PCM, up to 60 seconds.

## When something does not work

`game/logs/mh-runtime.log` is rewritten every time the game runs, and is shown at the bottom of the Workshop's Mods page. It names each mod as it loads, each option entry it skipped and each Lua error. A script that raises an error is switched off for the rest of the run; the game carries on.
