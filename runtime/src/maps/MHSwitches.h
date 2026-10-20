#ifndef MH_SWITCHES_H
#define MH_SWITCHES_H

#include "mh_host.h"
#include "MHEffectEmitters.h"

/* A custom map's trigger pads (manifest "switches"), the doors they open ("doors") and what
   else they do ("triggers"). A door is a native reversible cell sequence (class 0x1000)
   whose gate is touch (0), a key (1..5) or a trigger channel (6..31). Key doors also get approach feedback; collected keys persist until the map ends or a script revokes them. Stepping onto a pad grants its
   channel, so those doors open on touch from then on, and opens the ones in the player's
   area at once, as the game's own adjacent-door action does. Then the trigger with that
   channel runs its actions: break cells (the game's own destruction, as if shot), change
   cells to other definitions, play effects, reveal entities that start disabled. */
#define MH_MAX_SWITCHES 32u
#define MH_MAX_SWITCH_DOORS 64u
#define MH_MAX_TRIGGERS 26u
#define MH_MAX_TRIGGER_ACTIONS 128u

typedef struct MHSwitch {
    mh_u32 group, layer, x, y, channel;
} MHSwitch;

typedef struct MHSwitchDoor {
    mh_u32 group, layer, x, y, lock, axis; /* 1 north-south passage, 2 east-west; 0 older package */
} MHSwitchDoor;

#define MH_TRIGGER_BREAK  1u
#define MH_TRIGGER_CELL   2u
#define MH_TRIGGER_EFFECT 3u
#define MH_TRIGGER_REVEAL 4u

typedef struct MHTriggerAction {
    mh_u32 kind;
    mh_u32 group, layer, x, y;  /* a layer cell; for reveal, the object's position in map units */
    mh_u32 value;               /* CELL: definition; REVEAL: map type */
    MHEffectEmitter effect;     /* EFFECT: its particles and point */
} MHTriggerAction;

typedef struct MHTrigger {
    mh_u32 channel, once, fired;
    mh_u32 first, count;        /* its actions in the action list */
} MHTrigger;

void MHSwitchesArm(const MHSwitch *switches, mh_u32 switch_count, const MHSwitchDoor *doors, mh_u32 door_count,
                   MHTrigger *triggers, mh_u32 trigger_count, const MHTriggerAction *actions, mh_u32 action_count);
void MHSwitchesFrame(const MHHostAPI *api);
/* Keys last for a custom-map session; explicit mod revocation remains supported. */
void MHSwitchesResetKeys(void);
void MHSwitchesRevokeKeys(mh_u32 mask);

#endif
