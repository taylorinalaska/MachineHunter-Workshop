#ifndef MH_ENTITY_OVERRIDES_H
#define MH_ENTITY_OVERRIDES_H

#include "mh_host.h"

/* A custom map's changes to one retail entity type (manifest "entity_overrides").
   The engine has a fixed set of types, so the change applies to every copy of the
   type while the map is played; the game's own values are put back afterwards. */
/* One of the type's animation records played differently, by this type's actors only: which frames of its sprite file it
   shows, from which one it starts, how many game updates each is held, and how it
   plays (1 hold, 2 loop, 3 back and forth; records that hand over to game code at
   their end, modes 4..6, keep their mode). */
typedef struct MHAnimationOverride {
    mh_u32 record;
    mh_u32 base;
    mh_u32 span;
    mh_u32 start;
    mh_u32 ticks;
    mh_u32 mode;
    mh_u32 reversed;
} MHAnimationOverride;

#define MH_MAX_TYPE_ANIMATIONS 16u

typedef struct MHEntityOverride {
    mh_u32 type;
    /* 0 keeps the retail value. */
    mh_u32 health;
    /* Percent of the retail value; 100 keeps it. Robots only. */
    mh_u32 speed_pct;
    mh_u32 fire_rate_pct;
    mh_u32 damage_pct;
    MHAnimationOverride animations[MH_MAX_TYPE_ANIMATIONS];
    mh_u32 animation_count;
} MHEntityOverride;

#define MH_MAX_ENTITY_OVERRIDES 16u
/* An actor's health survives leaving and re-entering the player's range in one byte of its
   map record, so anything above 255 comes back wrapped round. */
#define MH_ENTITY_OVERRIDE_HEALTH_MAX 255u
#define MH_ENTITY_OVERRIDE_PCT_MIN 10u
#define MH_ENTITY_OVERRIDE_PCT_MAX 500u

/* Whether a type can be overridden: it has an actor descriptor and is not the player's own body. */
int MHEntityOverrideTypeSupported(const MHHostAPI *api, mh_u32 type);

/* Whether an override's animations can be applied: each record is one the type draws
   with, and its frames lie inside the sprite file its slot holds on `level` (or the
   map's own replacement: `package_frames[slot]`, 0 where the map has none). */
int MHEntityOverrideAnimationsValid(const MHHostAPI *api, const MHEntityOverride *o, mh_u32 level, const mh_u32 *package_frames);

/* Apply the overrides. Returns 0 when one of them could not be applied; whatever
   was applied is still undone by MHEntityOverridesRestore. */
int MHEntityOverridesApply(const MHHostAPI *api, const MHEntityOverride *list, mh_u32 count);

void MHEntityOverridesRestore(const MHHostAPI *api);

/* Hook the game's actor creation and animation start, which per-type animations need.
   Called once; without it overrides with animations are refused. */
int MHEntityAnimationsInit(const MHHostAPI *api);

#endif
