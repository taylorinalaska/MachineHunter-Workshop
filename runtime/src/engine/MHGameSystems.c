#include "MHGameSystems.h"

/*
 * Camera, input blocking, startup skipping and Enter in the pause menu.
 *
 * These are the engine hooks several mods would otherwise each install for
 * themselves. They are pass-through until a mod uses the matching API.
 */

#if defined(_MSC_VER) || defined(__clang__)
#define MH_CDECL __cdecl
#else
#define MH_CDECL
#endif

/* Input: the game's per-frame control snapshot. */
#define MH_VA_INPUT_SNAPSHOT            0x004520C0u
#define MH_VA_INPUT_RAW_BITS            0x006BB958u
#define MH_VA_INPUT_CURRENT_BITS        0x006BB8E4u
#define MH_VA_INPUT_PREVIOUS_BITS       0x006BB940u
#define MH_VA_GAME_FLOW_STATE           0x004AF8CCu
#define MH_FLOW_PAUSED                  12u
/* Control bits: Enter is the pause key, Ctrl (fire) confirms in the pause menu. */
#define MH_CONTROL_PAUSE                0x8000u
#define MH_CONTROL_CONFIRM              0x0010u

/* Camera: the view the renderer draws from is a pointer to a 0x4C-byte record. */
#define MH_VA_ACTIVE_CAMERA_UPDATE      0x00420F00u
#define MH_VA_ACTIVE_VIEW_PTR           0x00489A74u
#define MH_VA_RETAIL_VIEW_STRUCT        0x004B0170u
#define MH_ACTIVE_VIEW_SIZE             0x0000004Cu
#define MH_VA_ACTIVE_VIEW_PREP          0x00441E90u
#define MH_VA_ACTIVE_COMPOSITOR         0x00443490u
#define MH_VA_ACTIVE_VIEW_SCALE         0x0069C36Cu
#define MH_VA_VIEW_CENTER_X             0x006A2470u
#define MH_VA_VIEW_CENTER_Y             0x0069C258u
#define MH_VA_PROJECTION_FOCAL          0x0048BD3Cu
#define MH_VA_VIEW_WIDTH                0x0069C2E4u
#define MH_VA_VIEW_HEIGHT               0x0069C3B4u
#define MH_VA_VIDEO_WIDTH               0x0048BD40u
#define MH_VA_VIDEO_HEIGHT              0x0048BD44u
#define MH_VA_TRIG_COS_TABLE            0x00632908u
#define MH_VA_TRIG_SIN_TABLE            0x0065A880u

/* Startup: the named-movie wrapper and the legal screen's countdown. */
#define MH_VA_NAMED_MOVIE_WRAPPER       0x00425350u
#define MH_VA_COPYRIGHT_INIT            0x00450240u
#define MH_VA_COPYRIGHT_TIMER           0x0049451Cu
#define MH_MOVIE_MGM                    0
#define MH_MOVIE_EURO                   1
#define MH_MOVIE_INTRO1                 2
#define MH_MOVIE_TITLE1                 8

typedef void   (MH_CDECL *PFN_Void)(void);
typedef mh_u32 (MH_CDECL *PFN_InputSnapshot)(void);
typedef int    (MH_CDECL *PFN_NamedMovie)(int movie_index, int playback_mode);

typedef struct MHActiveView {
    mh_i32 x;                 /* +0x00, fixed-point X; the renderer reads the word at +2 */
    mh_i32 y;                 /* +0x04 */
    mh_i32 z;                 /* +0x08 */
    mh_u8 tail[MH_ACTIVE_VIEW_SIZE - 12u];
} MHActiveView;

/* What the renderer used for the frame now on screen. */
typedef struct MHProjectionState {
    int valid;
    mh_i32 view_x, view_y, view_z;
    mh_u16 yaw, orient;
    mh_i32 depth_bias, y_param, scale, focal, center_x;
    mh_i32 yaw_c, yaw_s, orient_c, orient_s, y_base;
} MHProjectionState;

int MH_STDCALL MHMapsAutostartRequested(void);

static const MHHostAPI *g_host;
static PFN_Void g_camera_update_original;
static PFN_Void g_view_prep_original;
static PFN_Void g_compositor_original;
static PFN_InputSnapshot g_input_snapshot_original;
static PFN_NamedMovie g_named_movie_original;
static PFN_Void g_copyright_init_original;

static int g_camera_override;
static mh_i32 g_camera_x, g_camera_y;
static mh_i32 g_camera_zoom = MH_ZOOM_ONE;
static mh_i32 g_retail_zoom = MH_ZOOM_ONE;
static mh_u32 g_retail_view_ptr = MH_VA_RETAIL_VIEW_STRUCT;
static MHActiveView g_override_view;
static MHProjectionState g_projection;

static mh_u32 g_block_next, g_block_active;
static int g_skip_movies, g_skip_title, g_skip_movies_logged, g_skip_title_logged;

static mh_i32 read_i32(mh_u32 address) { mh_i32 v = 0; g_host->read_memory(address, &v, 4); return v; }
static mh_u32 read_u32(mh_u32 address) { mh_u32 v = 0; g_host->read_memory(address, &v, 4); return v; }
static mh_u16 read_u16(mh_u32 address) { mh_u16 v = 0; g_host->read_memory(address, &v, 2); return v; }
static short read_i16(mh_u32 address) { short v = 0; g_host->read_memory(address, &v, 2); return v; }
static void write_u32(mh_u32 address, mh_u32 value) { *(volatile mh_u32 *)address = value; }
static void write_i32(mh_u32 address, mh_i32 value) { *(volatile mh_i32 *)address = value; }
static void write_u16(mh_u32 address, mh_u16 value) { *(volatile mh_u16 *)address = value; }

/* ---------------------------------------------------------------- camera */

static mh_i32 valid_zoom(mh_i32 scale)
{
    return (scale < MH_ZOOM_MIN || scale > MH_ZOOM_MAX) ? MH_ZOOM_ONE : scale;
}

/* Remember the game's own view so it can be handed back. */
static void capture_retail_view(void)
{
    mh_u32 ptr = read_u32(MH_VA_ACTIVE_VIEW_PTR);
    if (ptr && ptr != (mh_u32)(void *)&g_override_view) g_retail_view_ptr = ptr;
    if (!g_retail_view_ptr || g_retail_view_ptr == (mh_u32)(void *)&g_override_view) g_retail_view_ptr = MH_VA_RETAIL_VIEW_STRUCT;
    g_retail_zoom = valid_zoom(read_i32(MH_VA_ACTIVE_VIEW_SCALE));
}

/* The game keeps updating its own view record (shake, rotation, height).
   Clone it, replace only X/Y, and point the renderer at the clone. */
static void refresh_override_view(void)
{
    if (!g_camera_override) return;
    if (!g_host->read_memory(g_retail_view_ptr, &g_override_view, MH_ACTIVE_VIEW_SIZE)) return;
    g_override_view.x = g_camera_x;
    g_override_view.y = g_camera_y;
    write_u32(MH_VA_ACTIVE_VIEW_PTR, (mh_u32)(void *)&g_override_view);
    write_i32(MH_VA_ACTIVE_VIEW_SCALE, g_camera_zoom);
}

static void begin_override(void)
{
    if (g_camera_override) return;
    capture_retail_view();
    g_camera_x = read_i32(g_retail_view_ptr + 0x00u);
    g_camera_y = read_i32(g_retail_view_ptr + 0x04u);
    g_camera_zoom = g_retail_zoom;
    g_camera_override = 1;
}

int MH_STDCALL MHCameraSet(const MHPosition *position, mh_i32 zoom)
{
    if (!position || !g_host) return 0;
    begin_override();
    g_camera_x = position->x;
    g_camera_y = position->y;
    if (zoom) g_camera_zoom = zoom < MH_ZOOM_MIN ? MH_ZOOM_MIN : (zoom > MH_ZOOM_MAX ? MH_ZOOM_MAX : zoom);
    refresh_override_view();
    return 1;
}

int MH_STDCALL MHCameraPan(mh_i32 right, mh_i32 down)
{
    mh_u32 index;
    mh_i32 cosine, sine;
    if (!g_host) return 0;
    begin_override();
    index = (mh_u32)read_u16(g_retail_view_ptr + 0x16u) & 0x7FFu;
    cosine = read_i32(MH_VA_TRIG_COS_TABLE + index * 4u);
    sine = read_i32(MH_VA_TRIG_SIN_TABLE + index * 4u);
    if (cosine == 0 && sine == 0) {
        g_camera_x += right;
        g_camera_y += down;
    } else {
        /* The inverse of the view's yaw, so "right" is right on screen however
           the map is turned. The tables are Q15. */
        mh_i32 r = right / 32768, d = down / 32768;
        g_camera_x += cosine * r - sine * d;
        g_camera_y += sine * r + cosine * d;
    }
    refresh_override_view();
    return 1;
}

void MH_STDCALL MHCameraRelease(void)
{
    if (!g_camera_override) return;
    write_u32(MH_VA_ACTIVE_VIEW_PTR, g_retail_view_ptr ? g_retail_view_ptr : MH_VA_RETAIL_VIEW_STRUCT);
    write_i32(MH_VA_ACTIVE_VIEW_SCALE, g_retail_zoom);
    g_camera_override = 0;
}

int MH_STDCALL MHCameraGet(MHCameraState *state)
{
    mh_u32 view;
    if (!state || !g_host) return 0;
    view = g_camera_override ? g_retail_view_ptr : read_u32(MH_VA_ACTIVE_VIEW_PTR);
    if (!view) return 0;
    state->position.x = g_camera_override ? g_camera_x : read_i32(view + 0x00u);
    state->position.y = g_camera_override ? g_camera_y : read_i32(view + 0x04u);
    state->position.z = read_i32(view + 0x08u);
    state->zoom = g_camera_override ? g_camera_zoom : valid_zoom(read_i32(MH_VA_ACTIVE_VIEW_SCALE));
    state->yaw = (mh_u16)(read_u16(view + 0x16u) & 0x7FFu);
    state->overridden = (mh_u16)(g_camera_override ? 1u : 0u);
    return 1;
}

/* Free movement and zoom ignore the game's F7/F8 viewport shrink. */
static void force_full_viewport(void)
{
    mh_i32 width = read_i32(MH_VA_VIDEO_WIDTH), height = read_i32(MH_VA_VIDEO_HEIGHT);
    if (width <= 0 || width > 4096 || height <= 0 || height > 4096) return;
    write_i32(MH_VA_VIEW_CENTER_X, width >> 1);
    write_i32(MH_VA_VIEW_CENTER_Y, height >> 1);
    write_i32(MH_VA_VIEW_WIDTH, width);
    write_i32(MH_VA_VIEW_HEIGHT, height);
}

static void MH_CDECL camera_update_hook(void)
{
    if (g_camera_update_original) g_camera_update_original();
    refresh_override_view();
}

static void MH_CDECL view_prep_hook(void)
{
    refresh_override_view();
    if (g_view_prep_original) g_view_prep_original();
    if (g_camera_override) force_full_viewport();
}

/* ------------------------------------------------------------ projection */

static int load_projection(MHProjectionState *state)
{
    mh_u32 view = read_u32(MH_VA_ACTIVE_VIEW_PTR);
    mh_u16 angle;
    state->valid = 0;
    if (!view) return 0;
    state->view_x = (mh_i32)read_i16(view + 0x02u);
    state->view_y = (mh_i32)read_i16(view + 0x06u);
    state->view_z = (mh_i32)read_i16(view + 0x0Au);
    state->yaw = read_u16(view + 0x16u);
    state->orient = read_u16(view + 0x1Eu);
    state->depth_bias = (mh_i32)read_i16(view + 0x12u);
    state->y_param = read_i32(view + 0x24u);
    state->scale = read_i32(MH_VA_ACTIVE_VIEW_SCALE);
    state->focal = read_i32(MH_VA_PROJECTION_FOCAL);
    if (!state->focal) state->focal = (mh_i32)(((mh_u32)state->scale * 360u) >> 14);
    state->center_x = read_i32(MH_VA_VIEW_CENTER_X);

    angle = (mh_u16)((-(mh_i32)state->yaw) & 0x07ff);
    state->yaw_c = read_i32(MH_VA_TRIG_COS_TABLE + (mh_u32)angle * 4u);
    state->yaw_s = read_i32(MH_VA_TRIG_SIN_TABLE + (mh_u32)angle * 4u);
    angle = (mh_u16)((-(mh_i32)state->orient) & 0x07ff);
    state->orient_c = read_i32(MH_VA_TRIG_COS_TABLE + (mh_u32)angle * 4u);
    state->orient_s = read_i32(MH_VA_TRIG_SIN_TABLE + (mh_u32)angle * 4u);
    state->y_base = (mh_i32)(((mh_u32)state->scale * (mh_u32)state->y_param) >> 14);
    state->valid = state->focal != 0;
    return state->valid;
}

static void MH_CDECL compositor_hook(void)
{
    refresh_override_view();
    if (g_compositor_original) g_compositor_original();
    /* Overlays are drawn later, at present time, when the live view may already
       describe the next frame. Keep what this frame was rendered with. */
    (void)load_projection(&g_projection);
}

/* The integer projection of the retail polygon path at 0x00436B10. The
   arithmetic mirrors x86 low-32-bit IMUL/ADD/SUB before the arithmetic shifts
   so projected points land where the game's own geometry does. */
static mh_i32 mul_add_sar15(mh_i32 a, mh_i32 b, mh_i32 c, mh_i32 d)
{
    return ((mh_i32)((mh_u32)a * (mh_u32)b + (mh_u32)c * (mh_u32)d)) >> 15;
}

static mh_i32 mul_sub_sar15(mh_i32 a, mh_i32 b, mh_i32 c, mh_i32 d)
{
    return ((mh_i32)((mh_u32)a * (mh_u32)b - (mh_u32)c * (mh_u32)d)) >> 15;
}

static mh_i32 mul_sar16(mh_i32 a, mh_i32 b)
{
    return ((mh_i32)((mh_u32)a * (mh_u32)b)) >> 16;
}

int MH_STDCALL MHCameraProject(const MHPosition *world, mh_i32 *screen_x, mh_i32 *screen_y)
{
    MHProjectionState live;
    const MHProjectionState *state = &g_projection;
    mh_i32 rel_x, rel_y, rel_z, rotated_x, rotated_y, scaled_z, vertical, depth, factor, sx, sy;
    if (!world || !screen_x || !screen_y || !g_host) return 0;
    if (!state->valid) {
        if (!load_projection(&live)) return 0;
        state = &live;
    }

    /* 0x004422A0 builds actor vertices in this camera-relative basis, in map subunits. */
    rel_x = (mh_i32)((mh_u32)(world->x >> 16) - (mh_u32)state->view_x);
    rel_y = (mh_i32)((mh_u32)(world->y >> 16) - (mh_u32)state->view_y);
    rel_z = (mh_i32)((mh_u32)state->view_z - (mh_u32)(world->z >> 16));

    rotated_x = mul_sub_sar15(state->yaw_c, rel_x, state->yaw_s, rel_y);
    rotated_y = mul_add_sar15(state->yaw_s, rel_x, state->yaw_c, rel_y);

    /* 0x00436D08..0x00436D94: the first result is the on-screen vertical, the
       second (plus view+0x12) is depth. */
    scaled_z = ((mh_i32)(((mh_u32)rel_z * 13u) << 9)) >> 12;
    vertical = mul_sub_sar15(state->orient_c, rotated_y, state->orient_s, scaled_z);
    depth = mul_add_sar15(state->orient_c, scaled_z, state->orient_s, rotated_y);
    depth = (mh_i32)((mh_u32)depth + (mh_u32)state->depth_bias);
    if (depth < 10) return 0;

    factor = (mh_i32)((mh_i32)((mh_u32)state->focal << 16) / depth);
    sx = (mh_i32)((mh_u32)state->center_x + (mh_u32)mul_sar16(rotated_x, factor));
    sy = (mh_i32)((mh_u32)state->y_base + (mh_u32)mul_sar16(vertical, factor));
    if (sx < -32768 || sx > 32767 || sy < -32768 || sy > 32767) return 0;
    *screen_x = sx;
    *screen_y = sy;
    return 1;
}

/* ----------------------------------------------------------------- input */

void MH_STDCALL MHInputBlock(mh_u32 controls) { g_block_next |= controls & MH_CONTROLS_ALL; }
mh_u32 MH_STDCALL MHInputBlocked(void) { return g_block_active; }

void MH_STDCALL MHInputEndFrame(void)
{
    g_block_active = g_block_next;
    g_block_next = 0;
}

/*
 * Enter is the pause key, and while paused it still is: in the pause menu it
 * toggles the pause off whatever is highlighted, and only Ctrl (fire) picks
 * an item, although the menu says "RETURN CONFIRMS". So QUIT could not be
 * picked with Enter: it just resumed the game. While paused, Enter is made
 * the menu's confirm instead; held on into play it does not pause again.
 */
static int g_enter_confirms;

static mh_u16 enter_as_confirm(mh_u16 bits)
{
    return (bits & MH_CONTROL_PAUSE) ? (mh_u16)((bits & ~MH_CONTROL_PAUSE) | MH_CONTROL_CONFIRM) : bits;
}

static void pause_menu_enter(void)
{
    mh_u16 current = read_u16(MH_VA_INPUT_CURRENT_BITS);
    if (read_u32(MH_VA_GAME_FLOW_STATE) == MH_FLOW_PAUSED) {
        g_enter_confirms = (current & MH_CONTROL_PAUSE) != 0;
        write_u16(MH_VA_INPUT_CURRENT_BITS, enter_as_confirm(current));
        write_u16(MH_VA_INPUT_PREVIOUS_BITS, enter_as_confirm(read_u16(MH_VA_INPUT_PREVIOUS_BITS)));
    } else if (g_enter_confirms) {
        /* The Enter that picked CONTINUE is still down: it is not a new press of the pause key. */
        if (current & MH_CONTROL_PAUSE) write_u16(MH_VA_INPUT_PREVIOUS_BITS, (mh_u16)(read_u16(MH_VA_INPUT_PREVIOUS_BITS) | MH_CONTROL_PAUSE));
        else g_enter_confirms = 0;
    }
}

static mh_u32 MH_CDECL input_snapshot_hook(void)
{
    mh_u32 result = g_input_snapshot_original ? g_input_snapshot_original() : 0u;
    pause_menu_enter();
    if (g_block_active) {
        write_u32(MH_VA_INPUT_RAW_BITS, read_u32(MH_VA_INPUT_RAW_BITS) & ~g_block_active);
        write_u16(MH_VA_INPUT_CURRENT_BITS, (mh_u16)(read_u16(MH_VA_INPUT_CURRENT_BITS) & (0xFFFFu ^ g_block_active)));
    }
    return result;
}

/* --------------------------------------------------------------- startup */

void MH_STDCALL MHStartupSkip(int movies, int title)
{
    if (movies) g_skip_movies = 1;
    if (title) g_skip_title = 1;
}

static int MH_CDECL named_movie_hook(int movie_index, int playback_mode)
{
    /* Zero is the wrapper's ordinary "movie finished" result, so startup
       carries on through its normal cleanup. */
    if (g_skip_movies && (movie_index == MH_MOVIE_MGM || movie_index == MH_MOVIE_EURO || movie_index == MH_MOVIE_INTRO1)) {
        if (!g_skip_movies_logged) { g_skip_movies_logged = 1; g_host->log("MH startup: logo and intro movies skipped"); }
        return 0;
    }
    /* TITLE1 returns 1 when a key interrupts it; saying so keeps TITLE2 and
       the game's own route into the main menu. */
    if (g_skip_title && movie_index == MH_MOVIE_TITLE1) {
        if (!g_skip_title_logged) { g_skip_title_logged = 1; g_host->log("MH startup: PRESS START skipped"); }
        return 1;
    }
    return g_named_movie_original(movie_index, playback_mode);
}

static void MH_CDECL copyright_init_hook(void)
{
    g_copyright_init_original();
    /* The legal screen has no input branch, only a 300-tick countdown. */
    if (g_skip_movies) write_i32(MH_VA_COPYRIGHT_TIMER, 0);
}

/* ------------------------------------------------------------------ init */

static int hook(mh_u32 address, const mh_u8 *expected, mh_u32 size, void *replacement, void **original, const char *what)
{
    mh_u32 trampoline = 0;
    if (!g_host->install_detour(address, expected, size, replacement, &trampoline)) {
        g_host->log(what);
        return 0;
    }
    if (original) *original = (void *)trampoline;
    return 1;
}

int MH_STDCALL MHGameSystemsInit(const MHHostAPI *host)
{
    static const mh_u8 camera_update_expected[8] = { 0x83, 0xEC, 0x10, 0xB8, 0x78, 0x00, 0x00, 0x00 };
    static const mh_u8 view_prep_expected[8] = { 0x8B, 0x0D, 0x6C, 0xC3, 0x69, 0x00, 0x8B, 0xC1 };
    static const mh_u8 compositor_expected[8] = { 0xA0, 0xFD, 0xAC, 0x67, 0x00, 0x83, 0xEC, 0x14 };
    static const mh_u8 input_expected[6] = { 0x66, 0xA1, 0xE4, 0xB8, 0x6B, 0x00 };
    static const mh_u8 named_movie_expected[9] = { 0x8B, 0x44, 0x24, 0x04, 0x56, 0x8B, 0x74, 0x24, 0x0C };
    static const mh_u8 copyright_expected[6] = { 0x56, 0xBE, 0x58, 0x44, 0x49, 0x00 };

    if (!host || !host->install_detour || !host->read_memory || !host->log) return 0;
    g_host = host;

    if (!hook(MH_VA_ACTIVE_CAMERA_UPDATE, camera_update_expected, 8u, (void *)&camera_update_hook, (void **)&g_camera_update_original, "MH camera: camera-update hook signature mismatch") ||
        !hook(MH_VA_ACTIVE_VIEW_PREP, view_prep_expected, 8u, (void *)&view_prep_hook, (void **)&g_view_prep_original, "MH camera: view-prep hook signature mismatch") ||
        !hook(MH_VA_ACTIVE_COMPOSITOR, compositor_expected, 8u, (void *)&compositor_hook, (void **)&g_compositor_original, "MH camera: compositor hook signature mismatch") ||
        !hook(MH_VA_INPUT_SNAPSHOT, input_expected, 6u, (void *)&input_snapshot_hook, (void **)&g_input_snapshot_original, "MH input: snapshot hook signature mismatch") ||
        !hook(MH_VA_NAMED_MOVIE_WRAPPER, named_movie_expected, 9u, (void *)&named_movie_hook, (void **)&g_named_movie_original, "MH startup: named-movie hook signature mismatch") ||
        !hook(MH_VA_COPYRIGHT_INIT, copyright_expected, 6u, (void *)&copyright_init_hook, (void **)&g_copyright_init_original, "MH startup: legal-screen hook signature mismatch"))
        return 0;

    /* A map started straight from the Workshop goes directly to it. */
    if (MHMapsAutostartRequested()) MHStartupSkip(1, 1);
    host->log("MH services: camera, input blocking and startup skipping ready");
    return 1;
}
