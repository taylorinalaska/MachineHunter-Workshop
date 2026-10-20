#include "mh_host.h"
#include "mh.h"
#include "MHAPI.h"
#include "mh_contract_data.h"
#include "mh_catalog_data.h"
#include "MHResourceSystem.h"
#include "MHSoundSystem.h"
#include "MHOptions.h"
#include "MHGameSystems.h"
#include "MHPackageRegistry.h"
#include "MHSwitches.h"

#if defined(_MSC_VER) || defined(__clang__)
#define MH_CDECL __cdecl
#else
#define MH_CDECL
#endif

#define MH_MAP_OBJECTS_INITIALIZE 0x004514B0u
#define MH_MAP_OBJECT_SPAWN       0x00450ED0u
#define MH_WORLD_ACTOR_REMOVE     0x00426810u
#define MH_SOUND_PLAY             0x0044D800u
#define MH_SOUND_ENABLED          0x006B1014u
#define MH_CURRENT_MISSION        0x004AFE98u
#define MH_MISSION_LEVEL_BYTE     0x00489869u
#define MH_MISSION_STRIDE         0x10u
#define MH_CURRENT_GROUP          0x004B6434u
#define MH_MAP_BUFFER_PTR         0x00656958u
#define MH_MAP_BUFFER_CAP         0x50000u
#define MH_ACTOR_GROUP_OFF        0x1Au
#define MH_ACTOR_POSITION_X_OFF   0x00u
#define MH_ACTOR_POSITION_Y_OFF   0x04u
#define MH_ACTOR_POSITION_Z_OFF   0x08u
#define MH_ACTOR_FACING_OFF       0x0Eu
#define MH_ACTOR_ACTIVE_OFF       0x58u
#define MH_ACTOR_CURRENT_CELL_OFF 0x50u
#define MH_ACTOR_HEALTH_OFF       0x234u
#define MH_ACTOR_ACTIVE_TYPE_MASK 0x0Fu
#define MH_MAX_SUBSCRIPTIONS      96u
#define MH_ACTOR_EVENT_CAPACITY   48u
#define MH_DEFINITION_TABLE_PTR 0x004B6414u
#define MH_DIFFICULTY             0x0048A378u
#define MH_ACCESS_MASK            0x004A09D4u
#define MH_EXIT_READY_LATCH       0x004B01E0u
#define MH_MISSION_COMPLETE_LATCH 0x004B01E8u
#define MH_RESCUES_CURRENT        0x006B1CF0u
#define MH_SECRETS_CURRENT        0x006B1CF2u
#define MH_ITEMS_CURRENT          0x006B1CF4u
#define MH_KILLS_CURRENT          0x006B1CF6u
#define MH_RESCUES_TOTAL          0x006B1D50u
#define MH_SECRETS_TOTAL          0x006B1D52u
#define MH_ITEMS_TOTAL            0x006B1D54u
#define MH_KILLS_TOTAL            0x006B1D56u
/* Main game-flow state: -1 when a level is won, then 11 while the game moves to the statistics screen. */
#define MH_GAME_FLOW_STATE        0x004AF8CCu
#define MH_FLOW_LEVEL_WON         (-1)
#define MH_FLOW_LEVEL_END         11

typedef mh_u32 (MH_CDECL *PFN_MapObjectsInitialize)(mh_u32 map_ptr);
typedef mh_u32 (MH_CDECL *PFN_MapObjectSpawn)(mh_u32 object_ptr);
typedef void (MH_CDECL *PFN_WorldActorRemove)(mh_u32 actor_ptr);
typedef mh_u32 (MH_CDECL *PFN_SoundPlay)(mh_u32 effect_id,mh_u32 source_ptr,mh_u32 owner_ptr);
typedef struct MHListener { MHSubscription id; mh_u32 mask; MHEventCallback callback; void *context; int active; } MHListener;

static const MHHostAPI *g_host;
static PFN_MapObjectsInitialize g_original_map_initialize;
static MHListener g_listeners[MH_MAX_SUBSCRIPTIONS];
static MHSubscription g_next_subscription=1u;
static mh_u32 g_last_group=MH_INVALID_INDEX;
static MHEntity g_last_player=MH_INVALID_ENTITY;
static int g_initialized,g_runtime_ready,g_map_loaded_pending,g_level_ending;
static mh_u32 g_last_player_cell_ptr;
static mh_u8 g_actor_active[MH_ACTOR_EVENT_CAPACITY];

static void clear_bytes(void *dst,mh_u32 size){mh_u8 *p=(mh_u8 *)dst;mh_u32 i;for(i=0;i<size;++i)p[i]=0;}
static void event_reset(MHEvent *e,MHEventType type){clear_bytes(e,sizeof(*e));e->type=type;e->level=MH_INVALID_INDEX;e->group=MH_INVALID_INDEX;e->previous_group=MH_INVALID_INDEX;e->entity=MH_INVALID_ENTITY;e->previous_entity=MH_INVALID_ENTITY;e->cell_group=MH_INVALID_INDEX;e->cell_layer=MH_INVALID_INDEX;e->cell_x=MH_INVALID_INDEX;e->cell_y=MH_INVALID_INDEX;e->cell_definition=0xffffu;e->cell_class=0xffffu;}
static mh_u32 event_bit(MHEventType type){if(type<MH_EVENT_RUNTIME_READY||type>MH_EVENT_LEVEL_COMPLETE)return 0u;return 1u<<((mh_u32)type-1u);}
static void dispatch(MHEvent *e){mh_u32 i,bit;const MHAPI *api;if(!e)return;api=MHAPIGet();e->frame=(g_host&&g_host->frame_count)?g_host->frame_count():0u;bit=event_bit(e->type);for(i=0;i<MH_MAX_SUBSCRIPTIONS;++i){MHListener *l=&g_listeners[i];if(l->active&&l->callback&&(l->mask&bit))l->callback(api,e,l->context);}}

static void MH_STDCALL api_log(const char *s){if(g_host&&g_host->log)g_host->log(s);}
static mh_u32 MH_STDCALL api_frame(void){return(g_host&&g_host->frame_count)?g_host->frame_count():0u;}
static MHSubscription MH_STDCALL api_subscribe(mh_u32 mask,MHEventCallback cb,void *ctx){mh_u32 i;MHSubscription id;if(!cb||!(mask&MH_EVENT_MASK_ALL))return 0;for(i=0;i<MH_MAX_SUBSCRIPTIONS;++i)if(!g_listeners[i].active){id=g_next_subscription++;if(!id)id=g_next_subscription++;g_listeners[i].id=id;g_listeners[i].mask=mask&MH_EVENT_MASK_ALL;g_listeners[i].callback=cb;g_listeners[i].context=ctx;g_listeners[i].active=1;return id;}return 0;}
static int MH_STDCALL api_unsubscribe(MHSubscription id){mh_u32 i;if(!id)return 0;for(i=0;i<MH_MAX_SUBSCRIPTIONS;++i)if(g_listeners[i].active&&g_listeners[i].id==id){clear_bytes(&g_listeners[i],sizeof(g_listeners[i]));return 1;}return 0;}

static mh_u32 MH_STDCALL api_mission(void){mh_u32 v=MH_INVALID_INDEX;if(!g_host||!g_host->read_memory||!g_host->read_memory(MH_CURRENT_MISSION,&v,4u))return MH_INVALID_INDEX;return v;}
static mh_u32 MH_STDCALL api_level(void){mh_u32 m=api_mission();mh_u8 level=0;if(!g_host||!g_host->read_memory||m>=MH_SINGLE_PLAYER_LEVEL_COUNT)return MH_INVALID_INDEX;if(!g_host->read_memory(MH_MISSION_LEVEL_BYTE+m*MH_MISSION_STRIDE,&level,1u)||(mh_u32)level>=MH_LEVEL_COUNT)return MH_INVALID_INDEX;return(mh_u32)level;}
static const char *MH_STDCALL api_level_name(mh_u32 level){return level<MH_LEVEL_COUNT?MH_LEVEL_NAMES[level]:(const char *)0;}
static int MH_STDCALL api_game_state(MHGameState *state)
{
    if(!state||!g_host||!g_host->read_memory)return 0;
    clear_bytes(state,sizeof(*state));
    if(!g_host->read_memory(MH_DIFFICULTY,&state->difficulty,4u) ||
       !g_host->read_memory(MH_ACCESS_MASK,&state->access_mask,4u) ||
       !g_host->read_memory(MH_EXIT_READY_LATCH,&state->exit_ready,4u) ||
       !g_host->read_memory(MH_MISSION_COMPLETE_LATCH,&state->mission_complete,4u) ||
       !g_host->read_memory(MH_KILLS_CURRENT,&state->kills,2u) ||
       !g_host->read_memory(MH_KILLS_TOTAL,&state->kills_total,2u) ||
       !g_host->read_memory(MH_RESCUES_CURRENT,&state->rescues,2u) ||
       !g_host->read_memory(MH_RESCUES_TOTAL,&state->rescues_total,2u) ||
       !g_host->read_memory(MH_ITEMS_CURRENT,&state->items,2u) ||
       !g_host->read_memory(MH_ITEMS_TOTAL,&state->items_total,2u) ||
       !g_host->read_memory(MH_SECRETS_CURRENT,&state->secrets,2u) ||
       !g_host->read_memory(MH_SECRETS_TOTAL,&state->secrets_total,2u))return 0;
    return 1;
}
static int write_bool_latch(mh_u32 address,int enabled){mh_u32 v=enabled?1u:0u;return g_host&&g_host->write_memory?g_host->write_memory(address,&v,4u):0;}
static int MH_STDCALL api_game_set_exit_ready(int ready){return write_bool_latch(MH_EXIT_READY_LATCH,ready);}
static int MH_STDCALL api_game_set_mission_complete(int complete){return write_bool_latch(MH_MISSION_COMPLETE_LATCH,complete);}
static int MH_STDCALL api_game_grant_access(mh_u32 mask){mh_u32 value=0u;if(!g_host||!g_host->read_memory||!g_host->write_memory||!g_host->read_memory(MH_ACCESS_MASK,&value,4u))return 0;value|=mask;return g_host->write_memory(MH_ACCESS_MASK,&value,4u);}
static int MH_STDCALL api_game_revoke_access(mh_u32 mask){mh_u32 value=0u;if(!g_host||!g_host->read_memory||!g_host->write_memory||!g_host->read_memory(MH_ACCESS_MASK,&value,4u))return 0;value&=~mask;if(!g_host->write_memory(MH_ACCESS_MASK,&value,4u))return 0;MHSwitchesRevokeKeys(mask);return 1;}
static mh_u32 MH_STDCALL api_map_group(void){mh_u32 g=MH_INVALID_INDEX;if(!g_host||!g_host->read_memory||!g_host->read_memory(MH_CURRENT_GROUP,&g,4u))return MH_INVALID_INDEX;return g;}
static mh_u32 map_base(void){mh_u32 p=0;if(!g_host||!g_host->read_memory||!g_host->read_memory(MH_MAP_BUFFER_PTR,&p,4u))return 0;return p;}
static mh_u32 map_max_definition(void){mh_u32 base=map_base(),max_id=MH_INVALID_INDEX;if(!base||!g_host||!g_host->read_memory||!g_host->read_memory(base+0x18u,&max_id,4u)||max_id>=2048u)return MH_INVALID_INDEX;return max_id;}
static int MH_STDCALL api_map_loaded(void){return map_base()!=0u;}
static int map_pointer_valid(mh_u32 address,mh_u32 bytes){mh_u32 base=map_base();if(!base||address<base||bytes>MH_MAP_BUFFER_CAP)return 0;return address-base<=MH_MAP_BUFFER_CAP-bytes;}
static mh_u32 MH_STDCALL api_map_group_count(void){mh_u32 base=map_base(),count=0;if(!base||!g_host->read_memory||!g_host->read_memory(base+0x1Cu,&count,4u)||count>3u)return 0;return count;}
static mh_u32 map_group_ptr(mh_u32 group){mh_u32 base=map_base(),count=0,offset=0;if(!base||!g_host->read_memory||!g_host->read_memory(base+0x1Cu,&count,4u)||group>=count||count>3u)return 0;if(!g_host->read_memory(base+0x20u+group*4u,&offset,4u)||!offset||offset>=MH_MAP_BUFFER_CAP)return 0;return base+offset;}
static mh_u32 map_layer_ptr(mh_u32 group,mh_u32 layer){mh_u32 gp=map_group_ptr(group),count=0;if(!gp||!g_host->read_memory||!g_host->read_memory(gp,&count,4u)||layer>=count||count>64u)return 0;return gp+4u+layer*0x80u;}
static mh_u32 MH_STDCALL api_map_layer_count(mh_u32 group){mh_u32 gp=map_group_ptr(group),count=0;if(!gp||!g_host->read_memory||!g_host->read_memory(gp,&count,4u)||count>64u)return 0;return count;}
static int MH_STDCALL api_map_layer_get(mh_u32 group,mh_u32 layer,MHLayerInfo *info){mh_u32 lp=map_layer_ptr(group,layer),w=0,h=0;mh_i32 ox=0,oy=0;if(!lp||!info||!g_host->read_memory)return 0;if(!g_host->read_memory(lp+0x0Cu,&ox,4u)||!g_host->read_memory(lp+0x10u,&oy,4u)||!g_host->read_memory(lp+0x14u,&w,4u)||!g_host->read_memory(lp+0x18u,&h,4u)||w>4096u||h>4096u)return 0;clear_bytes(info,sizeof(*info));info->group=group;info->layer=layer;info->origin_x=ox;info->origin_y=oy;info->width=w;info->height=h;return 1;}
static MHMapObject map_object_handle(mh_u32 address){mh_u32 base=map_base();if(!base||!map_pointer_valid(address,0x24u))return 0;return(MHMapObject)((address-base)+1u);}
static mh_u32 map_object_address(MHMapObject object){mh_u32 base=map_base(),off;if(!base||!object)return 0;off=(mh_u32)object-1u;if(off>MH_MAP_BUFFER_CAP-0x24u)return 0;return base+off;}
static mh_u32 layer_object_at_address(mh_u32 group,mh_u32 layer,mh_u32 wanted,mh_u32 *count_out){mh_u32 lp=map_layer_ptr(group,layer),rows=0,row_bank=0,row,index=0;if(count_out)*count_out=0;if(!lp||!g_host->read_memory||!g_host->read_memory(lp+0x18u,&rows,4u)||rows>4096u)return 0;if(!g_host->read_memory(lp+0x28u,&row_bank,4u)||!row_bank||!map_pointer_valid(row_bank,rows?rows*0x24u:0u))return 0;for(row=0;row<rows;++row){mh_u32 object=0,guard=0;if(!g_host->read_memory(row_bank+row*0x24u,&object,4u))return 0;while(object){mh_u32 next=0;if(!map_pointer_valid(object,0x24u))return 0;if(index==wanted){if(count_out)*count_out=index+1u;return object;}++index;if(++guard>4096u)return 0;if(!g_host->read_memory(object,&next,4u))return 0;object=next;}}if(count_out)*count_out=index;return 0;}
static mh_u32 MH_STDCALL api_map_object_count(mh_u32 g,mh_u32 l){mh_u32 count=0;(void)layer_object_at_address(g,l,0xffffffffu,&count);return count;}
static MHMapObject MH_STDCALL api_map_object_at(mh_u32 g,mh_u32 l,mh_u32 i){return map_object_handle(layer_object_at_address(g,l,i,(mh_u32 *)0));}

static mh_u32 actor_capacity(void){return(g_host&&g_host->constant)?g_host->constant("actor.pool.capacity"):0u;}
static mh_u32 actor_stride(void){return(g_host&&g_host->constant)?g_host->constant("actor.pool.stride"):0u;}
static mh_u32 actor_address(MHEntity e){mh_u32 slot;if(!e||!g_host||!g_host->actor_address)return 0;slot=(mh_u32)e-1u;if(slot>=actor_capacity())return 0;return g_host->actor_address(slot);}
static MHEntity entity_from_address(mh_u32 address){mh_u32 base,stride,slot;if(!address||!g_host||!g_host->actor_address)return 0;base=g_host->actor_address(0u);stride=actor_stride();if(!base||!stride||address<base)return 0;slot=(address-base)/stride;if(slot>=actor_capacity()||base+slot*stride!=address)return 0;return(MHEntity)(slot+1u);}
static int find_map_object_location(mh_u32 address,mh_u32 *go,mh_u32 *lo){mh_u32 groups=api_map_group_count(),g,l;for(g=0;g<groups;++g){mh_u32 layers=api_map_layer_count(g);for(l=0;l<layers;++l){mh_u32 lp=map_layer_ptr(g,l),rows=0,row_bank=0,row;if(!lp||!g_host->read_memory(lp+0x18u,&rows,4u)||rows>4096u)continue;if(!g_host->read_memory(lp+0x28u,&row_bank,4u)||!row_bank)continue;for(row=0;row<rows;++row){mh_u32 object=0,guard=0;if(!g_host->read_memory(row_bank+row*0x24u,&object,4u))break;while(object){mh_u32 next=0;if(object==address){if(go)*go=g;if(lo)*lo=l;return 1;}if(!map_pointer_valid(object,0x24u)||++guard>4096u)break;if(!g_host->read_memory(object,&next,4u))break;object=next;}}}}return 0;}
static int MH_STDCALL api_map_object_get(MHMapObject object,MHMapObjectState *state){mh_u32 a=map_object_address(object),g=0,l=0,actor=0;mh_u16 tw=0;mh_u8 flags=0,health=0;MHI16 x=0,y=0,z=0;if(!a||!state||!g_host||!g_host->read_memory||!find_map_object_location(a,&g,&l))return 0;if(!g_host->read_memory(a+0x04u,&tw,2u)||!g_host->read_memory(a+0x06u,&x,2u)||!g_host->read_memory(a+0x08u,&y,2u)||!g_host->read_memory(a+0x0Au,&z,2u)||!g_host->read_memory(a+0x0Cu,&flags,1u)||!g_host->read_memory(a+0x0Du,&health,1u)||!g_host->read_memory(a+0x14u,&actor,4u))return 0;clear_bytes(state,sizeof(*state));state->object=object;state->group=g;state->layer=l;state->map_type=tw&0xffu;state->behavior_selector=(tw>>9)&31u;state->weapon_selector=(tw>>14)&3u;state->flags=flags;state->position.x=(mh_i32)x*65536L;state->position.y=(mh_i32)y*65536L;state->position.z=(mh_i32)z*65536L;state->cached_health=(mh_i32)health;state->entity=entity_from_address(actor);return 1;}
static int MH_STDCALL api_entity_exists(MHEntity e);
static int MH_STDCALL api_entity_despawn(MHEntity e);
static int MH_STDCALL api_map_object_set_enabled(MHMapObject object,int enabled)
{
    mh_u32 a=map_object_address(object),actor=0;mh_u8 flags=0;
    if(!a||!g_host||!g_host->read_memory||!g_host->write_memory)return 0;
    if(!g_host->read_memory(a+0x0Cu,&flags,1u)||!g_host->read_memory(a+0x14u,&actor,4u))return 0;
    if(enabled)flags=(mh_u8)(flags&~1u);else flags=(mh_u8)(flags|1u);
    if(!g_host->write_memory(a+0x0Cu,&flags,1u))return 0;
    if(!enabled&&actor){MHEntity e=entity_from_address(actor);if(e&&!api_entity_despawn(e))return 0;}
    return 1;
}
static MHEntity MH_STDCALL api_map_object_spawn(MHMapObject object)
{
    mh_u32 a=map_object_address(object),group=MH_INVALID_INDEX,layer=0,actor=0;mh_u8 flags=0;PFN_MapObjectSpawn spawn;
    if(!a||!g_host||!g_host->read_memory||!find_map_object_location(a,&group,&layer))return MH_INVALID_ENTITY;
    (void)layer;
    if(group!=api_map_group())return MH_INVALID_ENTITY;
    if(!g_host->read_memory(a+0x0Cu,&flags,1u)||!g_host->read_memory(a+0x14u,&actor,4u))return MH_INVALID_ENTITY;
    if(flags&1u)return MH_INVALID_ENTITY;
    if(actor)return entity_from_address(actor);
    spawn=(PFN_MapObjectSpawn)(void *)MH_MAP_OBJECT_SPAWN;
    (void)spawn(a);
    if(!g_host->read_memory(a+0x14u,&actor,4u))return MH_INVALID_ENTITY;
    return entity_from_address(actor);
}

static int map_cell_address(mh_u32 group,mh_u32 layer,mh_u32 x,mh_u32 y,mh_u32 *address_out)
{
    mh_u32 lp=map_layer_ptr(group,layer),width=0u,height=0u,grid=0u,address;
    if(!lp||!address_out||!g_host||!g_host->read_memory)return 0;
    if(!g_host->read_memory(lp+0x14u,&width,4u)||!g_host->read_memory(lp+0x18u,&height,4u)||x>=width||y>=height)return 0;
    if(!g_host->read_memory(lp+0x5Cu,&grid,4u)||!grid)return 0;
    address=grid+((y*width+x)*2u);if(!map_pointer_valid(address,2u))return 0;*address_out=address;return 1;
}
static int MH_STDCALL api_map_cell_get(mh_u32 group,mh_u32 layer,mh_u32 x,mh_u32 y,MHCellState *state)
{
    mh_u32 address,defs=0u;mh_u16 raw=0u,word0=0u,id;mh_u8 def[8];mh_u32 i;
    if(!state||!map_cell_address(group,layer,x,y,&address)||!g_host->read_memory(address,&raw,2u))return 0;
    id=(mh_u16)(raw&0x07ffu);if((mh_u32)id>map_max_definition())return 0;if(!g_host->read_memory(MH_DEFINITION_TABLE_PTR,&defs,4u)||!defs)return 0;
    if(!g_host->read_memory(defs+(mh_u32)id*8u,def,8u))return 0;word0=(mh_u16)((mh_u16)def[0]|((mh_u16)def[1]<<8));
    clear_bytes(state,sizeof(*state));state->group=group;state->layer=layer;state->x=x;state->y=y;state->raw_word=raw;state->definition_id=id;state->definition_class=(mh_u16)(word0&0x1e00u);state->runtime_state=(mh_u16)((raw>>11)&0x1fu);
    for(i=0u;i<8u;++i)state->definition[i]=def[i];return 1;
}
static int MH_STDCALL api_map_cell_set_definition(mh_u32 group,mh_u32 layer,mh_u32 x,mh_u32 y,mh_u16 definition_id)
{
    mh_u32 address,defs=0u;mh_u16 raw=0u,next;
    if(definition_id>=2048u||(mh_u32)definition_id>map_max_definition()||!map_cell_address(group,layer,x,y,&address)||!g_host||!g_host->read_memory||!g_host->write_memory)return 0;
    if(!g_host->read_memory(MH_DEFINITION_TABLE_PTR,&defs,4u)||!defs||!g_host->read_memory(address,&raw,2u))return 0;
    next=(mh_u16)((raw&0xf800u)|(definition_id&0x07ffu));return g_host->write_memory(address,&next,2u);
}

static int cell_state_from_pointer(mh_u32 cell_ptr,MHCellState *state)
{
    mh_u32 groups=api_map_group_count(),g,l;
    if(!cell_ptr||!state||!g_host||!g_host->read_memory)return 0;
    for(g=0u;g<groups;++g){
        mh_u32 layers=api_map_layer_count(g);
        for(l=0u;l<layers;++l){
            mh_u32 lp=map_layer_ptr(g,l),width=0u,height=0u,grid=0u,cells,bytes,off,index;
            if(!lp||!g_host->read_memory(lp+0x14u,&width,4u)||!g_host->read_memory(lp+0x18u,&height,4u)||!g_host->read_memory(lp+0x5Cu,&grid,4u)||!grid||!width||!height)continue;
            if(width>4096u||height>4096u||height>0xffffffffu/width)continue;
            cells=width*height;if(cells>0x7fffffffu)continue;bytes=cells*2u;if(bytes>MH_MAP_BUFFER_CAP||!map_pointer_valid(grid,bytes))continue;
            if(cell_ptr<grid||cell_ptr-grid>=bytes)continue;
            off=cell_ptr-grid;if(off&1u)continue;index=off/2u;
            return api_map_cell_get(g,l,index%width,index/width,state);
        }
    }
    return 0;
}
static int MH_STDCALL api_map_entity_cell(MHEntity entity,MHCellState *state)
{
    mh_u32 actor=actor_address(entity),cell=0u;
    if(!actor||!state||!api_entity_exists(entity)||!g_host||!g_host->read_memory)return 0;
    if(!g_host->read_memory(actor+MH_ACTOR_CURRENT_CELL_OFF,&cell,4u)||!cell)return 0;
    return cell_state_from_pointer(cell,state);
}
static mh_u32 player_cell_pointer(MHEntity player)
{
    mh_u32 actor=actor_address(player),cell=0u;
    if(!actor||!api_entity_exists(player)||!g_host||!g_host->read_memory)return 0u;
    if(!g_host->read_memory(actor+MH_ACTOR_CURRENT_CELL_OFF,&cell,4u))return 0u;
    return cell;
}

static int MH_STDCALL api_entity_exists(MHEntity e){mh_u32 a=actor_address(e),active=0;if(!a||!g_host||!g_host->read_memory||!g_host->read_memory(a+MH_ACTOR_ACTIVE_OFF,&active,4u))return 0;return active!=0;}
static mh_u32 MH_STDCALL api_entity_capacity(void){return actor_capacity();}
static mh_u32 MH_STDCALL api_entity_count(void){mh_u32 i,n=0,cap=actor_capacity();for(i=0;i<cap;++i)if(api_entity_exists((MHEntity)(i+1u)))++n;return n;}
static MHEntity MH_STDCALL api_entity_at(mh_u32 wanted){mh_u32 i,seen=0,cap=actor_capacity();for(i=0;i<cap;++i){MHEntity e=(MHEntity)(i+1u);if(!api_entity_exists(e))continue;if(seen++==wanted)return e;}return 0;}
static MHEntity MH_STDCALL api_entity_from_slot(mh_u32 slot){return slot<actor_capacity()?(MHEntity)(slot+1u):0;}
static mh_u32 MH_STDCALL api_entity_slot(MHEntity e){mh_u32 s;if(!e)return MH_INVALID_INDEX;s=(mh_u32)e-1u;return s<actor_capacity()?s:MH_INVALID_INDEX;}
static MHEntity MH_STDCALL api_player(void){mh_u32 address,base,stride,slot;if(!g_host||!g_host->find_player_actor||!g_host->actor_address)return 0;address=g_host->find_player_actor();if(!address)return 0;base=g_host->actor_address(0u);stride=actor_stride();if(!base||!stride||address<base)return 0;slot=(address-base)/stride;if(slot>=actor_capacity()||base+slot*stride!=address)return 0;return(MHEntity)(slot+1u);}
static int MH_STDCALL api_entity_get(MHEntity e,MHEntityState *s){mh_u32 a=actor_address(e),active=0;mh_u16 group=0,facing=0;mh_i32 x=0,y=0,z=0,health=0;if(!a||!s||!g_host||!g_host->read_memory)return 0;if(!g_host->read_memory(a+MH_ACTOR_ACTIVE_OFF,&active,4u)||!active||!g_host->read_memory(a+MH_ACTOR_GROUP_OFF,&group,2u)||!g_host->read_memory(a+MH_ACTOR_POSITION_X_OFF,&x,4u)||!g_host->read_memory(a+MH_ACTOR_POSITION_Y_OFF,&y,4u)||!g_host->read_memory(a+MH_ACTOR_POSITION_Z_OFF,&z,4u)||!g_host->read_memory(a+MH_ACTOR_HEALTH_OFF,&health,4u)||!g_host->read_memory(a+MH_ACTOR_FACING_OFF,&facing,2u))return 0;clear_bytes(s,sizeof(*s));s->entity=e;s->slot=api_entity_slot(e);s->active_type=active&MH_ACTOR_ACTIVE_TYPE_MASK;s->group=(mh_i32)group;s->position.x=x;s->position.y=y;s->position.z=z;s->health=health;s->facing=facing;return 1;}
static int MH_STDCALL api_entity_set_position(MHEntity e,const MHPosition *p){mh_u32 a=actor_address(e);if(!a||!p||!g_host||!g_host->write_memory||!api_entity_exists(e))return 0;if(!g_host->write_memory(a,&p->x,4u)||!g_host->write_memory(a+4u,&p->y,4u))return 0;return g_host->write_memory(a+8u,&p->z,4u);}
static int MH_STDCALL api_entity_set_health(MHEntity e,mh_i32 h){mh_u32 a=actor_address(e);return a&&g_host&&g_host->write_memory&&api_entity_exists(e)?g_host->write_memory(a+MH_ACTOR_HEALTH_OFF,&h,4u):0;}
static int MH_STDCALL api_entity_set_facing(MHEntity e,mh_u16 f){mh_u32 a=actor_address(e);if(!a||!g_host||!g_host->write_memory||!api_entity_exists(e))return 0;f&=(MH_FACING_PERIOD-1u);return g_host->write_memory(a+MH_ACTOR_FACING_OFF,&f,2u);}
static int MH_STDCALL api_entity_despawn(MHEntity e)
{
    mh_u32 a=actor_address(e),slot=api_entity_slot(e);PFN_WorldActorRemove remove_actor;
    if(!a||slot==MH_INVALID_INDEX||slot<8u||!api_entity_exists(e))return 0;
    remove_actor=(PFN_WorldActorRemove)(void *)MH_WORLD_ACTOR_REMOVE;
    remove_actor(a);
    return !api_entity_exists(e);
}
static int MH_STDCALL api_input_down(int k){return(g_host&&g_host->key_down)?g_host->key_down(k):0;}
static int MH_STDCALL api_input_pressed(int k){return(g_host&&g_host->key_pressed)?g_host->key_pressed(k):0;}

static int ascii_equal_ci(const char *a,const char *b)
{
    unsigned char ca,cb;
    if(!a||!b)return 0;
    for(;;){
        ca=(unsigned char)*a++;cb=(unsigned char)*b++;
        if(ca>='a'&&ca<='z')ca=(unsigned char)(ca-'a'+'A');
        if(cb>='a'&&cb<='z')cb=(unsigned char)(cb-'a'+'A');
        if(ca!=cb)return 0;
        if(!ca)return 1;
    }
}
static int MH_STDCALL api_sound_enabled(void){mh_u32 v=0u;return g_host&&g_host->read_memory&&g_host->read_memory(MH_SOUND_ENABLED,&v,4u)&&v!=0u;}
static mh_u32 MH_STDCALL api_sound_retail_count(void){return MH_SOUND_EFFECT_COUNT;}
static int MH_STDCALL api_sound_retail_get(mh_u32 effect_id,MHSoundEffectInfo *info){if(!info||effect_id>=MH_SOUND_EFFECT_COUNT)return 0;info->effect_id=effect_id;info->sample_name=MH_SOUND_EFFECTS[effect_id].sample_name;return 1;}
static mh_u32 MH_STDCALL api_sound_retail_find(const char *sample_name){mh_u32 i;if(!sample_name)return MH_INVALID_INDEX;for(i=0u;i<MH_SOUND_EFFECT_COUNT;++i)if(ascii_equal_ci(sample_name,MH_SOUND_EFFECTS[i].sample_name))return i;return MH_INVALID_INDEX;}
static int sound_play_internal(mh_u32 effect_id,mh_u32 source_ptr,mh_u32 owner_ptr){PFN_SoundPlay fn;mh_u32 result;if(effect_id>=MH_SOUND_EFFECT_COUNT||!api_sound_enabled())return 0;fn=(PFN_SoundPlay)(void *)MH_SOUND_PLAY;result=fn(effect_id,source_ptr,owner_ptr);return result!=0u;}
static int MH_STDCALL api_sound_play_retail(mh_u32 effect_id){return sound_play_internal(effect_id,0u,0u);}
static int MH_STDCALL api_sound_play_retail_entity(mh_u32 effect_id,MHEntity entity){mh_u32 actor=actor_address(entity);if(!actor||!api_entity_exists(entity))return 0;return sound_play_internal(effect_id,actor,actor+MH_ACTOR_ACTIVE_OFF);}
static MHSound MH_STDCALL api_sound_load_wav(const char *package_id,const char *relative_path){return (MHSound)MHSoundLoadWav(package_id,relative_path);}
static int MH_STDCALL api_sound_unload(MHSound sound){return MHSoundUnloadWav((mh_u32)sound);}
static int MH_STDCALL api_sound_play_custom(MHSound sound){return MHSoundPlayWav((mh_u32)sound);}
static int MH_STDCALL api_sound_play_at(MHSound sound,const MHPosition *position){if(!position)return 0;return MHSoundPlayWavAt((mh_u32)sound,position->x,position->y);}
static int MH_STDCALL api_sound_play_entity(MHSound sound,MHEntity entity){mh_u32 actor=actor_address(entity);if(!actor||!api_entity_exists(entity))return 0;return MHSoundPlayWavEntity((mh_u32)sound,actor,actor+MH_ACTOR_ACTIVE_OFF);}
static int MH_STDCALL api_sound_stop_custom(MHSound sound){return MHSoundStopWav((mh_u32)sound);}

static mh_u32 MH_STDCALL api_resource_count(void){return MHResourceCount();}
static int MH_STDCALL api_resource_get(MHResource resource,MHResourceInfo *info)
{
    MHInternalResourceInfo internal;mh_u32 i;
    if(!info||!MHResourceGet((mh_u32)resource,&internal))return 0;
    clear_bytes(info,sizeof(*info));info->resource=(MHResource)internal.resource;info->stored_size=internal.stored_size;info->archive_offset=internal.archive_offset;
    for(i=0u;i+1u<sizeof(info->name)&&internal.name[i];++i)info->name[i]=internal.name[i];info->name[i]=0;
    return 1;
}
static MHResource MH_STDCALL api_resource_find(const char *name){return(MHResource)MHResourceFind(name);}

static mh_u32 MH_STDCALL api_catalog_entity_count(void){return MH_ENTITY_CATALOG_COUNT;}
static mh_u32 MH_STDCALL api_catalog_entity_type_at(mh_u32 i){return i<MH_ENTITY_CATALOG_COUNT?MH_ENTITY_CATALOG_TYPES[i]:MH_INVALID_INDEX;}
static const char *MH_STDCALL api_catalog_entity_name(mh_u32 t){return t<256u?MH_ENTITY_NAMES_BY_TYPE[t]:(const char *)0;}
static mh_u32 MH_STDCALL api_catalog_stage_count(void){return MH_STAGE_CATALOG_COUNT;}
static mh_u32 MH_STDCALL api_catalog_stage_resource_count(mh_u32 level){return level<MH_STAGE_CATALOG_COUNT?MH_STAGE_RESOURCE_COUNTS[level]:0u;}
static int MH_STDCALL api_catalog_stage_resource(mh_u32 level,mh_u32 index,MHStageResourceInfo *info){mh_u32 at;const MHGeneratedStageResource *src;if(!info||level>=MH_STAGE_CATALOG_COUNT||index>=MH_STAGE_RESOURCE_COUNTS[level])return 0;at=MH_STAGE_RESOURCE_OFFSETS[level]+index;if(at>=MH_STAGE_RESOURCE_COUNT)return 0;src=&MH_STAGE_RESOURCES[at];info->level=src->level;info->role=src->role;info->archive_id=src->archive_id;info->name=src->name;return 1;}
static mh_u32 MH_STDCALL api_catalog_stage_sprite_count(mh_u32 level){return level<MH_STAGE_CATALOG_COUNT?MH_STAGE_SPRITE_COUNTS[level]:0u;}
static int MH_STDCALL api_catalog_stage_sprite(mh_u32 level,mh_u32 index,MHStageSpriteBindingInfo *info){mh_u32 at;const MHGeneratedStageSprite *src;if(!info||level>=MH_STAGE_CATALOG_COUNT||index>=MH_STAGE_SPRITE_COUNTS[level])return 0;at=MH_STAGE_SPRITE_OFFSETS[level]+index;if(at>=MH_STAGE_SPRITE_BINDING_COUNT)return 0;src=&MH_STAGE_SPRITES[at];info->level=src->level;info->binding_index=src->binding_index;info->archive_id=src->archive_id;info->runtime_slot=src->runtime_slot;info->name=src->name;return 1;}
static mh_u32 MH_STDCALL api_catalog_ambient_profile_count(mh_u32 level){return level<MH_STAGE_CATALOG_COUNT?MH_AMBIENT_PROFILE_COUNTS[level]:0u;}
static int MH_STDCALL api_catalog_ambient_profile(mh_u32 level,mh_u32 index,MHAmbientProfileInfo *info){mh_u32 at;const MHGeneratedAmbientProfile *src;if(!info||level>=MH_STAGE_CATALOG_COUNT||index>=MH_AMBIENT_PROFILE_COUNTS[level])return 0;at=MH_AMBIENT_PROFILE_OFFSETS[level]+index;if(at>=MH_AMBIENT_PROFILE_COUNT)return 0;src=&MH_AMBIENT_PROFILES[at];clear_bytes(info,sizeof(*info));info->level=src->level;info->selector=src->selector;info->mode=src->mode;info->sound_id=src->sound_id;info->sample_name=src->sample_name;info->base_delay=src->base_delay;info->random_range=src->random_range;info->retail_uses=src->retail_uses;return 1;}

/* ---- runtime, game and input additions */
static mh_u32 MH_STDCALL api_time(void){return(g_host&&g_host->time)?g_host->time():0u;}
static mh_u32 MH_STDCALL api_mod_count(void){return MHPackageCount();}
static int MH_STDCALL api_mod_get(mh_u32 index,MHModInfo *info){const MHPackage *p=MHPackageAt(index);if(!p||!info)return 0;info->id=p->id;info->name=p->name;info->version=p->version;info->author=p->author;info->description=p->description;info->root=p->root;return 1;}
static void MH_STDCALL api_game_skip_startup(int movies,int title){MHStartupSkip(movies,title);}
static void MH_STDCALL api_input_block(mh_u32 controls){MHInputBlock(controls);}
static mh_u32 MH_STDCALL api_input_blocked(void){return MHInputBlocked();}
static int MH_STDCALL api_input_key_code(const char *name){return MHKeyCode(name);}
static const char *MH_STDCALL api_input_key_name(int vk){return MHKeyName(vk);}

/* ---- options */
static MHOption MH_STDCALL api_option_add(const char *mod,const MHOptionSpec *spec){const MHPackage *p=MHPackageFind(mod);if(!p)return MH_INVALID_OPTION;return MHOptionAdd(p->id,p->name,spec);}
static void MH_STDCALL option_listener(MHOption option,mh_i32 value,int action){MHEvent e;event_reset(&e,action?MH_EVENT_ACTION:MH_EVENT_OPTION_CHANGED);e.option=option;e.value=value;dispatch(&e);}

/* ---- engine: the unsafe tier */
static mh_u32 MH_STDCALL api_engine_symbol(const char *name){return(g_host&&name)?g_host->symbol(name):0u;}
static mh_u32 MH_STDCALL api_engine_constant(const char *name){return(g_host&&name)?g_host->constant(name):0u;}
static int MH_STDCALL api_engine_read(mh_u32 address,void *out,mh_u32 size){return g_host?g_host->read_memory(address,out,size):0;}
static int MH_STDCALL api_engine_write(mh_u32 address,const void *data,mh_u32 size){return g_host?g_host->write_memory(address,data,size):0;}
static int MH_STDCALL api_engine_patch(mh_u32 address,const void *expected,const void *replacement,mh_u32 size){return g_host?g_host->patch(address,expected,replacement,size):0;}
static int MH_STDCALL api_engine_detour(mh_u32 address,const void *expected,mh_u32 size,void *hook,void **original){mh_u32 trampoline=0u;if(!g_host||!hook||!g_host->install_detour(address,expected,size,hook,&trampoline))return 0;if(original)*original=(void *)trampoline;return 1;}
static mh_u32 MH_STDCALL api_engine_actor(mh_u32 slot){return(g_host&&g_host->actor_address)?g_host->actor_address(slot):0u;}
static mh_u32 MH_STDCALL api_engine_player_actor(void){return(g_host&&g_host->find_player_actor)?g_host->find_player_actor():0u;}
static int MH_STDCALL api_engine_dump(const char *path,mh_u32 address,mh_u32 size)
{
    char folder[260];mh_u32 i,slash=0u;
    if(!g_host||!path)return 0;
    /* Create the folder the file goes in; one level is enough for logs\<name>. */
    for(i=0u;path[i]&&i+1u<sizeof(folder);++i){folder[i]=path[i];if(path[i]=='\\'||path[i]=='/')slash=i;}
    if(slash){folder[slash]=0;g_host->make_directory(folder);}
    return g_host->dump_memory(path,address,size);
}

static MHAPI g_api={MH_API_VERSION,{api_log,api_frame,api_subscribe,api_unsubscribe,api_time,api_mod_count,api_mod_get},{api_mission,api_level,api_level_name,api_game_state,api_game_set_exit_ready,api_game_set_mission_complete,api_game_grant_access,api_game_revoke_access,api_game_skip_startup},{api_map_loaded,api_map_group,api_map_group_count,api_map_layer_count,api_map_layer_get,api_map_object_count,api_map_object_at,api_map_object_get,api_map_object_set_enabled,api_map_object_spawn,api_map_cell_get,api_map_cell_set_definition,api_map_entity_cell},{api_entity_capacity,api_entity_count,api_entity_at,api_entity_from_slot,api_entity_slot,api_player,api_entity_exists,api_entity_get,api_entity_set_position,api_entity_set_health,api_entity_set_facing,api_entity_despawn},{api_input_down,api_input_pressed,api_input_block,api_input_blocked,api_input_key_code,api_input_key_name},{api_sound_enabled,api_sound_retail_count,api_sound_retail_get,api_sound_retail_find,api_sound_play_retail,api_sound_play_retail_entity,api_sound_load_wav,api_sound_unload,api_sound_play_custom,api_sound_play_at,api_sound_play_entity,api_sound_stop_custom},{api_resource_count,api_resource_get,api_resource_find},{api_catalog_entity_count,api_catalog_entity_type_at,api_catalog_entity_name,api_catalog_stage_count,api_catalog_stage_resource_count,api_catalog_stage_resource,api_catalog_stage_sprite_count,api_catalog_stage_sprite,api_catalog_ambient_profile_count,api_catalog_ambient_profile},
{MHOptionFind,MHOptionGet,MHOptionSet,MHOptionStep,api_option_add,MHOptionCount,MHOptionAt,MHOptionGetInfo,MHOptionChoice,MHOptionText},
{MHDrawSize,MHDrawColor,MHDrawRect,MHDrawShade,MHDrawLine,MHDrawText,MHDrawTextWidth,MHDrawGetTarget},
{MHCameraGet,MHCameraSet,MHCameraPan,MHCameraRelease,MHCameraProject},
{api_engine_symbol,api_engine_constant,api_engine_read,api_engine_write,api_engine_patch,api_engine_detour,api_engine_actor,api_engine_player_actor,api_engine_dump}};

static void dispatch_entity_transitions(mh_u32 level,mh_u32 group)
{
    MHEvent e;mh_u32 i,cap=actor_capacity();
    if(cap>MH_ACTOR_EVENT_CAPACITY)cap=MH_ACTOR_EVENT_CAPACITY;
    for(i=0u;i<cap;++i){
        MHEntity entity=(MHEntity)(i+1u);
        mh_u8 active=(mh_u8)(api_entity_exists(entity)?1u:0u);
        if(active==g_actor_active[i])continue;
        g_actor_active[i]=active;
        event_reset(&e,active?MH_EVENT_ENTITY_CREATED:MH_EVENT_ENTITY_DESTROYED);
        e.level=level;e.group=group;e.entity=entity;dispatch(&e);
    }
}
static void MH_STDCALL api_frame_tick(const MHHostAPI *host)
{
    MHEvent e;MHCellState cell;mh_u32 group,level,cell_ptr;MHEntity player;(void)host;
    group=api_map_group();level=api_level();player=api_player();
    if(g_map_loaded_pending){g_map_loaded_pending=0;g_last_group=group;g_last_player=player;g_last_player_cell_ptr=0u;event_reset(&e,MH_EVENT_MAP_LOADED);e.level=level;e.group=group;e.entity=player;dispatch(&e);}
    dispatch_entity_transitions(level,group);
    if(group!=g_last_group){event_reset(&e,MH_EVENT_GROUP_CHANGED);e.group=group;e.previous_group=g_last_group;e.level=level;g_last_group=group;dispatch(&e);}
    if(player!=g_last_player){event_reset(&e,MH_EVENT_PLAYER_CHANGED);e.entity=player;e.previous_entity=g_last_player;e.group=group;e.level=level;g_last_player=player;g_last_player_cell_ptr=0u;dispatch(&e);}
    cell_ptr=player_cell_pointer(player);
    if(cell_ptr!=g_last_player_cell_ptr){
        g_last_player_cell_ptr=cell_ptr;
        if(cell_ptr&&cell_state_from_pointer(cell_ptr,&cell)){
            event_reset(&e,MH_EVENT_PLAYER_CELL_CHANGED);e.level=level;e.group=group;e.entity=player;e.cell_group=cell.group;e.cell_layer=cell.layer;e.cell_x=cell.x;e.cell_y=cell.y;e.cell_definition=cell.definition_id;e.cell_class=cell.definition_class;dispatch(&e);
        }
    }
    {
        /* The exit pad and the boss endings all hand over through the same
           states, so this one check covers every way a level is won. */
        mh_i32 flow=0; int ending;
        g_host->read_memory(MH_GAME_FLOW_STATE,&flow,4u);
        ending=flow==MH_FLOW_LEVEL_WON||flow==MH_FLOW_LEVEL_END;
        if(ending&&!g_level_ending){event_reset(&e,MH_EVENT_LEVEL_COMPLETE);e.level=level;e.group=group;e.entity=player;dispatch(&e);}
        g_level_ending=ending;
    }
    event_reset(&e,MH_EVENT_FRAME);e.level=level;e.group=group;e.entity=player;dispatch(&e);
}
static mh_u32 MH_CDECL map_initialize_hook(mh_u32 map_ptr)
{
    MHEvent e;mh_u32 result=0;
    event_reset(&e,MH_EVENT_MAP_LOADING);e.level=api_level();dispatch(&e);
    if(g_original_map_initialize)result=g_original_map_initialize(map_ptr);
    MHSwitchesResetKeys();
    g_map_loaded_pending=1;return result;
}
const MHAPI *MH_STDCALL MHAPIGet(void){return &g_api;}
void MH_STDCALL MHAPIDispatchSimple(MHEventType type){MHEvent e;if(!g_initialized)return;event_reset(&e,type);e.level=api_level();e.group=api_map_group();dispatch(&e);}
void MH_STDCALL MHAPIDispatchRuntimeReady(void){MHEvent e;if(!g_initialized||g_runtime_ready)return;g_runtime_ready=1;event_reset(&e,MH_EVENT_RUNTIME_READY);dispatch(&e);}
int MH_STDCALL MHAPIInit(const MHHostAPI *host){static const mh_u8 expected[5]={0x83,0xEC,0x10,0x53,0x55};mh_u32 trampoline=0,i,cap;if(!host||!host->install_detour||!host->register_frame_callback)return 0;g_host=host;clear_bytes(g_listeners,sizeof(g_listeners));clear_bytes(g_actor_active,sizeof(g_actor_active));g_next_subscription=1;g_last_group=api_map_group();g_last_player=api_player();g_last_player_cell_ptr=0u;g_map_loaded_pending=0;cap=actor_capacity();if(cap>MH_ACTOR_EVENT_CAPACITY)cap=MH_ACTOR_EVENT_CAPACITY;for(i=0u;i<cap;++i)g_actor_active[i]=(mh_u8)(api_entity_exists((MHEntity)(i+1u))?1u:0u);if(!host->install_detour(MH_MAP_OBJECTS_INITIALIZE,expected,5u,(void *)&map_initialize_hook,&trampoline)){host->log("MH API: map lifecycle hook failed signature check");return 0;}g_original_map_initialize=(PFN_MapObjectsInitialize)(void *)trampoline;if(!host->register_frame_callback(api_frame_tick)){host->log("MH API: frame callback registration failed");return 0;}MHOptionsSetListener(option_listener);g_initialized=1;host->log("MH API 5 initialized");return 1;}
