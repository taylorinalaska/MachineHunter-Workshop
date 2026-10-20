#include "MHEffectEmitters.h"

/* 0x004156E0 spawns effect `id` (1..0xBC) at the 16.16 position its second argument points
   to; the third is the effect's starting turn (0..0x7FF). It returns the effect, or 0 when
   the pool is full. Emitters such as smoke (0x00416AB0) call it through thunk 0x00401366. */
typedef mh_u32 (__cdecl *PFN_SpawnEffect)(mh_u32 id, const void *source, mh_u32 turn);
#define MH_SPAWN_EFFECT       0x004156E0u
#define MH_EFFECT_TABLE       0x00481130u
/* Counts game updates; the retail emitters time themselves from it, and it stands still while paused. */
#define MH_UPDATE_COUNTER     0x004AFE90u
#define MH_CURRENT_GROUP      0x004B6434u
/* Effects are only spawned near the player, so far-off emitters do not use up the pool
   the weapons draw from: about as far as actors stay awake. */
#define MH_EFFECT_REACH       (10 * 256)
/* At most this many particles a game update, from all emitters together. */
#define MH_EFFECT_BUDGET      12u

static mh_u32 g_last_counter;
static int g_have_counter;
static mh_u32 g_seed=0x2545F491u;
/* The engine reads its spawn position through a pointer it normally gets from an actor,
   and some effects look further into that actor; give them a zeroed one. */
static mh_i32 g_source[0x400 / 4];

static mh_u32 next_random(void)
{
    g_seed=g_seed*1664525u+1013904223u;
    return g_seed>>8;
}

int MHEffectIdAllowed(const MHHostAPI *api, mh_u32 fx)
{
    mh_u32 descriptor=0;
    if (fx==0u || fx>=MH_EFFECT_ID_COUNT) return 0;
    return api->read_memory(MH_EFFECT_TABLE+fx*8u+4u,&descriptor,4) && descriptor!=0u;
}

void MHEffectEmittersReset(void)
{
    g_have_counter=0;
}

static void spawn(const MHEffectEmitter *e, mh_u32 layer)
{
    mh_i32 spread=(mh_i32)e->spread[layer];
    mh_i32 dx=spread ? (mh_i32)(next_random()%(mh_u32)(spread*2+1))-spread : 0;
    mh_i32 dy=spread ? (mh_i32)(next_random()%(mh_u32)(spread*2+1))-spread : 0;
    g_source[0]=(e->x+dx)<<16;
    g_source[1]=(e->y+dy)<<16;
    /* Height above the ground storey; a storey is 0x100 map units, counted upwards. */
    g_source[2]=e->z<<16;
    ((PFN_SpawnEffect)MH_SPAWN_EFFECT)(e->fx[layer],g_source,next_random()&0x7FFu);
}

void MHEffectBurst(const MHEffectEmitter *e)
{
    mh_u32 i;
    for (i=0;i<e->layer_count && i<MH_EFFECT_MAX_LAYERS;++i) spawn(e,i);
}

void MHEffectEmittersFrame(const MHHostAPI *api, MHEffectEmitter *list, mh_u32 count)
{
    mh_u32 counter=0,group=0,player,steps,budget=MH_EFFECT_BUDGET,i,j;
    mh_i32 px=0,py=0;
    if (!count || !api->find_player_actor) return;
    player=api->find_player_actor();
    if (!player || !api->read_memory(MH_UPDATE_COUNTER,&counter,4) || !api->read_memory(MH_CURRENT_GROUP,&group,4)) return;
    if (!api->read_memory(player,&px,4) || !api->read_memory(player+4u,&py,4)) return;
    px>>=16; py>>=16;
    if (!g_have_counter) { g_last_counter=counter; g_have_counter=1; return; }
    steps=counter-g_last_counter;
    g_last_counter=counter;
    if (!steps) return;
    /* After a long stall (loading, a menu) do not catch up all at once. */
    if (steps>4u) steps=4u;
    while (steps--) {
        mh_u32 tick=counter-steps;
        for (i=0;i<count;++i) {
            MHEffectEmitter *e=&list[i];
            mh_i32 dx=e->x-px, dy=e->y-py;
            if (e->group!=group || !e->every || (tick+e->phase)%e->every) continue;
            if (dx<-MH_EFFECT_REACH || dx>MH_EFFECT_REACH || dy<-MH_EFFECT_REACH || dy>MH_EFFECT_REACH) continue;
            for (j=0;j<e->layer_count && budget;++j,--budget) spawn(e,j);
        }
    }
}
