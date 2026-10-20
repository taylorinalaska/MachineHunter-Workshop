#include "MHOptions.h"

/* Mod settings and options; the file format is described in MHOptions.h. */

typedef void *MHHandle;
typedef int mh_bool;

#define MH_INVALID_HANDLE ((MHHandle)(mh_i32)-1)
#define MH_GENERIC_READ 0x80000000u
#define MH_GENERIC_WRITE 0x40000000u
#define MH_FILE_SHARE_READ 0x00000001u
#define MH_CREATE_ALWAYS 2u
#define MH_OPEN_EXISTING 3u
#define MH_FILE_ATTRIBUTE_NORMAL 0x00000080u
#define MH_SETTINGS_PATH "mods\\settings.cfg"
#define MH_SETTINGS_CAP 32768u
#define MH_OPTION_TEXT_CAP 28672u
#define MH_VALUE_CAP 64u

typedef MHHandle (MH_STDCALL *PFN_CreateFileA)(const char *, mh_u32, mh_u32, void *, mh_u32, mh_u32, MHHandle);
typedef mh_bool (MH_STDCALL *PFN_ReadFile)(MHHandle, void *, mh_u32, mh_u32 *, void *);
typedef mh_bool (MH_STDCALL *PFN_WriteFile)(MHHandle, const void *, mh_u32, mh_u32 *, void *);
typedef mh_u32 (MH_STDCALL *PFN_GetFileSize)(MHHandle, mh_u32 *);
typedef mh_bool (MH_STDCALL *PFN_CloseHandle)(MHHandle);

typedef struct MHOptionRecord {
    const char *mod, *section, *key, *label;
    mh_u32 type, flags;
    mh_i32 value, default_value, launch_value, min, max, step;
    const char *choices[MH_OPTION_CHOICE_MAX];
    mh_u32 choice_count;
    /* Key options of a mod with the same group name never share a key (mod.json "unique"). */
    const char *unique;
} MHOptionRecord;

typedef struct MHKeyNameEntry { const char *name; int vk; } MHKeyNameEntry;

/* The first name listed for a code is the one written back to the file. */
static const MHKeyNameEntry KEY_NAMES[] = {
    {"NONE",0x00},{"OFF",0x00},
    {"BACKSPACE",0x08},{"TAB",0x09},{"ENTER",0x0D},{"RETURN",0x0D},{"SHIFT",0x10},{"CTRL",0x11},{"ALT",0x12},
    {"ESC",0x1B},{"ESCAPE",0x1B},{"SPACE",0x20},{"PAGEUP",0x21},{"PAGEDOWN",0x22},{"END",0x23},{"HOME",0x24},
    {"LEFT",0x25},{"UP",0x26},{"RIGHT",0x27},{"DOWN",0x28},{"INSERT",0x2D},{"DELETE",0x2E},
    {"NUMPAD_MULTIPLY",0x6A},{"NUMPAD_PLUS",0x6B},{"NUMPAD_MINUS",0x6D},{"NUMPAD_DIVIDE",0x6F},
    {"SEMICOLON",0xBA},{"PLUS",0xBB},{"COMMA",0xBC},{"LESS",0xBC},{"MINUS",0xBD},{"PERIOD",0xBE},{"GREATER",0xBE},
    {"SLASH",0xBF},{"TILDE",0xC0},{"LBRACKET",0xDB},{"BACKSLASH",0xDC},{"RBRACKET",0xDD},{"QUOTE",0xDE}
};
#define KEY_NAME_COUNT ((mh_u32)(sizeof(KEY_NAMES)/sizeof(KEY_NAMES[0])))

static const MHHostAPI *g_host;
static PFN_CreateFileA g_create_file;
static PFN_ReadFile g_read_file;
static PFN_WriteFile g_write_file;
static PFN_GetFileSize g_get_file_size;
static PFN_CloseHandle g_close_handle;
static MHOptionListener g_listener;

static char g_settings[MH_SETTINGS_CAP];
static char g_settings_out[MH_SETTINGS_CAP];
static mh_u32 g_settings_size;

static MHOptionRecord g_options[MH_OPTION_MAX];
static mh_u32 g_option_count;
static char g_text[MH_OPTION_TEXT_CAP];
static mh_u32 g_text_used;

/* ------------------------------------------------------------------ text */

static int lower(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }
static int is_space(int c) { return c == ' ' || c == '\t' || c == '\r'; }

static mh_u32 text_length(const char *s) { mh_u32 n = 0; if (s) while (s[n]) ++n; return n; }

static int text_equal(const char *a, const char *b)
{
    if (!a || !b) return 0;
    while (*a && *a == *b) { ++a; ++b; }
    return *a == *b;
}

/* `a` is a span of `len` characters, `b` a C string; letters compare without case. */
static int span_equal_i(const char *a, mh_u32 len, const char *b)
{
    mh_u32 i = 0;
    if (!a || !b) return 0;
    while (i < len && b[i]) {
        if (lower((unsigned char)a[i]) != lower((unsigned char)b[i])) return 0;
        ++i;
    }
    return i == len && b[i] == 0;
}

static const char *arena_copy(const char *src, mh_u32 max_length)
{
    mh_u32 n = text_length(src), i;
    char *out;
    if (n > max_length) n = max_length;
    if (g_text_used + n + 1u > MH_OPTION_TEXT_CAP) return "";
    out = g_text + g_text_used;
    for (i = 0; i < n; ++i) out[i] = src[i];
    out[n] = 0;
    g_text_used += n + 1u;
    return out;
}

static char *put_text(char *p, char *end, const char *text)
{
    while (text && *text && p < end) *p++ = *text++;
    return p;
}

static char *put_i32(char *p, char *end, mh_i32 value)
{
    char tmp[12];
    mh_u32 n = 0, magnitude;
    if (value < 0) {
        if (p < end) *p++ = '-';
        magnitude = (mh_u32)(-(value + 1)) + 1u;
    } else {
        magnitude = (mh_u32)value;
    }
    do { tmp[n++] = (char)('0' + (magnitude % 10u)); magnitude /= 10u; } while (magnitude && n < sizeof(tmp));
    while (n && p < end) *p++ = tmp[--n];
    return p;
}

static int parse_i32(const char *text, mh_u32 len, mh_i32 *out)
{
    mh_u32 i = 0, value = 0;
    int negative = 0, digits = 0;
    if (i < len && (text[i] == '-' || text[i] == '+')) { negative = text[i] == '-'; ++i; }
    for (; i < len; ++i) {
        if (text[i] < '0' || text[i] > '9') return 0;
        if (value > 200000000u) return 0;
        value = value * 10u + (mh_u32)(text[i] - '0');
        digits = 1;
    }
    if (!digits) return 0;
    *out = negative ? -(mh_i32)value : (mh_i32)value;
    return 1;
}

/* ------------------------------------------------------------------ keys */

static int hex_digit(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    c = lower(c);
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static int key_code_span(const char *text, mh_u32 len)
{
    mh_u32 i;
    while (len && is_space((unsigned char)text[0])) { ++text; --len; }
    while (len && is_space((unsigned char)text[len - 1u])) --len;
    if (!len) return -1;

    if (len == 1u) {
        int c = (unsigned char)text[0];
        if (c >= 'a' && c <= 'z') c -= 32;
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
        if (c == '[') return 0xDB;
        if (c == ']') return 0xDD;
        if (c == '+') return 0xBB;
        if (c == '-') return 0xBD;
        if (c == ',') return 0xBC;
        if (c == '.') return 0xBE;
        if (c == '/') return 0xBF;
        return -1;
    }
    if ((text[0] == 'F' || text[0] == 'f') && len <= 3u) {
        mh_i32 n = 0;
        if (parse_i32(text + 1, len - 1u, &n) && n >= 1 && n <= 12) return 0x6F + (int)n;
    }
    if (len == 7u && span_equal_i(text, 6u, "NUMPAD") && text[6] >= '0' && text[6] <= '9') return 0x60 + (text[6] - '0');
    if (len == 4u && text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) {
        int hi = hex_digit((unsigned char)text[2]), lo = hex_digit((unsigned char)text[3]);
        if (hi >= 0 && lo >= 0) return (hi << 4) | lo;
    }
    for (i = 0; i < KEY_NAME_COUNT; ++i)
        if (span_equal_i(text, len, KEY_NAMES[i].name)) return KEY_NAMES[i].vk;
    return -1;
}

int MH_STDCALL MHKeyCode(const char *name)
{
    return name ? key_code_span(name, text_length(name)) : -1;
}

const char *MH_STDCALL MHKeyName(int vk)
{
    static char buffer[12];
    static const char HEX[] = "0123456789ABCDEF";
    mh_u32 i;
    char *p = buffer, *end = buffer + sizeof(buffer) - 1;
    for (i = 0; i < KEY_NAME_COUNT; ++i) if (KEY_NAMES[i].vk == vk) return KEY_NAMES[i].name;
    if ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9')) {
        *p++ = (char)vk;
    } else if (vk >= 0x70 && vk <= 0x7B) {
        *p++ = 'F';
        p = put_i32(p, end, vk - 0x6F);
    } else if (vk >= 0x60 && vk <= 0x69) {
        p = put_text(p, end, "NUMPAD");
        *p++ = (char)('0' + (vk - 0x60));
    } else {
        *p++ = '0'; *p++ = 'x';
        *p++ = HEX[(vk >> 4) & 15]; *p++ = HEX[vk & 15];
    }
    *p = 0;
    return buffer;
}

/* -------------------------------------------------------------- the file */

static void settings_read(void)
{
    MHHandle h;
    mh_u32 size, high = 0, got = 0;
    if (!g_create_file || !g_read_file || !g_get_file_size || !g_close_handle) return;
    h = g_create_file(MH_SETTINGS_PATH, MH_GENERIC_READ, MH_FILE_SHARE_READ, 0, MH_OPEN_EXISTING, MH_FILE_ATTRIBUTE_NORMAL, 0);
    if (!h || h == MH_INVALID_HANDLE) return;
    size = g_get_file_size(h, &high);
    if (size != 0xffffffffu && !high && size < MH_SETTINGS_CAP &&
        g_read_file(h, g_settings, size, &got, 0) && got == size) g_settings_size = size;
    g_close_handle(h);
}

/* One line of the file, trimmed: [*start, *end). Returns 0 at the end of the file. */
static int settings_line(mh_u32 *cursor, mh_u32 *raw_start, mh_u32 *start, mh_u32 *end)
{
    mh_u32 i = *cursor, a, b;
    if (i >= g_settings_size) return 0;
    a = i;
    while (i < g_settings_size && g_settings[i] != '\n') ++i;
    b = i;
    *cursor = i < g_settings_size ? i + 1u : i;
    if (raw_start) *raw_start = a;
    while (a < b && is_space((unsigned char)g_settings[a])) ++a;
    while (b > a && is_space((unsigned char)g_settings[b - 1u])) --b;
    *start = a;
    *end = b;
    return 1;
}

static int line_is_section(mh_u32 a, mh_u32 b) { return b > a + 1u && g_settings[a] == '[' && g_settings[b - 1u] == ']'; }

/* Split "key = value" at the first '='. Comment and blank lines have no key. */
static int line_key(mh_u32 a, mh_u32 b, mh_u32 *key_end, mh_u32 *value_start)
{
    mh_u32 eq = a, k;
    if (a >= b || g_settings[a] == '#' || g_settings[a] == ';') return 0;
    while (eq < b && g_settings[eq] != '=') ++eq;
    if (eq >= b) return 0;
    k = eq;
    while (k > a && is_space((unsigned char)g_settings[k - 1u])) --k;
    ++eq;
    while (eq < b && is_space((unsigned char)g_settings[eq])) ++eq;
    *key_end = k;
    *value_start = eq;
    return k > a;
}

/* The value of `key` in `[section]`, or among the lines before any section when `section` is 0. */
static int settings_find(const char *section, const char *key, mh_u32 *value_start, mh_u32 *value_end)
{
    mh_u32 cursor = 0, a, b, key_end, vs;
    int inside = section == 0;
    while (settings_line(&cursor, 0, &a, &b)) {
        if (line_is_section(a, b)) {
            if (!section) return 0;
            inside = span_equal_i(g_settings + a + 1u, b - a - 2u, section);
            continue;
        }
        if (inside && line_key(a, b, &key_end, &vs) && span_equal_i(g_settings + a, key_end - a, key)) {
            *value_start = vs;
            *value_end = b;
            return 1;
        }
    }
    return 0;
}

static int out_put(mh_u32 *size, const char *text, mh_u32 len)
{
    mh_u32 i;
    if (*size + len >= MH_SETTINGS_CAP) return 0;
    for (i = 0; i < len; ++i) g_settings_out[(*size)++] = text[i];
    return 1;
}

static int out_setting(mh_u32 *size, const char *key, const char *value)
{
    return out_put(size, key, text_length(key)) && out_put(size, " = ", 3u) && out_put(size, value, text_length(value));
}

/* Write one value, leaving every other line, comment and unknown key as it was. */
static int settings_store(const char *section, const char *key, const char *value)
{
    static const char HEADER[] = "# Machine Hunter mod settings. The Workshop's Mods page edits this file;\r\n# the game updates it when an option is changed in the Mod Menu.\r\n";
    mh_u32 cursor = 0, raw, a, b, key_end, vs, out = 0, wrote = 0, i;
    mh_u32 replace_a = 0, replace_b = 0, insert_at = 0;
    int inside = 0, have_section = 0, have_line = 0;
    MHHandle h;

    if (!g_create_file || !g_write_file || !g_close_handle) return 0;
    g_settings_size = 0;
    settings_read();

    while (settings_line(&cursor, &raw, &a, &b)) {
        if (line_is_section(a, b)) {
            inside = span_equal_i(g_settings + a + 1u, b - a - 2u, section);
            if (inside) { have_section = 1; insert_at = cursor; }
            continue;
        }
        if (!inside) continue;
        if (a < b) insert_at = cursor;
        if (!have_line && line_key(a, b, &key_end, &vs) && span_equal_i(g_settings + a, key_end - a, key)) {
            have_line = 1;
            replace_a = a;
            replace_b = b;
        }
    }

    if (have_line) {
        if (!out_put(&out, g_settings, replace_a) || !out_setting(&out, key, value) ||
            !out_put(&out, g_settings + replace_b, g_settings_size - replace_b)) return 0;
    } else if (have_section) {
        if (!out_put(&out, g_settings, insert_at)) return 0;
        if (insert_at && g_settings[insert_at - 1u] != '\n' && !out_put(&out, "\r\n", 2u)) return 0;
        if (!out_setting(&out, key, value) || !out_put(&out, "\r\n", 2u) ||
            !out_put(&out, g_settings + insert_at, g_settings_size - insert_at)) return 0;
    } else {
        if (!g_settings_size && !out_put(&out, HEADER, sizeof(HEADER) - 1u)) return 0;
        if (!out_put(&out, g_settings, g_settings_size)) return 0;
        if (out && g_settings_out[out - 1u] != '\n' && !out_put(&out, "\r\n", 2u)) return 0;
        if (!out_put(&out, "\r\n[", 3u) || !out_put(&out, section, text_length(section)) || !out_put(&out, "]\r\n", 3u) ||
            !out_setting(&out, key, value) || !out_put(&out, "\r\n", 2u)) return 0;
    }

    h = g_create_file(MH_SETTINGS_PATH, MH_GENERIC_WRITE, MH_FILE_SHARE_READ, 0, MH_CREATE_ALWAYS, MH_FILE_ATTRIBUTE_NORMAL, 0);
    if (!h || h == MH_INVALID_HANDLE) return 0;
    if (!g_write_file(h, g_settings_out, out, &wrote, 0) || wrote != out) { g_close_handle(h); return 0; }
    g_close_handle(h);
    for (i = 0; i < out; ++i) g_settings[i] = g_settings_out[i];
    g_settings_size = out;
    return 1;
}

int MH_STDCALL MHOptionsModDisabled(const char *mod_id)
{
    mh_u32 a, b, i;
    if (!mod_id || !settings_find(0, "disabled", &a, &b)) return 0;
    i = a;
    while (i < b) {
        mh_u32 start;
        while (i < b && (g_settings[i] == ',' || is_space((unsigned char)g_settings[i]))) ++i;
        start = i;
        while (i < b && g_settings[i] != ',' && !is_space((unsigned char)g_settings[i])) ++i;
        if (i > start && span_equal_i(g_settings + start, i - start, mod_id)) return 1;
    }
    return 0;
}

/* --------------------------------------------------------------- options */

static MHOptionRecord *record(MHOption option)
{
    return option && option <= g_option_count ? &g_options[option - 1u] : (MHOptionRecord *)0;
}

static mh_i32 clamp_value(const MHOptionRecord *o, mh_i32 value)
{
    if (o->type == MH_OPTION_TOGGLE) return value ? 1 : 0;
    if (o->type == MH_OPTION_CHOICE) return (value < 0 || (mh_u32)value >= o->choice_count) ? o->default_value : value;
    if (o->type == MH_OPTION_NUMBER) return value < o->min ? o->min : (value > o->max ? o->max : value);
    if (o->type == MH_OPTION_KEY) return (value < 0 || value > 255) ? o->default_value : value;
    return 0;
}

/* The text stored in the file for a value. */
static void value_to_file(const MHOptionRecord *o, mh_i32 value, char *out, mh_u32 cap)
{
    char *p = out, *end = out + cap - 1u;
    if (o->type == MH_OPTION_TOGGLE) p = put_text(p, end, value ? "on" : "off");
    else if (o->type == MH_OPTION_CHOICE) p = put_text(p, end, (mh_u32)value < o->choice_count ? o->choices[value] : "");
    else if (o->type == MH_OPTION_KEY) p = put_text(p, end, MHKeyName((int)value));
    else p = put_i32(p, end, value);
    *p = 0;
}

static int value_from_file(const MHOptionRecord *o, const char *text, mh_u32 len, mh_i32 *out)
{
    mh_u32 i;
    mh_i32 number;
    if (!len) return 0;
    if (o->type == MH_OPTION_TOGGLE) {
        if (span_equal_i(text, len, "on") || span_equal_i(text, len, "1") || span_equal_i(text, len, "true") || span_equal_i(text, len, "yes")) { *out = 1; return 1; }
        if (span_equal_i(text, len, "off") || span_equal_i(text, len, "0") || span_equal_i(text, len, "false") || span_equal_i(text, len, "no")) { *out = 0; return 1; }
        return 0;
    }
    if (o->type == MH_OPTION_CHOICE) {
        for (i = 0; i < o->choice_count; ++i) if (span_equal_i(text, len, o->choices[i])) { *out = (mh_i32)i; return 1; }
        return 0;
    }
    if (o->type == MH_OPTION_KEY) {
        int vk = key_code_span(text, len);
        if (vk < 0) return 0;
        *out = vk;
        return 1;
    }
    if (o->type == MH_OPTION_NUMBER && parse_i32(text, len, &number)) { *out = clamp_value(o, number); return 1; }
    return 0;
}

MHOption MH_STDCALL MHOptionFind(const char *mod_id, const char *key)
{
    mh_u32 i;
    if (!mod_id || !key) return MH_INVALID_OPTION;
    for (i = 0; i < g_option_count; ++i)
        if (text_equal(g_options[i].mod, mod_id) && text_equal(g_options[i].key, key)) return (MHOption)(i + 1u);
    return MH_INVALID_OPTION;
}

static int valid_key(const char *key)
{
    mh_u32 i = 0;
    if (!key || !*key) return 0;
    for (; key[i]; ++i) {
        unsigned char c = (unsigned char)key[i];
        if (i >= 40u || !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.')) return 0;
    }
    return 1;
}

MHOption MH_STDCALL MHOptionAdd(const char *mod_id, const char *mod_name, const MHOptionSpec *spec)
{
    MHOptionRecord *o;
    MHOption existing;
    mh_u32 i, a, b;
    if (!mod_id || !*mod_id || !spec || !valid_key(spec->key) || spec->type > MH_OPTION_ACTION) return MH_INVALID_OPTION;
    existing = MHOptionFind(mod_id, spec->key);
    if (existing) return existing;
    if (g_option_count >= MH_OPTION_MAX) {
        if (g_host) g_host->log("MH options: option limit reached");
        return MH_INVALID_OPTION;
    }
    if (spec->type == MH_OPTION_CHOICE && (!spec->choices || !spec->choice_count || spec->choice_count > MH_OPTION_CHOICE_MAX)) return MH_INVALID_OPTION;

    o = &g_options[g_option_count];
    o->mod = arena_copy(mod_id, 95u);
    o->key = arena_copy(spec->key, 40u);
    o->label = arena_copy(spec->label && *spec->label ? spec->label : spec->key, 40u);
    o->section = arena_copy(spec->section && *spec->section ? spec->section : (mod_name && *mod_name ? mod_name : mod_id), 24u);
    if (!*o->mod || !*o->key) return MH_INVALID_OPTION;
    o->type = spec->type;
    o->flags = spec->flags & (MH_OPTION_RESTART | MH_OPTION_SESSION | MH_OPTION_HIDDEN);
    o->min = spec->min;
    o->max = spec->max;
    if (o->min > o->max) { mh_i32 swap = o->min; o->min = o->max; o->max = swap; }
    o->step = spec->step > 0 ? spec->step : 1;
    o->choice_count = 0;
    if (spec->type == MH_OPTION_CHOICE)
        for (i = 0; i < spec->choice_count; ++i) o->choices[o->choice_count++] = arena_copy(spec->choices[i] ? spec->choices[i] : "", 24u);
    o->default_value = 0;
    o->default_value = clamp_value(o, spec->default_value);
    o->value = o->default_value;
    if (o->type != MH_OPTION_ACTION && !(o->flags & MH_OPTION_SESSION) && settings_find(mod_id, spec->key, &a, &b))
        (void)value_from_file(o, g_settings + a, b - a, &o->value);
    o->launch_value = o->value;
    o->unique = "";
    return (MHOption)(++g_option_count);
}

/*
 * "unique" groups. Choosing a key that another option of the group has moves
 * it: that one is set to no key. A settings file that already gives two of
 * them one key (written by hand) keeps it on the first declared. The
 * Workshop applies the same two rules (packages/core/src/pkg/mods.ts).
 */
static int same_group(const MHOptionRecord *a, const MHOptionRecord *b)
{
    return a != b && a->type == MH_OPTION_KEY && b->type == MH_OPTION_KEY && *a->unique &&
           span_equal_i(a->mod, text_length(a->mod), b->mod) && span_equal_i(a->unique, text_length(a->unique), b->unique);
}

void MH_STDCALL MHOptionSetUnique(MHOption option, const char *group)
{
    MHOptionRecord *o = record(option);
    mh_u32 i;
    if (!o || o->type != MH_OPTION_KEY || !group || !*group) return;
    o->unique = arena_copy(group, 24u);
    /* Declared later than one already holding the key: it has none. */
    for (i = 0; i < g_option_count; ++i)
        if (&g_options[i] != o && same_group(&g_options[i], o) && o->value && g_options[i].value == o->value) {
            MHOptionSet(option, 0);
            break;
        }
}

mh_i32 MH_STDCALL MHOptionGet(MHOption option)
{
    const MHOptionRecord *o = record(option);
    return o ? o->value : 0;
}

int MH_STDCALL MHOptionSet(MHOption option, mh_i32 value)
{
    MHOptionRecord *o = record(option);
    char text[MH_VALUE_CAP];
    if (!o || o->type == MH_OPTION_ACTION) return 0;
    value = clamp_value(o, value);
    if (value == o->value) return 1;
    o->value = value;
    if (value && *o->unique) {
        mh_u32 i;
        for (i = 0; i < g_option_count; ++i)
            if (same_group(&g_options[i], o) && g_options[i].value == value) MHOptionSet((MHOption)(i + 1u), 0);
    }
    if (!(o->flags & MH_OPTION_SESSION)) {
        value_to_file(o, value, text, sizeof(text));
        if (!settings_store(o->mod, o->key, text) && g_host) g_host->log("MH options: could not save mods\\settings.cfg");
    }
    if (g_listener) g_listener(option, value, 0);
    return 1;
}

int MH_STDCALL MHOptionStep(MHOption option, int direction)
{
    MHOptionRecord *o = record(option);
    mh_i32 next;
    if (!o) return 0;
    if (o->type == MH_OPTION_ACTION) {
        if (g_listener) g_listener(option, 0, 1);
        return 1;
    }
    if (o->type == MH_OPTION_KEY) return 0;
    next = o->value;
    if (o->type == MH_OPTION_TOGGLE) {
        next = !next;
    } else if (o->type == MH_OPTION_CHOICE) {
        mh_i32 count = (mh_i32)o->choice_count;
        next = (next + (direction < 0 ? count - 1 : 1)) % count;
    } else if (direction < 0) {
        next = next - o->step < o->min ? o->max : next - o->step;
    } else {
        next = next + o->step > o->max ? o->min : next + o->step;
    }
    return MHOptionSet(option, next);
}

mh_u32 MH_STDCALL MHOptionCount(void) { return g_option_count; }
MHOption MH_STDCALL MHOptionAt(mh_u32 index) { return index < g_option_count ? (MHOption)(index + 1u) : MH_INVALID_OPTION; }

int MH_STDCALL MHOptionGetInfo(MHOption option, MHOptionInfo *info)
{
    const MHOptionRecord *o = record(option);
    if (!o || !info) return 0;
    info->option = option;
    info->mod = o->mod;
    info->section = o->section;
    info->key = o->key;
    info->label = o->label;
    info->type = o->type;
    info->flags = o->flags;
    if ((o->flags & MH_OPTION_RESTART) && o->value != o->launch_value) info->flags |= MH_OPTION_PENDING;
    info->value = o->value;
    info->default_value = o->default_value;
    info->min = o->min;
    info->max = o->max;
    info->step = o->step;
    info->choice_count = o->choice_count;
    return 1;
}

const char *MH_STDCALL MHOptionChoice(MHOption option, mh_u32 index)
{
    const MHOptionRecord *o = record(option);
    return o && index < o->choice_count ? o->choices[index] : (const char *)0;
}

int MH_STDCALL MHOptionText(MHOption option, char *out, mh_u32 capacity)
{
    const MHOptionRecord *o = record(option);
    char *p = out, *end;
    if (!o || !out || !capacity) return 0;
    end = out + capacity - 1u;
    if (o->type == MH_OPTION_TOGGLE) p = put_text(p, end, o->value ? "ON" : "OFF");
    else if (o->type == MH_OPTION_CHOICE) p = put_text(p, end, (mh_u32)o->value < o->choice_count ? o->choices[o->value] : "");
    else if (o->type == MH_OPTION_KEY) p = put_text(p, end, MHKeyName((int)o->value));
    else if (o->type == MH_OPTION_NUMBER) p = put_i32(p, end, o->value);
    *p = 0;
    return 1;
}

void MH_STDCALL MHOptionsSetListener(MHOptionListener listener) { g_listener = listener; }

int MH_STDCALL MHOptionsInit(const MHHostAPI *host)
{
    if (!host || !host->symbol || !host->log) return 0;
    g_host = host;
    g_create_file = (PFN_CreateFileA)(void *)host->symbol("win32.create_file_a");
    g_read_file = (PFN_ReadFile)(void *)host->symbol("win32.read_file");
    g_write_file = (PFN_WriteFile)(void *)host->symbol("win32.write_file");
    g_get_file_size = (PFN_GetFileSize)(void *)host->symbol("win32.get_file_size");
    g_close_handle = (PFN_CloseHandle)(void *)host->symbol("win32.close_handle");
    g_option_count = 0;
    g_text_used = 0;
    g_settings_size = 0;
    settings_read();
    host->log(g_settings_size ? "MH options: loaded mods\\settings.cfg" : "MH options: no mods\\settings.cfg yet; every mod is on with its defaults");
    return 1;
}
