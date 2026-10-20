#include "mh_host.h"
#include "mh.h"
#include "MHScriptHost.h"

/* Minimal dynamically-bound Lua 5.4 host. The Machine Hunter runtime remains
   independent of Lua headers/import libraries; runtime/lua54.dll is loaded
   once and every mods\\<id>\\main.lua gets its own lua_State. */

/* MSVC x86 emits a reference to __fltused for floating-point code even
   when no CRT routine is required. Provide the marker locally; the runtime
   intentionally remains CRT-free. */
int _fltused = 0;

typedef void lua_State;
typedef long long lua_Integer;
typedef double lua_Number;
typedef int (*lua_CFunction)(lua_State *L);
typedef long long lua_KContext;
typedef int (*lua_KFunction)(lua_State *L, int status, lua_KContext ctx);

typedef void *MHModule;
typedef void *MHHandle;
typedef int mh_bool;

#define MH_INVALID_HANDLE ((MHHandle)(mh_i32)-1)
#define MH_FILE_ATTRIBUTE_DIRECTORY 0x10u
#define MH_SCRIPT_MAX_MODS MH_PACKAGE_MAX
#define MH_SCRIPT_ID_CAP MH_PACKAGE_ID_CAP
#define MH_SCRIPT_PATH_CAP MH_PACKAGE_PATH_CAP

#define LUA_OK 0
#define LUA_TNIL 0
#define LUA_TBOOLEAN 1
#define LUA_TNUMBER 3
#define LUA_TSTRING 4
#define LUA_TTABLE 5
#define LUA_TFUNCTION 6
#define LUA_REGISTRYINDEX (-1001000)
#define lua_upvalueindex(i) (LUA_REGISTRYINDEX - (i))

typedef struct MHFileTime { mh_u32 lo, hi; } MHFileTime;
typedef struct MHFindDataA {
    mh_u32 attributes;
    MHFileTime creation;
    MHFileTime access;
    MHFileTime write;
    mh_u32 size_high;
    mh_u32 size_low;
    mh_u32 reserved0;
    mh_u32 reserved1;
    char filename[260];
    char alt_filename[14];
} MHFindDataA;

typedef MHModule (MH_STDCALL *PFN_LoadLibraryA)(const char *);
typedef void *(MH_STDCALL *PFN_GetProcAddress)(MHModule, const char *);
typedef MHHandle (MH_STDCALL *PFN_FindFirstFileA)(const char *, MHFindDataA *);
typedef mh_bool (MH_STDCALL *PFN_FindClose)(MHHandle);

typedef lua_State *(*PFN_luaL_newstate)(void);
typedef void (*PFN_luaL_openlibs)(lua_State *L);
typedef void (*PFN_lua_close)(lua_State *L);
typedef int (*PFN_luaL_loadfilex)(lua_State *L, const char *filename, const char *mode);
typedef int (*PFN_lua_pcallk)(lua_State *L, int nargs, int nresults, int errfunc, lua_KContext ctx, lua_KFunction k);
typedef int (*PFN_lua_getglobal)(lua_State *L, const char *name);
typedef void (*PFN_lua_setglobal)(lua_State *L, const char *name);
typedef int (*PFN_lua_getfield)(lua_State *L, int index, const char *k);
typedef void (*PFN_lua_setfield)(lua_State *L, int index, const char *k);
typedef void (*PFN_lua_createtable)(lua_State *L, int narr, int nrec);
typedef void (*PFN_lua_pushcclosure)(lua_State *L, lua_CFunction fn, int n);
typedef const char *(*PFN_lua_pushstring)(lua_State *L, const char *s);
typedef void (*PFN_lua_pushinteger)(lua_State *L, lua_Integer n);
typedef void (*PFN_lua_pushnumber)(lua_State *L, lua_Number n);
typedef void (*PFN_lua_pushboolean)(lua_State *L, int b);
typedef void (*PFN_lua_pushnil)(lua_State *L);
typedef void (*PFN_lua_pushlightuserdata)(lua_State *L, void *p);
typedef const char *(*PFN_lua_tolstring)(lua_State *L, int index, unsigned long *len);
typedef lua_Integer (*PFN_lua_tointegerx)(lua_State *L, int index, int *isnum);
typedef lua_Number (*PFN_lua_tonumberx)(lua_State *L, int index, int *isnum);
typedef void *(*PFN_lua_touserdata)(lua_State *L, int index);
typedef int (*PFN_lua_toboolean)(lua_State *L, int index);
typedef int (*PFN_lua_type)(lua_State *L, int index);
typedef int (*PFN_lua_gettop)(lua_State *L);
typedef void (*PFN_lua_settop)(lua_State *L, int index);
typedef int (*PFN_lua_geti)(lua_State *L, int index, lua_Integer n);
typedef unsigned long (*PFN_lua_rawlen)(lua_State *L, int index);

typedef struct MHLuaFns {
    PFN_luaL_newstate L_newstate;
    PFN_luaL_openlibs L_openlibs;
    PFN_lua_close close;
    PFN_luaL_loadfilex L_loadfilex;
    PFN_lua_pcallk pcallk;
    PFN_lua_getglobal getglobal;
    PFN_lua_setglobal setglobal;
    PFN_lua_getfield getfield;
    PFN_lua_setfield setfield;
    PFN_lua_createtable createtable;
    PFN_lua_pushcclosure pushcclosure;
    PFN_lua_pushstring pushstring;
    PFN_lua_pushinteger pushinteger;
    PFN_lua_pushnumber pushnumber;
    PFN_lua_pushboolean pushboolean;
    PFN_lua_pushnil pushnil;
    PFN_lua_pushlightuserdata pushlightuserdata;
    PFN_lua_tolstring tolstring;
    PFN_lua_tointegerx tointegerx;
    PFN_lua_tonumberx tonumberx;
    PFN_lua_touserdata touserdata;
    PFN_lua_toboolean toboolean;
    PFN_lua_type type;
    PFN_lua_gettop gettop;
    PFN_lua_settop settop;
    PFN_lua_geti geti;
    PFN_lua_rawlen rawlen;
} MHLuaFns;

typedef struct MHScriptMod {
    char id[MH_SCRIPT_ID_CAP];
    lua_State *L;
    int active;
} MHScriptMod;

static const MHHostAPI *g_host;
static const MHAPI *g_api;
static MHLuaFns g_lua;
static MHScriptMod g_scripts[MH_SCRIPT_MAX_MODS];
static mh_u32 g_script_count;
static int g_available;
static MHSubscription g_event_subscription;
static PFN_FindFirstFileA g_find_first;
static PFN_FindClose g_find_close;
static PFN_GetProcAddress g_get_proc;

/* The script a call comes from. Inside a coroutine L is that coroutine's
   thread, not the state the script was loaded into, so the script is found
   through the registry, which every thread of a state shares. */
static MHScriptMod *script_for_state(lua_State *L);
#define MH_SCRIPT_REGISTRY_KEY "mh.script"

static int copy_text(char *out, mh_u32 cap, const char *src)
{
    mh_u32 i=0u;
    if (!out || !cap || !src) return 0;
    while (src[i]) { if (i+1u>=cap) return 0; out[i]=src[i]; ++i; }
    out[i]=0; return 1;
}


static void lua_pop_n(lua_State *L, int n)
{
    g_lua.settop(L, -n-1);
}

static MHScriptMod *script_for_state(lua_State *L)
{
    int ok=0; lua_Integer index;
    g_lua.getfield(L,LUA_REGISTRYINDEX,MH_SCRIPT_REGISTRY_KEY);
    index=g_lua.tointegerx(L,-1,&ok);
    lua_pop_n(L,1);
    if(!ok||index<1||index>(lua_Integer)g_script_count)return (MHScriptMod *)0;
    return &g_scripts[(mh_u32)index-1u];
}

static void log_lua_error(lua_State *L, const char *prefix)
{
    const char *text = g_lua.tolstring(L,-1,(unsigned long *)0);
    if (prefix) g_host->log(prefix);
    if (text) g_host->log(text);
    lua_pop_n(L,1);
}

static void *proc_any(MHModule module, const char *name)
{
    char decorated[96];
    void *p;
    mh_u32 i=0u;
    p=g_get_proc(module,name);
    if (p) return p;
    decorated[i++]='_';
    while (*name && i+1u<sizeof(decorated)) decorated[i++]=*name++;
    decorated[i]=0;
    return g_get_proc(module,decorated);
}

#define RESOLVE(field,type,name) do { g_lua.field=(type)proc_any(lua_module,name); if(!g_lua.field) return 0; } while(0)
static int resolve_lua(MHModule lua_module)
{
    RESOLVE(L_newstate,PFN_luaL_newstate,"luaL_newstate");
    RESOLVE(L_openlibs,PFN_luaL_openlibs,"luaL_openlibs");
    RESOLVE(close,PFN_lua_close,"lua_close");
    RESOLVE(L_loadfilex,PFN_luaL_loadfilex,"luaL_loadfilex");
    RESOLVE(pcallk,PFN_lua_pcallk,"lua_pcallk");
    RESOLVE(getglobal,PFN_lua_getglobal,"lua_getglobal");
    RESOLVE(setglobal,PFN_lua_setglobal,"lua_setglobal");
    RESOLVE(getfield,PFN_lua_getfield,"lua_getfield");
    RESOLVE(setfield,PFN_lua_setfield,"lua_setfield");
    RESOLVE(createtable,PFN_lua_createtable,"lua_createtable");
    RESOLVE(pushcclosure,PFN_lua_pushcclosure,"lua_pushcclosure");
    RESOLVE(pushstring,PFN_lua_pushstring,"lua_pushstring");
    RESOLVE(pushinteger,PFN_lua_pushinteger,"lua_pushinteger");
    RESOLVE(pushnumber,PFN_lua_pushnumber,"lua_pushnumber");
    RESOLVE(pushboolean,PFN_lua_pushboolean,"lua_pushboolean");
    RESOLVE(pushnil,PFN_lua_pushnil,"lua_pushnil");
    RESOLVE(pushlightuserdata,PFN_lua_pushlightuserdata,"lua_pushlightuserdata");
    RESOLVE(tolstring,PFN_lua_tolstring,"lua_tolstring");
    RESOLVE(tointegerx,PFN_lua_tointegerx,"lua_tointegerx");
    RESOLVE(tonumberx,PFN_lua_tonumberx,"lua_tonumberx");
    RESOLVE(touserdata,PFN_lua_touserdata,"lua_touserdata");
    RESOLVE(toboolean,PFN_lua_toboolean,"lua_toboolean");
    RESOLVE(type,PFN_lua_type,"lua_type");
    RESOLVE(gettop,PFN_lua_gettop,"lua_gettop");
    RESOLVE(settop,PFN_lua_settop,"lua_settop");
    RESOLVE(geti,PFN_lua_geti,"lua_geti");
    RESOLVE(rawlen,PFN_lua_rawlen,"lua_rawlen");
    return 1;
}
#undef RESOLVE

static int arg_integer(lua_State *L, int index, mh_i32 *out)
{
    int ok=0; lua_Integer value=g_lua.tointegerx(L,index,&ok);
    if (!ok || !out) return 0; *out=(mh_i32)value; return 1;
}

static int arg_number(lua_State *L, int index, lua_Number *out)
{
    int ok=0; lua_Number value=g_lua.tonumberx(L,index,&ok);
    if (!ok || !out) return 0; *out=value; return 1;
}

static int l_runtime_log(lua_State *L)
{
    const char *text=g_lua.tolstring(L,1,(unsigned long *)0);
    if (text) g_api->runtime.log(text);
    return 0;
}
static int l_runtime_frame(lua_State *L) { g_lua.pushinteger(L,(lua_Integer)g_api->runtime.frame()); return 1; }
static int l_game_mission(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->game.mission());return 1;}
static int l_game_level(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->game.level());return 1;}
static int l_game_level_name(lua_State *L)
{
    mh_i32 level=(mh_i32)g_api->game.level();const char *name;
    if(g_lua.gettop(L)>=1&&!arg_integer(L,1,&level)){g_lua.pushnil(L);return 1;}
    name=g_api->game.level_name((MHU32)level);if(name)g_lua.pushstring(L,name);else g_lua.pushnil(L);return 1;
}
static void set_table_integer(lua_State *L,const char *name,lua_Integer value){g_lua.pushinteger(L,value);g_lua.setfield(L,-2,name);}
static void set_table_number(lua_State *L,const char *name,lua_Number value){g_lua.pushnumber(L,value);g_lua.setfield(L,-2,name);}
static void set_table_string(lua_State *L,const char *name,const char *value){g_lua.pushstring(L,value?value:"");g_lua.setfield(L,-2,name);}
/* The game's flow state: 1 menus, 10 playing, 12 paused (more for briefings and level ends). */
static int l_game_flow(lua_State *L){mh_i32 flow=0;if(!g_host->read_memory(0x004AF8CCu,&flow,4u)){g_lua.pushnil(L);return 1;}g_lua.pushinteger(L,flow);return 1;}
static int l_game_state(lua_State *L){MHGameState st;if(!g_api->game.state(&st)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,12);set_table_integer(L,"difficulty",st.difficulty);set_table_integer(L,"access_mask",st.access_mask);set_table_integer(L,"exit_ready",st.exit_ready);set_table_integer(L,"mission_complete",st.mission_complete);set_table_integer(L,"kills",st.kills);set_table_integer(L,"kills_total",st.kills_total);set_table_integer(L,"rescues",st.rescues);set_table_integer(L,"rescues_total",st.rescues_total);set_table_integer(L,"items",st.items);set_table_integer(L,"items_total",st.items_total);set_table_integer(L,"secrets",st.secrets);set_table_integer(L,"secrets_total",st.secrets_total);return 1;}
static int l_game_set_exit_ready(lua_State *L){g_lua.pushboolean(L,g_api->game.set_exit_ready(g_lua.toboolean(L,1)!=0));return 1;}
static int l_game_set_mission_complete(lua_State *L){g_lua.pushboolean(L,g_api->game.set_mission_complete(g_lua.toboolean(L,1)!=0));return 1;}
static int l_game_grant_access(lua_State *L){mh_i32 mask;if(!arg_integer(L,1,&mask)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->game.grant_access((MHU32)mask));return 1;}
static int l_game_revoke_access(lua_State *L){mh_i32 mask;if(!arg_integer(L,1,&mask)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->game.revoke_access((MHU32)mask));return 1;}

static int l_map_loaded(lua_State *L){g_lua.pushboolean(L,g_api->map.loaded());return 1;}
static int l_map_group(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->map.group());return 1;}
static int l_map_group_count(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->map.group_count());return 1;}
static int l_map_layer_count(lua_State *L){mh_i32 group;if(!arg_integer(L,1,&group)){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->map.layer_count((MHU32)group));return 1;}
static int l_map_layer_get(lua_State *L){mh_i32 group,layer;MHLayerInfo info;if(!arg_integer(L,1,&group)||!arg_integer(L,2,&layer)||!g_api->map.layer_get((MHU32)group,(MHU32)layer,&info)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,6);set_table_integer(L,"group",info.group);set_table_integer(L,"layer",info.layer);set_table_integer(L,"origin_x",info.origin_x);set_table_integer(L,"origin_y",info.origin_y);set_table_integer(L,"width",info.width);set_table_integer(L,"height",info.height);return 1;}
static int l_map_object_count(lua_State *L){mh_i32 group,layer;if(!arg_integer(L,1,&group)||!arg_integer(L,2,&layer)){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->map.object_count((MHU32)group,(MHU32)layer));return 1;}
static int l_map_object_at(lua_State *L){mh_i32 group,layer,index;if(!arg_integer(L,1,&group)||!arg_integer(L,2,&layer)||!arg_integer(L,3,&index)){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->map.object_at((MHU32)group,(MHU32)layer,(MHU32)index));return 1;}
static int l_map_object_get(lua_State *L){mh_i32 object;MHMapObjectState state;if(!arg_integer(L,1,&object)||!g_api->map.object_get((MHMapObject)object,&state)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,12);set_table_integer(L,"id",state.object);set_table_integer(L,"group",state.group);set_table_integer(L,"layer",state.layer);set_table_integer(L,"type",state.map_type);set_table_integer(L,"behavior",state.behavior_selector);set_table_integer(L,"weapon",state.weapon_selector);set_table_integer(L,"flags",state.flags);set_table_number(L,"x",(lua_Number)state.position.x/(lua_Number)MH_WORLD_ONE);set_table_number(L,"y",(lua_Number)state.position.y/(lua_Number)MH_WORLD_ONE);set_table_number(L,"z",(lua_Number)state.position.z/(lua_Number)MH_WORLD_ONE);set_table_integer(L,"cached_health",state.cached_health);set_table_integer(L,"entity",state.entity);return 1;}
static int l_map_object_set_enabled(lua_State *L){mh_i32 object;if(!arg_integer(L,1,&object)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->map.object_set_enabled((MHMapObject)object,g_lua.toboolean(L,2)));return 1;}
static int l_map_object_spawn(lua_State *L){mh_i32 object;if(!arg_integer(L,1,&object)){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->map.object_spawn((MHMapObject)object));return 1;}
static int l_map_cell_get(lua_State *L){mh_i32 group,layer,x,y;MHCellState st;mh_u32 i;if(!arg_integer(L,1,&group)||!arg_integer(L,2,&layer)||!arg_integer(L,3,&x)||!arg_integer(L,4,&y)||!g_api->map.cell_get((MHU32)group,(MHU32)layer,(MHU32)x,(MHU32)y,&st)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,9);set_table_integer(L,"group",st.group);set_table_integer(L,"layer",st.layer);set_table_integer(L,"x",st.x);set_table_integer(L,"y",st.y);set_table_integer(L,"raw",st.raw_word);set_table_integer(L,"definition",st.definition_id);set_table_integer(L,"class",st.definition_class);set_table_integer(L,"runtime_state",st.runtime_state);g_lua.createtable(L,8,0);for(i=0u;i<8u;++i){g_lua.pushinteger(L,(lua_Integer)st.definition[i]);g_lua.setfield(L,-2,(i==0u)?"b0":(i==1u)?"b1":(i==2u)?"b2":(i==3u)?"b3":(i==4u)?"b4":(i==5u)?"b5":(i==6u)?"b6":"b7");}g_lua.setfield(L,-2,"definition_bytes");return 1;}
static int l_map_cell_set_definition(lua_State *L){mh_i32 group,layer,x,y,def;if(!arg_integer(L,1,&group)||!arg_integer(L,2,&layer)||!arg_integer(L,3,&x)||!arg_integer(L,4,&y)||!arg_integer(L,5,&def)||def<0){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->map.cell_set_definition((MHU32)group,(MHU32)layer,(MHU32)x,(MHU32)y,(MHU16)def));return 1;}
static int l_map_entity_cell(lua_State *L){mh_i32 entity;MHCellState st;mh_u32 i;if(!arg_integer(L,1,&entity)||entity<=0||!g_api->map.entity_cell((MHEntity)entity,&st)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,9);set_table_integer(L,"group",st.group);set_table_integer(L,"layer",st.layer);set_table_integer(L,"x",st.x);set_table_integer(L,"y",st.y);set_table_integer(L,"raw",st.raw_word);set_table_integer(L,"definition",st.definition_id);set_table_integer(L,"class",st.definition_class);set_table_integer(L,"runtime_state",st.runtime_state);g_lua.createtable(L,8,0);for(i=0u;i<8u;++i){g_lua.pushinteger(L,(lua_Integer)st.definition[i]);g_lua.setfield(L,-2,(i==0u)?"b0":(i==1u)?"b1":(i==2u)?"b2":(i==3u)?"b3":(i==4u)?"b4":(i==5u)?"b5":(i==6u)?"b6":"b7");}g_lua.setfield(L,-2,"definition_bytes");return 1;}

static int l_entities_capacity(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->entities.capacity());return 1;}
static int l_entities_count(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->entities.count());return 1;}
static int l_entities_from_slot(lua_State *L){mh_i32 slot;if(!arg_integer(L,1,&slot)||slot<0){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->entities.from_slot((MHU32)slot));return 1;}
static int l_entities_slot(lua_State *L){mh_i32 entity;if(!arg_integer(L,1,&entity)||entity<=0){g_lua.pushinteger(L,(lua_Integer)MH_INVALID_INDEX);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->entities.slot((MHEntity)entity));return 1;}
static int l_entities_at(lua_State *L){mh_i32 index;if(!arg_integer(L,1,&index)){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->entities.at((MHU32)index));return 1;}
static int l_entities_player(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->entities.player());return 1;}
static int l_entities_exists(lua_State *L){mh_i32 entity;if(!arg_integer(L,1,&entity)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->entities.exists((MHEntity)entity));return 1;}
static int l_entities_get(lua_State *L){mh_i32 entity;MHEntityState state;if(!arg_integer(L,1,&entity)||!g_api->entities.get((MHEntity)entity,&state)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,10);set_table_integer(L,"id",state.entity);set_table_integer(L,"slot",state.slot);set_table_integer(L,"active_type",state.active_type);set_table_integer(L,"group",state.group);set_table_number(L,"x",(lua_Number)state.position.x/(lua_Number)MH_WORLD_ONE);set_table_number(L,"y",(lua_Number)state.position.y/(lua_Number)MH_WORLD_ONE);set_table_number(L,"z",(lua_Number)state.position.z/(lua_Number)MH_WORLD_ONE);set_table_integer(L,"health",state.health);set_table_integer(L,"facing",state.facing);return 1;}
static int l_entities_set_health(lua_State *L){mh_i32 entity,health;if(!arg_integer(L,1,&entity)||!arg_integer(L,2,&health)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->entities.set_health((MHEntity)entity,health));return 1;}
static int l_entities_set_facing(lua_State *L){mh_i32 entity,facing;if(!arg_integer(L,1,&entity)||!arg_integer(L,2,&facing)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->entities.set_facing((MHEntity)entity,(MHU16)facing));return 1;}
static int l_entities_set_position(lua_State *L){mh_i32 entity;lua_Number x,y,z;MHPosition pos;if(!arg_integer(L,1,&entity)||!arg_number(L,2,&x)||!arg_number(L,3,&y)||!arg_number(L,4,&z)){g_lua.pushboolean(L,0);return 1;}pos.x=(MHI32)(x*(lua_Number)MH_WORLD_ONE);pos.y=(MHI32)(y*(lua_Number)MH_WORLD_ONE);pos.z=(MHI32)(z*(lua_Number)MH_WORLD_ONE);g_lua.pushboolean(L,g_api->entities.set_position((MHEntity)entity,&pos));return 1;}
static int l_entities_despawn(lua_State *L){mh_i32 entity;if(!arg_integer(L,1,&entity)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->entities.despawn((MHEntity)entity));return 1;}
static int l_input_down(lua_State *L){mh_i32 key;if(!arg_integer(L,1,&key)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->input.down((int)key));return 1;}
static int l_input_pressed(lua_State *L){mh_i32 key;if(!arg_integer(L,1,&key)){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->input.pressed((int)key));return 1;}


static int l_sound_enabled(lua_State *L){g_lua.pushboolean(L,g_api->sound.enabled());return 1;}
static int l_sound_retail_count(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->sound.retail_count());return 1;}
static int l_sound_retail_get(lua_State *L){mh_i32 id;MHSoundEffectInfo info;if(!arg_integer(L,1,&id)||id<0||!g_api->sound.retail_get((MHU32)id,&info)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,2);set_table_integer(L,"id",info.effect_id);set_table_string(L,"sample",info.sample_name);return 1;}
static int l_sound_retail_find(lua_State *L){const char *name=g_lua.tolstring(L,1,(unsigned long *)0);MHU32 id;if(!name){g_lua.pushnil(L);return 1;}id=g_api->sound.retail_find(name);if(id==MH_INVALID_INDEX)g_lua.pushnil(L);else g_lua.pushinteger(L,(lua_Integer)id);return 1;}
static int l_sound_play_retail(lua_State *L){mh_i32 id;if(!arg_integer(L,1,&id)||id<0){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->sound.play_retail((MHU32)id));return 1;}
static int l_sound_play_retail_entity(lua_State *L){mh_i32 id,entity;if(!arg_integer(L,1,&id)||!arg_integer(L,2,&entity)||id<0||entity<=0){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->sound.play_retail_entity((MHU32)id,(MHEntity)entity));return 1;}
static int l_sound_load(lua_State *L){const char *path=g_lua.tolstring(L,1,(unsigned long *)0);MHScriptMod *mod=script_for_state(L);MHSound sound;if(!path||!mod){g_lua.pushnil(L);return 1;}sound=g_api->sound.load_wav(mod->id,path);if(sound==MH_INVALID_SOUND)g_lua.pushnil(L);else g_lua.pushinteger(L,(lua_Integer)sound);return 1;}
static int l_sound_unload(lua_State *L){mh_i32 sound;if(!arg_integer(L,1,&sound)||sound<=0){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->sound.unload((MHSound)sound));return 1;}
static int l_sound_play_custom(lua_State *L){mh_i32 sound;if(!arg_integer(L,1,&sound)||sound<=0){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->sound.play((MHSound)sound));return 1;}
static int l_sound_play_at(lua_State *L){mh_i32 sound;lua_Number x,y;MHPosition p;if(!arg_integer(L,1,&sound)||sound<=0||!arg_number(L,2,&x)||!arg_number(L,3,&y)){g_lua.pushboolean(L,0);return 1;}p.x=(MHI32)(x*(lua_Number)MH_WORLD_ONE);p.y=(MHI32)(y*(lua_Number)MH_WORLD_ONE);p.z=0;g_lua.pushboolean(L,g_api->sound.play_at((MHSound)sound,&p));return 1;}
static int l_sound_play_entity(lua_State *L){mh_i32 sound,entity;if(!arg_integer(L,1,&sound)||!arg_integer(L,2,&entity)||sound<=0||entity<=0){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->sound.play_entity((MHSound)sound,(MHEntity)entity));return 1;}
static int l_sound_stop_custom(lua_State *L){mh_i32 sound;if(!arg_integer(L,1,&sound)||sound<=0){g_lua.pushboolean(L,0);return 1;}g_lua.pushboolean(L,g_api->sound.stop((MHSound)sound));return 1;}

static int l_resources_count(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->resources.count());return 1;}
static int l_resources_get(lua_State *L)
{
    mh_i32 resource;MHResourceInfo info;
    if(!arg_integer(L,1,&resource)||resource<0||!g_api->resources.get((MHResource)resource,&info)){g_lua.pushnil(L);return 1;}
    g_lua.createtable(L,0,4);set_table_integer(L,"id",info.resource);set_table_string(L,"name",info.name);set_table_integer(L,"stored_size",info.stored_size);set_table_integer(L,"archive_offset",info.archive_offset);return 1;
}
static int l_resources_find(lua_State *L)
{
    const char *name=g_lua.tolstring(L,1,(unsigned long *)0);MHResource resource;
    if(!name){g_lua.pushnil(L);return 1;}resource=g_api->resources.find(name);
    if(resource==MH_INVALID_RESOURCE)g_lua.pushnil(L);else g_lua.pushinteger(L,(lua_Integer)resource);return 1;
}

static int l_catalog_entity_count(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->catalog.entity_count());return 1;}
static int l_catalog_entity_type_at(lua_State *L){mh_i32 index;if(!arg_integer(L,1,&index)){g_lua.pushnil(L);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->catalog.entity_type_at((MHU32)index));return 1;}
static int l_catalog_entity_name(lua_State *L){mh_i32 type;const char *name;if(!arg_integer(L,1,&type)){g_lua.pushnil(L);return 1;}name=g_api->catalog.entity_name((MHU32)type);if(name)g_lua.pushstring(L,name);else g_lua.pushnil(L);return 1;}
static int l_catalog_stage_count(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->catalog.stage_count());return 1;}
static int l_catalog_stage_resource_count(lua_State *L){mh_i32 level;if(!arg_integer(L,1,&level)){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->catalog.stage_resource_count((MHU32)level));return 1;}
static int l_catalog_stage_resource(lua_State *L){mh_i32 level,index;MHStageResourceInfo info;if(!arg_integer(L,1,&level)||!arg_integer(L,2,&index)||!g_api->catalog.stage_resource((MHU32)level,(MHU32)index,&info)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,4);set_table_integer(L,"level",info.level);set_table_string(L,"role",info.role);set_table_integer(L,"archive_id",info.archive_id);set_table_string(L,"name",info.name);return 1;}
static int l_catalog_stage_sprite_count(lua_State *L){mh_i32 level;if(!arg_integer(L,1,&level)){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->catalog.stage_sprite_count((MHU32)level));return 1;}
static int l_catalog_stage_sprite(lua_State *L){mh_i32 level,index;MHStageSpriteBindingInfo info;if(!arg_integer(L,1,&level)||!arg_integer(L,2,&index)||!g_api->catalog.stage_sprite((MHU32)level,(MHU32)index,&info)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,5);set_table_integer(L,"level",info.level);set_table_integer(L,"binding_index",info.binding_index);set_table_integer(L,"archive_id",info.archive_id);set_table_integer(L,"runtime_slot",info.runtime_slot);set_table_string(L,"name",info.name);return 1;}
static int l_catalog_ambient_profile_count(lua_State *L){mh_i32 level;if(!arg_integer(L,1,&level)){g_lua.pushinteger(L,0);return 1;}g_lua.pushinteger(L,(lua_Integer)g_api->catalog.ambient_profile_count((MHU32)level));return 1;}
static int l_catalog_ambient_profile(lua_State *L){mh_i32 level,index;MHAmbientProfileInfo info;if(!arg_integer(L,1,&level)||!arg_integer(L,2,&index)||!g_api->catalog.ambient_profile((MHU32)level,(MHU32)index,&info)){g_lua.pushnil(L);return 1;}g_lua.createtable(L,0,8);set_table_integer(L,"level",info.level);set_table_integer(L,"selector",info.selector);set_table_integer(L,"mode",info.mode);set_table_integer(L,"sound_id",info.sound_id);if(info.sample_name)set_table_string(L,"sample_name",info.sample_name);set_table_integer(L,"base_delay",info.base_delay);set_table_integer(L,"random_range",info.random_range);set_table_integer(L,"retail_uses",info.retail_uses);return 1;}

/* ---- API 5: time, options, drawing, camera. Lua sees cells where C sees world units. */
/* Copy as much as fits; the result is always terminated. */
static void text_fit(char *out,mh_u32 cap,const char *src){mh_u32 i=0u;while(src&&src[i]&&i+1u<cap){out[i]=src[i];++i;}out[i]=0;}
static int text_same(const char *a,const char *b){if(!a||!b)return 0;while(*a&&*a==*b){++a;++b;}return *a==*b;}
static int text_same_i(const char *a,const char *b)
{
    if(!a||!b)return 0;
    for(;;){int ca=(unsigned char)*a++,cb=(unsigned char)*b++;if(ca>='A'&&ca<='Z')ca+=32;if(cb>='A'&&cb<='Z')cb+=32;if(ca!=cb)return 0;if(!ca)return 1;}
}
/* A number argument as a whole pixel or unit; fractions are dropped. */
static int arg_whole(lua_State *L,int index,mh_i32 *out)
{
    lua_Number value;
    if(!arg_number(L,index,&value)||value>2000000000.0||value<-2000000000.0)return 0;
    *out=(mh_i32)value;return 1;
}
static mh_i32 cells_to_world(lua_Number cells){return (mh_i32)(cells*(lua_Number)MH_WORLD_ONE);}

static int l_runtime_time(lua_State *L){g_lua.pushinteger(L,(lua_Integer)g_api->runtime.time());return 1;}
static int l_runtime_mods(lua_State *L)
{
    MHU32 i,count=g_api->runtime.mod_count();MHModInfo info;
    /* Keyed by mod id, so a script can ask mh.runtime.mods()["mod-menu"]. */
    g_lua.createtable(L,0,(int)count);
    for(i=0u;i<count;++i){
        if(!g_api->runtime.mod_get(i,&info))continue;
        g_lua.createtable(L,0,3);set_table_string(L,"id",info.id);set_table_string(L,"name",info.name);set_table_string(L,"version",info.version);
        g_lua.setfield(L,-2,info.id);
    }
    return 1;
}
static int l_game_skip_startup(lua_State *L){g_api->game.skip_startup(g_lua.toboolean(L,1),g_lua.toboolean(L,2));return 0;}

static int l_input_block(lua_State *L)
{
    const char *what=g_lua.tolstring(L,1,(unsigned long *)0);
    g_api->input.block(what&&text_same_i(what,"move")?MH_CONTROLS_MOVE:MH_CONTROLS_ALL);return 0;
}
/* True while a menu has the keyboard (every control is blocked). */
static int l_input_blocked(lua_State *L){g_lua.pushboolean(L,g_api->input.blocked()==MH_CONTROLS_ALL);return 1;}
static int l_input_key_code(lua_State *L)
{
    const char *name=g_lua.tolstring(L,1,(unsigned long *)0);int vk=name?g_api->input.key_code(name):-1;
    if(vk<0)g_lua.pushnil(L);else g_lua.pushinteger(L,(lua_Integer)vk);return 1;
}
static int l_input_key_name(lua_State *L){mh_i32 key;if(!arg_integer(L,1,&key)){g_lua.pushnil(L);return 1;}g_lua.pushstring(L,g_api->input.key_name((int)key));return 1;}

/* mh.options.get("key") reads this mod's option; mh.options.get("other-mod","key") another mod's. */
static MHOption option_argument(lua_State *L,int *value_index)
{
    MHScriptMod *mod=script_for_state(L);
    const char *a=g_lua.tolstring(L,1,(unsigned long *)0),*b;
    int two=g_lua.gettop(L)>=*value_index+2;
    if(!a||!mod)return MH_INVALID_OPTION;
    if(!two){*value_index=2;return g_api->options.find(mod->id,a);}
    b=g_lua.tolstring(L,2,(unsigned long *)0);*value_index=3;
    return b?g_api->options.find(a,b):MH_INVALID_OPTION;
}
static void push_option_value(lua_State *L,const MHOptionInfo *info)
{
    if(info->type==MH_OPTION_TOGGLE)g_lua.pushboolean(L,info->value!=0);
    else if(info->type==MH_OPTION_CHOICE){const char *text=g_api->options.choice(info->option,(MHU32)info->value);g_lua.pushstring(L,text?text:"");}
    else if(info->type==MH_OPTION_ACTION)g_lua.pushnil(L);
    else g_lua.pushinteger(L,(lua_Integer)info->value);
}
static int l_options_get(lua_State *L)
{
    int value_index=0;MHOptionInfo info;MHOption option=option_argument(L,&value_index);
    if(!option||!g_api->options.info(option,&info)){g_lua.pushnil(L);return 1;}
    push_option_value(L,&info);return 1;
}
static int l_options_set(lua_State *L)
{
    int value_index=1,type;MHOptionInfo info;mh_i32 value=0;MHU32 i;const char *text;
    MHOption option=option_argument(L,&value_index);
    if(!option||!g_api->options.info(option,&info)){g_lua.pushboolean(L,0);return 1;}
    type=g_lua.type(L,value_index);
    if(type==LUA_TBOOLEAN)value=g_lua.toboolean(L,value_index)!=0;
    else if(type==LUA_TNUMBER){if(!arg_whole(L,value_index,&value)){g_lua.pushboolean(L,0);return 1;}}
    else if(type==LUA_TSTRING){
        text=g_lua.tolstring(L,value_index,(unsigned long *)0);value=-1;
        if(info.type==MH_OPTION_CHOICE){for(i=0u;i<info.choice_count;++i)if(text_same_i(text,g_api->options.choice(option,i)))value=(mh_i32)i;}
        else if(info.type==MH_OPTION_KEY)value=g_api->input.key_code(text);
        if(value<0){g_lua.pushboolean(L,0);return 1;}
    }
    else{g_lua.pushboolean(L,0);return 1;}
    g_lua.pushboolean(L,g_api->options.set(option,value));return 1;
}
static int field_integer(lua_State *L,const char *name,mh_i32 *out)
{
    int ok=0;
    if(g_lua.getfield(L,1,name)==LUA_TNUMBER)ok=arg_whole(L,-1,out);
    lua_pop_n(L,1);return ok;
}
static int field_flag(lua_State *L,const char *name,int fallback)
{
    int value=fallback;
    if(g_lua.getfield(L,1,name)==LUA_TBOOLEAN)value=g_lua.toboolean(L,-1);
    lua_pop_n(L,1);return value;
}
static void field_text(lua_State *L,const char *name,char *out,mh_u32 cap)
{
    const char *text;out[0]=0;
    if(g_lua.getfield(L,1,name)==LUA_TSTRING){text=g_lua.tolstring(L,-1,(unsigned long *)0);text_fit(out,cap,text);}
    lua_pop_n(L,1);
}
/* mh.options.add{ key=..., label=..., type="toggle"|"choice"|"number"|"key"|"action", ... } */
static int l_options_add(lua_State *L)
{
    static char choice_text[16][25];
    const char *choice_list[16];
    char key[41],label[41],section[25],type[12],default_text[25];
    MHOptionSpec spec;MHScriptMod *mod=script_for_state(L);MHU32 count=0u,i;int default_type;
    if(!mod||g_lua.type(L,1)!=LUA_TTABLE){g_lua.pushboolean(L,0);return 1;}
    field_text(L,"key",key,sizeof(key));field_text(L,"label",label,sizeof(label));
    field_text(L,"section",section,sizeof(section));field_text(L,"type",type,sizeof(type));
    spec.key=key;spec.label=label;spec.section=section;spec.flags=0u;spec.default_value=0;spec.min=0;spec.max=100;spec.step=1;
    if(text_same(type,"toggle"))spec.type=MH_OPTION_TOGGLE;
    else if(text_same(type,"choice"))spec.type=MH_OPTION_CHOICE;
    else if(text_same(type,"number"))spec.type=MH_OPTION_NUMBER;
    else if(text_same(type,"key"))spec.type=MH_OPTION_KEY;
    else if(text_same(type,"action"))spec.type=MH_OPTION_ACTION;
    else{g_lua.pushboolean(L,0);return 1;}
    (void)field_integer(L,"min",&spec.min);(void)field_integer(L,"max",&spec.max);(void)field_integer(L,"step",&spec.step);
    if(field_flag(L,"restart",0))spec.flags|=MH_OPTION_RESTART;
    if(field_flag(L,"hidden",0))spec.flags|=MH_OPTION_HIDDEN;
    if(!field_flag(L,"saved",1))spec.flags|=MH_OPTION_SESSION;
    if(g_lua.getfield(L,1,"choices")==LUA_TTABLE){
        MHU32 length=(MHU32)g_lua.rawlen(L,-1);
        for(i=1u;i<=length&&count<16u;++i){
            const char *text;
            g_lua.geti(L,-1,(lua_Integer)i);text=g_lua.tolstring(L,-1,(unsigned long *)0);
            if(text){text_fit(choice_text[count],sizeof(choice_text[count]),text);choice_list[count]=choice_text[count];++count;}
            lua_pop_n(L,1);
        }
    }
    lua_pop_n(L,1);
    spec.choices=choice_list;spec.choice_count=count;
    default_type=g_lua.getfield(L,1,"default");
    if(default_type==LUA_TBOOLEAN)spec.default_value=g_lua.toboolean(L,-1)!=0;
    else if(default_type==LUA_TNUMBER)(void)arg_whole(L,-1,&spec.default_value);
    else if(default_type==LUA_TSTRING){
        text_fit(default_text,sizeof(default_text),g_lua.tolstring(L,-1,(unsigned long *)0));
        if(spec.type==MH_OPTION_CHOICE){for(i=0u;i<count;++i)if(text_same_i(default_text,choice_text[i]))spec.default_value=(mh_i32)i;}
        else if(spec.type==MH_OPTION_KEY){int vk=g_api->input.key_code(default_text);spec.default_value=vk<0?0:vk;}
    }
    lua_pop_n(L,1);
    g_lua.pushboolean(L,g_api->options.add(mod->id,&spec)!=MH_INVALID_OPTION);return 1;
}

static int l_draw_size(lua_State *L){MHI32 w=0,h=0;if(!g_api->draw.size(&w,&h)){g_lua.pushnil(L);return 1;}g_lua.pushinteger(L,(lua_Integer)w);g_lua.pushinteger(L,(lua_Integer)h);return 2;}
/* mh.draw.color(r, g, b) or mh.draw.color(0xRRGGBB) */
static int l_draw_color(lua_State *L)
{
    mh_i32 r=0,g=0,b=0;MHU32 rgb;
    if(!arg_whole(L,1,&r)){g_lua.pushinteger(L,0);return 1;}
    if(g_lua.gettop(L)>=3&&arg_whole(L,2,&g)&&arg_whole(L,3,&b))rgb=(((MHU32)r&255u)<<16)|(((MHU32)g&255u)<<8)|((MHU32)b&255u);
    else rgb=(MHU32)r;
    g_lua.pushinteger(L,(lua_Integer)g_api->draw.color(rgb));return 1;
}
static int l_draw_rect(lua_State *L){mh_i32 x,y,w,h,c;if(arg_whole(L,1,&x)&&arg_whole(L,2,&y)&&arg_whole(L,3,&w)&&arg_whole(L,4,&h)&&arg_whole(L,5,&c))g_api->draw.rect(x,y,w,h,(MHU32)c);return 0;}
static int l_draw_shade(lua_State *L){mh_i32 x,y,w,h,p=60;if(arg_whole(L,1,&x)&&arg_whole(L,2,&y)&&arg_whole(L,3,&w)&&arg_whole(L,4,&h)){(void)arg_whole(L,5,&p);g_api->draw.shade(x,y,w,h,(MHU32)(p<0?0:p));}return 0;}
static int l_draw_line(lua_State *L){mh_i32 x0,y0,x1,y1,c;if(arg_whole(L,1,&x0)&&arg_whole(L,2,&y0)&&arg_whole(L,3,&x1)&&arg_whole(L,4,&y1)&&arg_whole(L,5,&c))g_api->draw.line(x0,y0,x1,y1,(MHU32)c);return 0;}
static int l_draw_text(lua_State *L)
{
    mh_i32 x,y,c,scale=1;const char *text=g_lua.tolstring(L,3,(unsigned long *)0);
    if(!arg_whole(L,1,&x)||!arg_whole(L,2,&y)||!text||!arg_whole(L,4,&c)){g_lua.pushinteger(L,0);return 1;}
    (void)arg_whole(L,5,&scale);
    g_lua.pushinteger(L,(lua_Integer)g_api->draw.text(x,y,text,(MHU32)c,(MHU32)(scale<1?1:scale)));return 1;
}
static int l_draw_text_width(lua_State *L)
{
    mh_i32 scale=1;const char *text=g_lua.tolstring(L,1,(unsigned long *)0);
    (void)arg_whole(L,2,&scale);
    g_lua.pushinteger(L,(lua_Integer)(text?g_api->draw.text_width(text,(MHU32)(scale<1?1:scale)):0));return 1;
}

static int l_camera_get(lua_State *L)
{
    MHCameraState state;
    if(!g_api->camera.get(&state)){g_lua.pushnil(L);return 1;}
    g_lua.createtable(L,0,6);
    set_table_number(L,"x",(lua_Number)state.position.x/(lua_Number)MH_WORLD_ONE);
    set_table_number(L,"y",(lua_Number)state.position.y/(lua_Number)MH_WORLD_ONE);
    set_table_number(L,"z",(lua_Number)state.position.z/(lua_Number)MH_WORLD_ONE);
    set_table_number(L,"zoom",(lua_Number)state.zoom/(lua_Number)MH_ZOOM_ONE);
    set_table_integer(L,"yaw",state.yaw);
    g_lua.pushboolean(L,state.overridden!=0);g_lua.setfield(L,-2,"overridden");
    return 1;
}
/* mh.camera.set(x, y [, zoom]): zoom 1 is the game's normal view, 0.25 to 2 allowed. */
static int l_camera_set(lua_State *L)
{
    lua_Number x,y,zoom=0.0;MHPosition position;
    if(!arg_number(L,1,&x)||!arg_number(L,2,&y)){g_lua.pushboolean(L,0);return 1;}
    (void)arg_number(L,3,&zoom);
    position.x=cells_to_world(x);position.y=cells_to_world(y);position.z=0;
    g_lua.pushboolean(L,g_api->camera.set(&position,zoom>0.0?(MHI32)(zoom*(lua_Number)MH_ZOOM_ONE):0));return 1;
}
static int l_camera_pan(lua_State *L)
{
    lua_Number right,down;
    if(!arg_number(L,1,&right)||!arg_number(L,2,&down)){g_lua.pushboolean(L,0);return 1;}
    g_lua.pushboolean(L,g_api->camera.pan(cells_to_world(right),cells_to_world(down)));return 1;
}
static int l_camera_release(lua_State *L){(void)L;g_api->camera.release();return 0;}
static int l_camera_project(lua_State *L)
{
    lua_Number x,y,z=0.0;MHPosition position;MHI32 sx=0,sy=0;
    if(!arg_number(L,1,&x)||!arg_number(L,2,&y)){g_lua.pushnil(L);return 1;}
    (void)arg_number(L,3,&z);
    position.x=cells_to_world(x);position.y=cells_to_world(y);position.z=cells_to_world(z);
    if(!g_api->camera.project(&position,&sx,&sy)){g_lua.pushnil(L);return 1;}
    g_lua.pushinteger(L,(lua_Integer)sx);g_lua.pushinteger(L,(lua_Integer)sy);return 2;
}

static void table_function(lua_State *L,const char *name,lua_CFunction fn){g_lua.pushcclosure(L,fn,0);g_lua.setfield(L,-2,name);}
static void register_mh(lua_State *L,const MHPackage *package)
{
    g_lua.createtable(L,0,8);
    g_lua.pushinteger(L,(lua_Integer)MH_API_VERSION);g_lua.setfield(L,-2,"api_version");
    g_lua.createtable(L,0,6);set_table_string(L,"id",package->id);set_table_string(L,"name",package->name);set_table_string(L,"version",package->version);set_table_string(L,"author",package->author);set_table_string(L,"description",package->description);set_table_string(L,"root",package->root);g_lua.setfield(L,-2,"mod");
    g_lua.createtable(L,0,4);table_function(L,"log",l_runtime_log);table_function(L,"frame",l_runtime_frame);table_function(L,"time",l_runtime_time);table_function(L,"mods",l_runtime_mods);g_lua.setfield(L,-2,"runtime");
    g_lua.createtable(L,0,9);table_function(L,"flow",l_game_flow);table_function(L,"mission",l_game_mission);table_function(L,"level",l_game_level);table_function(L,"level_name",l_game_level_name);table_function(L,"state",l_game_state);table_function(L,"set_exit_ready",l_game_set_exit_ready);table_function(L,"set_mission_complete",l_game_set_mission_complete);table_function(L,"grant_access",l_game_grant_access);table_function(L,"revoke_access",l_game_revoke_access);table_function(L,"skip_startup",l_game_skip_startup);g_lua.setfield(L,-2,"game");
    g_lua.createtable(L,0,13);table_function(L,"loaded",l_map_loaded);table_function(L,"group",l_map_group);table_function(L,"group_count",l_map_group_count);table_function(L,"layer_count",l_map_layer_count);table_function(L,"layer_get",l_map_layer_get);table_function(L,"object_count",l_map_object_count);table_function(L,"object_at",l_map_object_at);table_function(L,"object_get",l_map_object_get);table_function(L,"object_set_enabled",l_map_object_set_enabled);table_function(L,"object_spawn",l_map_object_spawn);table_function(L,"cell_get",l_map_cell_get);table_function(L,"cell_set_definition",l_map_cell_set_definition);table_function(L,"entity_cell",l_map_entity_cell);g_lua.setfield(L,-2,"map");
    g_lua.createtable(L,0,12);table_function(L,"capacity",l_entities_capacity);table_function(L,"count",l_entities_count);table_function(L,"at",l_entities_at);table_function(L,"from_slot",l_entities_from_slot);table_function(L,"slot",l_entities_slot);table_function(L,"player",l_entities_player);table_function(L,"exists",l_entities_exists);table_function(L,"get",l_entities_get);table_function(L,"set_position",l_entities_set_position);table_function(L,"set_health",l_entities_set_health);table_function(L,"set_facing",l_entities_set_facing);table_function(L,"despawn",l_entities_despawn);g_lua.setfield(L,-2,"entities");
    g_lua.createtable(L,0,6);table_function(L,"down",l_input_down);table_function(L,"pressed",l_input_pressed);table_function(L,"block",l_input_block);table_function(L,"blocked",l_input_blocked);table_function(L,"key_code",l_input_key_code);table_function(L,"key_name",l_input_key_name);g_lua.setfield(L,-2,"input");
    g_lua.createtable(L,0,12);table_function(L,"enabled",l_sound_enabled);table_function(L,"retail_count",l_sound_retail_count);table_function(L,"retail_get",l_sound_retail_get);table_function(L,"retail_find",l_sound_retail_find);table_function(L,"play_retail",l_sound_play_retail);table_function(L,"play_retail_entity",l_sound_play_retail_entity);table_function(L,"load_wav",l_sound_load);table_function(L,"unload",l_sound_unload);table_function(L,"play",l_sound_play_custom);table_function(L,"play_at",l_sound_play_at);table_function(L,"play_entity",l_sound_play_entity);table_function(L,"stop",l_sound_stop_custom);g_lua.setfield(L,-2,"sound");
    g_lua.createtable(L,0,3);table_function(L,"count",l_resources_count);table_function(L,"get",l_resources_get);table_function(L,"find",l_resources_find);g_lua.setfield(L,-2,"resources");
    g_lua.createtable(L,0,10);table_function(L,"entity_count",l_catalog_entity_count);table_function(L,"entity_type_at",l_catalog_entity_type_at);table_function(L,"entity_name",l_catalog_entity_name);table_function(L,"stage_count",l_catalog_stage_count);table_function(L,"stage_resource_count",l_catalog_stage_resource_count);table_function(L,"stage_resource",l_catalog_stage_resource);table_function(L,"stage_sprite_count",l_catalog_stage_sprite_count);table_function(L,"stage_sprite",l_catalog_stage_sprite);table_function(L,"ambient_profile_count",l_catalog_ambient_profile_count);table_function(L,"ambient_profile",l_catalog_ambient_profile);g_lua.setfield(L,-2,"catalog");
    g_lua.createtable(L,0,3);table_function(L,"get",l_options_get);table_function(L,"set",l_options_set);table_function(L,"add",l_options_add);g_lua.setfield(L,-2,"options");
    g_lua.createtable(L,0,7);table_function(L,"size",l_draw_size);table_function(L,"color",l_draw_color);table_function(L,"rect",l_draw_rect);table_function(L,"shade",l_draw_shade);table_function(L,"line",l_draw_line);table_function(L,"text",l_draw_text);table_function(L,"text_width",l_draw_text_width);g_lua.setfield(L,-2,"draw");
    g_lua.createtable(L,0,5);table_function(L,"get",l_camera_get);table_function(L,"set",l_camera_set);table_function(L,"pan",l_camera_pan);table_function(L,"release",l_camera_release);table_function(L,"project",l_camera_project);g_lua.setfield(L,-2,"camera");
    g_lua.setglobal(L,"mh");
}

static const char *event_function_name(MHEventType type)
{
    if(type==MH_EVENT_RUNTIME_READY)return "on_runtime_ready";
    if(type==MH_EVENT_FRAME)return "on_frame";
    if(type==MH_EVENT_MAP_LOADING)return "on_map_loading";
    if(type==MH_EVENT_MAP_LOADED)return "on_map_loaded";
    if(type==MH_EVENT_GROUP_CHANGED)return "on_group_changed";
    if(type==MH_EVENT_PLAYER_CHANGED)return "on_player_changed";
    if(type==MH_EVENT_ENTITY_CREATED)return "on_entity_created";
    if(type==MH_EVENT_ENTITY_DESTROYED)return "on_entity_destroyed";
    if(type==MH_EVENT_PLAYER_CELL_CHANGED)return "on_player_cell_changed";
    if(type==MH_EVENT_OPTION_CHANGED)return "on_option_changed";
    if(type==MH_EVENT_ACTION)return "on_action";
    if(type==MH_EVENT_DRAW)return "on_draw";
    if(type==MH_EVENT_DRAW_OVERLAY)return "on_draw_overlay";
    if(type==MH_EVENT_LEVEL_COMPLETE)return "on_level_complete";
    return (const char *)0;
}

static void push_event(lua_State *L,const MHEvent *event)
{
    g_lua.createtable(L,0,13);
    set_table_integer(L,"type",event->type);
    set_table_integer(L,"frame",event->frame);
    set_table_integer(L,"level",event->level);
    set_table_integer(L,"group",event->group);
    set_table_integer(L,"previous_group",event->previous_group);
    set_table_integer(L,"entity",event->entity);
    set_table_integer(L,"previous_entity",event->previous_entity);
    set_table_integer(L,"cell_group",event->cell_group);
    set_table_integer(L,"cell_layer",event->cell_layer);
    set_table_integer(L,"cell_x",event->cell_x);
    set_table_integer(L,"cell_y",event->cell_y);
    set_table_integer(L,"cell_definition",event->cell_definition);
    set_table_integer(L,"cell_class",event->cell_class);
    if(event->type==MH_EVENT_OPTION_CHANGED||event->type==MH_EVENT_ACTION){
        MHOptionInfo info;
        if(g_api->options.info(event->option,&info)){
            set_table_string(L,"mod",info.mod);set_table_string(L,"key",info.key);
            push_option_value(L,&info);g_lua.setfield(L,-2,"value");
        }
    }
}

static void call_event(MHScriptMod *mod,const MHEvent *event)
{
    const char *name; lua_State *L;
    if(!mod||!mod->active||!mod->L||!event)return;
    name=event_function_name(event->type); if(!name)return; L=mod->L;
    if(g_lua.getglobal(L,name)!=LUA_TFUNCTION){lua_pop_n(L,1);return;}
    push_event(L,event);
    if(g_lua.pcallk(L,1,0,0,0,(lua_KFunction)0)!=LUA_OK){
        log_lua_error(L,"MH Lua callback error; script disabled");
        if(mod->id[0])g_host->log(mod->id);
        mod->active=0;
    }
}

static void MH_STDCALL on_event(const MHAPI *api,const MHEvent *event,void *context)
{
    mh_u32 i; MHOptionInfo info; const char *owner=(const char *)0; (void)api; (void)context;
    /* A script hears about its own mod's options only. */
    if(event->type==MH_EVENT_OPTION_CHANGED||event->type==MH_EVENT_ACTION){
        if(!g_api->options.info(event->option,&info))return;
        owner=info.mod;
    }
    for(i=0u;i<g_script_count;++i){
        if(owner&&!text_same(owner,g_scripts[i].id))continue;
        call_event(&g_scripts[i],event);
    }
}

static int script_exists(const char *path)
{
    MHFindDataA fd; MHHandle h;
    if(!g_find_first||!g_find_close)return 0;
    h=g_find_first(path,&fd); if(h==MH_INVALID_HANDLE)return 0; g_find_close(h);
    return !(fd.attributes & MH_FILE_ATTRIBUTE_DIRECTORY);
}

int MH_STDCALL MHScriptHostTryLoad(const MHPackage *package)
{
    char path[MH_SCRIPT_PATH_CAP]; lua_State *L; MHScriptMod *mod;
    if(!g_available||!package)return 0;
    if(!MHPackagePath(package,MH_PACKAGE_SCRIPT_ENTRY,path,sizeof(path)))return -1;
    if(!script_exists(path))return 0;
    if(g_script_count>=MH_SCRIPT_MAX_MODS){g_host->log("MH Lua: script mod limit reached");return -1;}
    L=g_lua.L_newstate(); if(!L){g_host->log("MH Lua: luaL_newstate failed");return -1;}
    mod=&g_scripts[g_script_count++];copy_text(mod->id,sizeof(mod->id),package->id);mod->L=L;mod->active=0;
    g_lua.L_openlibs(L);
    g_lua.pushinteger(L,(lua_Integer)g_script_count);g_lua.setfield(L,LUA_REGISTRYINDEX,MH_SCRIPT_REGISTRY_KEY);
    register_mh(L,package);
    if(g_lua.L_loadfilex(L,path,(const char *)0)!=LUA_OK){log_lua_error(L,"MH Lua load error");g_lua.close(L);--g_script_count;mod->L=(lua_State *)0;return -1;}
    if(g_lua.pcallk(L,0,0,0,0,(lua_KFunction)0)!=LUA_OK){log_lua_error(L,"MH Lua initialization error");g_lua.close(L);--g_script_count;mod->L=(lua_State *)0;return -1;}
    mod->active=1;
    g_host->log("MH Lua: loaded script mod"); g_host->log(package->id); return 1;
}

int MH_STDCALL MHScriptHostInit(const MHHostAPI *host,const MHAPI *api)
{
    PFN_LoadLibraryA load_library; MHModule lua_module;
    if(!host||!api||!host->symbol||!host->log)return 0;
    g_host=host; g_api=api; g_script_count=0u; g_available=0;
    load_library=(PFN_LoadLibraryA)(void *)host->symbol("win32.load_library_a");
    g_get_proc=(PFN_GetProcAddress)(void *)host->symbol("win32.get_proc_address");
    g_find_first=(PFN_FindFirstFileA)(void *)host->symbol("win32.find_first_file_a");
    g_find_close=(PFN_FindClose)(void *)host->symbol("win32.find_close");
    if(!load_library||!g_get_proc||!g_find_first||!g_find_close)return 0;
    lua_module=load_library("lua54.dll");
    if(!lua_module){host->log("MH Lua: lua54.dll not found; script mods disabled");return 1;}
    if(!resolve_lua(lua_module)){host->log("MH Lua: lua54.dll is missing required Lua 5.4 exports");return 1;}
    g_event_subscription=api->runtime.subscribe(MH_EVENT_MASK_ALL,on_event,(void *)0);
    if(!g_event_subscription){host->log("MH Lua: could not subscribe to runtime events");return 0;}
    g_available=1; host->log("MH Lua: script host initialized"); return 1;
}
