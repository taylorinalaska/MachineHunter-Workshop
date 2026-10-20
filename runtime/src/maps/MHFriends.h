#ifndef MH_FRIENDS_H
#define MH_FRIENDS_H

#include "mh_host.h"

/* A custom map's friendly characters (manifest "friends"). A friend never takes the
   player as its target; it fights the nearest enemy instead, enemies fight it when it is
   nearer than the player, and it dies when its health runs out. One that follows walks its own two-point route, which the
   runtime keeps moving to spots near the player, so it walks with its own animation
   and collision, wanders a little when the player stands still, and is put back on
   the player's trail when it falls out of sight. */
#define MH_MAX_FRIENDS 16u

typedef struct MHFriend {
    mh_u32 group, layer;
    mh_i32 x, y;          /* placement, map units within the layer */
    mh_u32 type;
    mh_u32 follow;
    /* Found at run time. */
    mh_u32 object;        /* map object record address, 0 until found */
    mh_u32 path;          /* its route record, 0 when it has none */
    mh_i32 target_x, target_y;
    mh_u32 retarget_at;   /* game update at which to pick a new spot */
    int holding;          /* arrived, standing until the next spot */
    mh_u32 stuck_since;   /* game update since which it has made no progress */
    mh_i32 best_gap;      /* closest it has come while catching up */
    int dead;             /* killed; no longer looked after */
    int robot;            /* a robot body, which can fight with the robot combat AI */
    int fighting;         /* switched to the combat AI */
    mh_u32 fight_actor;   /* the actor it was switched on */
    mh_u32 saved_ai;      /* its own AI controller, to switch back to */
    mh_u32 calm_since;    /* last game update with an enemy in reach */
} MHFriend;

/* Install the targeting hooks. Safe to call once; a signature mismatch leaves friends hostile and is logged. */
int MHFriendsInit(const MHHostAPI *api);

/* Use this list for the level being started (0 friends turns the feature off). */
void MHFriendsArm(MHFriend *list, mh_u32 count);

/* Once a frame while the custom level runs. */
void MHFriendsFrame(const MHHostAPI *api);

#endif
