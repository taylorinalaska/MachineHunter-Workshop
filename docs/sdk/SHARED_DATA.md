# Shared runtime/tool data

The runtime and the Workshop must not keep separate copies of recovered constants. Three files under `gamedata/` are the single source:

| File | What it holds | Who reads it |
| --- | --- | --- |
| `gamedata/contract.json` | API version, package conventions, coordinate scales, event IDs, level IDs, asset-override limits. Hand-maintained. | `scripts/gen-runtime-headers.ts` turns it into `runtime/sdk/include/mh_contract.h` (public) and `runtime/src/generated/mh_contract_data.h` (internal). |
| `gamedata/catalog.json` | 115 observed entity types, the resource and sprite bindings of all 25 stages, sprite-container and bitmap metadata, the 461 retail sound effects, ambient sound profiles. Carried over from the recovered analysis. | `scripts/gen-runtime-headers.ts` turns it into `runtime/src/generated/mh_catalog_data.h`. |
| `gamedata/bestiary.json` | Names, categories, behavior notes, weapon data and usage for every entity. Included as shared authoring metadata. | The Workshop (Entity Lab and the builder's entity palette). |

`runtime/build.ps1` regenerates the headers before compiling, so editing `contract.json` and rebuilding is all it takes to change, say, an override size limit.

Numbers that live in the game's own files are deliberately **not** stored here. The Workshop reads level tables, briefing text, animation records, health and collision radii from the retail executable, and textures, sprites and sounds from `DATA.ARC`, each time it starts (`packages/core/src/exe/tables.ts`).

## Ambient sound profiles

`gamedata/catalog.json` includes `ambient_sound_profiles`, from the recovered per-level retail tables. Each item has the level index, MAP name, selector, mode, sound ID, sample name when the ID is a normal retail effect, delay fields and how often retail Type 39 emitters use it.
