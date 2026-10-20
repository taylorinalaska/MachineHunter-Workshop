/*
 * Controls: choose the keyboard key for each of the game's controls.
 *
 * The game turns key presses into a bitfield of controls in its window
 * procedure (0x00439BE0). For keys Tab (VK 9) to numpad 9 (VK 0x69), a byte
 * table picks what a key does when it goes down (0x0043A43C) and when it
 * comes up (0x0043A510); each entry is a case of a jump table that sets or
 * clears one control bit. This mod rewrites those two tables from its
 * options: a control's case goes on the key chosen for it, and keys nobody
 * chose do nothing. The key options are one "unique" group in mod.json, so
 * the options system (in the game and in the Workshop alike) never lets two
 * controls share a key: choosing a taken key moves it.
 *
 * The cases are read from the original tables, at each control's original
 * key, so nothing about the jump tables is assumed beyond the table layout.
 * The menus read the same controls, so moving a control moves it there too.
 * With the mod switched off the game is exactly retail.
 */
#include "mh.h"

typedef MHU8 u8;
typedef MHU32 u32;
typedef MHI32 i32;

#define KEY_FIRST        0x09   /* Tab */
#define DOWN_TABLE       0x0043A43Cu
#define DOWN_COUNT       0x6F   /* Tab .. F8 */
#define UP_TABLE         0x0043A510u
#define UP_COUNT         0x61   /* Tab .. numpad 9 */
#define RAW_CONTROLS     0x006BB958u
#define NUMPAD_FIRST     0x60
#define NUMPAD_LAST      0x69
#define UNUSED_KEY       0x41   /* A: does nothing in the original game */

typedef struct Control {
    const char *key;   /* option key in mod.json */
    int original;      /* the original game's key */
    MHOption option;
} Control;

static Control g_controls[] = {
    { "forward", 0x26 },        /* Up: control bit 0x0001 */
    { "back", 0x28 },           /* Down: 0x0002 */
    { "turn_left", 0x25 },      /* Left: 0x0004 */
    { "turn_right", 0x27 },     /* Right: 0x0008 */
    { "fire", 0x11 },           /* Ctrl: 0x0010 */
    { "strafe", 0x10 },         /* Shift: 0x0020, locks the facing while held (0x00413050) */
    { "fire_forward", 0x59 },   /* Y: 0x0040 */
    { "fire_left", 0x47 },      /* G: 0x0080 */
    { "fire_right", 0x4A },     /* J: 0x0100 */
    { "fire_back", 0x48 },      /* H: 0x0200 */
    { "weapon_toggle", 0x57 },  /* W: 0x0400 */
    { "map", 0x09 },            /* Tab: 0x0800, the automap */
    { "fire_secondary", 0x20 }, /* Space: 0x2000, uses the chosen powerup (0x00449F10) */
    { "powerup_toggle", 0x53 }, /* S: 0x4000, switches the powerup (0x004134A0) */
    { "pause", 0x0D }           /* Enter: 0x8000 */
};
#define CONTROL_COUNT (sizeof(g_controls) / sizeof(g_controls[0]))

static const MHAPI *mh;
static u8 g_original_down[DOWN_COUNT];
static u8 g_original_up[UP_COUNT];
static MHOption g_numpad, g_reset;
static int g_ready;

/* Keys the tables can take: the digits never reach them (they choose weapons
   earlier on), and Alt comes as a system key the window procedure ignores. */
static int bindable(int vk)
{
    if (vk < KEY_FIRST || vk >= KEY_FIRST + UP_COUNT) return 0;
    if (vk >= 0x30 && vk <= 0x39) return 0;
    if (vk == 0x12) return 0;
    return 1;
}

static void apply(void)
{
    u8 down[DOWN_COUNT], up[UP_COUNT];
    u8 nothing_down = g_original_down[UNUSED_KEY - KEY_FIRST], nothing_up = g_original_up[UNUSED_KEY - KEY_FIRST];
    u32 i;
    int vk, numpad = mh->options.get(g_numpad) != 0;
    u32 raw = 0;
    for (i = 0; i < DOWN_COUNT; ++i) down[i] = (i < UP_COUNT) ? nothing_down : g_original_down[i];
    for (i = 0; i < UP_COUNT; ++i) up[i] = nothing_up;
    if (numpad) {
        for (vk = NUMPAD_FIRST; vk <= NUMPAD_LAST; ++vk) {
            down[vk - KEY_FIRST] = g_original_down[vk - KEY_FIRST];
            up[vk - KEY_FIRST] = g_original_up[vk - KEY_FIRST];
        }
    }
    for (i = 0; i < CONTROL_COUNT; ++i) {
        vk = (int)mh->options.get(g_controls[i].option);
        if (!vk) continue;   /* NONE */
        if (!bindable(vk)) {
            mh->runtime.log("Controls: a key the game cannot use was chosen; that control has no key");
            continue;
        }
        down[vk - KEY_FIRST] = g_original_down[g_controls[i].original - KEY_FIRST];
        up[vk - KEY_FIRST] = g_original_up[g_controls[i].original - KEY_FIRST];
    }
    if (!mh->engine.write(DOWN_TABLE, down, DOWN_COUNT) || !mh->engine.write(UP_TABLE, up, UP_COUNT)) {
        mh->runtime.log("Controls: could not write the key tables");
        return;
    }
    /* A key held across the change would otherwise stay down: its key-up now clears another control. */
    mh->engine.write(RAW_CONTROLS, &raw, 4u);
}

static void MH_STDCALL on_event(const MHAPI *api, const MHEvent *event, void *context)
{
    u32 i;
    (void)api; (void)context;
    if (!g_ready) return;
    if (event->type == MH_EVENT_ACTION && event->option == g_reset) {
        for (i = 0; i < CONTROL_COUNT; ++i) mh->options.set(g_controls[i].option, g_controls[i].original);
        return;
    }
    if (event->type != MH_EVENT_OPTION_CHANGED) return;
    if (event->option == g_numpad) { apply(); return; }
    for (i = 0; i < CONTROL_COUNT; ++i)
        if (event->option == g_controls[i].option) { apply(); return; }
}

MH_EXPORT int MH_STDCALL MHModInit(const MHModContext *context)
{
    /* The lookups that read the two tables: mov cl,[eax+0x0043A43C] and mov dl,[eax+0x0043A510]. */
    static const u8 down_lookup[6] = {0x8A,0x88,0x3C,0xA4,0x43,0x00};
    static const u8 up_lookup[6] = {0x8A,0x90,0x10,0xA5,0x43,0x00};
    u32 i;
    if (!context || !context->mh || context->mh->api_version != MH_API_VERSION) return 0;
    mh = context->mh;
    if (!mh->engine.patch(0x00439E03u, down_lookup, down_lookup, 6u) || !mh->engine.patch(0x0043A0E1u, up_lookup, up_lookup, 6u) ||
        !mh->engine.read(DOWN_TABLE, g_original_down, DOWN_COUNT) || !mh->engine.read(UP_TABLE, g_original_up, UP_COUNT)) {
        mh->runtime.log("Controls: the keyboard code is not the supported retail code; controls left as they are");
        return 0;
    }
    /* Each original key must do something, and A nothing, or the tables are not the retail ones. */
    for (i = 0; i < CONTROL_COUNT; ++i) {
        int k = g_controls[i].original - KEY_FIRST;
        if (g_original_down[k] == g_original_down[UNUSED_KEY - KEY_FIRST] || g_original_up[k] == g_original_up[UNUSED_KEY - KEY_FIRST]) {
            mh->runtime.log("Controls: the key tables are not the retail ones; controls left as they are");
            return 0;
        }
    }
    for (i = 0; i < CONTROL_COUNT; ++i) {
        g_controls[i].option = mh->options.find(context->mod.id, g_controls[i].key);
        if (g_controls[i].option == MH_INVALID_OPTION) return 0;
    }
    g_numpad = mh->options.find(context->mod.id, "numpad");
    g_reset = mh->options.find(context->mod.id, "reset");
    if (g_numpad == MH_INVALID_OPTION || g_reset == MH_INVALID_OPTION) return 0;
    if (mh->runtime.subscribe(MH_EVENT_MASK_OPTION_CHANGED | MH_EVENT_MASK_ACTION, on_event, (void *)0) == MH_INVALID_SUBSCRIPTION) return 0;
    g_ready = 1;
    apply();
    mh->runtime.log("Controls: keys set");
    return 1;
}
