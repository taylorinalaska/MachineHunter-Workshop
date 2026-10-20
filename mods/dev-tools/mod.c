/*
 * Developer Tools: see what the game is doing.
 *
 * An information panel, labels and lines drawn over the actors, the
 * collision the engine really uses, and a few switches for testing: enemies
 * that ignore the player, slow motion, memory snapshots and an event trace.
 *
 * This is the reference for the engine tier of the API (mh->engine): it reads
 * the game's own structures and hooks three of its functions. The offsets
 * used here are documented in research/ADDRESSES.csv and research/notes.
 * Everything a player can switch is declared in mod.json.
 */
#include "mh.h"
#include "trace.h"

typedef MHU8 mh_u8;
typedef MHU16 mh_u16;
typedef MHU32 mh_u32;
typedef MHI32 mh_i32;

#define MH_CDECL __cdecl

/* Functions hooked for the gameplay switches. */
#define MH_VA_SEARCH_PLAYER_GROUP       0x00448440u
#define MH_VA_UPDATE_PLAYER_RELATIONS   0x00429030u
#define MH_VA_GAMEPLAY_WORLD_UPDATE_THUNK 0x0040240Fu

#define MH_VA_TRIG_COS_TABLE            0x00632908u
#define MH_VA_TRIG_SIN_TABLE            0x0065A880u

/* The loaded map: layers of the current group, each a grid of cell words. */
#define MH_VA_CURRENT_GROUP_LAYER_COUNT  0x004B01BCu
#define MH_VA_CURRENT_GROUP_LAYERS_PTR   0x004B98C0u
#define MH_VA_DEFINITION_METADATA_PTR    0x004B6414u
#define MH_VA_MAP_BUFFER_PTR             0x00656958u
#define MH_MAP_BUFFER_CAP                0x00050000u
#define MH_LAYER_STRIDE                  0x00000080u
#define MH_LAYER_ORIGIN_X_OFF            0x0000000Cu
#define MH_LAYER_ORIGIN_Y_OFF            0x00000010u
#define MH_LAYER_WIDTH_OFF               0x00000014u
#define MH_LAYER_HEIGHT_OFF              0x00000018u
#define MH_LAYER_GRID_PTR_OFF            0x0000005Cu
#define MH_COLLISION_SCAN_RADIUS_CELLS   24
#define MH_COLLISION_CACHE_MAX_PRIMITIVES 32768u
#define MH_COLLISION_CACHE_REFRESH_FRAMES 4u

/* Actors and the map objects they were spawned from. */
#define MH_WORLD_ACTOR_BASE             0x00621978u
#define MH_ACTOR_STRIDE                 0x000002B4u
#define MH_WORLD_ACTOR_COUNT            40u
#define MH_RELATION_TABLE_OFFSET        0x000000A0u
#define MH_RELATION_STRIDE              0x00000018u
#define MH_VA_MAP_OBJECT_POOL_PTR         0x006B58E8u
#define MH_MAP_OBJECT_STRIDE              0x00000024u
#define MH_MAP_OBJECT_TYPE_WORD_OFF       0x00000004u
#define MH_MAP_OBJECT_PATH_PTR_OFF        0x00000018u
#define MH_ACTOR_LINEAR_VELOCITY_OFF      0x00000014u
#define MH_ACTOR_PATH_STATE_OFF           0x00000066u
#define MH_ACTOR_PATH_INDEX_OFF           0x0000006Au
#define MH_ACTOR_AI_STATE_OFF             0x0000006Bu
#define MH_ACTOR_CONTROL_BITS_OFF         0x0000006Cu
#define MH_ACTOR_STATE_FN_OFF             0x0000007Cu
#define MH_ACTOR_STATE_VALUE_OFF          0x00000080u
#define MH_ACTOR_AI_CALLBACK_OFF          0x00000088u
#define MH_ACTOR_AI_COUNTDOWN_OFF         0x0000008Cu
#define MH_ACTOR_AI_RELOAD_OFF            0x0000008Eu
#define MH_ACTOR_MAP_REF_OFF              0x00000098u
#define MH_ACTOR_MAX_HEALTH_OFF           0x00000238u
#define MH_ACTOR_COMBAT_SUBSTATE_OFF      0x00000266u
#define MH_ACTOR_TURN_VELOCITY_OFF        0x00000268u
#define MH_DEBUG_MAX_PATH_POINTS          64u

typedef mh_u32 (MH_CDECL *PFN_SearchPlayerGroup)(mh_u32 query_actor, mh_u32 facing_reference,
                                                 mh_u32 angle_limit, mh_u32 distance_limit);
typedef void   (MH_CDECL *PFN_UpdatePlayerRelations)(mh_u32 player_slot);
typedef void   (MH_CDECL *PFN_GameplayWorldUpdate)(void);

typedef struct MHCollisionPrimitive {
    mh_i32 x;
    mh_i32 y;
    mh_i32 z;
    mh_u16 kind;
    mh_u16 data;
} MHCollisionPrimitive;

typedef struct MHCollisionCacheState {
    int valid;
    int overflow;
    mh_u32 map_base;
    mh_u32 layers;
    mh_u32 layer_count;
    mh_u32 defs;
    mh_i32 camera_cell_x;
    mh_i32 camera_cell_y;
    mh_u32 refresh_frame;
    mh_u32 count;
} MHCollisionCacheState;

const MHAPI *mh;

static PFN_SearchPlayerGroup g_search_player_original;
static PFN_UpdatePlayerRelations g_update_relations_original;
static PFN_GameplayWorldUpdate g_world_update_original;

/* The switches, mirrored from the options in mod.json. */
static int g_info_hud;
static int g_show_player_info;
static int g_show_actor_info;
static int g_show_actor_types;
static int g_show_actor_states;
static int g_show_actor_headings;
static int g_show_actor_paths;
static int g_show_actor_path_points;
static int g_show_actor_targets;
static int g_show_collision;
static int g_show_weapon_info;
static int g_show_developer_info;
static int g_show_cheat_info;
static int g_passive_ai;
static int g_trace;
static int g_game_speed_mode;
static mh_u32 g_game_speed_phase;

static mh_u32 g_snapshot_notice_until;
static mh_u32 g_selected_slot;

static mh_u8 g_overlay_white;
static mh_u8 g_overlay_actor_type_color;
static mh_u8 g_overlay_heading_color;
static mh_u8 g_overlay_path_color;
static mh_u8 g_overlay_point_color;
static mh_u8 g_overlay_target_color;
static mh_u8 g_overlay_selected_color;
static mh_u8 g_overlay_collision_color;
static MHCollisionPrimitive g_collision_cache[MH_COLLISION_CACHE_MAX_PRIMITIVES];
static MHCollisionCacheState g_collision_cache_state;

static const char *const SPEED_LABELS[5] = { "1X", "1/2", "1/4", "1/8", "PAUSE" };

/* ---------------------------------------------------------------- memory */

static mh_i32 read_i32(mh_u32 address) { mh_i32 value = 0; mh->engine.read(address, &value, 4); return value; }
static mh_u32 read_u32(mh_u32 address) { mh_u32 value = 0; mh->engine.read(address, &value, 4); return value; }
static mh_u16 read_u16(mh_u32 address) { mh_u16 value = 0; mh->engine.read(address, &value, 2); return value; }
static mh_u8 read_u8(mh_u32 address) { mh_u8 value = 0; mh->engine.read(address, &value, 1); return value; }
static short read_i16(mh_u32 address) { short value = 0; mh->engine.read(address, &value, 2); return value; }
static void write_u32_direct(mh_u32 address, mh_u32 value) { *(volatile mh_u32 *)address = value; }

/* --------------------------------------------------------------- drawing
 * The overlay code passes a frame around from when it plotted pixels itself;
 * drawing now goes through mh->draw, which clips and knows the palette. */

static void draw_text(mh_u8 *fb, int w, int h, int x, int y, const char *text, mh_u8 color)
{
    (void)fb; (void)w; (void)h;
    mh->draw.text(x, y, text, color, 1u);
}

static void shade_rect(mh_u8 *fb, int w, int h, int x, int y, int rw, int rh)
{
    (void)fb; (void)w; (void)h;
    mh->draw.shade(x, y, rw, rh, 80u);
}

static void debug_draw_line(mh_u8 *fb, int w, int h, int x0, int y0, int x1, int y1, mh_u8 color)
{
    (void)fb; (void)w; (void)h;
    mh->draw.line(x0, y0, x1, y1, color);
}

static void debug_draw_cross(mh_u8 *fb, int w, int h, int x, int y, int radius, mh_u8 color)
{
    debug_draw_line(fb,w,h,x-radius,y,x+radius,y,color);
    debug_draw_line(fb,w,h,x,y-radius,x,y+radius,color);
}

/* A point in map subunits (256 to a cell) to a pixel of the frame on screen. */
static int debug_project_world(int w, int h, mh_i32 world_x, mh_i32 world_y, mh_i32 world_z,
                               int *screen_x, int *screen_y)
{
    MHPosition position;
    MHI32 sx = 0, sy = 0;
    (void)w; (void)h;
    position.x = (mh_i32)((mh_u32)world_x << 16);
    position.y = (mh_i32)((mh_u32)world_y << 16);
    position.z = (mh_i32)((mh_u32)world_z << 16);
    if (!mh->camera.project(&position, &sx, &sy)) return 0;
    *screen_x = (int)sx;
    *screen_y = (int)sy;
    return 1;
}

/* ------------------------------------------------------------------ text */

static char *ui_append_u32(char *p, mh_u32 v)
{
    char tmp[11];
    int n = 0, i;
    if (v == 0) { *p++='0'; *p=0; return p; }
    while (v && n < 10) { tmp[n++] = (char)('0' + (v % 10)); v /= 10; }
    for (i=n-1; i>=0; --i) *p++ = tmp[i];
    *p = 0;
    return p;
}

static char *ui_append_i32(char *p, mh_i32 v)
{
    if (v < 0) {
        *p++ = '-';
        if (v == (mh_i32)0x80000000u) {
            const char *q = "2147483648";
            while (*q) *p++ = *q++;
            *p = 0;
            return p;
        }
        return ui_append_u32(p, (mh_u32)(-v));
    }
    return ui_append_u32(p, (mh_u32)v);
}

static char *ui_append_hex8(char *p, mh_u32 v)
{
    static const char H[]="0123456789ABCDEF";
    int i;
    *p++='0'; *p++='X';
    for (i=7;i>=0;--i) *p++=H[(v>>(i*4))&15u];
    *p=0;
    return p;
}

static char *ui_append_text(char *p, const char *text)
{
    while (*text) *p++ = *text++;
    *p = 0;
    return p;
}

/* ---------------------------------------------------------------- actors */

typedef struct MHDebugMapInfo {
    int valid;
    int player;
    mh_u32 player_slot;
    mh_u32 map_ref;
    mh_u32 object_addr;
    mh_u16 type_word;
    mh_u32 map_type;
    mh_u32 behavior_selector;
    mh_u32 path_ptr;
} MHDebugMapInfo;

typedef struct MHDebugRelation {
    int valid;
    mh_u32 relation_slot;
    mh_u32 target_actor;
    mh_u32 target_slot;
    mh_u32 angle;
    mh_u32 distance_3d;
    mh_u32 distance_xy;
    mh_i32 vertical_delta;
} MHDebugRelation;

static int actor_pointer_to_slot(mh_u32 actor, mh_u32 *slot_out)
{
    mh_u32 base, stride, capacity, delta;
    if (!mh || !actor) return 0;
    base = mh->engine.symbol("gameplay.actor_pool");
    stride = mh->engine.constant("actor.pool.stride");
    capacity = mh->engine.constant("actor.pool.capacity");
    if (!base || !stride || !capacity || actor < base) return 0;
    delta = actor - base;
    if ((delta % stride) != 0u || (delta / stride) >= capacity) return 0;
    if (slot_out) *slot_out = delta / stride;
    return 1;
}

static int debug_actor_map_info(mh_u32 actor, MHDebugMapInfo *out)
{
    mh_u32 ref, object_base;
    if (!out) return 0;
    out->valid = 0;
    out->player = 0;
    out->player_slot = 0;
    out->map_ref = 0xffffffffu;
    out->object_addr = 0;
    out->type_word = 0;
    out->map_type = 0;
    out->behavior_selector = 0;
    out->path_ptr = 0;
    if (!actor) return 0;

    ref = read_u32(actor + MH_ACTOR_MAP_REF_OFF);
    if (ref & 0x80000000u) {
        out->valid = 1;
        out->player = 1;
        out->player_slot = ref & 7u;
        return 1;
    }
    if (ref == 0xffffffffu || ref > 0x0000ffffu) return 0;
    object_base = read_u32(MH_VA_MAP_OBJECT_POOL_PTR);
    if (!object_base) return 0;
    out->object_addr = object_base + ref * MH_MAP_OBJECT_STRIDE;
    out->type_word = read_u16(out->object_addr + MH_MAP_OBJECT_TYPE_WORD_OFF);
    out->map_type = (mh_u32)(out->type_word & 0x00ffu);
    if (!out->map_type) return 0;
    out->behavior_selector = (mh_u32)((out->type_word >> 9) & 0x1fu);
    out->path_ptr = read_u32(out->object_addr + MH_MAP_OBJECT_PATH_PTR_OFF);
    out->map_ref = ref;
    out->valid = 1;
    return 1;
}

static int debug_selected_relation(mh_u32 actor, MHDebugRelation *out)
{
    mh_u8 packed;
    mh_u32 rel_slot, rel, target, target_slot;
    if (!out) return 0;
    out->valid=0; out->relation_slot=0; out->target_actor=0; out->target_slot=0;
    out->angle=0; out->distance_3d=0; out->distance_xy=0; out->vertical_delta=0;
    if (!actor) return 0;
    packed = read_u8(actor + MH_ACTOR_AI_STATE_OFF);
    rel_slot = ((mh_u32)packed) >> 5;
    if (rel_slot >= 8u) return 0;
    rel = actor + MH_RELATION_TABLE_OFFSET + rel_slot * MH_RELATION_STRIDE;
    target = read_u32(rel + 0x00u);
    if (!actor_pointer_to_slot(target,&target_slot)) return 0;
    if (!read_u32(target + mh->engine.constant("actor.active.offset"))) return 0;
    out->valid=1;
    out->relation_slot=rel_slot;
    out->target_actor=target;
    out->target_slot=target_slot;
    out->angle=read_u32(rel + 0x04u);
    out->distance_3d=read_u32(rel + 0x08u);
    out->distance_xy=read_u32(rel + 0x0Cu);
    out->vertical_delta=read_i32(rel + 0x10u);
    return 1;
}

/* ------------------------------------------------------------- collision */

static int collision_map_range_valid(mh_u32 base, mh_u32 address, mh_u32 bytes)
{
    if (!base || !address || address < base || bytes > MH_MAP_BUFFER_CAP) return 0;
    return address - base <= MH_MAP_BUFFER_CAP - bytes;
}

static void debug_draw_projected_line(mh_u8 *fb, int w, int h,
                                      int sx0, int sy0, int sx1, int sy1,
                                      mh_u8 color)
{
    /* Collision scans submit many nearby edges. Reject segments wholly outside
       one viewport side before entering the pixel-line loop. */
    if ((sx0 < 0 && sx1 < 0) || (sx0 >= w && sx1 >= w) ||
        (sy0 < 0 && sy1 < 0) || (sy0 >= h && sy1 >= h)) return;
    debug_draw_line(fb,w,h,sx0,sy0,sx1,sy1,color);
}

static int collision_mask_bit(mh_u16 mask, int x, int y)
{
    int index;
    if (x < 0 || y < 0 || x > 3 || y > 3) return 0;
    index = x + y * 4;
    return (mask & (mh_u16)(0x8000u >> index)) != 0;
}

typedef struct MHCollisionPointCache {
    mh_u8 state[25]; /* 0=uncomputed, 1=not projectable, 2=projected */
    int sx[25];
    int sy[25];
} MHCollisionPointCache;

static void collision_point_cache_init(MHCollisionPointCache *cache)
{
    int i;
    if (!cache) return;
    for (i=0;i<25;++i) cache->state[i] = 0;
}

static int collision_project_grid_point(MHCollisionPointCache *cache,
                                        int w, int h,
                                        mh_i32 cell_x, mh_i32 cell_y, mh_i32 z,
                                        int gx, int gy, int *sx, int *sy)
{
    int index;
    if (!cache || gx < 0 || gx > 4 || gy < 0 || gy > 4) return 0;
    index = gx + gy*5;
    if (!cache->state[index]) {
        if (debug_project_world(w,h,cell_x + gx*64,cell_y + gy*64,z,
                                &cache->sx[index],&cache->sy[index]))
            cache->state[index] = 2;
        else
            cache->state[index] = 1;
    }
    if (cache->state[index] != 2) return 0;
    if (sx) *sx = cache->sx[index];
    if (sy) *sy = cache->sy[index];
    return 1;
}

static void draw_collision_grid_line(mh_u8 *fb, int w, int h,
                                     mh_i32 cell_x, mh_i32 cell_y, mh_i32 z,
                                     int gx0, int gy0, int gx1, int gy1,
                                     mh_u8 color, MHCollisionPointCache *cache)
{
    int sx0, sy0, sx1, sy1;
    if (!collision_project_grid_point(cache,w,h,cell_x,cell_y,z,gx0,gy0,&sx0,&sy0)) return;
    if (!collision_project_grid_point(cache,w,h,cell_x,cell_y,z,gx1,gy1,&sx1,&sy1)) return;
    debug_draw_projected_line(fb,w,h,sx0,sy0,sx1,sy1,color);
}

static void draw_collision_mask(mh_u8 *fb, int w, int h,
                                mh_i32 cell_x, mh_i32 cell_y, mh_i32 z,
                                mh_u16 mask, mh_u8 color)
{
    int boundary, pos, run_start;
    MHCollisionPointCache cache;
    collision_point_cache_init(&cache);

    /* Emit the exact same occupied/empty boundary as the previous per-subcell
       implementation, but merge contiguous 64-unit edges into one segment.
       A solid 0xffff cell therefore projects/draws 4 lines instead of 16. */
    for (boundary=0; boundary<=4; ++boundary) {
        run_start = -1;
        for (pos=0; pos<=4; ++pos) {
            int edge = 0;
            if (pos < 4) {
                int above = (boundary > 0) ? collision_mask_bit(mask,pos,boundary-1) : 0;
                int below = (boundary < 4) ? collision_mask_bit(mask,pos,boundary) : 0;
                edge = above != below;
            }
            if (edge && run_start < 0) run_start = pos;
            if ((!edge || pos == 4) && run_start >= 0) {
                draw_collision_grid_line(fb,w,h,cell_x,cell_y,z,
                                         run_start,boundary,pos,boundary,
                                         color,&cache);
                run_start = -1;
            }
        }
    }

    for (boundary=0; boundary<=4; ++boundary) {
        run_start = -1;
        for (pos=0; pos<=4; ++pos) {
            int edge = 0;
            if (pos < 4) {
                int left = (boundary > 0) ? collision_mask_bit(mask,boundary-1,pos) : 0;
                int right = (boundary < 4) ? collision_mask_bit(mask,boundary,pos) : 0;
                edge = left != right;
            }
            if (edge && run_start < 0) run_start = pos;
            if ((!edge || pos == 4) && run_start >= 0) {
                draw_collision_grid_line(fb,w,h,cell_x,cell_y,z,
                                         boundary,run_start,boundary,pos,
                                         color,&cache);
                run_start = -1;
            }
        }
    }
}

static void draw_collision_diagonal(mh_u8 *fb, int w, int h,
                                    mh_i32 x, mh_i32 y, mh_i32 z,
                                    mh_u16 flags, mh_u8 color)
{
    MHCollisionPointCache cache;
    collision_point_cache_init(&cache);
    switch (flags & 0x0180u) {
        case 0x0000u: /* blocked x+y >= 255/256 */
            draw_collision_grid_line(fb,w,h,x,y,z,4,0,4,4,color,&cache);
            draw_collision_grid_line(fb,w,h,x,y,z,4,4,0,4,color,&cache);
            draw_collision_grid_line(fb,w,h,x,y,z,0,4,4,0,color,&cache);
            break;
        case 0x0080u: /* blocked x+y <= 256 */
            draw_collision_grid_line(fb,w,h,x,y,z,0,0,4,0,color,&cache);
            draw_collision_grid_line(fb,w,h,x,y,z,0,0,0,4,color,&cache);
            draw_collision_grid_line(fb,w,h,x,y,z,0,4,4,0,color,&cache);
            break;
        case 0x0100u: /* blocked x >= y */
            draw_collision_grid_line(fb,w,h,x,y,z,0,0,4,0,color,&cache);
            draw_collision_grid_line(fb,w,h,x,y,z,4,0,4,4,color,&cache);
            draw_collision_grid_line(fb,w,h,x,y,z,0,0,4,4,color,&cache);
            break;
        default:      /* 0x0180: blocked y >= x */
            draw_collision_grid_line(fb,w,h,x,y,z,0,0,0,4,color,&cache);
            draw_collision_grid_line(fb,w,h,x,y,z,0,4,4,4,color,&cache);
            draw_collision_grid_line(fb,w,h,x,y,z,0,0,4,4,color,&cache);
            break;
    }
}

static int collision_cache_append(mh_i32 x, mh_i32 y, mh_i32 z,
                                  mh_u16 kind, mh_u16 data)
{
    MHCollisionPrimitive *p;
    if (g_collision_cache_state.count >= MH_COLLISION_CACHE_MAX_PRIMITIVES) {
        g_collision_cache_state.overflow = 1;
        return 0;
    }
    p = &g_collision_cache[g_collision_cache_state.count++];
    p->x = x;
    p->y = y;
    p->z = z;
    p->kind = kind;
    p->data = data;
    return 1;
}

static int rebuild_collision_cache(mh_u32 map_base, mh_u32 layers, mh_u32 layer_count,
                                   mh_u32 defs, mh_i32 camera_cell_x,
                                   mh_i32 camera_cell_y, mh_u32 frame)
{
    mh_u32 li;

    g_collision_cache_state.valid = 0;
    g_collision_cache_state.overflow = 0;
    g_collision_cache_state.count = 0;

    for (li=0; li<layer_count; ++li) {
        mh_u32 layer = layers + li*MH_LAYER_STRIDE;
        mh_i32 origin_x = read_i32(layer + MH_LAYER_ORIGIN_X_OFF);
        mh_i32 origin_y = read_i32(layer + MH_LAYER_ORIGIN_Y_OFF);
        mh_u32 width = read_u32(layer + MH_LAYER_WIDTH_OFF);
        mh_u32 height = read_u32(layer + MH_LAYER_HEIGHT_OFF);
        mh_u32 grid = read_u32(layer + MH_LAYER_GRID_PTR_OFF);
        mh_i32 min_x, max_x, min_y, max_y, x, y;
        mh_i32 z = 8 + (mh_i32)(li << 8);
        mh_u32 cells, bytes;

        if (!width || !height || width > 4096u || height > 4096u) continue;
        if (height > 0xffffffffu / width) continue;
        cells = width * height;
        if (cells > MH_MAP_BUFFER_CAP/2u) continue;
        bytes = cells * 2u;
        if (!collision_map_range_valid(map_base,grid,bytes)) continue;

        min_x = camera_cell_x - origin_x - MH_COLLISION_SCAN_RADIUS_CELLS;
        max_x = camera_cell_x - origin_x + MH_COLLISION_SCAN_RADIUS_CELLS;
        min_y = camera_cell_y - origin_y - MH_COLLISION_SCAN_RADIUS_CELLS;
        max_y = camera_cell_y - origin_y + MH_COLLISION_SCAN_RADIUS_CELLS;
        if (min_x < 0) min_x = 0;
        if (min_y < 0) min_y = 0;
        if (max_x >= (mh_i32)width) max_x = (mh_i32)width - 1;
        if (max_y >= (mh_i32)height) max_y = (mh_i32)height - 1;
        if (min_x > max_x || min_y > max_y) continue;

        for (y=min_y; y<=max_y; ++y) {
            for (x=min_x; x<=max_x; ++x) {
                mh_u32 index = (mh_u32)y * width + (mh_u32)x;
                mh_u16 raw = *(volatile mh_u16 *)(grid + index*2u);
                mh_u32 id = (mh_u32)(raw & 0x07ffu);
                mh_u32 meta = defs + id*8u;
                mh_u16 flags, mask;
                mh_i32 world_x, world_y;
                if (!collision_map_range_valid(map_base,meta,4u)) continue;
                flags = *(volatile mh_u16 *)meta;
                if (flags & 0x2000u) continue;
                world_x = (origin_x + x) * 256;
                world_y = (origin_y + y) * 256;

                if (flags & 0x8000u) {
                    if (!collision_cache_append(world_x,world_y,z,1u,0xffffu)) return 0;
                } else if ((flags & 0x0006u) == 0x0004u) {
                    mask = *(volatile mh_u16 *)(meta + 2u);
                    if (mask && !collision_cache_append(world_x,world_y,z,2u,mask)) return 0;
                } else if ((flags & 0x0006u) == 0x0002u) {
                    if (!collision_cache_append(world_x,world_y,z,3u,(mh_u16)(flags & 0x0180u))) return 0;
                }
            }
        }
    }

    g_collision_cache_state.map_base = map_base;
    g_collision_cache_state.layers = layers;
    g_collision_cache_state.layer_count = layer_count;
    g_collision_cache_state.defs = defs;
    g_collision_cache_state.camera_cell_x = camera_cell_x;
    g_collision_cache_state.camera_cell_y = camera_cell_y;
    g_collision_cache_state.refresh_frame = frame;
    g_collision_cache_state.valid = 1;
    return 1;
}

static void draw_collision_wireframe_uncached(mh_u8 *fb, int w, int h,
                                               mh_u32 map_base, mh_u32 layers,
                                               mh_u32 layer_count, mh_u32 defs,
                                               mh_i32 camera_cell_x,
                                               mh_i32 camera_cell_y, mh_u8 color)
{
    mh_u32 li;
    for (li=0; li<layer_count; ++li) {
        mh_u32 layer = layers + li*MH_LAYER_STRIDE;
        mh_i32 origin_x = read_i32(layer + MH_LAYER_ORIGIN_X_OFF);
        mh_i32 origin_y = read_i32(layer + MH_LAYER_ORIGIN_Y_OFF);
        mh_u32 width = read_u32(layer + MH_LAYER_WIDTH_OFF);
        mh_u32 height = read_u32(layer + MH_LAYER_HEIGHT_OFF);
        mh_u32 grid = read_u32(layer + MH_LAYER_GRID_PTR_OFF);
        mh_i32 min_x, max_x, min_y, max_y, x, y;
        mh_i32 z = 8 + (mh_i32)(li << 8);
        mh_u32 cells, bytes;

        if (!width || !height || width > 4096u || height > 4096u) continue;
        if (height > 0xffffffffu / width) continue;
        cells = width * height;
        if (cells > MH_MAP_BUFFER_CAP/2u) continue;
        bytes = cells * 2u;
        if (!collision_map_range_valid(map_base,grid,bytes)) continue;

        min_x = camera_cell_x - origin_x - MH_COLLISION_SCAN_RADIUS_CELLS;
        max_x = camera_cell_x - origin_x + MH_COLLISION_SCAN_RADIUS_CELLS;
        min_y = camera_cell_y - origin_y - MH_COLLISION_SCAN_RADIUS_CELLS;
        max_y = camera_cell_y - origin_y + MH_COLLISION_SCAN_RADIUS_CELLS;
        if (min_x < 0) min_x = 0;
        if (min_y < 0) min_y = 0;
        if (max_x >= (mh_i32)width) max_x = (mh_i32)width - 1;
        if (max_y >= (mh_i32)height) max_y = (mh_i32)height - 1;
        if (min_x > max_x || min_y > max_y) continue;

        for (y=min_y; y<=max_y; ++y) {
            for (x=min_x; x<=max_x; ++x) {
                mh_u32 index = (mh_u32)y * width + (mh_u32)x;
                mh_u16 raw = *(volatile mh_u16 *)(grid + index*2u);
                mh_u32 id = (mh_u32)(raw & 0x07ffu);
                mh_u32 meta = defs + id*8u;
                mh_u16 flags, mask;
                mh_i32 world_x, world_y;
                if (!collision_map_range_valid(map_base,meta,4u)) continue;
                flags = *(volatile mh_u16 *)meta;
                if (flags & 0x2000u) continue;
                world_x = (origin_x + x) * 256;
                world_y = (origin_y + y) * 256;

                if (flags & 0x8000u) {
                    draw_collision_mask(fb,w,h,world_x,world_y,z,0xffffu,color);
                } else if ((flags & 0x0006u) == 0x0004u) {
                    mask = *(volatile mh_u16 *)(meta + 2u);
                    if (mask) draw_collision_mask(fb,w,h,world_x,world_y,z,mask,color);
                } else if ((flags & 0x0006u) == 0x0002u) {
                    draw_collision_diagonal(fb,w,h,world_x,world_y,z,flags,color);
                }
            }
        }
    }
}

static void draw_collision_wireframe(mh_u8 *fb, int w, int h)
{
    MHCameraState camera;
    mh_u32 map_base, layers, layer_count, defs, frame, i;
    mh_i32 camera_cell_x, camera_cell_y;
    int needs_rebuild;
    mh_u8 color;

    map_base = read_u32(MH_VA_MAP_BUFFER_PTR);
    layers = read_u32(MH_VA_CURRENT_GROUP_LAYERS_PTR);
    layer_count = read_u32(MH_VA_CURRENT_GROUP_LAYER_COUNT);
    defs = read_u32(MH_VA_DEFINITION_METADATA_PTR);
    if (!map_base || !layers || !defs || !layer_count || layer_count > 64u) return;
    if (!collision_map_range_valid(map_base,layers,layer_count*MH_LAYER_STRIDE)) return;
    if (!collision_map_range_valid(map_base,defs,8u)) return;
    if (!mh->camera.get(&camera)) return;

    /* World units are 2^24 to a cell. */
    camera_cell_x = camera.position.x >> 24;
    camera_cell_y = camera.position.y >> 24;
    frame = mh->runtime.frame();
    color = g_overlay_collision_color;

    needs_rebuild = !g_collision_cache_state.valid ||
                    g_collision_cache_state.map_base != map_base ||
                    g_collision_cache_state.layers != layers ||
                    g_collision_cache_state.layer_count != layer_count ||
                    g_collision_cache_state.defs != defs ||
                    g_collision_cache_state.camera_cell_x != camera_cell_x ||
                    g_collision_cache_state.camera_cell_y != camera_cell_y ||
                    (mh_u32)(frame - g_collision_cache_state.refresh_frame) >= MH_COLLISION_CACHE_REFRESH_FRAMES;

    if (needs_rebuild && !rebuild_collision_cache(map_base,layers,layer_count,defs,
                                                   camera_cell_x,camera_cell_y,frame)) {
        /* The cache is bounded. A map that overflows it is still drawn in
           full, straight from the grid. */
        draw_collision_wireframe_uncached(fb,w,h,map_base,layers,layer_count,defs,
                                          camera_cell_x,camera_cell_y,color);
        return;
    }

    for (i=0; i<g_collision_cache_state.count; ++i) {
        const MHCollisionPrimitive *p = &g_collision_cache[i];
        if (p->kind == 1u || p->kind == 2u)
            draw_collision_mask(fb,w,h,p->x,p->y,p->z,p->data,color);
        else if (p->kind == 3u)
            draw_collision_diagonal(fb,w,h,p->x,p->y,p->z,p->data,color);
    }
}

/* --------------------------------------------------------- world overlay */

static int debug_project_actor(mh_u32 actor, int w, int h, int *sx, int *sy,
                               mh_i32 *wx_out, mh_i32 *wy_out, mh_i32 *wz_out)
{
    mh_u32 ox, oy, oz;
    mh_i32 wx, wy, wz;
    if (!mh || !actor) return 0;
    ox=mh->engine.constant("actor.position_x.offset");
    oy=mh->engine.constant("actor.position_y.offset");
    oz=mh->engine.constant("actor.position_z.offset");
    wx=read_i32(actor+ox)>>16;
    wy=read_i32(actor+oy)>>16;
    wz=read_i32(actor+oz)>>16;
    if (wx_out) *wx_out=wx;
    if (wy_out) *wy_out=wy;
    if (wz_out) *wz_out=wz;
    return debug_project_world(w,h,wx,wy,wz,sx,sy);
}

static void draw_actor_label(mh_u8 *fb, int w, int h, int sx, int sy, mh_u32 actor,
                             const MHDebugMapInfo *mi, mh_u8 color)
{
    char text[32], *p=text;
    mh_u32 active_type=0;
    if (g_show_actor_types) {
        if (mi && mi->valid && mi->player) {
            *p++='P'; p=ui_append_u32(p,mi->player_slot);
        } else if (mi && mi->valid) {
            p=ui_append_u32(p,mi->map_type);
        } else {
            mh->engine.read(actor + mh->engine.constant("actor.active.offset"), &active_type, 4);
            *p++='A'; p=ui_append_u32(p,active_type & 0x0fu);
        }
    }
    if (g_show_actor_states) {
        if (p != text) *p++=' ';
        *p++='S'; *p=0;
        p=ui_append_u32(p,(mh_u32)(read_u8(actor+MH_ACTOR_AI_STATE_OFF)&0x1fu));
    }
    draw_text(fb,w,h,sx-(int)((p-text)*3),sy-11,text,color);
}

static void draw_actor_path(mh_u8 *fb, int w, int h, const MHDebugMapInfo *mi,
                            mh_i32 actor_z, mh_u8 path_color, mh_u8 point_color)
{
    mh_u32 path, count, i;
    int have_prev=0, prev_x=0, prev_y=0, sx=0, sy=0;
    if (!mi || !mi->valid || !mi->path_ptr) return;
    path=mi->path_ptr;
    count=(mh_u32)(read_u16(path+2u) & 0x7fffu);
    if (!count || count>MH_DEBUG_MAX_PATH_POINTS) return;
    for (i=0;i<count;++i) {
        mh_u32 point=path+8u+i*8u;
        mh_i32 x=(mh_i32)read_i16(point+0u);
        mh_i32 y=(mh_i32)read_i16(point+2u);
        char label[12], *p=label;
        if (!debug_project_world(w,h,x,y,actor_z,&sx,&sy)) { have_prev=0; continue; }
        if (g_show_actor_paths && have_prev) debug_draw_line(fb,w,h,prev_x,prev_y,sx,sy,path_color);
        if (g_show_actor_path_points) {
            debug_draw_cross(fb,w,h,sx,sy,2,point_color);
            p=ui_append_u32(p,i);
            draw_text(fb,w,h,sx+3,sy-3,label,point_color);
        }
        prev_x=sx; prev_y=sy; have_prev=1;
    }
}

static void draw_actor_world_overlay(mh_u8 *fb, int w, int h, const mh_u8 *bmi)
{
    mh_u32 capacity, active_off, facing_off, i, actor, active;
    mh_u8 type_color, heading_color, path_color, point_color, target_color, selected_color;
    int sx,sy,tx,ty;
    mh_i32 wx,wy,wz;
    if (!g_show_actor_types && !g_show_actor_states && !g_show_actor_headings &&
        !g_show_actor_paths && !g_show_actor_path_points && !g_show_actor_targets &&
        !g_show_actor_info) return;
    if (!mh) return;

    capacity=mh->engine.constant("actor.pool.capacity");
    active_off=mh->engine.constant("actor.active.offset");
    facing_off=mh->engine.constant("actor.facing_angle.offset");
    if (!capacity || !active_off) return;

    (void)bmi;
    type_color=g_overlay_actor_type_color;
    heading_color=g_overlay_heading_color;
    path_color=g_overlay_path_color;
    point_color=g_overlay_point_color;
    target_color=g_overlay_target_color;
    selected_color=g_overlay_selected_color;

    for (i=0;i<capacity;++i) {
        MHDebugMapInfo mi;
        MHDebugRelation rel;
        mh_u16 facing;
        mh_i32 c,sn;
        actor=mh->engine.actor(i); active=0;
        if (!actor || !mh->engine.read(actor+active_off,&active,4) || !active) continue;
        if (!debug_project_actor(actor,w,h,&sx,&sy,&wx,&wy,&wz)) continue;
        debug_actor_map_info(actor,&mi);

        if (g_show_actor_paths || g_show_actor_path_points)
            draw_actor_path(fb,w,h,&mi,wz,path_color,point_color);

        if (g_show_actor_targets && debug_selected_relation(actor,&rel) &&
            debug_project_actor(rel.target_actor,w,h,&tx,&ty,0,0,0))
            debug_draw_line(fb,w,h,sx,sy,tx,ty,target_color);

        if (g_show_actor_headings) {
            mh_i32 end_x,end_y;
            facing=read_u16(actor+facing_off)&0x07ffu;
            c=read_i32(MH_VA_TRIG_COS_TABLE+(mh_u32)facing*4u);
            sn=read_i32(MH_VA_TRIG_SIN_TABLE+(mh_u32)facing*4u);
            end_x=wx+(mh_i32)(((long long)c*96)>>15);
            end_y=wy+(mh_i32)(((long long)sn*96)>>15);
            if (debug_project_world(w,h,end_x,end_y,wz,&tx,&ty))
                debug_draw_line(fb,w,h,sx,sy,tx,ty,heading_color);
        }

        if (g_show_actor_types || g_show_actor_states)
            draw_actor_label(fb,w,h,sx,sy,actor,&mi,type_color);

        if (g_show_actor_info && i==g_selected_slot) {
            debug_draw_cross(fb,w,h,sx,sy,6,selected_color);
            debug_draw_line(fb,w,h,sx-5,sy-5,sx+5,sy+5,selected_color);
            debug_draw_line(fb,w,h,sx-5,sy+5,sx+5,sy-5,selected_color);
        }
    }
}

/* ------------------------------------------------------------- inspector */

static void select_next_active(void)
{
    mh_u32 capacity = mh->engine.constant("actor.pool.capacity");
    mh_u32 active_off = mh->engine.constant("actor.active.offset");
    mh_u32 n, idx, addr, active;
    if (!capacity || !active_off) return;
    for (n=1; n<=capacity; ++n) {
        idx=(g_selected_slot+n)%capacity;
        addr=mh->engine.actor(idx); active=0;
        if (addr && mh->engine.read(addr+active_off,&active,4) && active) {
            g_selected_slot=idx;
            return;
        }
    }
}

/* Writes the game's data segment, the actor pool and the player to logs\snapshots. */
static void make_snapshot(void)
{
    char path[96], line[112], *p;
    mh_u32 base = mh->engine.constant("state.snapshot.base");
    mh_u32 size = mh->engine.constant("state.snapshot.size");
    mh_u32 frame = mh->runtime.frame();
    mh_u32 player, inv=0, pool=mh->engine.symbol("gameplay.actor_pool");
    mh_u32 stride=mh->engine.constant("actor.pool.stride");
    mh_u32 capacity=mh->engine.constant("actor.pool.capacity");
    mh_u32 inv_off=mh->engine.constant("actor.inventory_ptr.offset");
    int ok;
    if (!base || !size) return;

    p=path; p=ui_append_text(p,"logs\\snapshots\\state_"); p=ui_append_u32(p,frame); p=ui_append_text(p,".bin");
    ok=mh->engine.dump(path,base,size);

    if (pool && stride && capacity) {
        p=path; p=ui_append_text(p,"logs\\snapshots\\actors_"); p=ui_append_u32(p,frame); p=ui_append_text(p,".bin");
        mh->engine.dump(path,pool,stride*capacity);
    }

    if (g_selected_slot < capacity) {
        mh_u32 selected=mh->engine.actor(g_selected_slot), selected_active=0;
        if (selected && mh->engine.read(selected+mh->engine.constant("actor.active.offset"),&selected_active,4) && selected_active) {
            p=path; p=ui_append_text(p,"logs\\snapshots\\selected_"); p=ui_append_u32(p,frame); p=ui_append_text(p,".bin");
            mh->engine.dump(path,selected,stride ? stride : 0x2B4u);
        }
    }

    player=mh->engine.player_actor();
    if (player) {
        p=path; p=ui_append_text(p,"logs\\snapshots\\player_"); p=ui_append_u32(p,frame); p=ui_append_text(p,".bin");
        mh->engine.dump(path,player,stride ? stride : 0x2B4u);
        mh->engine.read(player+inv_off,&inv,4);
        if (inv) {
            p=path; p=ui_append_text(p,"logs\\snapshots\\inventory_"); p=ui_append_u32(p,frame); p=ui_append_text(p,".bin");
            mh->engine.dump(path,inv,0x100);
        }
        p=line; p=ui_append_text(p,"Developer Tools: snapshot player "); p=ui_append_hex8(p,player);
        p=ui_append_text(p," inventory "); p=ui_append_hex8(p,inv); mh->runtime.log(line);
    }

    if (ok) {
        mh->runtime.log("Developer Tools: memory snapshot written to logs\\snapshots");
        g_snapshot_notice_until = frame + 180u;
    } else {
        mh->runtime.log("Developer Tools: memory snapshot failed");
    }
}

static void draw_info_hud(mh_u8 *fb, int w, int h, mh_u8 white)
{
    mh_u32 player=0, flags=0, hp=0, inv=0, weapon=0, ammo=0;
    mh_u32 aim=0, timer_a=0, timer_b=0, recent_fire=0;
    mh_u32 flags_off, hp_off, inv_off, weapon_off, ammo_base, active_off;
    mh_u32 capacity=0, i, a=0, active=0, active_count=0;
    mh_u32 selected=0, selected_flags=0, selected_hp=0, selected_active=0;
    mh_u32 invincible_addr=0, unlimited_addr=0, invincible=0, unlimited=0;
    int lines=3, y=5, panel_w;
    char line[112], *p;

    if (g_show_player_info) lines += 2;
    if (g_show_weapon_info) lines += 1;
    if (g_show_actor_info) lines += 8;
    if (g_show_developer_info) lines += 1;
    if (g_show_cheat_info) lines += 1;

    panel_w = (w > 316) ? 316 : (w - 4);
    shade_rect(fb,w,h,2,2,panel_w,lines*8+4);

    if (g_snapshot_notice_until > mh->runtime.frame())
        draw_text(fb,w,h,5,y,"DEVELOPER TOOLS  SNAPSHOT SAVED",white);
    else
        draw_text(fb,w,h,5,y,"DEVELOPER TOOLS",white);
    y += 8;

    active_off=mh->engine.constant("actor.active.offset");
    flags_off=mh->engine.constant("actor.flags.offset");
    hp_off=mh->engine.constant("actor.health.offset");
    capacity=mh->engine.constant("actor.pool.capacity");
    if (active_off && capacity) {
        for (i=0;i<capacity;++i) {
            a=mh->engine.actor(i); active=0;
            if (a && mh->engine.read(a+active_off,&active,4) && active) ++active_count;
        }
    }

    p=line; p=ui_append_text(p,"FRAME "); p=ui_append_u32(p,mh->runtime.frame());
    p=ui_append_text(p,"  ACTORS "); p=ui_append_u32(p,active_count);
    draw_text(fb,w,h,5,y,line,white);
    y += 8;

    player=mh->engine.player_actor();
    if (player) {
        mh->engine.read(player+flags_off,&flags,4);
        mh->engine.read(player+hp_off,&hp,4);
    }
    p=line; p=ui_append_text(p,"PLAYER "); p=ui_append_hex8(p,player);
    p=ui_append_text(p,"  HP "); p=ui_append_u32(p,hp);
    draw_text(fb,w,h,5,y,line,white);
    y += 8;

    if (player) {
        inv_off=mh->engine.constant("actor.inventory_ptr.offset");
        weapon_off=mh->engine.constant("inventory.selected_weapon.offset");
        ammo_base=mh->engine.constant("inventory.ammo_base.offset");
        mh->engine.read(player+inv_off,&inv,4);
        if (inv) {
            mh->engine.read(inv+weapon_off,&weapon,2);
            mh->engine.read(inv+ammo_base+(weapon*4u),&ammo,4);
        }
        mh->engine.read(player+mh->engine.constant("actor.aim_angle.offset"),&aim,4);
        mh->engine.read(player+mh->engine.constant("actor.weapon_timer_a.offset"),&timer_a,4);
        mh->engine.read(player+mh->engine.constant("actor.weapon_timer_b.offset"),&timer_b,4);
        mh->engine.read(player+mh->engine.constant("actor.weapon_recent_fire.offset"),&recent_fire,4);
    }

    if (g_show_player_info) {
        p=line; p=ui_append_text(p,"FLAGS "); p=ui_append_hex8(p,flags);
        p=ui_append_text(p,"  AIM "); p=ui_append_u32(p,aim);
        draw_text(fb,w,h,5,y,line,white);
        y += 8;

        p=line; p=ui_append_text(p,"WT "); p=ui_append_u32(p,timer_a);
        p=ui_append_text(p,"/"); p=ui_append_u32(p,timer_b);
        p=ui_append_text(p,"  RF "); p=ui_append_u32(p,recent_fire);
        draw_text(fb,w,h,5,y,line,white);
        y += 8;
    }

    if (g_show_weapon_info) {
        p=line; p=ui_append_text(p,"WEAPON "); p=ui_append_u32(p,weapon);
        p=ui_append_text(p,"  AMMO "); p=ui_append_u32(p,ammo);
        draw_text(fb,w,h,5,y,line,white);
        y += 8;
    }

    if (g_show_actor_info) {
        MHDebugMapInfo mi;
        MHDebugRelation rel;
        mh_u32 max_hp=0, map_ref=0, state_fn=0, state_value=0, ai_cb=0;
        mh_u32 target_slot=0xffffffffu, path_count=0, path_mode=0, path_group=0, path_layer=0;
        mh_u16 facing=0, path_state=0, combat_state=0;
        mh_u8 ai_state=0, control_bits=0, path_index=0;
        short ai_count=0, ai_reload=0;
        mh_i32 px=0,py=0,pz=0,lin_vel=0,turn_vel=0;
        int have_rel=0;
        rel.relation_slot=0; rel.target_slot=0xffffffffu; rel.distance_3d=0; rel.distance_xy=0;

        if (g_selected_slot < capacity) {
            selected=mh->engine.actor(g_selected_slot);
            if (selected) mh->engine.read(selected+active_off,&selected_active,4);
            if (!selected_active && active_count) {
                select_next_active();
                selected=mh->engine.actor(g_selected_slot);
                if (selected) mh->engine.read(selected+active_off,&selected_active,4);
            }
        }

        debug_actor_map_info(selected,&mi);
        if (selected_active) {
            mh->engine.read(selected+flags_off,&selected_flags,4);
            mh->engine.read(selected+hp_off,&selected_hp,4);
            max_hp=read_u32(selected+MH_ACTOR_MAX_HEALTH_OFF);
            facing=read_u16(selected+mh->engine.constant("actor.facing_angle.offset"))&0x07ffu;
            px=read_i32(selected+mh->engine.constant("actor.position_x.offset"))>>16;
            py=read_i32(selected+mh->engine.constant("actor.position_y.offset"))>>16;
            pz=read_i32(selected+mh->engine.constant("actor.position_z.offset"))>>16;
            lin_vel=read_i32(selected+MH_ACTOR_LINEAR_VELOCITY_OFF);
            turn_vel=read_i32(selected+MH_ACTOR_TURN_VELOCITY_OFF);
            path_state=read_u16(selected+MH_ACTOR_PATH_STATE_OFF);
            path_index=read_u8(selected+MH_ACTOR_PATH_INDEX_OFF);
            ai_state=read_u8(selected+MH_ACTOR_AI_STATE_OFF);
            control_bits=read_u8(selected+MH_ACTOR_CONTROL_BITS_OFF);
            state_fn=read_u32(selected+MH_ACTOR_STATE_FN_OFF);
            state_value=read_u32(selected+MH_ACTOR_STATE_VALUE_OFF);
            ai_cb=read_u32(selected+MH_ACTOR_AI_CALLBACK_OFF);
            ai_count=read_i16(selected+MH_ACTOR_AI_COUNTDOWN_OFF);
            ai_reload=read_i16(selected+MH_ACTOR_AI_RELOAD_OFF);
            combat_state=read_u16(selected+MH_ACTOR_COMBAT_SUBSTATE_OFF);
            map_ref=read_u32(selected+MH_ACTOR_MAP_REF_OFF);
            have_rel=debug_selected_relation(selected,&rel);
            if (have_rel) target_slot=rel.target_slot;
            if (mi.valid && mi.path_ptr) {
                path_mode=read_u16(mi.path_ptr+0u);
                path_count=(mh_u32)(read_u16(mi.path_ptr+2u) & 0x7fffu);
                path_group=read_u16(mi.path_ptr+4u);
                path_layer=read_u16(mi.path_ptr+6u);
            }
        }

        p=line; p=ui_append_text(p,"SEL "); p=ui_append_u32(p,g_selected_slot);
        p=ui_append_text(p," "); p=ui_append_hex8(p,selected);
        p=ui_append_text(p," TYPE ");
        if (mi.valid && mi.player) { p=ui_append_text(p,"P"); p=ui_append_u32(p,mi.player_slot); }
        else if (mi.valid) p=ui_append_u32(p,mi.map_type);
        else p=ui_append_text(p,"-");
        draw_text(fb,w,h,5,y,line,white); y+=8;

        p=line; p=ui_append_text(p,"HP "); p=ui_append_u32(p,selected_hp);
        p=ui_append_text(p,"/"); p=ui_append_u32(p,max_hp);
        p=ui_append_text(p," FLAGS "); p=ui_append_hex8(p,selected_flags);
        p=ui_append_text(p," BEH "); p=ui_append_u32(p,mi.valid&&!mi.player?mi.behavior_selector:0u);
        draw_text(fb,w,h,5,y,line,white); y+=8;

        p=line; p=ui_append_text(p,"POS "); p=ui_append_i32(p,px); p=ui_append_text(p,",");
        p=ui_append_i32(p,py); p=ui_append_text(p,","); p=ui_append_i32(p,pz);
        p=ui_append_text(p," FACE "); p=ui_append_u32(p,facing);
        draw_text(fb,w,h,5,y,line,white); y+=8;

        p=line; p=ui_append_text(p,"AI S"); p=ui_append_u32(p,(mh_u32)(ai_state&0x1fu));
        p=ui_append_text(p," RAW "); p=ui_append_u32(p,ai_state);
        p=ui_append_text(p," CTRL "); p=ui_append_hex8(p,(mh_u32)control_bits);
        p=ui_append_text(p," COMBAT "); p=ui_append_u32(p,combat_state);
        draw_text(fb,w,h,5,y,line,white); y+=8;

        p=line; p=ui_append_text(p,"VEL "); p=ui_append_i32(p,lin_vel);
        p=ui_append_text(p," TURN "); p=ui_append_i32(p,turn_vel);
        p=ui_append_text(p," PATHSTATE "); p=ui_append_u32(p,path_state);
        p=ui_append_text(p," IDX "); p=ui_append_u32(p,path_index);
        draw_text(fb,w,h,5,y,line,white); y+=8;

        p=line; p=ui_append_text(p,"AI CB "); p=ui_append_hex8(p,ai_cb);
        p=ui_append_text(p," T "); p=ui_append_i32(p,(mh_i32)ai_count);
        p=ui_append_text(p," R "); p=ui_append_i32(p,(mh_i32)ai_reload);
        draw_text(fb,w,h,5,y,line,white); y+=8;

        p=line; p=ui_append_text(p,"TARGET ");
        if (have_rel) {
            p=ui_append_u32(p,target_slot); p=ui_append_text(p," REL "); p=ui_append_u32(p,rel.relation_slot);
            p=ui_append_text(p," D3 "); p=ui_append_u32(p,rel.distance_3d);
            p=ui_append_text(p," DXY "); p=ui_append_u32(p,rel.distance_xy);
        } else p=ui_append_text(p,"-");
        draw_text(fb,w,h,5,y,line,white); y+=8;

        p=line;
        if (path_count) {
            p=ui_append_text(p,"PATH N "); p=ui_append_u32(p,path_count);
            p=ui_append_text(p," MODE "); p=ui_append_u32(p,path_mode);
            p=ui_append_text(p," G/L "); p=ui_append_u32(p,path_group); p=ui_append_text(p,"/"); p=ui_append_u32(p,path_layer);
        } else {
            p=ui_append_text(p,"MAPREF "); p=ui_append_hex8(p,map_ref);
            p=ui_append_text(p," FN "); p=ui_append_hex8(p,state_fn);
            p=ui_append_text(p," SV "); p=ui_append_hex8(p,state_value);
        }
        draw_text(fb,w,h,5,y,line,white); y+=8;
    }

    if (g_show_developer_info) {
        MHCameraState camera;
        p=line; p=ui_append_text(p,"PASSIVE "); p=ui_append_text(p,g_passive_ai?"ON":"OFF");
        p=ui_append_text(p,"  SPEED "); p=ui_append_text(p,SPEED_LABELS[g_game_speed_mode]);
        if (mh->camera.get(&camera)) {
            p=ui_append_text(p,"  CAM "); p=ui_append_text(p,camera.overridden?"FREE":"GAME");
            p=ui_append_text(p,"  ZOOM "); p=ui_append_u32(p,(mh_u32)camera.zoom*100u/(mh_u32)MH_ZOOM_ONE);
        }
        draw_text(fb,w,h,5,y,line,white);
        y += 8;
    }

    if (g_show_cheat_info) {
        invincible_addr=mh->engine.symbol("cheat.invincible");
        unlimited_addr=mh->engine.symbol("cheat.unlimited_ammo");
        if (invincible_addr) mh->engine.read(invincible_addr,&invincible,4);
        if (unlimited_addr) mh->engine.read(unlimited_addr,&unlimited,4);
        p=line; p=ui_append_text(p,"INV "); p=ui_append_u32(p,invincible);
        p=ui_append_text(p,"  UNLIMITED "); p=ui_append_u32(p,unlimited);
        draw_text(fb,w,h,5,y,line,white);
    }
}

/* ------------------------------------------------------ gameplay switches */

/* Passive enemies: the engine keeps, for every actor, a table of what it
   knows about each player. Emptying it and failing the search leaves enemies
   with nobody to notice. */
static void clear_player_relation_slots(mh_u32 player_slot)
{
    mh_u32 i;
    mh_u32 slot;
    if (player_slot >= 8u) return;

    slot = MH_WORLD_ACTOR_BASE + MH_RELATION_TABLE_OFFSET + player_slot * MH_RELATION_STRIDE;
    for (i = 0; i < MH_WORLD_ACTOR_COUNT; ++i) {
        write_u32_direct(slot, 0u);
        slot += MH_ACTOR_STRIDE;
    }
}

static void MH_CDECL update_player_relations_hook(mh_u32 player_slot)
{
    if (g_passive_ai) {
        clear_player_relation_slots(player_slot);
        return;
    }
    if (g_update_relations_original) g_update_relations_original(player_slot);
}

static mh_u32 MH_CDECL search_player_hook(mh_u32 query_actor, mh_u32 facing_reference,
                                           mh_u32 angle_limit, mh_u32 distance_limit)
{
    if (g_passive_ai) return 0;
    if (!g_search_player_original) return 0;
    return g_search_player_original(query_actor, facing_reference, angle_limit, distance_limit);
}

/* Game speed: run the world update on every 2nd, 4th or 8th frame, or not at all. */
static void MH_CDECL gameplay_world_update_hook(void)
{
    static const mh_u32 divisors[4] = { 1u, 2u, 4u, 8u };
    mh_u32 divisor;

    if (!g_world_update_original) return;
    if (g_game_speed_mode >= 4) {
        g_game_speed_phase = 0;
        return;
    }
    divisor = divisors[(mh_u32)g_game_speed_mode];
    if (divisor <= 1u) {
        g_game_speed_phase = 0;
        g_world_update_original();
        return;
    }
    if (g_game_speed_phase == 0u) g_world_update_original();
    ++g_game_speed_phase;
    if (g_game_speed_phase >= divisor) g_game_speed_phase = 0u;
}

/* ----------------------------------------------------------------- frame */

static int world_overlay_visible(void)
{
    return g_show_collision || g_show_actor_types || g_show_actor_states ||
           g_show_actor_headings || g_show_actor_paths || g_show_actor_path_points ||
           g_show_actor_targets || g_show_actor_info;
}

static void draw(void)
{
    MHI32 w = 0, h = 0;
    if (!mh->draw.size(&w, &h)) return;
    if (!world_overlay_visible() && !g_info_hud) return;

    /* The palette changes with the level, so colours are looked up every frame. */
    g_overlay_white = (mh_u8)mh->draw.color(0xFFFFFFu);
    g_overlay_actor_type_color = (mh_u8)mh->draw.color(0xF0F0F0u);
    g_overlay_heading_color = (mh_u8)mh->draw.color(0x46E646u);
    g_overlay_path_color = (mh_u8)mh->draw.color(0xF0D228u);
    g_overlay_point_color = (mh_u8)mh->draw.color(0xF0F028u);
    g_overlay_target_color = (mh_u8)mh->draw.color(0xF0503Cu);
    g_overlay_selected_color = (mh_u8)mh->draw.color(0x3CE6F0u);
    g_overlay_collision_color = (mh_u8)mh->draw.color(0xF046DCu);

    if (g_show_collision) draw_collision_wireframe((mh_u8 *)0, (int)w, (int)h);
    draw_actor_world_overlay((mh_u8 *)0, (int)w, (int)h, (const mh_u8 *)0);
    if (g_info_hud) draw_info_hud((mh_u8 *)0, (int)w, (int)h, g_overlay_white);
}

/* ---------------------------------------------------------------- options */

typedef struct MHSwitch { const char *key; int *value; MHOption option; } MHSwitch;

static MHSwitch g_switches[] = {
    { "hud", &g_info_hud, 0 }, { "player", &g_show_player_info, 0 }, { "weapon", &g_show_weapon_info, 0 },
    { "inspector", &g_show_actor_info, 0 }, { "types", &g_show_actor_types, 0 }, { "states", &g_show_actor_states, 0 },
    { "headings", &g_show_actor_headings, 0 }, { "paths", &g_show_actor_paths, 0 }, { "points", &g_show_actor_path_points, 0 },
    { "targets", &g_show_actor_targets, 0 }, { "collision", &g_show_collision, 0 }, { "status", &g_show_developer_info, 0 },
    { "cheats", &g_show_cheat_info, 0 }, { "passive", &g_passive_ai, 0 }, { "trace", &g_trace, 0 },
    { "speed", &g_game_speed_mode, 0 }
};
#define SWITCH_COUNT ((mh_u32)(sizeof(g_switches) / sizeof(g_switches[0])))

static MHOption g_action_next, g_action_snapshot, g_action_mark;

static void MH_STDCALL on_event(const MHAPI *api, const MHEvent *event, void *context)
{
    mh_u32 i;
    (void)api; (void)context;
    switch (event->type) {
        case MH_EVENT_FRAME:
            DevTraceFrame();
            break;
        case MH_EVENT_DRAW:
            draw();
            break;
        case MH_EVENT_OPTION_CHANGED:
            for (i = 0; i < SWITCH_COUNT; ++i) {
                if (g_switches[i].option != event->option) continue;
                *g_switches[i].value = (int)event->value;
                if (g_switches[i].value == &g_trace) DevTraceSetEnabled(g_trace);
                if (g_switches[i].value == &g_game_speed_mode) g_game_speed_phase = 0;
            }
            break;
        case MH_EVENT_ACTION:
            if (event->option == g_action_next) select_next_active();
            else if (event->option == g_action_snapshot) make_snapshot();
            else if (event->option == g_action_mark) DevTraceInsertMarker();
            break;
        default:
            break;
    }
}

MH_EXPORT int MH_STDCALL MHModInit(const MHModContext *context)
{
    static const mh_u8 relations_expected[8] = { 0x55, 0x8B, 0x6C, 0x24, 0x08, 0x8B, 0xC5, 0x56 };
    static const mh_u8 search_expected[8] = { 0x83, 0xEC, 0x08, 0x53, 0x8B, 0x5C, 0x24, 0x14 };
    static const mh_u8 world_update_expected[5] = { 0xE9, 0xBC, 0x52, 0x02, 0x00 };
    const char *id;
    mh_u32 i;

    if (!context || !context->mh || context->mh->api_version != MH_API_VERSION) return 0;
    mh = context->mh;
    id = context->mod.id;

    for (i = 0; i < SWITCH_COUNT; ++i) {
        g_switches[i].option = mh->options.find(id, g_switches[i].key);
        *g_switches[i].value = (int)mh->options.get(g_switches[i].option);
    }
    g_action_next = mh->options.find(id, "next_actor");
    g_action_snapshot = mh->options.find(id, "snapshot");
    g_action_mark = mh->options.find(id, "trace_mark");
    if (g_game_speed_mode < 0 || g_game_speed_mode > 4) g_game_speed_mode = 0;

    /* A hook that does not match leaves its feature inert; the rest still works. */
    if (!mh->engine.detour(MH_VA_UPDATE_PLAYER_RELATIONS, relations_expected, 8u, (void *)&update_player_relations_hook, (void **)&g_update_relations_original) ||
        !mh->engine.detour(MH_VA_SEARCH_PLAYER_GROUP, search_expected, 8u, (void *)&search_player_hook, (void **)&g_search_player_original))
        mh->runtime.log("Developer Tools: passive enemies unavailable (signature mismatch)");
    if (!mh->engine.detour(MH_VA_GAMEPLAY_WORLD_UPDATE_THUNK, world_update_expected, 5u, (void *)&gameplay_world_update_hook, (void **)&g_world_update_original))
        mh->runtime.log("Developer Tools: game speed unavailable (signature mismatch)");

    DevTraceInit();
    if (g_trace) DevTraceSetEnabled(1);

    return mh->runtime.subscribe(MH_EVENT_MASK_FRAME | MH_EVENT_MASK_DRAW | MH_EVENT_MASK_OPTION_CHANGED | MH_EVENT_MASK_ACTION,
                                 on_event, (void *)0) != MH_INVALID_SUBSCRIPTION;
}
