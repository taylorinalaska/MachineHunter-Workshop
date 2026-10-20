#ifndef MH_EFFECT_EMITTERS_H
#define MH_EFFECT_EMITTERS_H

#include "mh_host.h"

/* A custom map's effect emitter (manifest "effects"): every `every` game updates it
   spawns each of its particles, from the engine's own effect table, at its spot,
   scattered by up to `spread` map units. The particles look and move as the game's do. */
#define MH_EFFECT_MAX_LAYERS 3u
#define MH_EFFECT_MAX_EMITTERS 96u
/* The engine's effect table has 0xBD entries; 0 is unused. */
#define MH_EFFECT_ID_COUNT 0xBDu

typedef struct MHEffectEmitter {
    mh_u32 group;
    mh_i32 x, y, z;              /* map units (256 a cell) */
    mh_u32 every;                /* game updates between bursts, 1..255 */
    mh_u32 layer_count;
    mh_u32 fx[MH_EFFECT_MAX_LAYERS];
    mh_u32 spread[MH_EFFECT_MAX_LAYERS];
    mh_u32 phase;
} MHEffectEmitter;

/* Whether an effect id can be spawned by a map (it has a descriptor and is not on the refused list). */
int MHEffectIdAllowed(const MHHostAPI *api, mh_u32 fx);

/* Run the emitters of the area the player is in, once per game update that passed. */
void MHEffectEmittersFrame(const MHHostAPI *api, MHEffectEmitter *list, mh_u32 count);

/* Spawn every particle of an emitter once, now (a trigger's effect). */
void MHEffectBurst(const MHEffectEmitter *e);

/* Forget the update counter, so a new level starts afresh. */
void MHEffectEmittersReset(void);

#endif
