#include "MHSwitches.h"
#include "mh.h"
#include "MHAPI.h"
#include "MHSoundSystem.h"

/* Access channels granted so far this level: bit (channel-1). Gated sequences test it. */
#define MH_ACCESS_MASK      0x004A09D4u
#define MH_MAP_BUFFER_PTR   0x00656958u
#define MH_MAP_BUFFER_CAP   0x50000u
/* Opens a reversible cell sequence and its partner: (cell pointer, storey descriptor,
   16.16 position). The adjacent-door action 0x0041FFD2 calls it through this thunk. */
#define MH_VA_OPEN_SEQUENCE 0x00401924u
/* Storey descriptor: +0x0C/+0x10 origin in cells, +0x14 width, +0x18 height, +0x5C cell grid. */
#define MH_LAYER_ORIGIN_X   0x0Cu
#define MH_LAYER_ORIGIN_Y   0x10u
#define MH_LAYER_WIDTH      0x14u
#define MH_LAYER_HEIGHT     0x18u
#define MH_LAYER_GRID       0x5Cu

/* Destroys a destructible cell as a shot that breaks it does: its effect, its sound, its
   replacement. (cell pointer, storey descriptor, 16.16 position); the impact path 0x00447670
   reaches it through 0x00421340, which first clears the cell's damage bits. */
#define MH_VA_DESTROY_CELL  0x00401316u
/* Definition metadata table pointer: 8 bytes per definition, word 0 its flags. */
#define MH_DEFINITION_META  0x004B6414u
#define MH_FLAG_DESTRUCTIBLE 0x4000u

typedef void (__cdecl *PFN_OpenSequence)(mh_u32 cell, mh_u32 layer, const mh_i32 *position);
typedef void (__cdecl *PFN_DestroyCell)(mh_u32 cell, mh_u32 layer, const mh_i32 *position);

static const MHSwitch *g_switches;
static mh_u32 g_switch_count;
static const MHSwitchDoor *g_doors;
static mh_u32 g_door_count;
static MHTrigger *g_triggers;
static mh_u32 g_trigger_count;
static const MHTriggerAction *g_actions;
static mh_u32 g_action_count;
/* The switch the player stood on at the last update, so a switch acts once per step onto it. */
static mh_u32 g_on=0xFFFFFFFFu;
static mh_u32 g_collected_keys;
static mh_u8 g_door_axis[MH_MAX_SWITCH_DOORS];
static mh_u32 g_feedback_door=0xFFFFFFFFu;

void MHSwitchesResetKeys(void) { mh_u32 i; g_collected_keys=0; g_feedback_door=0xFFFFFFFFu; for(i=0;i<MH_MAX_SWITCH_DOORS;++i)g_door_axis[i]=0; }
void MHSwitchesRevokeKeys(mh_u32 mask) { g_collected_keys&=~mask; }

void MHSwitchesArm(const MHSwitch *switches, mh_u32 switch_count, const MHSwitchDoor *doors, mh_u32 door_count,
                   MHTrigger *triggers, mh_u32 trigger_count, const MHTriggerAction *actions, mh_u32 action_count)
{
    mh_u32 i;
    g_switches=switches;
    g_switch_count=switch_count>MH_MAX_SWITCHES ? MH_MAX_SWITCHES : switch_count;
    g_doors=doors;
    g_door_count=door_count>MH_MAX_SWITCH_DOORS ? MH_MAX_SWITCH_DOORS : door_count;
    g_triggers=triggers;
    g_trigger_count=trigger_count>MH_MAX_TRIGGERS ? MH_MAX_TRIGGERS : trigger_count;
    g_actions=actions;
    g_action_count=action_count>MH_MAX_TRIGGER_ACTIONS ? MH_MAX_TRIGGER_ACTIONS : action_count;
    for (i=0;i<g_trigger_count;++i) g_triggers[i].fired=0;
    g_on=0xFFFFFFFFu;
    MHSwitchesResetKeys();
}

static mh_u32 layer_address(const MHHostAPI *api, mh_u32 group, mh_u32 layer)
{
    mh_u32 base=0,offset=0,count=0;
    if (!api->read_memory(MH_MAP_BUFFER_PTR,&base,4) || !base) return 0u;
    if (!api->read_memory(base+0x20u+group*4u,&offset,4) || !offset || offset>=MH_MAP_BUFFER_CAP) return 0u;
    if (!api->read_memory(base+offset,&count,4) || layer>=count || count>64u) return 0u;
    return base+offset+4u+layer*0x80u;
}

/* A layer cell: its storey descriptor, its cell pointer and the 16.16 point at its middle. */
static int locate_cell(const MHHostAPI *api, mh_u32 group, mh_u32 layer, mh_u32 x, mh_u32 y, mh_u32 *lp_out, mh_u32 *cell_out, mh_i32 *position)
{
    mh_u32 lp=layer_address(api,group,layer),width=0,height=0,grid=0;
    mh_i32 ox=0,oy=0;
    if (!lp || !api->read_memory(lp+MH_LAYER_WIDTH,&width,4) || !api->read_memory(lp+MH_LAYER_HEIGHT,&height,4) || !api->read_memory(lp+MH_LAYER_GRID,&grid,4)) return 0;
    if (!grid || x>=width || y>=height) return 0;
    api->read_memory(lp+MH_LAYER_ORIGIN_X,&ox,4);
    api->read_memory(lp+MH_LAYER_ORIGIN_Y,&oy,4);
    position[0]=((ox+(mh_i32)x)*256+128)<<16;
    position[1]=((oy+(mh_i32)y)*256+128)<<16;
    position[2]=((mh_i32)layer*256)<<16;
    *lp_out=lp;
    *cell_out=grid+(y*width+x)*2u;
    return 1;
}

#ifdef MH_DOOR_STATE_TEST
extern void MHTestOpenSequence(mh_u32 cell,mh_u32 layer,const mh_i32 *position);
#endif

static void open_door(const MHHostAPI *api, const MHSwitchDoor *d)
{
    mh_u32 lp=0,cell=0;
    mh_i32 position[3];
    if (!locate_cell(api,d->group,d->layer,d->x,d->y,&lp,&cell,position)) return;
#ifdef MH_DOOR_STATE_TEST
    MHTestOpenSequence(cell,lp,position);
#else
    ((PFN_OpenSequence)MH_VA_OPEN_SEQUENCE)(cell,lp,position);
#endif
}

/* Break a cell as a shot would, if it is (still) destructible. */
static void break_cell(const MHHostAPI *api, const MHTriggerAction *a)
{
    mh_u32 lp=0,cell=0,table=0;
    mh_u16 word=0,flags=0;
    mh_i32 position[3];
    if (!locate_cell(api,a->group,a->layer,a->x,a->y,&lp,&cell,position)) return;
    if (!api->read_memory(cell,&word,2) || !api->read_memory(MH_DEFINITION_META,&table,4) || !table) return;
    if (!api->read_memory(table+(word&0x7FFu)*8u,&flags,2) || !(flags&MH_FLAG_DESTRUCTIBLE)) return;
    word&=0x7FFu;
    api->write_memory(cell,&word,2);
    ((PFN_DestroyCell)MH_VA_DESTROY_CELL)(cell,lp,position);
}

/* Enable and spawn the map object at a position, if it is there. */
static void reveal(const MHHostAPI *api, const MHAPI *mh, const MHTriggerAction *a)
{
    mh_u32 j,n=mh->map.object_count(a->group,a->layer);
    for (j=0;j<n;++j) {
        MHMapObject handle=mh->map.object_at(a->group,a->layer,j);
        MHMapObjectState o;
        if (!handle || !mh->map.object_get(handle,&o)) continue;
        if (o.map_type!=a->value || o.position.x/65536L!=(mh_i32)a->x || o.position.y/65536L!=(mh_i32)a->y) continue;
        mh->map.object_set_enabled(handle,1);
        api->log(mh->map.object_spawn(handle) ? "MH Maps: a trigger revealed an entity" : "MH Maps: a trigger enabled an entity; it appears when the player comes near");
        return;
    }
    api->log("MH Maps: a trigger's entity to reveal is not in the map");
}

static void run_trigger(const MHHostAPI *api, const MHAPI *mh, MHTrigger *t)
{
    mh_u32 i;
    if (t->once && t->fired) return;
    t->fired=1;
    for (i=t->first;i<t->first+t->count && i<g_action_count;++i) {
        const MHTriggerAction *a=&g_actions[i];
        if (a->kind==MH_TRIGGER_BREAK) break_cell(api,a);
        else if (a->kind==MH_TRIGGER_CELL) mh->map.cell_set_definition(a->group,a->layer,a->x,a->y,(mh_u16)a->value);
        else if (a->kind==MH_TRIGGER_EFFECT) MHEffectBurst(&a->effect);
        else if (a->kind==MH_TRIGGER_REVEAL) reveal(api,mh,a);
    }
}

/* Native contact requires entering the panel cell, which larger possessed
   bodies cannot reach. Activate authorized doors on approach; announce a
   missing key once until the player moves away. Native sequence gates remain. */
static void key_doors_frame(const MHHostAPI *api,const MHAPI *mh,const MHCellState *here)
{
    static const mh_u32 voices[5]={0x77u,0x75u,0x7Cu,0x73u,0x6Du};
    MHEntityState player;
    mh_u32 mask=0,i,near=0xFFFFFFFFu;
    if(!g_door_count||!mh->entities.get(mh->entities.player(),&player))return;
    if(!api->read_memory(MH_ACCESS_MASK,&mask,4))return;
    g_collected_keys|=mask&0x1Fu;
    if((mask&g_collected_keys)!=g_collected_keys) {
        mask|=g_collected_keys;
        api->write_memory(MH_ACCESS_MASK,&mask,4);
    }
    for(i=0;i<g_door_count;++i) {
        const MHSwitchDoor *d=&g_doors[i];
        mh_i32 point[3],dx,dy;
        mh_u32 lp,cell,table=0;
        mh_u16 word=0,flags=0,footprint=0;
        if(d->lock>31u||d->group!=here->group||d->layer!=here->layer)continue;
        if(!locate_cell(api,d->group,d->layer,d->x,d->y,&lp,&cell,point))continue;
        dx=player.position.x-point[0];if(dx<0)dx=-dx;
        dy=player.position.y-point[1];if(dy<0)dy=-dy;
        /* Leave a full-cell-away observer outside the activation range so
           reversible sequences can close normally. */
        if(dx>0x00F00000L||dy>0x00F00000L)continue;
        if(!api->read_memory(cell,&word,2)||!api->read_memory(MH_DEFINITION_META,&table,4)||!table)continue;
        api->read_memory(table+(word&0x7FFu)*8u,&flags,2);
        api->read_memory(table+(word&0x7FFu)*8u+2u,&footprint,2);
        if((flags&0x1E00u)!=0x1000u)continue;
        /* Remember the closed panel axis across its animation frames. Large
           bodies stop before entering this cell, so activate from approach. */
        if(d->axis)g_door_axis[i]=(mh_u8)d->axis;
        else if(footprint==0x0FF0u)g_door_axis[i]=1;
        else if(footprint==0x6666u)g_door_axis[i]=2;
        if(g_door_axis[i]==1 ? dx>0x00600000L : g_door_axis[i]==2 ? dy>0x00600000L : 1)continue;
        if(!d->lock || (mask&(1u<<(d->lock-1u)))) { open_door(api,d); continue; }
        if(d->lock<=5u && near==0xFFFFFFFFu)near=i;
    }
    if(near!=g_feedback_door) {
        if(near==0xFFFFFFFFu)g_feedback_door=near;
        else {
            MHSoundEffectInfo sound;
            mh_u32 effect=voices[g_doors[near].lock-1u];
            if(mh->sound.retail_get(effect,&sound)&&MHSoundDoorFeedback(effect,sound.sample_name)) {
                g_feedback_door=near;
                api->log("MH Maps: key-required door feedback queued");
            }
        }
    }
}

void MHSwitchesFrame(const MHHostAPI *api)
{
    const MHAPI *mh=MHAPIGet();
    MHCellState here;
    mh_u32 i,j,on=0xFFFFFFFFu;
    if ((!g_switch_count&&!g_door_count) || !mh || !mh->map.loaded()) return;
    if (!mh->map.entity_cell(mh->entities.player(),&here)) return;
    key_doors_frame(api,mh,&here);
    if(!g_switch_count)return;
    for (i=0;i<g_switch_count;++i) {
        const MHSwitch *s=&g_switches[i];
        if (s->group==here.group && s->layer==here.layer && s->x==here.x && s->y==here.y) { on=i; break; }
    }
    if (on==g_on) return;
    g_on=on;
    if (on==0xFFFFFFFFu) return;
    {
        const MHSwitch *s=&g_switches[on];
        mh_u32 mask=0;
        api->read_memory(MH_ACCESS_MASK,&mask,4);
        mask|=1u<<(s->channel-1u);
        api->write_memory(MH_ACCESS_MASK,&mask,4);
        for (j=0;j<g_door_count;++j)
            if (g_doors[j].lock==s->channel && g_doors[j].group==here.group) open_door(api,&g_doors[j]);
        for (j=0;j<g_trigger_count;++j)
            if (g_triggers[j].channel==s->channel) run_trigger(api,mh,&g_triggers[j]);
        api->log("MH Maps: a switch was used");
    }
}
