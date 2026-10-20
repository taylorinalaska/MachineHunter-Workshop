/*
 * Mod Menu: an in-game list of every installed mod's options.
 *
 * The menu owns nothing it shows. Mods declare options in their mod.json (or
 * add them with mh.options.add); the runtime keeps them; this mod is only a
 * way to look at and change them while playing. It uses the public API alone,
 * so it is also the reference for building a different menu.
 *
 * Every mod with options has a page of its own, so adding or removing a mod
 * adds or removes its page and nothing else. A mod whose options are in more
 * than one section shows each section as a heading on its page.
 */
#include "mh.h"

#define VK_BACK    0x08
#define VK_RETURN  0x0D
#define VK_ESCAPE  0x1B
#define VK_SPACE   0x20
#define VK_LEFT    0x25
#define VK_UP      0x26
#define VK_RIGHT   0x27
#define VK_DOWN    0x28
#define VK_DELETE  0x2E
#define VK_F3      0x72

#define MAX_PAGES      32u
#define MAX_ROWS       64u
#define MAX_VISIBLE    17      /* rows that fit at 320x240 */
#define MIN_VISIBLE    6
#define HINT_MS        5000u

/* Layout in 320x240 units; everything is multiplied by the UI scale. */
#define MENU_X          8
#define MENU_Y          8
#define MENU_W        214
#define MENU_PAD        6
#define MENU_ROW_H     10
#define MENU_HEADER_H  30
#define MENU_FOOTER_H  14
#define ROW_CHARS      ((MENU_W - 2 * MENU_PAD) / 6)

static const MHAPI *mh;
static const char *g_mod_id;
static MHOption g_open_key, g_dim, g_hint;

static int g_open;
static int g_section, g_row, g_scroll;
static MHOption g_capturing;          /* a KEY option waiting for the next key press */
static int g_capture_armed;
static MHU32 g_hint_started;
static int g_hint_done;

/* One page per mod with visible options, by the mod's name in alphabetical order. */
typedef struct Page { const char *mod, *name; } Page;
static Page g_pages[MAX_PAGES];
static MHU32 g_section_count;   /* pages of options; the list of installed mods comes after them */
/* The rows of the page shown: an option, or a section heading (option 0) that cannot be selected. */
typedef struct Row { MHOption option; const char *heading; } Row;
static Row g_rows[MAX_ROWS];
static MHU32 g_row_count;
static int g_visible_rows = MIN_VISIBLE;

static int lower(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }

static int compare_i(const char *a, const char *b)
{
    for (;;) {
        int ca = lower((unsigned char)*a++), cb = lower((unsigned char)*b++);
        if (ca != cb) return ca < cb ? -1 : 1;
        if (!ca) return 0;
    }
}

static int text_length(const char *s) { int n = 0; while (s[n]) ++n; return n; }

static char *append(char *p, char *end, const char *text)
{
    while (*text && p < end) *p++ = *text++;
    *p = 0;
    return p;
}

static char *append_number(char *p, char *end, MHU32 value)
{
    char tmp[11];
    int n = 0;
    do { tmp[n++] = (char)('0' + value % 10u); value /= 10u; } while (value && n < 10);
    while (n && p < end) *p++ = tmp[--n];
    *p = 0;
    return p;
}

/* The page after the last section lists the mods that are loaded. */
static int on_mods_page(void) { return g_section == (int)g_section_count; }
static int page_count(void) { return (int)g_section_count + 1; }

/* The mod's display name, or its id when no loaded mod has that id. */
static const char *mod_name(const char *id)
{
    MHU32 i, count = mh->runtime.mod_count();
    MHModInfo mod;
    for (i = 0; i < count; ++i)
        if (mh->runtime.mod_get(i, &mod) && !compare_i(mod.id, id)) return mod.name;
    return id;
}

static int visible(MHOption option, MHOptionInfo *info)
{
    return mh->options.info(option, info) && !(info->flags & MH_OPTION_HIDDEN);
}

/* The rows of mod `id`: its options in the order it declares them, grouped by section; a
   heading starts each section when there is more than one. */
static MHU32 mod_rows(const char *id, Row *rows, MHU32 cap)
{
    const char *sections[MAX_ROWS];
    MHU32 i, j, n = 0, section_count = 0, count = mh->options.count();
    MHOptionInfo info;
    for (i = 0; i < count; ++i) {
        if (!visible(mh->options.at(i), &info) || compare_i(info.mod, id)) continue;
        for (j = 0; j < section_count; ++j) if (!compare_i(sections[j], info.section)) break;
        if (j == section_count && section_count < MAX_ROWS) sections[section_count++] = info.section;
    }
    for (j = 0; j < section_count; ++j) {
        if (section_count > 1u && n < cap) { rows[n].option = MH_INVALID_OPTION; rows[n].heading = sections[j]; ++n; }
        for (i = 0; i < count && n < cap; ++i) {
            MHOption option = mh->options.at(i);
            if (!visible(option, &info) || compare_i(info.mod, id) || compare_i(info.section, sections[j])) continue;
            rows[n].option = option; rows[n].heading = 0; ++n;
        }
    }
    return n;
}

static void collect_sections(void)
{
    MHU32 i, j, count = mh->options.count();
    MHOptionInfo info;
    Row rows[MAX_ROWS];
    int most = MIN_VISIBLE;
    g_section_count = 0;
    for (i = 0; i < count; ++i) {
        MHU32 at;
        const char *name;
        if (!visible(mh->options.at(i), &info)) continue;
        for (at = 0; at < g_section_count; ++at) if (!compare_i(g_pages[at].mod, info.mod)) break;
        if (at < g_section_count || g_section_count >= MAX_PAGES) continue;
        /* Insert in alphabetical order of the mod's name. */
        name = mod_name(info.mod);
        at = g_section_count;
        while (at > 0 && compare_i(name, g_pages[at - 1u].name) < 0) { g_pages[at] = g_pages[at - 1u]; --at; }
        g_pages[at].mod = info.mod;
        g_pages[at].name = name;
        ++g_section_count;
    }
    /* Size the panel for the longest page so it does not jump while browsing. */
    for (j = 0; j < g_section_count; ++j) {
        int n = (int)mod_rows(g_pages[j].mod, rows, MAX_ROWS);
        if (n > most) most = n;
    }
    if ((int)mh->runtime.mod_count() > most) most = (int)mh->runtime.mod_count();
    g_visible_rows = most > MAX_VISIBLE ? MAX_VISIBLE : most;
}

static void collect_rows(void)
{
    MHU32 i;
    g_row_count = 0;
    if (on_mods_page()) {
        g_row_count = mh->runtime.mod_count();
        if (g_row_count > MAX_ROWS) g_row_count = MAX_ROWS;
        for (i = 0; i < g_row_count; ++i) { g_rows[i].option = MH_INVALID_OPTION; g_rows[i].heading = 0; }
        return;
    }
    g_row_count = mod_rows(g_pages[g_section].mod, g_rows, MAX_ROWS);
}

/* Headings are passed over: the selection moves to the next option in the direction of `step`. */
static int selectable(int row) { return on_mods_page() || g_rows[row].heading == 0; }

static void move_selection(int step)
{
    int i, n = (int)g_row_count;
    for (i = 0; i < n; ++i) {
        g_row = (g_row + step + n) % n;
        if (selectable(g_row)) return;
    }
}

static void clamp_selection(void)
{
    if (g_section >= page_count()) g_section = page_count() - 1;
    if (g_section < 0) g_section = 0;
    collect_rows();
    if (g_row >= (int)g_row_count) g_row = (int)g_row_count - 1;
    if (g_row < 0) g_row = 0;
    if (g_row_count && !selectable(g_row)) move_selection(1);
    /* Keep a section's heading in view above its first option. */
    if (g_row > 0 && g_row - 1 < g_scroll && !selectable(g_row - 1)) g_scroll = g_row - 1;
    if (g_row < g_scroll) g_scroll = g_row;
    if (g_row >= g_scroll + g_visible_rows) g_scroll = g_row - g_visible_rows + 1;
    if (g_scroll < 0) g_scroll = 0;
}

static int open_key(void)
{
    int key = (int)mh->options.get(g_open_key);
    return key ? key : VK_F3;
}

/* While a key option waits for its new key: any key sets it, Delete clears it, Escape cancels. */
static void update_capture(void)
{
    int key;
    if (!g_capture_armed) { g_capture_armed = 1; return; }   /* skip the Enter that started it */
    for (key = 8; key < 256; ++key) {
        if (!mh->input.pressed(key)) continue;
        /* Shift, Ctrl and Alt also report as left/right pairs; keep the plain codes. */
        if (key >= 0xA0 && key <= 0xA5) continue;
        if (key != VK_ESCAPE) {
            int value = key == VK_DELETE ? 0 : key;
            if (g_capturing == g_open_key && !value) value = VK_F3;   /* the menu must stay reachable */
            mh->options.set(g_capturing, value);
        }
        g_capturing = MH_INVALID_OPTION;
        return;
    }
}

static void update(void)
{
    MHOptionInfo info;
    int pages;
    if (!g_capturing && mh->input.pressed(open_key())) {
        g_open = !g_open;
        g_hint_done = 1;
        mh->runtime.log(g_open ? "Mod Menu: opened" : "Mod Menu: closed");
    }
    if (!g_open) return;

    /* The menu has the keyboard: the game sees no controls while it is open. */
    mh->input.block(MH_CONTROLS_ALL);
    collect_sections();
    clamp_selection();
    if (g_capturing) { update_capture(); return; }

    pages = page_count();
    if (mh->input.pressed(VK_LEFT)) { g_section = (g_section + pages - 1) % pages; g_row = 0; g_scroll = 0; }
    if (mh->input.pressed(VK_RIGHT)) { g_section = (g_section + 1) % pages; g_row = 0; g_scroll = 0; }
    clamp_selection();
    if (!g_row_count) return;
    if (mh->input.pressed(VK_UP)) move_selection(-1);
    if (mh->input.pressed(VK_DOWN)) move_selection(1);
    clamp_selection();
    if (on_mods_page()) return;

    if (mh->input.pressed(VK_RETURN) || mh->input.pressed(VK_SPACE)) {
        if (mh->options.info(g_rows[g_row].option, &info) && info.type == MH_OPTION_KEY) {
            g_capturing = g_rows[g_row].option;
            g_capture_armed = 0;
        } else {
            mh->options.step(g_rows[g_row].option, 1);
        }
    } else if (mh->input.pressed(VK_BACK)) {
        mh->options.step(g_rows[g_row].option, -1);
    }
}

/* ------------------------------------------------------------------ draw */

static int ui_scale(MHI32 w, MHI32 h)
{
    int sx = (int)(w / 320), sy = (int)(h / 240), s = sx < sy ? sx : sy;
    return s < 1 ? 1 : s;
}

/* Text cut to `chars` characters. */
static MHI32 draw_clipped(MHI32 x, MHI32 y, const char *text, int chars, MHU32 color, int s)
{
    char buffer[48];
    int i = 0;
    if (chars > (int)sizeof(buffer) - 1) chars = (int)sizeof(buffer) - 1;
    while (text[i] && i < chars) { buffer[i] = text[i]; ++i; }
    buffer[i] = 0;
    return mh->draw.text(x, y, buffer, color, (MHU32)s);
}

static void draw_menu(MHI32 w, MHI32 h)
{
    MHU32 white = mh->draw.color(0xFFFFFFu), accent = mh->draw.color(0xFFA532u), dim = mh->draw.color(0x969696u);
    int s = ui_scale(w, h), x = MENU_X * s, y = MENU_Y * s, rw = MENU_W * s, rh, cx, cy, row, last, pending = 0;
    char text[48], *p, *end = text + sizeof(text) - 1;
    const char *title;

    rh = (MENU_HEADER_H + g_visible_rows * MENU_ROW_H + MENU_FOOTER_H + MENU_PAD) * s;
    if (x + rw > w) rw = (int)w - x;
    if (y + rh > h) rh = (int)h - y;
    mh->draw.shade(x, y, rw, rh, (MHU32)mh->options.get(g_dim));
    mh->draw.rect(x, y, rw, s, accent);

    cx = x + MENU_PAD * s;
    cy = y + 5 * s;
    mh->draw.text(cx, cy, "MOD MENU", white, (MHU32)s);
    p = append(text, end, mh->input.key_name(open_key()));
    p = append(p, end, " CLOSE");
    mh->draw.text(x + rw - MENU_PAD * s - mh->draw.text_width(text, (MHU32)s), cy, text, dim, (MHU32)s);

    /* The mod, with arrows, and where it is among the pages. */
    cy += 12 * s;
    title = on_mods_page() ? "INSTALLED MODS" : g_pages[g_section].name;
    cx = mh->draw.text(cx, cy, "< ", dim, (MHU32)s);
    cx = draw_clipped(cx, cy, title, 24, accent, s);
    mh->draw.text(cx, cy, " >", dim, (MHU32)s);
    p = append_number(text, end, (MHU32)g_section + 1u);
    p = append(p, end, "/");
    p = append_number(p, end, (MHU32)page_count());
    mh->draw.text(x + rw - MENU_PAD * s - mh->draw.text_width(text, (MHU32)s), cy, text, dim, (MHU32)s);

    cx = x + MENU_PAD * s;
    cy = y + MENU_HEADER_H * s;
    last = g_scroll + g_visible_rows;
    if (last > (int)g_row_count) last = (int)g_row_count;
    for (row = g_scroll; row < last; ++row, cy += MENU_ROW_H * s) {
        int selected = row == g_row, value_chars;
        MHU32 color = selected ? white : dim, value_color;
        MHOptionInfo info;
        MHModInfo mod;

        if (!on_mods_page() && g_rows[row].heading) {
            /* A section of the mod's options: a heading, not an option. */
            draw_clipped(cx, cy, g_rows[row].heading, ROW_CHARS, accent, s);
            continue;
        }
        if (selected) mh->draw.rect(x, cy - s, 2 * s, 9 * s, accent);
        if (on_mods_page()) {
            if (!mh->runtime.mod_get((MHU32)row, &mod)) continue;
            value_chars = text_length(mod.version);
            draw_clipped(cx, cy, mod.name, ROW_CHARS - value_chars - 1, color, s);
            mh->draw.text(x + rw - MENU_PAD * s - mh->draw.text_width(mod.version, (MHU32)s), cy, mod.version, dim, (MHU32)s);
            continue;
        }
        if (!mh->options.info(g_rows[row].option, &info)) continue;

        text[0] = 0;
        value_color = selected ? accent : white;
        if (info.type == MH_OPTION_ACTION) {
            if (selected) append(text, end, "RUN");
        } else if (g_capturing == g_rows[row].option) {
            append(text, end, "PRESS A KEY");
        } else {
            mh->options.text(g_rows[row].option, text, (MHU32)sizeof(text) - 2u);
            /* "OFF" stays dim so what is switched on stands out. */
            if (info.type == MH_OPTION_TOGGLE && !info.value) value_color = selected ? white : dim;
            if (info.flags & MH_OPTION_PENDING) { append(text + text_length(text), end, "*"); pending = 1; }
        }
        value_chars = text_length(text);
        draw_clipped(cx, cy, info.label, ROW_CHARS - value_chars - 1, color, s);
        mh->draw.text(x + rw - MENU_PAD * s - mh->draw.text_width(text, (MHU32)s), cy, text, value_color, (MHU32)s);
    }

    /* A scroll bar when the page is longer than the panel. */
    if ((int)g_row_count > g_visible_rows) {
        int track = g_visible_rows * MENU_ROW_H * s, top = y + MENU_HEADER_H * s - s;
        int bar = track * g_visible_rows / (int)g_row_count, at = track * g_scroll / (int)g_row_count;
        mh->draw.rect(x + rw - 2 * s, top + at, s, bar, dim);
    }

    cy = y + rh - (MENU_FOOTER_H - 3) * s;
    mh->draw.rect(x + MENU_PAD * s, cy - 4 * s, rw - 2 * MENU_PAD * s, s, dim);
    mh->draw.text(x + MENU_PAD * s, cy,
                  g_capturing ? "DELETE CLEARS   ESC CANCELS" : (pending ? "* TAKES EFFECT NEXT LAUNCH" : "ARROWS MOVE   ENTER/BKSP CHANGE"),
                  dim, (MHU32)s);
}

static void draw_hint(MHI32 w, MHI32 h)
{
    char text[40], *p, *end = text + sizeof(text) - 1;
    int s = ui_scale(w, h);
    MHU32 now = mh->runtime.time();
    if (g_hint_done || !mh->options.get(g_hint)) return;
    if (!g_hint_started) g_hint_started = now ? now : 1u;
    if (now - g_hint_started >= HINT_MS) { g_hint_done = 1; return; }
    p = append(text, end, mh->input.key_name(open_key()));
    append(p, end, " - MOD MENU");
    mh->draw.shade(2 * s, 2 * s, mh->draw.text_width(text, (MHU32)s) + 6 * s, 13 * s, 80u);
    mh->draw.text(5 * s, 5 * s, text, mh->draw.color(0xFFFFFFu), (MHU32)s);
}

static void MH_STDCALL on_event(const MHAPI *api, const MHEvent *event, void *context)
{
    MHI32 w = 0, h = 0;
    (void)api; (void)context;
    if (event->type == MH_EVENT_FRAME) {
        update();
    } else if (event->type == MH_EVENT_DRAW_OVERLAY && mh->draw.size(&w, &h)) {
        if (g_open) draw_menu(w, h);
        else draw_hint(w, h);
    }
}

MH_EXPORT int MH_STDCALL MHModInit(const MHModContext *context)
{
    if (!context || !context->mh || context->mh->api_version != MH_API_VERSION) return 0;
    mh = context->mh;
    g_mod_id = context->mod.id;
    g_open_key = mh->options.find(g_mod_id, "open_key");
    g_dim = mh->options.find(g_mod_id, "dim");
    g_hint = mh->options.find(g_mod_id, "hint");
    if (!g_open_key || !g_dim || !g_hint) {
        mh->runtime.log("Mod Menu: its options are missing from mod.json");
        return 0;
    }
    return mh->runtime.subscribe(MH_EVENT_MASK_FRAME | MH_EVENT_MASK_DRAW_OVERLAY, on_event, (void *)0) != MH_INVALID_SUBSCRIPTION;
}
