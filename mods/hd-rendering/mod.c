/*
 * HD Rendering: run the game's software renderer at up to 640x480.
 *
 * The retail game renders 320x240. This mod draws the 3D world at the chosen
 * size, with real extra detail rather than stretched, and leaves everything
 * else exactly as retail.
 *
 * The game is told the screen is 320x240, as it always was, except while it
 * draws the world. Every menu, briefing, status bar, message, the automap and
 * the "CONTINUE?" screen is therefore laid out and drawn by the game's own
 * code at retail coordinates, into a 320x240 layer. Just before the frame is
 * shown, the layer is scaled up: in play, only the pixels the interface
 * changed go on top of the full-size world; on a screen without a world (the
 * menus), the whole layer is shown.
 *
 * The range stays 4:3 and no taller than 480 lines: the game's sprite
 * row-offset table has 480 entries.
 *
 * The picture is then shown in a window of any size, or fullscreen on the
 * monitor the window is on, kept 4:3 with black bars or stretched, scaled
 * sharp, smooth or by whole pixels only. That part works at every render
 * resolution, 320x240 included.
 *
 * It needs nothing but the runtime. If the Mod Menu is installed its one
 * option appears there; it can equally be set in the Workshop or by hand in
 * mods\settings.cfg. With the mod switched off the game is exactly retail.
 */
#include "mh.h"

typedef MHU8 u8;
typedef MHU16 u16;
typedef MHU32 u32;
typedef MHI32 i32;

#define MH_VIDEO_WIDTH        0x0048BD40u
#define MH_VIDEO_HEIGHT       0x0048BD44u
#define MH_PROJECTION_FOCAL   0x0048BD3Cu
#define MH_WORLD_RENDER_THUNK 0x00402428u
#define MH_RENDER_MIN_W       320
#define MH_RENDER_MIN_H       240
#define MH_RENDER_MAX_W       640
#define MH_RENDER_MAX_H       480
#define MH_UI_W               320
#define MH_UI_H               240
#define MH_UI_SIZE            (MH_UI_W * MH_UI_H)

/* Where the 2D drawing code writes, and its clip rectangle and row-offset table. */
#define MH_ACTIVE_DRAW_PTR    0x0067B678u
#define MH_2D_CLIP_RIGHT      0x006A2450u
#define MH_2D_CLIP_LEFT       0x006A2454u
#define MH_2D_CLIP_BOTTOM     0x006A2458u
#define MH_2D_CLIP_TOP        0x006A245Cu
#define MH_ROW_TABLE          0x00632158u
/* The screen-centre drawing pointer the frame function sets for the world. */
#define MH_CENTER_DRAW_PTR    0x00658F18u
/* The view size at the current zoom, set by 0x00441E90 before the world is drawn:
   width, height, half width, half height. Code outside the world reads them too. */
#define MH_VIEW_WIDTH         0x0069C2E4u
#define MH_VIEW_HEIGHT        0x0069C3B4u
#define MH_VIEW_HALF_WIDTH    0x006A2470u
#define MH_VIEW_HALF_HEIGHT   0x0069C258u
/* The camera record 0x004B0170 works in screen pixels too: the screen point it keeps the
   player at (+0x20, +0x24, eased towards the middle every tick) and its screen rectangle
   (+0x30 left, right, top, bottom). The game updates them every tick at 320x240; the
   interface uses them too ("CONTINUE?" is centred on the rectangle). */
#define MH_CAMERA_CENTER      0x004B0190u
#define MH_CAMERA_RECT        0x004B01A0u

/* Menus (0x0042D030), the in-game frame (0x00443490: the world, then the status bar
   0x00443A60 and the rest of the interface) and the windowed present. */
#define MH_FRONTEND_COMPOSITOR 0x0042D030u
#define MH_GAME_FRAME          0x00443490u
#define MH_GAME_HUD            0x00443A60u
#define MH_PRESENT_WINDOWED    0x00439640u
/* The start of a frame (0x00439120, clears the frame when 0x0048BD38 is set) and a clear
   and present (0x004393F0) both point the 2D drawing back at the frame, 0x0065CC84. */
#define MH_FRAME_BEGIN         0x00439120u
#define MH_CLEAR_AND_PRESENT   0x004393F0u
/* The movie player's frame start (0x00425120 copies each 320x240 movie frame to the drawing pointer). */
#define MH_MOVIE_FRAME_BEGIN   0x00439260u
/* The game's window, and the import slot of StretchDIBits, which only the windowed present calls. */
#define MH_WINDOW              0x0067ACECu
#define MH_STRETCH_DIBITS_SLOT 0x0074A544u
#define MH_FRAME_CLEAR_FLAG    0x0048BD38u
#define MH_FRAMEBUFFER         0x0065CC84u
/* Flags of the frame function's first branch, which copies a whole 320x240 picture instead of drawing the world. */
#define MH_FRAME_PICTURE_FLAG  0x0067ACFDu
#define MH_FRAME_PICTURE_A     0x0069BE38u
#define MH_FRAME_PICTURE_B     0x0069BA78u

/* Four polygon setup paths store a hard-coded 8-bit pitch: mov dword [0x0062C420], 320. */
static const u32 k_pitch_sites[4] = { 0x00436893u, 0x004369E1u, 0x00436AA8u, 0x00436B50u };
static const u8 k_pitch_code[10] = { 0xC7,0x05,0x20,0xC4,0x62,0x00,0x40,0x01,0x00,0x00 };

static const MHAPI *mh;
static i32 g_render_width = MH_UI_W;
static i32 g_render_height = MH_UI_H;

static void copy_bytes(void *dst, const void *src, u32 n)
{
    u8 *d = (u8 *)dst;
    const u8 *s = (const u8 *)src;
    u32 i;
    for (i = 0; i < n; ++i) d[i] = s[i];
}

static void put_u32_le(u8 *dst, u32 value)
{
    dst[0] = (u8)(value & 0xffu);
    dst[1] = (u8)((value >> 8) & 0xffu);
    dst[2] = (u8)((value >> 16) & 0xffu);
    dst[3] = (u8)((value >> 24) & 0xffu);
}

static int valid_render_resolution(i32 width, i32 height)
{
    if (width < MH_RENDER_MIN_W || width > MH_RENDER_MAX_W) return 0;
    if (height < MH_RENDER_MIN_H || height > MH_RENDER_MAX_H) return 0;
    if ((width & 1) || (height & 1)) return 0;
    /* The recovered terrain and culling path has not been widened beyond 4:3. */
    if (width * 3 != height * 4) return 0;
    return 1;
}

/* True when the code at `address` is the retail code, even if another mod has detoured it. */
static int code_is(u32 address, const u8 *expected, u32 size)
{
    return mh->engine.patch(address, expected, expected, size);
}

static int detour(u32 address, const u8 *expected, u32 size, void *hook, u32 *original)
{
    void *previous = (void *)0;
    if (!mh->engine.detour(address, expected, size, hook, &previous)) return 0;
    *original = (u32)previous;
    return 1;
}

/* ------------------------------------------------------------------ world projection */

typedef void (__cdecl *PFN_Void)(void);

static PFN_Void g_world_render_original;

static void __cdecl configured_world_render_hook(void)
{
    i32 focal = *(volatile i32 *)MH_PROJECTION_FOCAL;
    /* Retail focal is calibrated for 240 vertical pixels. Preserve vertical
       FOV by scaling that already-computed zoom-dependent focal by height. */
    focal = (i32)(((u32)focal * (u32)g_render_height + 120u) / 240u);
    *(volatile i32 *)MH_PROJECTION_FOCAL = focal;
    if (g_world_render_original) g_world_render_original();
}

/* ------------------------------------------------------------------ the two screen sizes */

static u8 g_layer[MH_UI_SIZE];      /* everything but the world draws here, at 320x240 */
static u8 g_reference[MH_UI_SIZE];  /* the layer as it was before the interface drew, in play */
static u32 g_framebuffer;           /* the real frame, at the render size (0x0065CC84) */
static i32 g_full_size = 1;         /* what the game is told now: 1 the render size, 0 320x240 */
static i32 g_started = 0;           /* switched to 320x240 once the game's video is set up */
static i32 g_world_drawn = 0;       /* the world was drawn this frame, and the layer holds a reference */

static void rebuild_row_table(i32 pitch)
{
    volatile u32 *rows = (volatile u32 *)MH_ROW_TABLE;
    u32 y;
    for (y = 0; y < 480u; ++y) rows[y] = y * (u32)pitch;
}

static void set_pitch_sites(i32 pitch)
{
    u8 value[4];
    u32 i;
    put_u32_le(value, (u32)pitch);
    for (i = 0; i < 4u; ++i) mh->engine.write(k_pitch_sites[i] + 6u, value, 4u);
}

static i32 scaled(i32 value, i32 to, i32 from)
{
    /* View sizes are a few thousand at most: no overflow in 32 bits. */
    return value * to / from;
}

/* Values in screen pixels the game keeps between frames, scaled to the render size while
   the world is drawn and back to 320x240 after. Each remembers its exact 320x240 value,
   so scaling back and forth never drifts; one the game changed meanwhile is scaled anew. */
static const u32 k_pixel_values[] = {
    MH_VIEW_WIDTH, MH_VIEW_HEIGHT, MH_VIEW_HALF_WIDTH, MH_VIEW_HALF_HEIGHT,
    MH_CAMERA_CENTER, MH_CAMERA_CENTER + 4u,
    MH_CAMERA_RECT, MH_CAMERA_RECT + 4u, MH_CAMERA_RECT + 8u, MH_CAMERA_RECT + 12u
};
#define MH_PIXEL_VALUES (sizeof(k_pixel_values) / sizeof(k_pixel_values[0]))
static i32 g_small_value[MH_PIXEL_VALUES];   /* at 320x240 */
static i32 g_large_value[MH_PIXEL_VALUES];   /* what it was scaled to */

static void scale_pixel_values(i32 full)
{
    u32 i;
    for (i = 0; i < MH_PIXEL_VALUES; ++i) {
        volatile i32 *v = (volatile i32 *)k_pixel_values[i];
        if (full) {
            g_small_value[i] = *v;
            g_large_value[i] = scaled(*v, g_render_width, MH_UI_W);
            *v = g_large_value[i];
        } else {
            *v = *v == g_large_value[i] ? g_small_value[i] : scaled(*v, MH_UI_W, g_render_width);
        }
    }
}

/*
 * Tell the game the screen is the render size (`full`) or 320x240, and point
 * its 2D drawing at the real frame or the layer. The view sizes scale with it.
 */
static void set_full_size(i32 full)
{
    i32 w = full ? g_render_width : MH_UI_W;
    i32 h = full ? g_render_height : MH_UI_H;
    if (*(volatile u32 *)MH_FRAMEBUFFER) g_framebuffer = *(volatile u32 *)MH_FRAMEBUFFER;
    if (full == g_full_size) {
        *(volatile u32 *)MH_ACTIVE_DRAW_PTR = full ? g_framebuffer : (u32)(void *)g_layer;
        return;
    }
    g_full_size = full;
    *(volatile i32 *)MH_VIDEO_WIDTH = w;
    *(volatile i32 *)MH_VIDEO_HEIGHT = h;
    *(volatile u32 *)MH_ACTIVE_DRAW_PTR = full ? g_framebuffer : (u32)(void *)g_layer;
    *(volatile u16 *)MH_2D_CLIP_LEFT = 0;
    *(volatile u16 *)MH_2D_CLIP_TOP = 0;
    *(volatile u16 *)MH_2D_CLIP_RIGHT = (u16)(w - 1);
    *(volatile u16 *)MH_2D_CLIP_BOTTOM = (u16)(h - 1);
    rebuild_row_table(w);
    set_pitch_sites(w);
    scale_pixel_values(full);
    {
        /* The centre pointer as the frame function computes it, for the surface now drawn on. */
        i32 vw = *(volatile i32 *)MH_VIEW_WIDTH, vh = *(volatile i32 *)MH_VIEW_HEIGHT;
        u32 base = *(volatile u32 *)MH_ACTIVE_DRAW_PTR;
        *(volatile u32 *)MH_CENTER_DRAW_PTR = base + (u32)((h / 2 - vh / 2) * w + w / 2 - vw / 2);
    }
}

/* From now on the game sees 320x240 outside the world. Once its video is set up. */
static int start(void)
{
    if (g_started) return 1;
    if (!*(volatile u32 *)MH_FRAMEBUFFER) return 0;
    g_framebuffer = *(volatile u32 *)MH_FRAMEBUFFER;
    g_started = 1;
    set_full_size(0);
    mh->runtime.log("HD Rendering: everything but the world is drawn at 320x240 and scaled up");
    return 1;
}

/* The world is drawn: copy it, shrunk, into the layer, and keep a copy to see what the interface changes. */
static void begin_interface(void)
{
    i32 w = g_render_width, h = g_render_height, x, y;
    const u8 *frame = (const u8 *)g_framebuffer;
    if (!g_full_size) return;
    for (y = 0; y < MH_UI_H; ++y) {
        const u8 *row = frame + (y * h / MH_UI_H) * w;
        u8 *out = g_layer + y * MH_UI_W;
        for (x = 0; x < MH_UI_W; ++x) out[x] = row[x * w / MH_UI_W];
    }
    copy_bytes(g_reference, g_layer, sizeof(g_reference));
    g_world_drawn = 1;
    set_full_size(0);
}

/* Scale the layer onto the real frame: in play only what the interface changed, else all of it. */
static void show_layer(void)
{
    i32 w = g_render_width, h = g_render_height, x, y;
    u8 *frame = (u8 *)g_framebuffer;
    for (y = 0; y < h; ++y) {
        i32 ly = y * MH_UI_H / h;
        const u8 *layer = g_layer + ly * MH_UI_W;
        const u8 *reference = g_reference + ly * MH_UI_W;
        u8 *out = frame + y * w;
        if (g_world_drawn) {
            for (x = 0; x < w; ++x) {
                i32 lx = x * MH_UI_W / w;
                if (layer[lx] != reference[lx]) out[x] = layer[lx];
            }
        } else {
            for (x = 0; x < w; ++x) out[x] = layer[x * MH_UI_W / w];
        }
    }
    g_world_drawn = 0;
}

static PFN_Void g_compositor_original, g_frame_original, g_hud_original, g_present_original, g_begin_original, g_clear_original, g_movie_begin_original;

static void clear_layer(void)
{
    u32 i;
    for (i = 0; i < MH_UI_SIZE; ++i) g_layer[i] = 0;
    g_world_drawn = 0;
}

static void __cdecl frame_begin_hook(void)
{
    i32 clear = *(volatile i32 *)MH_FRAME_CLEAR_FLAG != 0;
    if (g_begin_original) g_begin_original();
    /* From the first frame on, so the startup screens and movies are drawn at 320x240 too. */
    if (!start()) return;
    if (clear) {
        /* The game cleared the frame at the size it sees, 320x240: only the top of the real frame.
           Where the world draws nothing the last frame would show through, smeared. */
        u32 *frame = (u32 *)g_framebuffer;
        u32 i, words = (u32)(g_render_width * g_render_height) / 4u;
        for (i = 0; i < words; ++i) frame[i] = 0u;
        clear_layer();
    }
    /* It points the drawing at the frame; outside the world it belongs on the layer. */
    set_full_size(g_full_size);
}

/* A movie frame: the player copies a whole 320x240 frame to the drawing pointer, which must be the layer. */
static void __cdecl movie_frame_begin_hook(void)
{
    if (g_movie_begin_original) g_movie_begin_original();
    if (start()) set_full_size(g_full_size);
}

static void __cdecl clear_and_present_hook(void)
{
    /* It presents straight away: what it shows is the cleared layer. */
    if (start()) clear_layer();
    if (g_clear_original) g_clear_original();
    if (g_started) set_full_size(g_full_size);
}

static void __cdecl compositor_hook(void)
{
    start();
    if (g_compositor_original) g_compositor_original();
}

static void __cdecl frame_hook(void)
{
    i32 picture = *(volatile u8 *)MH_FRAME_PICTURE_FLAG && *(volatile u32 *)MH_FRAME_PICTURE_A && *(volatile u32 *)MH_FRAME_PICTURE_B;
    if (!start() || picture) {
        /* The frame is a whole 320x240 picture: it goes on the layer like a menu. */
        if (g_frame_original) g_frame_original();
        return;
    }
    set_full_size(1);
    if (g_frame_original) g_frame_original();
    /* The status bar switches back as it starts; a frame that ended before it still must. */
    begin_interface();
}

static void __cdecl hud_hook(void)
{
    begin_interface();
    if (g_hud_original) g_hud_original();
}

static void display_present(void);

static void __cdecl present_hook(void)
{
    display_present();
    if (!g_started) {
        if (g_present_original) g_present_original();
        return;
    }
    /* Mods' overlays and the present itself work on the real frame. */
    set_full_size(1);
    show_layer();
    if (g_present_original) g_present_original();
    set_full_size(0);
}


/* ------------------------------------------------------------------ the window and the picture */

typedef struct Rect { i32 left, top, right, bottom; } Rect;
typedef struct MonitorInfo { u32 size; Rect monitor, work; u32 flags; } MonitorInfo;
typedef int (__stdcall *PFN_StretchDIBits)(void *, int, int, int, int, int, int, int, int, const void *, const void *, u32, u32);
typedef void *(__stdcall *PFN_LoadLibraryA)(const char *);
typedef void *(__stdcall *PFN_GetProcAddress)(void *, const char *);

static struct {
    int (__stdcall *GetClientRect)(void *, Rect *);
    int (__stdcall *GetWindowRect)(void *, Rect *);
    i32 (__stdcall *GetWindowLongA)(void *, int);
    i32 (__stdcall *SetWindowLongA)(void *, int, i32);
    int (__stdcall *SetWindowPos)(void *, void *, int, int, int, int, u32);
    int (__stdcall *AdjustWindowRectEx)(Rect *, u32, int, u32);
    void *(__stdcall *MonitorFromWindow)(void *, u32);
    int (__stdcall *GetMonitorInfoA)(void *, MonitorInfo *);
    int (__stdcall *SetStretchBltMode)(void *, int);
    int (__stdcall *SetBrushOrgEx)(void *, int, int, void *);
    int (__stdcall *PatBlt)(void *, int, int, int, int, u32);
} w32;

#define GWL_STYLE        (-16)
#define GWL_EXSTYLE      (-20)
#define WS_POPUP         0x80000000u
#define WS_VISIBLE       0x10000000u
#define WS_CAPTION       0x00C00000u
#define WS_SYSMENU       0x00080000u
#define WS_THICKFRAME    0x00040000u
#define WS_MINIMIZEBOX   0x00020000u
#define WS_MAXIMIZEBOX   0x00010000u
#define SWP_NOZORDER     0x0004u
#define SWP_FRAMECHANGED 0x0020u
#define SWP_SHOWWINDOW   0x0040u
#define SWP_NOOWNERZORDER 0x0200u
#define MONITOR_NEAREST  2u
#define BLACKNESS        0x00000042u
#define COLORONCOLOR     3
#define HALFTONE         4

/* Options, in the order of the choices in mod.json. */
enum { SHAPE_KEEP, SHAPE_STRETCH };
enum { SCALE_SHARP, SCALE_SMOOTH, SCALE_WHOLE };
enum { SHOW_WINDOW, SHOW_FULLSCREEN };
static const i32 k_window_scale[] = { 2, 3, 4, 5, 0 };   /* times 320x240; 0 is the largest that fits */
static MHOption g_opt_shape, g_opt_scaling, g_opt_display, g_opt_window_size, g_opt_fullscreen_key;
static PFN_StretchDIBits g_stretch_dibits;
static int g_window_ready, g_window_pending = 1, g_fullscreen;
static i32 g_window_style;   /* the windowed style, kept while fullscreen */

static void *window(void) { return (void *)*(volatile u32 *)MH_WINDOW; }

static int load_win32(void)
{
    PFN_LoadLibraryA load = (PFN_LoadLibraryA)mh->engine.symbol("win32.load_library_a");
    PFN_GetProcAddress find = (PFN_GetProcAddress)mh->engine.symbol("win32.get_proc_address");
    void *user32, *gdi32;
    if (!load || !find) return 0;
    user32 = load("user32.dll");
    gdi32 = load("gdi32.dll");
    if (!user32 || !gdi32) return 0;
    *(void **)&w32.GetClientRect = find(user32, "GetClientRect");
    *(void **)&w32.GetWindowRect = find(user32, "GetWindowRect");
    *(void **)&w32.GetWindowLongA = find(user32, "GetWindowLongA");
    *(void **)&w32.SetWindowLongA = find(user32, "SetWindowLongA");
    *(void **)&w32.SetWindowPos = find(user32, "SetWindowPos");
    *(void **)&w32.AdjustWindowRectEx = find(user32, "AdjustWindowRectEx");
    *(void **)&w32.MonitorFromWindow = find(user32, "MonitorFromWindow");
    *(void **)&w32.GetMonitorInfoA = find(user32, "GetMonitorInfoA");
    *(void **)&w32.SetStretchBltMode = find(gdi32, "SetStretchBltMode");
    *(void **)&w32.SetBrushOrgEx = find(gdi32, "SetBrushOrgEx");
    *(void **)&w32.PatBlt = find(gdi32, "PatBlt");
    return w32.GetClientRect && w32.GetWindowRect && w32.GetWindowLongA && w32.SetWindowLongA && w32.SetWindowPos && w32.AdjustWindowRectEx &&
           w32.MonitorFromWindow && w32.GetMonitorInfoA && w32.SetStretchBltMode && w32.SetBrushOrgEx && w32.PatBlt;
}

/* Where the picture goes in a client area of cw x ch: kept 4:3 (or the picture's own shape), whole pixels, or stretched. */
static void fit_picture(i32 cw, i32 ch, i32 pw, i32 ph, Rect *out)
{
    i32 shape = (i32)mh->options.get(g_opt_shape), scaling = (i32)mh->options.get(g_opt_scaling), w = cw, h = ch;
    if (shape != SHAPE_STRETCH) {
        if (scaling == SCALE_WHOLE && cw >= pw && ch >= ph) {
            i32 k = cw / pw < ch / ph ? cw / pw : ch / ph;
            w = pw * k;
            h = ph * k;
        } else if (cw * ph > ch * pw) {
            w = ch * pw / ph;
        } else {
            h = cw * ph / pw;
        }
    }
    out->left = (cw - w) / 2;
    out->top = (ch - h) / 2;
    out->right = out->left + w;
    out->bottom = out->top + h;
}

/* The game's StretchDIBits, from its windowed present: the picture goes where fit_picture says, the rest is black. */
static int __stdcall present_blit(void *dc, int x, int y, int w, int h, int sx, int sy, int sw, int sh, const void *bits, const void *info, u32 usage, u32 rop)
{
    Rect client, at;
    (void)x; (void)y; (void)w; (void)h;
    if (!w32.GetClientRect(window(), &client) || client.right <= 0 || client.bottom <= 0)
        return g_stretch_dibits(dc, x, y, w, h, sx, sy, sw, sh, bits, info, usage, rop);
    fit_picture(client.right, client.bottom, sw, sh, &at);
    if (at.top > 0) {
        w32.PatBlt(dc, 0, 0, client.right, at.top, BLACKNESS);
        w32.PatBlt(dc, 0, at.bottom, client.right, client.bottom - at.bottom, BLACKNESS);
    }
    if (at.left > 0) {
        w32.PatBlt(dc, 0, at.top, at.left, at.bottom - at.top, BLACKNESS);
        w32.PatBlt(dc, at.right, at.top, client.right - at.right, at.bottom - at.top, BLACKNESS);
    }
    if (mh->options.get(g_opt_scaling) == SCALE_SMOOTH) {
        w32.SetStretchBltMode(dc, HALFTONE);
        w32.SetBrushOrgEx(dc, 0, 0, (void *)0);
    } else {
        w32.SetStretchBltMode(dc, COLORONCOLOR);
    }
    return g_stretch_dibits(dc, at.left, at.top, at.right - at.left, at.bottom - at.top, sx, sy, sw, sh, bits, info, usage, rop);
}

static void log_size(const char *what, i32 w, i32 h)
{
    char text[64], *p = text;
    const char *q;
    i32 v[2], i;
    v[0] = w; v[1] = h;
    for (q = "HD Rendering: "; *q;) *p++ = *q++;
    for (q = what; *q;) *p++ = *q++;
    for (i = 0; i < 2; ++i) {
        char digits[12];
        i32 n = 0, x = v[i] < 0 ? 0 : v[i];
        *p++ = i ? 'x' : ' ';
        do { digits[n++] = (char)('0' + x % 10); x /= 10; } while (x);
        while (n) *p++ = digits[--n];
    }
    *p = 0;
    mh->runtime.log(text);
}

/* Put the window in the chosen mode: fullscreen on its monitor, or a window of the chosen size, centred. */
static void apply_window(void)
{
    void *hwnd = window(), *monitor;
    MonitorInfo mi;
    Rect r;
    i32 ex, scale, cw, ch, style;
    if (!hwnd) return;
    monitor = w32.MonitorFromWindow(hwnd, MONITOR_NEAREST);
    mi.size = sizeof(mi);
    if (!monitor || !w32.GetMonitorInfoA(monitor, &mi)) return;
    ex = w32.GetWindowLongA(hwnd, GWL_EXSTYLE);
    if (!g_window_ready) {
        g_window_ready = 1;
        /* A modern window: it can be resized, maximised and minimised. */
        g_window_style = (w32.GetWindowLongA(hwnd, GWL_STYLE) & ~(i32)WS_POPUP) | (i32)(WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
    }
    if (mh->options.get(g_opt_display) == SHOW_FULLSCREEN) {
        if (!g_fullscreen) g_window_style = w32.GetWindowLongA(hwnd, GWL_STYLE) & ~(i32)WS_POPUP;
        g_fullscreen = 1;
        w32.SetWindowLongA(hwnd, GWL_STYLE, (i32)(WS_POPUP | WS_VISIBLE));
        w32.SetWindowPos(hwnd, (void *)0, mi.monitor.left, mi.monitor.top, mi.monitor.right - mi.monitor.left, mi.monitor.bottom - mi.monitor.top,
                         SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        log_size("fullscreen", mi.monitor.right - mi.monitor.left, mi.monitor.bottom - mi.monitor.top);
        return;
    }
    g_fullscreen = 0;
    style = g_window_style | (i32)WS_VISIBLE;
    w32.SetWindowLongA(hwnd, GWL_STYLE, style);
    /* The size: a multiple of 320x240, no bigger than the work area with the frame around it. */
    scale = k_window_scale[mh->options.get(g_opt_window_size)];
    for (;;) {
        i32 k = scale ? scale : 8;
        cw = MH_UI_W * k;
        ch = MH_UI_H * k;
        r.left = 0; r.top = 0; r.right = cw; r.bottom = ch;
        w32.AdjustWindowRectEx(&r, (u32)style, 0, (u32)ex);
        if (k <= 1 || (r.right - r.left <= mi.work.right - mi.work.left && r.bottom - r.top <= mi.work.bottom - mi.work.top)) break;
        scale = k - 1;
    }
    w32.SetWindowPos(hwnd, (void *)0, mi.work.left + ((mi.work.right - mi.work.left) - (r.right - r.left)) / 2,
                     mi.work.top + ((mi.work.bottom - mi.work.top) - (r.bottom - r.top)) / 2,
                     r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    log_size("window", cw, ch);
}

/* Every present: the window is put in its mode once it exists, and again after an option changed. */
static void display_present(void)
{
    if (g_window_pending && window()) {
        g_window_pending = 0;
        apply_window();
    }
}

static void MH_STDCALL on_display_event(const MHAPI *api, const MHEvent *event, void *context)
{
    (void)api; (void)context;
    if (event->type == MH_EVENT_OPTION_CHANGED) {
        if (event->option == g_opt_display || event->option == g_opt_window_size) g_window_pending = 1;
        return;
    }
    if (event->type == MH_EVENT_FRAME) {
        i32 key = (i32)mh->options.get(g_opt_fullscreen_key);
        if (key && mh->input.pressed(key))
            mh->options.set(g_opt_display, mh->options.get(g_opt_display) == SHOW_FULLSCREEN ? SHOW_WINDOW : SHOW_FULLSCREEN);
    }
}

static void __cdecl display_only_present_hook(void)
{
    display_present();
    if (g_present_original) g_present_original();
}

/* The window and picture options: installed whatever the render resolution. */
static int install_display(const char *mod_id)
{
    static const u8 present_expected[5] = {0xA1,0x58,0xA3,0x65,0x00};
    u32 slot = 0, tramp = 0, hook = (u32)(void *)&present_blit;
    g_opt_shape = mh->options.find(mod_id, "shape");
    g_opt_scaling = mh->options.find(mod_id, "scaling");
    g_opt_display = mh->options.find(mod_id, "display");
    g_opt_window_size = mh->options.find(mod_id, "window_size");
    g_opt_fullscreen_key = mh->options.find(mod_id, "fullscreen_key");
    if (!g_opt_shape || !g_opt_scaling || !g_opt_display || !g_opt_window_size || !g_opt_fullscreen_key || !load_win32()) return 0;
    if (!mh->engine.read(MH_STRETCH_DIBITS_SLOT, &slot, 4u) || !slot) return 0;
    g_stretch_dibits = (PFN_StretchDIBits)slot;
    if (!mh->engine.write(MH_STRETCH_DIBITS_SLOT, &hook, 4u)) return 0;
    /* At 320x240 the interface hooks are not installed; the window still needs its present hook. */
    if (!g_present_original) {
        if (!detour(MH_PRESENT_WINDOWED, present_expected, 5u, (void *)&display_only_present_hook, &tramp)) return 0;
        g_present_original = (PFN_Void)tramp;
    }
    return mh->runtime.subscribe(MH_EVENT_MASK_FRAME | MH_EVENT_MASK_OPTION_CHANGED, on_display_event, (void *)0) != MH_INVALID_SUBSCRIPTION;
}

static int install_hooks(void)
{
    static const u8 world_expected[5] = {0xE9,0xD3,0x0D,0x04,0x00};
    static const u8 compositor_expected[6] = {0x51,0xA1,0xB4,0xC3,0x69,0x00};
    static const u8 frame_expected[5] = {0xA0,0xFD,0xAC,0x67,0x00};
    static const u8 hud_expected[8] = {0x83,0xEC,0x1C,0xA1,0xB4,0xC3,0x69,0x00};
    static const u8 present_expected[5] = {0xA1,0x58,0xA3,0x65,0x00};
    static const u8 begin_expected[5] = {0xA0,0xFC,0xAC,0x67,0x00};
    u32 tramp = 0;
    if (!detour(MH_WORLD_RENDER_THUNK, world_expected, 5u, (void *)&configured_world_render_hook, &tramp)) return 0;
    g_world_render_original = (PFN_Void)tramp;
    if (!detour(MH_FRONTEND_COMPOSITOR, compositor_expected, 6u, (void *)&compositor_hook, &tramp)) return 0;
    g_compositor_original = (PFN_Void)tramp;
    if (!detour(MH_GAME_FRAME, frame_expected, 5u, (void *)&frame_hook, &tramp)) return 0;
    g_frame_original = (PFN_Void)tramp;
    if (!detour(MH_GAME_HUD, hud_expected, 8u, (void *)&hud_hook, &tramp)) return 0;
    g_hud_original = (PFN_Void)tramp;
    if (!detour(MH_FRAME_BEGIN, begin_expected, 5u, (void *)&frame_begin_hook, &tramp)) return 0;
    g_begin_original = (PFN_Void)tramp;
    if (!detour(MH_CLEAR_AND_PRESENT, begin_expected, 5u, (void *)&clear_and_present_hook, &tramp)) return 0;
    g_clear_original = (PFN_Void)tramp;
    if (!detour(MH_MOVIE_FRAME_BEGIN, begin_expected, 5u, (void *)&movie_frame_begin_hook, &tramp)) return 0;
    g_movie_begin_original = (PFN_Void)tramp;
    /* In front of the runtime's own present hook, so mods' overlays draw on the real frame. */
    if (!detour(MH_PRESENT_WINDOWED, present_expected, 5u, (void *)&present_hook, &tramp)) return 0;
    g_present_original = (PFN_Void)tramp;
    return 1;
}

/* The code this mod changes, checked before anything is changed. */
static int code_matches(void)
{
    static const struct Check { u32 address; u8 size; u8 bytes[10]; } checks[] = {
        {0x0042D030u,6,{0x51,0xA1,0xB4,0xC3,0x69,0x00}},
        {0x00443490u,5,{0xA0,0xFD,0xAC,0x67,0x00}},
        {0x00443A60u,8,{0x83,0xEC,0x1C,0xA1,0xB4,0xC3,0x69,0x00}},
        {0x00439640u,5,{0xA1,0x58,0xA3,0x65,0x00}},
        {0x00439120u,5,{0xA0,0xFC,0xAC,0x67,0x00}},
        {0x004393F0u,5,{0xA0,0xFC,0xAC,0x67,0x00}},
        {0x00439260u,5,{0xA0,0xFC,0xAC,0x67,0x00}}
    };
    u32 i;
    for (i = 0; i < (u32)(sizeof(checks) / sizeof(checks[0])); ++i)
        if (!code_is(checks[i].address, checks[i].bytes, checks[i].size)) return 0;
    for (i = 0; i < 4u; ++i)
        if (!code_is(k_pitch_sites[i], k_pitch_code, 10u)) return 0;
    if (!code_is(MH_WORLD_RENDER_THUNK, (const u8 *)"\xE9\xD3\x0D\x04\x00", 5u)) return 0;
    return 1;
}

MH_EXPORT int MH_STDCALL MHModInit(const MHModContext *context)
{
    /* The same order as the "resolution" choices in mod.json. */
    static const i32 WIDTHS[4] = {320, 400, 512, 640};
    static const i32 HEIGHTS[4] = {240, 300, 384, 480};
    MHI32 choice;

    if (!context || !context->mh || context->mh->api_version != MH_API_VERSION) return 0;
    mh = context->mh;
    choice = mh->options.get(mh->options.find(context->mod.id, "resolution"));
    if (choice < 0 || choice > 3) choice = 3;
    g_render_width = WIDTHS[choice];
    g_render_height = HEIGHTS[choice];
    if (g_render_width == MH_UI_W) {
        if (!install_display(context->mod.id)) mh->runtime.log("HD Rendering: the window options are unavailable");
        mh->runtime.log("HD Rendering: the game's own 320x240 picture");
        return 1;
    }

    /* This runs while the game is starting, before it sets up its video mode, which is made at the render size. */
    if (!valid_render_resolution(g_render_width, g_render_height) || *(volatile i32 *)MH_VIDEO_WIDTH != MH_UI_W ||
        *(volatile i32 *)MH_VIDEO_HEIGHT != MH_UI_H || !code_matches()) {
        mh->runtime.log("HD Rendering: the renderer is not the supported retail code; left at 320x240");
        return 0;
    }
    if (!mh->engine.write(MH_VIDEO_WIDTH, &g_render_width, sizeof(g_render_width)) ||
        !mh->engine.write(MH_VIDEO_HEIGHT, &g_render_height, sizeof(g_render_height)) ||
        !install_hooks()) {
        mh->runtime.log("HD Rendering: could not hook the renderer");
        return 0;
    }
    /* Until the menus start, the game draws straight to the real frame at the render size. */
    set_pitch_sites(g_render_width);
    if (!install_display(context->mod.id)) mh->runtime.log("HD Rendering: the window options are unavailable");
    mh->runtime.log(choice == 1 ? "HD Rendering: 400x300" : (choice == 2 ? "HD Rendering: 512x384" : "HD Rendering: 640x480"));
    return 1;
}
