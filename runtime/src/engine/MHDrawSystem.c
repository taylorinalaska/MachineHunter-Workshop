#include "MHGameSystems.h"
#include "MHAPI.h"

/*
 * Drawing on top of the finished frame.
 *
 * The game renders 8-bit pixels through a palette that changes with the level
 * and screen, so colours are asked for as RGB and matched to the palette of
 * the moment. Mods draw from DRAW events (things in or over the world) and
 * DRAW_OVERLAY events (menus, which go above everything else).
 */

#define MH_VA_BITMAPINFO_PTR  0x0065A358u
#define MH_VA_FRAMEBUFFER_PTR 0x0065CC84u
#define MH_VA_VIDEO_WIDTH     0x0048BD40u
#define MH_VA_VIDEO_HEIGHT    0x0048BD44u
#define MH_BITMAPINFO_PALETTE 40u
#define MH_COLOR_CACHE        48u
#define MH_SHADE_CACHE        2u

typedef struct MHShadeTable { mh_u32 percent; int valid; mh_u8 map[256]; } MHShadeTable;

static MHDrawTarget g_target;
static int g_drawing;
static mh_u8 g_palette[1024];
static int g_palette_valid;
static mh_u32 g_color_rgb[MH_COLOR_CACHE];
static mh_u8 g_color_index[MH_COLOR_CACHE];
static mh_u32 g_color_count;
static MHShadeTable g_shades[MH_SHADE_CACHE];
static mh_u32 g_shade_next;

/* 5x7 glyphs, one byte per row, bit 4 leftmost. */
static mh_u8 glyph_row(char c, int r)
{
    static const mh_u8 DIGITS[10][7] = {
        {14,17,19,21,25,17,14}, {4,12,4,4,4,4,14}, {14,17,1,2,4,8,31},
        {30,1,1,14,1,1,30}, {2,6,10,18,31,2,2}, {31,16,16,30,1,1,30},
        {14,16,16,30,17,17,14}, {31,1,2,4,8,8,8}, {14,17,17,14,17,17,14},
        {14,17,17,15,1,1,14}
    };
    static const mh_u8 LETTERS[26][7] = {
        {14,17,17,31,17,17,17}, {30,17,17,30,17,17,30}, {14,17,16,16,16,17,14}, {30,17,17,17,17,17,30},
        {31,16,16,30,16,16,31}, {31,16,16,30,16,16,16}, {14,17,16,23,17,17,15}, {17,17,17,31,17,17,17},
        {14,4,4,4,4,4,14}, {1,1,1,1,17,17,14}, {17,18,20,24,20,18,17}, {16,16,16,16,16,16,31},
        {17,27,21,21,17,17,17}, {17,25,21,19,17,17,17}, {14,17,17,17,17,17,14}, {30,17,17,30,16,16,16},
        {14,17,17,17,21,18,13}, {30,17,17,30,20,18,17}, {15,16,16,14,1,1,30}, {31,4,4,4,4,4,4},
        {17,17,17,17,17,17,14}, {17,17,17,17,17,10,4}, {17,17,17,21,21,21,10}, {17,17,10,4,10,17,17},
        {17,17,10,4,4,4,4}, {31,1,2,4,8,16,31}
    };
    if (r < 0 || r > 6) return 0;
    if (c >= 'a' && c <= 'z') c = (char)(c - 32);
    if (c >= '0' && c <= '9') return DIGITS[c - '0'][r];
    if (c >= 'A' && c <= 'Z') return LETTERS[c - 'A'][r];
    switch (c) {
        case ':': return (r == 2 || r == 4) ? 4 : 0;
        case '-': return r == 3 ? 14 : 0;
        case '_': return r == 6 ? 31 : 0;
        case '.': return r == 6 ? 4 : 0;
        case ',': return r == 5 ? 4 : (r == 6 ? 8 : 0);
        case '\'': return r < 2 ? 4 : 0;
        case '!': return (r < 5 || r == 6) ? 4 : 0;
        case '/': { static const mh_u8 v[7] = {1,2,2,4,8,8,16}; return v[r]; }
        case '<': { static const mh_u8 v[7] = {2,4,8,16,8,4,2}; return v[r]; }
        case '>': { static const mh_u8 v[7] = {8,4,2,1,2,4,8}; return v[r]; }
        case '[': { static const mh_u8 v[7] = {14,8,8,8,8,8,14}; return v[r]; }
        case ']': { static const mh_u8 v[7] = {14,2,2,2,2,2,14}; return v[r]; }
        case '(': { static const mh_u8 v[7] = {2,4,8,8,8,4,2}; return v[r]; }
        case ')': { static const mh_u8 v[7] = {8,4,2,2,2,4,8}; return v[r]; }
        case '+': { static const mh_u8 v[7] = {0,4,4,31,4,4,0}; return v[r]; }
        case '=': { static const mh_u8 v[7] = {0,31,0,31,0,0,0}; return v[r]; }
        case '*': { static const mh_u8 v[7] = {0,21,14,31,14,21,0}; return v[r]; }
        case '%': { static const mh_u8 v[7] = {24,25,2,4,8,19,3}; return v[r]; }
        case '?': { static const mh_u8 v[7] = {14,17,1,2,4,0,4}; return v[r]; }
        case '#': { static const mh_u8 v[7] = {10,10,31,10,31,10,10}; return v[r]; }
        default: return 0;
    }
}

static mh_u8 nearest_color(int red, int green, int blue)
{
    mh_u32 best = 0xffffffffu;
    int i, best_i = 0;
    for (i = 0; i < 256; ++i) {
        int db = (int)g_palette[i * 4 + 0] - blue, dg = (int)g_palette[i * 4 + 1] - green, dr = (int)g_palette[i * 4 + 2] - red;
        mh_u32 d = (mh_u32)(db * db + dg * dg + dr * dr);
        if (d < best) { best = d; best_i = i; }
    }
    return (mh_u8)best_i;
}

/* Colour matches are only good for the palette they were made against. */
static void sync_palette(const mh_u8 *palette)
{
    mh_u32 i;
    int changed = !g_palette_valid;
    for (i = 0; !changed && i < 1024u; ++i) if (g_palette[i] != palette[i]) changed = 1;
    if (!changed) return;
    for (i = 0; i < 1024u; ++i) g_palette[i] = palette[i];
    g_palette_valid = 1;
    g_color_count = 0;
    for (i = 0; i < MH_SHADE_CACHE; ++i) g_shades[i].valid = 0;
}

void MH_STDCALL MHDrawFrame(void)
{
    mh_u32 frame = *(volatile mh_u32 *)MH_VA_FRAMEBUFFER_PTR;
    mh_u32 bitmap_info = *(volatile mh_u32 *)MH_VA_BITMAPINFO_PTR;
    mh_i32 width = *(volatile mh_i32 *)MH_VA_VIDEO_WIDTH;
    mh_i32 height = *(volatile mh_i32 *)MH_VA_VIDEO_HEIGHT;
    if (!frame || !bitmap_info || width < 64 || height < 32 || width > 4096 || height > 4096) return;

    g_target.pixels = (mh_u8 *)frame;
    g_target.width = width;
    g_target.height = height;
    g_target.pitch = width;
    g_target.palette = (const mh_u8 *)(bitmap_info + MH_BITMAPINFO_PALETTE);
    sync_palette(g_target.palette);
    g_drawing = 1;
    MHAPIDispatchSimple(MH_EVENT_DRAW);
    MHAPIDispatchSimple(MH_EVENT_DRAW_OVERLAY);
    g_drawing = 0;
}

int MH_STDCALL MHDrawSize(mh_i32 *width, mh_i32 *height)
{
    if (!g_drawing) return 0;
    if (width) *width = g_target.width;
    if (height) *height = g_target.height;
    return 1;
}

int MH_STDCALL MHDrawGetTarget(MHDrawTarget *target)
{
    if (!g_drawing || !target) return 0;
    *target = g_target;
    return 1;
}

mh_u32 MH_STDCALL MHDrawColor(mh_u32 rgb)
{
    mh_u32 i;
    mh_u8 index;
    if (!g_palette_valid) return 0u;
    rgb &= 0x00ffffffu;
    for (i = 0; i < g_color_count; ++i) if (g_color_rgb[i] == rgb) return g_color_index[i];
    index = nearest_color((int)((rgb >> 16) & 0xffu), (int)((rgb >> 8) & 0xffu), (int)(rgb & 0xffu));
    if (g_color_count < MH_COLOR_CACHE) {
        g_color_rgb[g_color_count] = rgb;
        g_color_index[g_color_count++] = index;
    }
    return index;
}

/* Clip a rectangle to the frame; returns 0 when nothing is left. */
static int clip(mh_i32 *x, mh_i32 *y, mh_i32 *w, mh_i32 *h)
{
    if (!g_drawing) return 0;
    if (*x < 0) { *w += *x; *x = 0; }
    if (*y < 0) { *h += *y; *y = 0; }
    if (*x + *w > g_target.width) *w = g_target.width - *x;
    if (*y + *h > g_target.height) *h = g_target.height - *y;
    return *w > 0 && *h > 0;
}

void MH_STDCALL MHDrawRect(mh_i32 x, mh_i32 y, mh_i32 width, mh_i32 height, mh_u32 color)
{
    mh_i32 xx, yy;
    if (!clip(&x, &y, &width, &height)) return;
    for (yy = y; yy < y + height; ++yy) {
        mh_u8 *row = g_target.pixels + yy * g_target.pitch + x;
        for (xx = 0; xx < width; ++xx) row[xx] = (mh_u8)color;
    }
}

void MH_STDCALL MHDrawShade(mh_i32 x, mh_i32 y, mh_i32 width, mh_i32 height, mh_u32 percent)
{
    MHShadeTable *table = (MHShadeTable *)0;
    mh_u32 i, keep;
    mh_i32 xx, yy;
    if (!clip(&x, &y, &width, &height)) return;
    if (percent > 100u) percent = 100u;
    for (i = 0; i < MH_SHADE_CACHE; ++i) if (g_shades[i].valid && g_shades[i].percent == percent) table = &g_shades[i];
    if (!table) {
        table = &g_shades[g_shade_next];
        g_shade_next = (g_shade_next + 1u) % MH_SHADE_CACHE;
        keep = 100u - percent;
        for (i = 0; i < 256u; ++i)
            table->map[i] = nearest_color((int)(g_palette[i * 4u + 2u] * keep / 100u), (int)(g_palette[i * 4u + 1u] * keep / 100u), (int)(g_palette[i * 4u] * keep / 100u));
        table->percent = percent;
        table->valid = 1;
    }
    for (yy = y; yy < y + height; ++yy) {
        mh_u8 *row = g_target.pixels + yy * g_target.pitch + x;
        for (xx = 0; xx < width; ++xx) row[xx] = table->map[row[xx]];
    }
}

void MH_STDCALL MHDrawLine(mh_i32 x0, mh_i32 y0, mh_i32 x1, mh_i32 y1, mh_u32 color)
{
    mh_i32 w, h, dx, dy, sx, sy, err, e2, guard = 0;
    if (!g_drawing) return;
    w = g_target.width;
    h = g_target.height;
    /* Nothing to do for a segment that lies wholly beyond one edge. */
    if ((x0 < 0 && x1 < 0) || (x0 >= w && x1 >= w) || (y0 < 0 && y1 < 0) || (y0 >= h && y1 >= h)) return;
    dx = x1 > x0 ? x1 - x0 : x0 - x1;
    dy = -(y1 > y0 ? y1 - y0 : y0 - y1);
    sx = x0 < x1 ? 1 : -1;
    sy = y0 < y1 ? 1 : -1;
    err = dx + dy;
    for (;;) {
        if (x0 >= 0 && y0 >= 0 && x0 < w && y0 < h) g_target.pixels[y0 * g_target.pitch + x0] = (mh_u8)color;
        if (x0 == x1 && y0 == y1) break;
        if (++guard > (w + h) * 4) break;
        e2 = err << 1;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

mh_i32 MH_STDCALL MHDrawTextWidth(const char *text, mh_u32 scale)
{
    mh_i32 n = 0;
    if (!text) return 0;
    if (!scale) scale = 1u;
    while (text[n]) ++n;
    return n * 6 * (mh_i32)scale;
}

mh_i32 MH_STDCALL MHDrawText(mh_i32 x, mh_i32 y, const char *text, mh_u32 color, mh_u32 scale)
{
    mh_i32 s, r, bit;
    if (!text) return x;
    if (!scale) scale = 1u;
    if (scale > 8u) scale = 8u;
    s = (mh_i32)scale;
    for (; *text; ++text, x += 6 * s) {
        if (!g_drawing) continue;
        for (r = 0; r < 7; ++r) {
            mh_u8 row = glyph_row(*text, r);
            if (!row) continue;
            for (bit = 0; bit < 5; ++bit)
                if (row & (1u << (4 - bit))) MHDrawRect(x + bit * s, y + r * s, s, s, color);
        }
    }
    return x;
}
