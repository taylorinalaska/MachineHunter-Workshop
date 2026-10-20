#ifndef MACHINE_HUNTER_SDK_H
#define MACHINE_HUNTER_SDK_H

/* Machine Hunter public C API (see docs/MODDING.md).

   A native mod is a mod.dll that exports MHModInit. Everything up to
   `camera` is the safe tier and is mirrored in Lua under the global `mh`.
   `engine` is the unsafe tier: named addresses, memory access and detours
   into the retail executable, for mods that change the game itself. */
#ifdef __cplusplus
extern "C" {
#endif

#include "mh_contract.h"

#if defined(_MSC_VER) || defined(__clang__)
#define MH_STDCALL __stdcall
#define MH_EXPORT __declspec(dllexport)
#else
#define MH_STDCALL
#define MH_EXPORT
#endif

typedef unsigned char  MHU8;
typedef unsigned short MHU16;
typedef unsigned long  MHU32;
typedef signed short   MHI16;
typedef signed long    MHI32;

typedef MHU32 MHEntity;
typedef MHU32 MHMapObject;
typedef MHU32 MHSubscription;
typedef MHU32 MHResource;
typedef MHU32 MHSound;
typedef MHU32 MHOption;
#define MH_INVALID_ENTITY ((MHEntity)0u)
#define MH_INVALID_MAP_OBJECT ((MHMapObject)0u)
#define MH_INVALID_SUBSCRIPTION ((MHSubscription)0u)
#define MH_INVALID_INDEX 0xffffffffu
#define MH_INVALID_RESOURCE ((MHResource)MH_INVALID_INDEX)
#define MH_INVALID_SOUND ((MHSound)0u)
#define MH_INVALID_OPTION ((MHOption)0u)

typedef struct MHPosition { MHI32 x,y,z; } MHPosition;
#define MH_WORLD_FROM_CELL(v) ((MHI32)((v) * (MHI32)MH_WORLD_ONE))
#define MH_WORLD_TO_CELL(v) ((MHI32)((v) / (MHI32)MH_WORLD_ONE))

typedef struct MHEvent {
    MHEventType type; MHU32 frame,level,group,previous_group; MHEntity entity,previous_entity;
    MHU32 cell_group,cell_layer,cell_x,cell_y; MHU16 cell_definition,cell_class;
    MHOption option; MHI32 value;   /* OPTION_CHANGED and ACTION */
} MHEvent;

typedef struct MHEntityState {
    MHEntity entity; MHU32 slot,active_type; MHI32 group; MHPosition position; MHI32 health; MHU16 facing,reserved;
} MHEntityState;

typedef struct MHLayerInfo {
    MHU32 group,layer; MHI32 origin_x,origin_y; MHU32 width,height;
} MHLayerInfo;

typedef struct MHCellState {
    MHU32 group,layer,x,y;
    MHU16 raw_word,definition_id,definition_class,runtime_state;
    MHU8 definition[8];
} MHCellState;

typedef struct MHMapObjectState {
    MHMapObject object; MHU32 group,layer,map_type,behavior_selector,weapon_selector,flags;
    MHPosition position; MHI32 cached_health; MHEntity entity;
} MHMapObjectState;

typedef struct MHModInfo {
    const char *id,*name,*version,*author,*description,*root;
} MHModInfo;

struct MHAPI;
typedef void (MH_STDCALL *MHEventCallback)(const struct MHAPI *mh,const MHEvent *event,void *context);

typedef struct MHGameState {
    MHU32 difficulty,access_mask,exit_ready,mission_complete;
    MHU16 kills,kills_total,rescues,rescues_total,items,items_total,secrets,secrets_total;
} MHGameState;

typedef struct MHRuntimeAPI {
    void (MH_STDCALL *log)(const char *text);
    MHU32 (MH_STDCALL *frame)(void);
    MHSubscription (MH_STDCALL *subscribe)(MHU32 event_mask,MHEventCallback callback,void *context);
    int (MH_STDCALL *unsubscribe)(MHSubscription subscription);
    MHU32 (MH_STDCALL *time)(void);                          /* milliseconds, for timing only */
    MHU32 (MH_STDCALL *mod_count)(void);                     /* mods loaded this run */
    int (MH_STDCALL *mod_get)(MHU32 index,MHModInfo *info);
} MHRuntimeAPI;

typedef struct MHGameAPI {
    MHU32 (MH_STDCALL *mission)(void);
    MHU32 (MH_STDCALL *level)(void);
    const char *(MH_STDCALL *level_name)(MHU32 level);
    int (MH_STDCALL *state)(MHGameState *state);
    int (MH_STDCALL *set_exit_ready)(int ready);
    int (MH_STDCALL *set_mission_complete)(int complete);
    int (MH_STDCALL *grant_access)(MHU32 mask);
    int (MH_STDCALL *revoke_access)(MHU32 mask);
    /* Skip the logo/intro movies and/or the PRESS START title loop. Call while the mod loads. */
    void (MH_STDCALL *skip_startup)(int movies,int title);
} MHGameAPI;

typedef struct MHMapAPI {
    int (MH_STDCALL *loaded)(void);
    MHU32 (MH_STDCALL *group)(void);
    MHU32 (MH_STDCALL *group_count)(void);
    MHU32 (MH_STDCALL *layer_count)(MHU32 group);
    int (MH_STDCALL *layer_get)(MHU32 group,MHU32 layer,MHLayerInfo *info);
    MHU32 (MH_STDCALL *object_count)(MHU32 group,MHU32 layer);
    MHMapObject (MH_STDCALL *object_at)(MHU32 group,MHU32 layer,MHU32 index);
    int (MH_STDCALL *object_get)(MHMapObject object,MHMapObjectState *state);
    int (MH_STDCALL *object_set_enabled)(MHMapObject object,int enabled);
    MHEntity (MH_STDCALL *object_spawn)(MHMapObject object);
    int (MH_STDCALL *cell_get)(MHU32 group,MHU32 layer,MHU32 x,MHU32 y,MHCellState *state);
    int (MH_STDCALL *cell_set_definition)(MHU32 group,MHU32 layer,MHU32 x,MHU32 y,MHU16 definition_id);
    int (MH_STDCALL *entity_cell)(MHEntity entity,MHCellState *state);
} MHMapAPI;

typedef struct MHEntitiesAPI {
    MHU32 (MH_STDCALL *capacity)(void);
    MHU32 (MH_STDCALL *count)(void);
    MHEntity (MH_STDCALL *at)(MHU32 active_index);
    MHEntity (MH_STDCALL *from_slot)(MHU32 slot);
    MHU32 (MH_STDCALL *slot)(MHEntity entity);
    MHEntity (MH_STDCALL *player)(void);
    int (MH_STDCALL *exists)(MHEntity entity);
    int (MH_STDCALL *get)(MHEntity entity,MHEntityState *state);
    int (MH_STDCALL *set_position)(MHEntity entity,const MHPosition *position);
    int (MH_STDCALL *set_health)(MHEntity entity,MHI32 health);
    int (MH_STDCALL *set_facing)(MHEntity entity,MHU16 facing);
    int (MH_STDCALL *despawn)(MHEntity entity);
} MHEntitiesAPI;

#define MH_CONTROLS_MOVE 0x000Fu   /* the four directions */
#define MH_CONTROLS_ALL  0xFFFFu

typedef struct MHInputAPI {
    int (MH_STDCALL *down)(int virtual_key);
    int (MH_STDCALL *pressed)(int virtual_key);
    /* Hide controls from the game for the next frame; call every frame while a menu or tool owns the keyboard. */
    void (MH_STDCALL *block)(MHU32 controls);
    /* What is blocked right now. MH_CONTROLS_ALL means a menu has the keyboard: leave your own hotkeys alone. */
    MHU32 (MH_STDCALL *blocked)(void);
    int (MH_STDCALL *key_code)(const char *name);            /* "F3", "UP", "A", "0x72"; -1 if unknown */
    const char *(MH_STDCALL *key_name)(int virtual_key);
} MHInputAPI;

typedef struct MHStageResourceInfo { MHU32 level; const char *role; MHU32 archive_id; const char *name; } MHStageResourceInfo;
typedef struct MHStageSpriteBindingInfo { MHU32 level,binding_index,archive_id,runtime_slot; const char *name; } MHStageSpriteBindingInfo;
typedef struct MHResourceInfo {
    MHResource resource;
    char name[16];
    MHU32 stored_size;
    MHU32 archive_offset;
} MHResourceInfo;

typedef struct MHSoundEffectInfo {
    MHU32 effect_id;
    const char *sample_name;
} MHSoundEffectInfo;

typedef struct MHAmbientProfileInfo {
    MHU32 level,selector,mode,sound_id;
    const char *sample_name;
    MHU16 base_delay,random_range;
    MHU32 retail_uses;
} MHAmbientProfileInfo;

typedef struct MHSoundAPI {
    int (MH_STDCALL *enabled)(void);
    MHU32 (MH_STDCALL *retail_count)(void);
    int (MH_STDCALL *retail_get)(MHU32 effect_id,MHSoundEffectInfo *info);
    MHU32 (MH_STDCALL *retail_find)(const char *sample_name);
    int (MH_STDCALL *play_retail)(MHU32 effect_id);
    int (MH_STDCALL *play_retail_entity)(MHU32 effect_id,MHEntity entity);
    MHSound (MH_STDCALL *load_wav)(const char *package_id,const char *relative_path);
    int (MH_STDCALL *unload)(MHSound sound);
    int (MH_STDCALL *play)(MHSound sound);
    int (MH_STDCALL *play_at)(MHSound sound,const MHPosition *position);
    int (MH_STDCALL *play_entity)(MHSound sound,MHEntity entity);
    int (MH_STDCALL *stop)(MHSound sound);
} MHSoundAPI;

typedef struct MHResourcesAPI {
    MHU32 (MH_STDCALL *count)(void);
    int (MH_STDCALL *get)(MHResource resource,MHResourceInfo *info);
    MHResource (MH_STDCALL *find)(const char *name);
} MHResourcesAPI;


typedef struct MHCatalogAPI {
    MHU32 (MH_STDCALL *entity_count)(void);
    MHU32 (MH_STDCALL *entity_type_at)(MHU32 index);
    const char *(MH_STDCALL *entity_name)(MHU32 map_type);
    MHU32 (MH_STDCALL *stage_count)(void);
    MHU32 (MH_STDCALL *stage_resource_count)(MHU32 level);
    int (MH_STDCALL *stage_resource)(MHU32 level,MHU32 index,MHStageResourceInfo *info);
    MHU32 (MH_STDCALL *stage_sprite_count)(MHU32 level);
    int (MH_STDCALL *stage_sprite)(MHU32 level,MHU32 index,MHStageSpriteBindingInfo *info);
    MHU32 (MH_STDCALL *ambient_profile_count)(MHU32 level);
    int (MH_STDCALL *ambient_profile)(MHU32 level,MHU32 index,MHAmbientProfileInfo *info);
} MHCatalogAPI;

/* ---- options: settings a mod declares in mod.json. They are saved in
   mods/settings.cfg, editable in the Workshop, and listed by the Mod Menu. */
#define MH_OPTION_TOGGLE 0u   /* value 0 or 1 */
#define MH_OPTION_CHOICE 1u   /* value is an index into the choices */
#define MH_OPTION_NUMBER 2u   /* value between min and max */
#define MH_OPTION_KEY    3u   /* value is a virtual-key code, 0 for none */
#define MH_OPTION_ACTION 4u   /* no value: something to run */

#define MH_OPTION_RESTART 0x0001u   /* takes effect the next time the game starts */
#define MH_OPTION_SESSION 0x0002u   /* not saved: back to its default every launch */
#define MH_OPTION_HIDDEN  0x0004u   /* not listed in menus */
#define MH_OPTION_PENDING 0x0100u   /* reported only: a RESTART option changed since launch */

typedef struct MHOptionSpec {
    const char *key,*label,*section;                         /* section 0: the mod's name */
    MHU32 type,flags;
    MHI32 default_value,min,max,step;
    const char *const *choices; MHU32 choice_count;
} MHOptionSpec;

typedef struct MHOptionInfo {
    MHOption option;
    const char *mod,*section,*key,*label;
    MHU32 type,flags;
    MHI32 value,default_value,min,max,step;
    MHU32 choice_count;
} MHOptionInfo;

typedef struct MHOptionsAPI {
    MHOption (MH_STDCALL *find)(const char *mod,const char *key);
    MHI32 (MH_STDCALL *get)(MHOption option);
    int (MH_STDCALL *set)(MHOption option,MHI32 value);      /* saves it and sends OPTION_CHANGED */
    int (MH_STDCALL *step)(MHOption option,int direction);   /* next/previous value; runs an ACTION */
    MHOption (MH_STDCALL *add)(const char *mod,const MHOptionSpec *spec);  /* an option not declared in mod.json */
    MHU32 (MH_STDCALL *count)(void);                         /* every option of every loaded mod */
    MHOption (MH_STDCALL *at)(MHU32 index);
    int (MH_STDCALL *info)(MHOption option,MHOptionInfo *info);
    const char *(MH_STDCALL *choice)(MHOption option,MHU32 index);
    int (MH_STDCALL *text)(MHOption option,char *out,MHU32 capacity);      /* the value as shown to a player */
} MHOptionsAPI;

/* ---- draw: on top of the finished frame, during DRAW / DRAW_OVERLAY events.
   The frame is 8-bit; `color` picks the closest palette entry to 0xRRGGBB. */
typedef struct MHDrawTarget { MHU8 *pixels; MHI32 width,height,pitch; const MHU8 *palette; /* 256 x blue,green,red,0 */ } MHDrawTarget;

typedef struct MHDrawAPI {
    int (MH_STDCALL *size)(MHI32 *width,MHI32 *height);
    MHU32 (MH_STDCALL *color)(MHU32 rgb);
    void (MH_STDCALL *rect)(MHI32 x,MHI32 y,MHI32 width,MHI32 height,MHU32 color);
    void (MH_STDCALL *shade)(MHI32 x,MHI32 y,MHI32 width,MHI32 height,MHU32 percent);   /* darken */
    void (MH_STDCALL *line)(MHI32 x0,MHI32 y0,MHI32 x1,MHI32 y1,MHU32 color);
    MHI32 (MH_STDCALL *text)(MHI32 x,MHI32 y,const char *text,MHU32 color,MHU32 scale); /* 6x8 cells; returns the x after it */
    MHI32 (MH_STDCALL *text_width)(const char *text,MHU32 scale);
    int (MH_STDCALL *target)(MHDrawTarget *target);          /* the frame itself, for mods that plot their own pixels */
} MHDrawAPI;

/* ---- camera */
#define MH_ZOOM_ONE 16384L
#define MH_ZOOM_MIN 4096L
#define MH_ZOOM_MAX 32768L

typedef struct MHCameraState { MHPosition position; MHI32 zoom; MHU16 yaw,overridden; } MHCameraState;

typedef struct MHCameraAPI {
    int (MH_STDCALL *get)(MHCameraState *state);
    int (MH_STDCALL *set)(const MHPosition *position,MHI32 zoom);   /* take the view until release(); zoom 0 keeps the game's */
    int (MH_STDCALL *pan)(MHI32 right,MHI32 down);                  /* move it in screen directions, in world units */
    void (MH_STDCALL *release)(void);
    int (MH_STDCALL *project)(const MHPosition *world,MHI32 *screen_x,MHI32 *screen_y);
} MHCameraAPI;

/* ---- engine: the unsafe tier. Addresses are for the one supported retail
   executable; `symbol` and `constant` name the ones already identified
   (research/ADDRESSES.csv lists far more). Every patch and detour states the
   bytes it expects, so a mismatch fails instead of corrupting the game. */
typedef struct MHEngineAPI {
    MHU32 (MH_STDCALL *symbol)(const char *name);            /* a named address, 0 if unknown */
    MHU32 (MH_STDCALL *constant)(const char *name);          /* a named offset or size */
    int (MH_STDCALL *read)(MHU32 address,void *out,MHU32 size);
    int (MH_STDCALL *write)(MHU32 address,const void *data,MHU32 size);
    /* Replace bytes after checking them. Works on code another mod has detoured. */
    int (MH_STDCALL *patch)(MHU32 address,const void *expected,const void *replacement,MHU32 size);
    /* Redirect a function to `hook`; *original then calls what was there (the game, or an earlier mod's hook). */
    int (MH_STDCALL *detour)(MHU32 address,const void *expected,MHU32 size,void *hook,void **original);
    MHU32 (MH_STDCALL *actor)(MHU32 slot);                   /* address of an actor slot */
    MHU32 (MH_STDCALL *player_actor)(void);
    int (MH_STDCALL *dump)(const char *path,MHU32 address,MHU32 size);
} MHEngineAPI;

typedef struct MHAPI {
    MHU32 api_version;
    MHRuntimeAPI runtime;
    MHGameAPI game;
    MHMapAPI map;
    MHEntitiesAPI entities;
    MHInputAPI input;
    MHSoundAPI sound;
    MHResourcesAPI resources;
    MHCatalogAPI catalog;
    MHOptionsAPI options;
    MHDrawAPI draw;
    MHCameraAPI camera;
    MHEngineAPI engine;
} MHAPI;

typedef struct MHModContext { const MHAPI *mh; MHModInfo mod; } MHModContext;

#ifndef MH_RUNTIME_CORE
MH_EXPORT int MH_STDCALL MHModInit(const MHModContext *context);
#endif
#ifdef __cplusplus
}
#endif
#endif
