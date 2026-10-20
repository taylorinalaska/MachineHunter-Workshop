#include "mh_host.h"
#include "mh_contract.h"
#include "mh_contract_data.h"
#include "MHPackageRegistry.h"
#include "MHResourceSystem.h"
#include "MHSoundSystem.h"
#include "MHEntityOverrides.h"
#include "MHEffectEmitters.h"
#include "MHFriends.h"
#include "MHSwitches.h"

/*
 * Machine Hunter native MAPS menu + custom level package loader.
 *
 * The menu itself is the original 1997 descriptor/renderer/input system.
 * Custom levels are .mhproject v2 packages: stored ZIP containers with
 * editable project JSON, compiled runtime MAP and explicit asset bindings. Packages
 * inherit a retail single-player asset profile and replace only explicitly
 * supplied resources. The Maps menu scans .mhproject files only.
 */

#if defined(_MSC_VER) || defined(__clang__)
#define MH_CDECL __cdecl
#else
#define MH_CDECL
#endif

typedef void *MH_HANDLE;
typedef int MH_BOOL;

#define MH_INVALID_HANDLE ((MH_HANDLE)(mh_i32)-1)
#define MH_FILE_ATTRIBUTE_DIRECTORY 0x10u
#define MH_GENERIC_READ              0x80000000u
#define MH_FILE_SHARE_READ           0x00000001u
#define MH_OPEN_EXISTING             3u
#define MH_FILE_ATTRIBUTE_NORMAL     0x00000080u
#define MH_INVALID_FILE_SIZE         0xffffffffu
#define MH_MB_ICONERROR              0x00000010u

#define MH_MENU_STRIDE 0x34u
#define MH_MENU_DWORDS 13u
#define MH_MAP_MENU_STATE 11u
#define MH_MAX_MAPS 64u
/* The screen has room for nine rows under the title before the game's own
   key hint: eight maps and BACK, or seven maps, the page row and BACK. */
#define MH_MAPS_ON_ONE_PAGE 8u
#define MH_MAPS_PER_PAGE 7u
#define MH_NAME_CAP 260u
#define MH_PATH_CAP 360u
#define MH_MAP_BUFFER_CAP 0x50000u
#define MH_PACKAGE_BUFFER_CAP (64u*1024u*1024u)
#define MH_PACKAGE_MAX_ENTRIES 256u
#define MH_PACKAGE_MAX_SPRITES 64u
#define MH_PACKAGE_MAX_SOUNDS 48u
#define MH_CURRENT_GROUP_VA 0x004B6434u
#define MH_SETTING_SFX_VA 0x00490F50u
#define MH_SETTING_AMBIENT_SFX_VA 0x00490F58u
#define MH_PACKAGE_ENTRY_NAME_CAP 160u
#define MH_BRIEFING_TEXT_CAP 2048u
#define MH_BRIEFING_TITLE_CAP 128u

#define MH_MENU_STATE_TABLE       0x0048B6E8u
#define MH_MENU_CURRENT_STATE     0x0062A09Cu
#define MH_MENU_SELECTION         0x0048A3ACu
#define MH_MENU_STATE_AUX_TABLE   0x0062A228u
#define MH_MENU_STATE11_AUX_ALIAS 0x0062A254u
#define MH_MENU_TRANSITION_TICKS  0x0062A058u
#define MH_MENU_DELAYED_ACTION    0x0062A088u
#define MH_MENU_PENDING_ACTION    0x0062A0A8u
#define MH_MENU_ORIGINAL_MAIN     0x0048A5A8u
#define MH_MENU_CHEATS_BASE       0x0048B3D8u
#define MH_MENU_RENDER_INIT       0x0040C050u
#define MH_MENU_SELECTOR          0x0042D680u
#define MH_START_GAME_THUNK       0x00401F5Fu
#define MH_GAME_FLOW_STATE        0x004AF8CCu
#define MH_CURRENT_MISSION        0x004AFE98u
#define MH_MISSION_LEVEL_BYTE     0x00489869u
#define MH_MISSION_STRIDE         0x10u
#define MH_LEVEL_TABLE            0x0048C920u
#define MH_LEVEL_STRIDE           0x4Cu
#define MH_LEVEL_ASSET_LOAD       0x0043D740u
#define MH_EXIT_READY_LATCH       0x004B01E0u
#define MH_MISSION_COMPLETE_LATCH 0x004B01E8u
/* The per-level mission update 0x0041FCB0 picks its branch from this byte
   table (one byte per level index). MINES4's branch (selector 1) sets off the
   mine's collapse once the mission-complete latch is set and the escape
   countdown 0x004B63FC is zero; selector 5 is the path most levels share. */
#define MH_MISSION_SELECTORS      0x0041FDBCu
#define MH_LEVEL_MINES4           3u
#define MH_MISSION_SELECTOR_SHARED 5u
#define MH_BRIEFING_TEXT_TABLE    0x00489F80u
#define MH_BRIEFING_BG_TABLE      0x00489FE8u
#define MH_MISSION_TITLE_PTR      0x00489870u
#define MH_INPUT_RAW_BITS         0x006BB958u
#define MH_INPUT_CURRENT_BITS     0x006BB8E4u
#define MH_INPUT_PREVIOUS_BITS    0x006BB940u
#define MH_INPUT_CONFIRM_MASK     0x8000u
#define MH_MAP_CONFIRM_DELAY_MS   1000u


/* Proven descriptor members. */
#define M_TYPE        0u
#define M_FLAGS       1u
#define M_X           2u
#define M_Y           3u
#define M_TEXT        4u
#define M_ACTION      9u
#define M_IMMEDIATE  10u
#define M_SECONDARY  11u
#define M_NEXT_STATE 12u

typedef struct MHMenuRecord { mh_u32 v[MH_MENU_DWORDS]; } MHMenuRecord;
typedef struct MH_FILETIME_ { mh_u32 lo, hi; } MH_FILETIME_;
typedef struct MH_FIND_DATAA_ {
    mh_u32 dwFileAttributes;
    MH_FILETIME_ ftCreationTime;
    MH_FILETIME_ ftLastAccessTime;
    MH_FILETIME_ ftLastWriteTime;
    mh_u32 nFileSizeHigh;
    mh_u32 nFileSizeLow;
    mh_u32 dwReserved0;
    mh_u32 dwReserved1;
    char cFileName[260];
    char cAlternateFileName[14];
} MH_FIND_DATAA_;

typedef MH_HANDLE (MH_STDCALL *PFN_FindFirstFileA)(const char *, MH_FIND_DATAA_ *);
typedef MH_BOOL   (MH_STDCALL *PFN_FindNextFileA)(MH_HANDLE, MH_FIND_DATAA_ *);
typedef MH_BOOL   (MH_STDCALL *PFN_FindClose)(MH_HANDLE);
typedef MH_HANDLE (MH_STDCALL *PFN_CreateFileA)(const char *, mh_u32, mh_u32, void *, mh_u32, mh_u32, MH_HANDLE);
typedef MH_BOOL   (MH_STDCALL *PFN_ReadFile)(MH_HANDLE, void *, mh_u32, mh_u32 *, void *);
typedef mh_u32    (MH_STDCALL *PFN_GetFileSize)(MH_HANDLE, mh_u32 *);
typedef mh_u32    (MH_STDCALL *PFN_GetTickCount)(void);
typedef MH_BOOL   (MH_STDCALL *PFN_CloseHandle)(MH_HANDLE);
typedef int       (MH_STDCALL *PFN_MessageBoxA)(void *, const char *, const char *, mh_u32);
typedef void      (MH_CDECL *PFN_MenuRenderInit)(void);
typedef void      (MH_CDECL *PFN_MenuSelector)(void);
typedef mh_i32    (MH_CDECL *PFN_LevelAssetLoad)(mh_u32 level_index);

static const MHHostAPI *g_api;
static PFN_FindFirstFileA g_find_first;
static PFN_FindNextFileA g_find_next;
static PFN_FindClose g_find_close;
static PFN_CreateFileA g_create_file;
static PFN_ReadFile g_read_file;
static PFN_GetFileSize g_get_file_size;
static PFN_GetTickCount g_get_tick_count;
static PFN_CloseHandle g_close_handle;
static PFN_MessageBoxA g_message_box;
static PFN_MenuRenderInit g_original_menu_render;
static PFN_MenuSelector g_original_menu_selector;
static PFN_LevelAssetLoad g_original_level_asset_load;

static MHMenuRecord g_main_menu[8];
static MHMenuRecord g_maps_menu[12];
static char g_map_names[MH_MAX_MAPS][MH_NAME_CAP];
static char g_map_paths[MH_MAX_MAPS][MH_PATH_CAP];
static char g_map_display_names[MH_MAX_MAPS][MH_NAME_CAP];
static mh_u32 g_map_count;
static int g_main_ready;
static int g_more_maps;
static mh_u32 g_maps_page;
static int g_maps_page_turned;
static char g_page_label[32];
static int g_maps_confirm_armed;
static int g_maps_confirm_neutral_seen;
static mh_u32 g_maps_unlock_tick;
static mh_u32 g_last_render_state=0xffffffffu;

static char g_maps_label[] = "MAPS";
static char g_back_label[] = "BACK";
static char g_empty_label[] = "NO CUSTOM MAPS";
static char g_error_title[] = "Machine Hunter - Maps";

/* The original map allocation is exactly 0x50000 bytes. Keep the loose map
   in plugin-owned memory until the original loader requests the base MAP ID. */
static mh_u8 g_validate_seen[(MH_MAP_BUFFER_CAP / 36u) + 2u];
static mh_u32 g_override_archive_id;
static mh_u32 g_override_base_level;
static int g_override_active;
static int g_override_seen;

typedef struct MHPackageEntry {
    char name[MH_PACKAGE_ENTRY_NAME_CAP];
    const mh_u8 *data;
    mh_u32 size;
} MHPackageEntry;

typedef struct MHSpriteOverride {
    mh_u32 slot;
    const MHPackageEntry *entry;
} MHSpriteOverride;

typedef enum MHExitRule {
    MH_EXIT_INHERIT=0,
    MH_EXIT_UNCONDITIONAL=1
} MHExitRule;

typedef struct MHPackageSound {
    const MHPackageEntry *entry;
    mh_u32 handle;
    mh_u32 group;
    mh_u32 x, y;
    mh_u32 delay_ms, random_ms;
    mh_u32 next_tick;
    int scheduled;
} MHPackageSound;

typedef struct MHCustomPackage {
    int active;
    mh_u32 base_level;
    mh_u32 base_ids[8];
    mh_u32 initial_group;
    int initial_group_set;
    MHExitRule exit_rule;
    const MHPackageEntry *map;
    const MHPackageEntry *terrain;
    const MHPackageEntry *pal;
    const MHPackageEntry *plt;
    const MHPackageEntry *rmp;
    const MHPackageEntry *brt;
    const MHPackageEntry *lmp;
    const MHPackageEntry *briefing_image;
    mh_u32 briefing_base_archive_id;
    MHSpriteOverride sprites[MH_PACKAGE_MAX_SPRITES];
    mh_u32 sprite_count;
    MHPackageSound sounds[MH_PACKAGE_MAX_SOUNDS];
    mh_u32 sound_count;
    MHEntityOverride entity_overrides[MH_MAX_ENTITY_OVERRIDES];
    mh_u32 entity_override_count;
    MHEffectEmitter effects[MH_EFFECT_MAX_EMITTERS];
    mh_u32 effect_count;
    MHFriend friends[MH_MAX_FRIENDS];
    mh_u32 friend_count;
    MHSwitch switches[MH_MAX_SWITCHES];
    mh_u32 switch_count;
    MHSwitchDoor switch_doors[MH_MAX_SWITCH_DOORS];
    mh_u32 switch_door_count;
    MHTrigger triggers[MH_MAX_TRIGGERS];
    mh_u32 trigger_count;
    MHTriggerAction trigger_actions[MH_MAX_TRIGGER_ACTIONS];
    mh_u32 trigger_action_count;
    char briefing_text[MH_BRIEFING_TEXT_CAP];
    char briefing_title[MH_BRIEFING_TITLE_CAP];
    int briefing_text_set;
    int briefing_title_set;
    int custom_debrief_declared;
} MHCustomPackage;

static mh_u8 g_package_buffer[MH_PACKAGE_BUFFER_CAP];
static mh_u32 g_package_size;
static MHPackageEntry g_package_entries[MH_PACKAGE_MAX_ENTRIES];
static mh_u32 g_package_entry_count;
static MHCustomPackage g_package;
static mh_u32 g_original_initial_group;
static mh_u8 g_original_mission_selector;
static int g_mission_selector_patched;
static int g_initial_group_patched;
static mh_u32 g_original_briefing_text_ptr;
static int g_briefing_text_patched;
static mh_u32 g_original_briefing_title_ptr;
static mh_u32 g_patched_briefing_mission;
static int g_briefing_title_patched;



static void copy_bytes(void *dst, const void *src, mh_u32 n)
{
    mh_u8 *d=(mh_u8 *)dst; const mh_u8 *s=(const mh_u8 *)src; mh_u32 i;
    for (i=0;i<n;++i) d[i]=s[i];
}

static void zero_bytes(void *dst, mh_u32 n)
{
    mh_u8 *d=(mh_u8 *)dst; mh_u32 i;
    for (i=0;i<n;++i) d[i]=0;
}

static mh_u32 str_len(const char *s)
{
    mh_u32 n=0; if (!s) return 0; while (s[n]) ++n; return n;
}

static int ascii_lower(int c)
{
    if (c>='A' && c<='Z') return c+('a'-'A');
    return c;
}

static int str_ieq(const char *a, const char *b)
{
    while (*a && *b) {
        if (ascii_lower((unsigned char)*a) != ascii_lower((unsigned char)*b)) return 0;
        ++a; ++b;
    }
    return *a==*b;
}

static int ends_with_i(const char *s, const char *suffix)
{
    mh_u32 ns=str_len(s), nx=str_len(suffix), i;
    if (nx>ns) return 0;
    for (i=0;i<nx;++i)
        if (ascii_lower((unsigned char)s[ns-nx+i]) != ascii_lower((unsigned char)suffix[i])) return 0;
    return 1;
}

static int copy_string(char *dst, mh_u32 cap, const char *src)
{
    mh_u32 i=0;
    if (!dst || !cap || !src) return 0;
    while (src[i]) { if (i+1>=cap) { dst[0]=0; return 0; } dst[i]=src[i]; ++i; }
    dst[i]=0; return 1;
}

static int append_string(char *dst, mh_u32 cap, const char *src)
{
    mh_u32 d=str_len(dst), i=0;
    while (src[i]) { if (d+i+1>=cap) return 0; dst[d+i]=src[i]; ++i; }
    dst[d+i]=0; return 1;
}

static void copy_name(char *dst, const char *src)
{
    mh_u32 i=0;
    while (src[i] && i+1<MH_NAME_CAP) { dst[i]=src[i]; ++i; }
    dst[i]=0;
}

static int copy_path(char *dst, mh_u32 cap, const char *src)
{
    mh_u32 i=0;
    if (!dst || !cap || !src) return 0;
    while (src[i]) { if (i+1u>=cap) return 0; dst[i]=src[i]; ++i; }
    dst[i]=0;
    return 1;
}

/* Retail style 1 reliably renders the game's uppercase/digit character set,
   while lowercase and punctuation slots can map to unrelated glyphs. Keep the
   real filename untouched for sorting/loading and build a display-only copy:
   a-z -> A-Z, A-Z/0-9/space preserved, everything else -> space. */
static void make_display_name(char *dst, const char *src)
{
    mh_u32 i=0;
    unsigned char c;
    while (src[i] && i+1<MH_NAME_CAP) {
        c=(unsigned char)src[i];
        if (c>='a' && c<='z')
            dst[i]=(char)(c-('a'-'A'));
        else if ((c>='A' && c<='Z') || (c>='0' && c<='9') || c==' ')
            dst[i]=(char)c;
        else
            dst[i]=' ';
        ++i;
    }
    dst[i]=0;
}

static int name_less(const char *a, const char *b)
{
    while (*a && *b) {
        int ca=ascii_lower((unsigned char)*a), cb=ascii_lower((unsigned char)*b);
        if (ca<cb) return 1;
        if (ca>cb) return 0;
        ++a; ++b;
    }
    return !*a && *b;
}

static void sort_names(void)
{
    mh_u32 i,j; char tmp_name[MH_NAME_CAP]; char tmp_path[MH_PATH_CAP];
    for (i=1;i<g_map_count;++i) {
        copy_name(tmp_name,g_map_names[i]);
        copy_path(tmp_path,sizeof(tmp_path),g_map_paths[i]);
        j=i;
        while (j>0 && name_less(tmp_name,g_map_names[j-1])) {
            copy_name(g_map_names[j],g_map_names[j-1]);
            copy_path(g_map_paths[j],sizeof(g_map_paths[j]),g_map_paths[j-1]);
            --j;
        }
        copy_name(g_map_names[j],tmp_name);
        copy_path(g_map_paths[j],sizeof(g_map_paths[j]),tmp_path);
    }
}

static int is_map_candidate(const MH_FIND_DATAA_ *fd)
{
    const char *n=fd->cFileName;
    if (fd->dwFileAttributes & MH_FILE_ATTRIBUTE_DIRECTORY) return 0;
    if (str_ieq(n,".") || str_ieq(n,"..")) return 0;
    return ends_with_i(n,".mhproject");
}

static int build_package_map_pattern(char *out, mh_u32 cap, const MHPackage *package)
{
    return MHPackagePath(package,MH_PACKAGE_MAPS_DIR "\\*.*",out,cap);
}

static int build_package_map_path(char *out, mh_u32 cap, const MHPackage *package, const char *name)
{
    char relative[MH_PATH_CAP];
    if (!copy_path(relative,sizeof(relative),MH_PACKAGE_MAPS_DIR "\\")) return 0;
    if (!append_string(relative,sizeof(relative),name)) return 0;
    return MHPackagePath(package,relative,out,cap);
}

static void scan_maps(void)
{
    MH_FIND_DATAA_ map_fd;
    MH_HANDLE map_h;
    char pattern[MH_PATH_CAP], path[MH_PATH_CAP], label[MH_NAME_CAP];
    mh_u32 package_index, package_count=MHPackageCount();
    g_map_count=0; g_more_maps=0;
    if (!g_find_first || !g_find_next || !g_find_close) return;

    for (package_index=0; package_index<package_count; ++package_index) {
        const MHPackage *package=MHPackageAt(package_index);
        if (!package || !build_package_map_pattern(pattern,sizeof(pattern),package)) continue;
        map_h=g_find_first(pattern,&map_fd);
        if (map_h==MH_INVALID_HANDLE) continue;
        do {
            if (!is_map_candidate(&map_fd)) continue;
            if (g_map_count>=MH_MAX_MAPS) {
                if (!g_more_maps) g_api->log("MH Maps Menu: more than 64 maps installed; the rest are not listed");
                g_more_maps=1;
                continue;
            }
            if (!build_package_map_path(path,sizeof(path),package,map_fd.cFileName)) continue;
            if (!copy_path(g_map_paths[g_map_count],sizeof(g_map_paths[g_map_count]),path)) continue;
            /* List maps by file name alone; is_map_candidate() guarantees the
               ".mhproject" suffix that is trimmed here. */
            label[0]=0;
            copy_path(label,sizeof(label),map_fd.cFileName);
            {
                mh_u32 len=str_len(label);
                if (len>10u) label[len-10u]=0;
            }
            copy_name(g_map_names[g_map_count],label);
            ++g_map_count;
        } while (g_find_next(map_h,&map_fd));
        g_find_close(map_h);
    }

    sort_names();
    {
        mh_u32 i;
        for (i=0;i<g_map_count;++i) make_display_name(g_map_display_names[i],g_map_names[i]);
    }
}

static int read_record(mh_u32 address, MHMenuRecord *out)
{
    return g_api->read_memory(address,out,MH_MENU_STRIDE);
}

static void make_text_row(MHMenuRecord *dst, const MHMenuRecord *prototype,
                          const char *text, mh_u32 y)
{
    copy_bytes(dst,prototype,MH_MENU_STRIDE);
    dst->v[M_Y]=y;
    dst->v[M_TEXT]=(mh_u32)(const void *)text;
    dst->v[M_ACTION]=0;
    dst->v[M_IMMEDIATE]=0;
    dst->v[M_SECONDARY]=0;
    dst->v[M_NEXT_STATE]=0xffffffffu;
}

static void map_error(const char *message, const char *name)
{
    mh_u32 hwnd=0, hwnd_addr;
    g_api->log("MH Maps Menu: custom map load rejected");
    if (name) g_api->log(name);
    if (message) g_api->log(message);
    if (g_message_box && message) {
        hwnd_addr=g_api->symbol("window.hwnd");
        if (hwnd_addr) g_api->read_memory(hwnd_addr,&hwnd,4);
        g_message_box((void *)hwnd,message,g_error_title,MH_MB_ICONERROR);
    }
}

static int read_file_exact(const char *path, mh_u8 *dst, mh_u32 cap, mh_u32 *size_out)
{
    MH_HANDLE h;
    mh_u32 size, high=0, got=0;
    if (!g_create_file || !g_read_file || !g_get_file_size || !g_close_handle) return 0;
    h=g_create_file(path,MH_GENERIC_READ,MH_FILE_SHARE_READ,0,MH_OPEN_EXISTING,MH_FILE_ATTRIBUTE_NORMAL,0);
    if (!h || h==MH_INVALID_HANDLE) return 0;
    size=g_get_file_size(h,&high);
    if (size==MH_INVALID_FILE_SIZE || high!=0 || size==0 || size>cap) { g_close_handle(h); return 0; }
    if (!g_read_file(h,dst,size,&got,0) || got!=size) { g_close_handle(h); return 0; }
    g_close_handle(h);
    *size_out=size;
    return 1;
}

static mh_u32 buf_u32(const mh_u8 *b, mh_u32 off)
{
    return (mh_u32)b[off] | ((mh_u32)b[off+1]<<8) | ((mh_u32)b[off+2]<<16) | ((mh_u32)b[off+3]<<24);
}

static mh_i32 buf_i32(const mh_u8 *b, mh_u32 off)
{
    return (mh_i32)buf_u32(b,off);
}

/* Mirrors the conservative structural checks in tools/map_codec.py closely
   enough to reject malformed files before the original relocation code sees
   them. It does not claim that every semantically valid edit is understood. */
static int map_structure_sane(const mh_u8 *b, mh_u32 size)
{
    mh_u32 offsets[6], group_count, gi, li, ri, group_off, layer_count;
    mh_u32 d, bank, height, first, obj, slots, idx, steps, i;
    mh_i32 width_i, height_i;

    if (!b || size<32u || size>MH_MAP_BUFFER_CAP) return 0;
    for (i=0;i<6u;++i) offsets[i]=buf_u32(b,i*4u);
    group_count=buf_u32(b,28u);

    if (offsets[2]<32u || offsets[2]>offsets[0] || offsets[0]>size) return 0;
    if ((offsets[0]-offsets[2])%36u) return 0;
    for (i=0;i<6u;++i) if (offsets[i]>size) return 0;
    if (!group_count || group_count>3u || group_count>(offsets[2]-32u)/4u) return 0;

    slots=(offsets[0]-offsets[2])/36u;
    if (slots >= (MH_MAP_BUFFER_CAP/36u)+2u) return 0;
    zero_bytes(g_validate_seen,slots+1u);

    for (gi=0;gi<group_count;++gi) {
        if (32u+gi*4u+4u>size) return 0;
        group_off=buf_u32(b,32u+gi*4u);
        if (group_off+4u>offsets[2]) return 0;
        layer_count=buf_u32(b,group_off);
        if (!layer_count || layer_count>16u) return 0;
        if (group_off < 32u+4u*group_count) return 0;
        if (group_off+4u+128u*layer_count>offsets[2]) return 0;

        for (li=0;li<layer_count;++li) {
            d=group_off+4u+128u*li;
            if (d+128u>offsets[2]) return 0;
            width_i=buf_i32(b,d+20u);
            height_i=buf_i32(b,d+24u);
            if (width_i<0 || height_i<0) return 0;
            height=(mh_u32)height_i;
            bank=d+buf_u32(b,d+8u);
            if (bank<d || bank>offsets[2]) return 0;
            if (height > (offsets[2]-bank)/36u) return 0;

            for (ri=0;ri<height;++ri) {
                mh_u32 head=bank+ri*36u;
                if (head+4u>offsets[2]) return 0;
                first=buf_u32(b,head);
                if (!first) continue;
                if (first>offsets[0]-bank) return 0;
                obj=bank+first;
                steps=0;
                for (;;) {
                    if (obj<offsets[2] || obj+36u>offsets[0]) return 0;
                    if ((obj-offsets[2])%36u) return 0;
                    idx=(obj-offsets[2])/36u;
                    if (idx>=slots || g_validate_seen[idx]) return 0;
                    g_validate_seen[idx]=1;
                    ++steps;
                    if (steps>slots) return 0;
                    if (buf_u32(b,obj)==0u) break;
                    obj+=36u;
                }
            }
        }
    }
    return 1;
}


static mh_u16 buf_u16(const mh_u8 *b, mh_u32 off)
{
    return (mh_u16)((mh_u16)b[off] | ((mh_u16)b[off+1]<<8));
}

static int path_has_parent_ref(const char *s)
{
    mh_u32 i=0;
    if (!s || !*s) return 1;
    if (s[0]=='/' || s[0]=='\\') return 1;
    while (s[i]) {
        if (s[i]=='\\' || s[i]==':') return 1;
        if (s[i]=='.' && s[i+1]=='.' &&
            (i==0 || s[i-1]=='/') &&
            (s[i+2]==0 || s[i+2]=='/')) return 1;
        ++i;
    }
    return 0;
}

static mh_u32 package_crc32(const mh_u8 *b, mh_u32 size)
{ mh_u32 n=0xffffffffu,i,j; for(i=0;i<size;++i){n^=b[i];for(j=0;j<8;++j)n=(n>>1)^((n&1u)?0xedb88320u:0u);}return n^0xffffffffu; }

static int package_parse_zip(mh_u8 *buffer, mh_u32 size)
{
    mh_u32 p=0;
    g_package_entry_count=0;
    while (p+4u<=size) {
        mh_u32 sig=buf_u32(buffer,p);
        mh_u16 flags, method, name_len, extra_len;
        mh_u32 packed, unpacked, data_off, next, i;
        MHPackageEntry *e;
        if (sig==0x02014b50u || sig==0x06054b50u) break;
        if (sig!=0x04034b50u || p+30u>size) return 0;
        flags=buf_u16(buffer,p+6u);
        method=buf_u16(buffer,p+8u);
        packed=buf_u32(buffer,p+18u);
        unpacked=buf_u32(buffer,p+22u);
        name_len=buf_u16(buffer,p+26u);
        extra_len=buf_u16(buffer,p+28u);
        if ((flags & 0x0009u)!=0u) return 0; /* encrypted/data descriptor unsupported */
        if (method!=0u || packed!=unpacked) return 0; /* v1 packages are ZIP_STORED */
        if (!name_len || name_len>=MH_PACKAGE_ENTRY_NAME_CAP) return 0;
        data_off=p+30u+(mh_u32)name_len+(mh_u32)extra_len;
        if (data_off<p || data_off>size || unpacked>size-data_off) return 0;
        next=data_off+unpacked;
        if (g_package_entry_count>=MH_PACKAGE_MAX_ENTRIES) return 0;
        e=&g_package_entries[g_package_entry_count];
        for (i=0;i<(mh_u32)name_len;++i) e->name[i]=(char)buffer[p+30u+i];
        e->name[name_len]=0;
        if (path_has_parent_ref(e->name)) return 0;
        for(i=0;i<name_len;++i) if (!e->name[i] || (mh_u8)e->name[i]>=128u) return 0;
        for(i=0;i<g_package_entry_count;++i) if(str_ieq(e->name,g_package_entries[i].name)) return 0;
        if(package_crc32(buffer+data_off,unpacked)!=buf_u32(buffer,p+14u)) return 0;
        /* Directory entries are harmless; do not expose them as resources. */
        if (name_len && e->name[name_len-1]!='/') {
            e->data=buffer+data_off;
            e->size=unpacked;
            ++g_package_entry_count;
        }
        p=next;
    }
    return g_package_entry_count!=0u;
}

static const MHPackageEntry *package_find(const char *name)
{
    mh_u32 i;
    if (!name || !*name) return 0;
    for (i=0;i<g_package_entry_count;++i)
        if (str_ieq(g_package_entries[i].name,name)) return &g_package_entries[i];
    return 0;
}

static const mh_u8 *json_ws(const mh_u8 *p, const mh_u8 *end)
{
    while (p<end && (*p==' ' || *p=='\t' || *p=='\r' || *p=='\n')) ++p;
    return p;
}

static const mh_u8 *json_string_end(const mh_u8 *p, const mh_u8 *end)
{
    if (p>=end || *p!='"') return 0;
    ++p;
    while (p<end) {
        if (*p=='"') return p+1;
        if (*p=='\\') {
            ++p;
            if (p>=end) return 0;
            if (*p=='u') {
                mh_u32 i;
                for (i=0;i<4u;++i) {
                    ++p;
                    if (p>=end) return 0;
                    if (!((*p>='0'&&*p<='9')||(*p>='a'&&*p<='f')||(*p>='A'&&*p<='F'))) return 0;
                }
            }
        }
        ++p;
    }
    return 0;
}

static const mh_u8 *json_skip_value(const mh_u8 *p, const mh_u8 *end, mh_u32 depth)
{
    const mh_u8 *q;
    if (depth>16u) return 0;
    p=json_ws(p,end);
    if (p>=end) return 0;
    if (*p=='"') return json_string_end(p,end);
    if (*p=='{') {
        ++p; p=json_ws(p,end);
        if (p<end && *p=='}') return p+1;
        for (;;) {
            q=json_string_end(p,end); if (!q) return 0;
            p=json_ws(q,end); if (p>=end || *p!=':') return 0;
            p=json_skip_value(p+1,end,depth+1u); if (!p) return 0;
            p=json_ws(p,end); if (p>=end) return 0;
            if (*p=='}') return p+1;
            if (*p!=',') return 0;
            p=json_ws(p+1,end);
        }
    }
    if (*p=='[') {
        ++p; p=json_ws(p,end);
        if (p<end && *p==']') return p+1;
        for (;;) {
            p=json_skip_value(p,end,depth+1u); if (!p) return 0;
            p=json_ws(p,end); if (p>=end) return 0;
            if (*p==']') return p+1;
            if (*p!=',') return 0;
            p=json_ws(p+1,end);
        }
    }
    q=p;
    while (q<end && *q!=',' && *q!='}' && *q!=']' && *q!=' ' && *q!='\t' && *q!='\r' && *q!='\n') ++q;
    return q>p ? q : 0;
}

static int json_raw_key_eq(const mh_u8 *s, const mh_u8 *e, const char *key)
{
    mh_u32 i=0;
    if (!s || !e || e<=s+1 || *s!='"' || e[-1]!='"') return 0;
    ++s; --e;
    while (s<e && key[i]) {
        if (*s=='\\' || ascii_lower(*s)!=ascii_lower((unsigned char)key[i])) return 0;
        ++s; ++i;
    }
    return s==e && key[i]==0;
}

static int json_object_get(const mh_u8 *obj, const mh_u8 *obj_end, const char *key,
                           const mh_u8 **value_out, const mh_u8 **value_end_out)
{
    const mh_u8 *p,*ks,*ke,*vs,*ve;
    if (!obj || !obj_end || obj>=obj_end) return 0;
    p=json_ws(obj,obj_end);
    if (p>=obj_end || *p!='{') return 0;
    p=json_ws(p+1,obj_end);
    if (p<obj_end && *p=='}') return 0;
    while (p<obj_end) {
        ks=p; ke=json_string_end(ks,obj_end); if (!ke) return 0;
        p=json_ws(ke,obj_end); if (p>=obj_end || *p!=':') return 0;
        vs=json_ws(p+1,obj_end); ve=json_skip_value(vs,obj_end,0); if (!ve) return 0;
        if (json_raw_key_eq(ks,ke,key)) {
            if (value_out) *value_out=vs;
            if (value_end_out) *value_end_out=ve;
            return 1;
        }
        p=json_ws(ve,obj_end);
        if (p>=obj_end || *p=='}') return 0;
        if (*p!=',') return 0;
        p=json_ws(p+1,obj_end);
    }
    return 0;
}

static int json_copy_string(const mh_u8 *v, const mh_u8 *ve, char *dst, mh_u32 cap)
{
    mh_u32 n=0;
    const mh_u8 *p;
    if (!v || !ve || !dst || cap<1u || v>=ve || *v!='"' || ve[-1]!='"') return 0;
    p=v+1;
    while (p<ve-1) {
        unsigned char c=*p++;
        if (c=='\\') {
            if (p>=ve-1) return 0;
            c=*p++;
            if (c=='n') c='\n';
            else if (c=='r') c='\r';
            else if (c=='t') c='\t';
            else if (c=='b') c='\b';
            else if (c=='f') c='\f';
            else if (c=='"' || c=='\\' || c=='/') { }
            else return 0; /* \u is intentionally excluded from runtime paths/text v1. */
        }
        if (n+1u>=cap) return 0;
        dst[n++]=(char)c;
    }
    dst[n]=0;
    return 1;
}

static int json_u32(const mh_u8 *v, const mh_u8 *ve, mh_u32 *out)
{
    mh_u32 n=0;
    const mh_u8 *p=json_ws(v,ve);
    int any=0;
    if (!p || p>=ve) return 0;
    while (p<ve && *p>='0' && *p<='9') {
        any=1;
        if (n>429496729u) return 0;
        n=n*10u+(mh_u32)(*p-'0');
        ++p;
    }
    p=json_ws(p,ve);
    if (!any || p!=ve) return 0;
    *out=n;
    return 1;
}

static int json_member_string(const mh_u8 *obj, const mh_u8 *obj_end, const char *key,
                              char *dst, mh_u32 cap)
{
    const mh_u8 *v,*ve;
    if (!json_object_get(obj,obj_end,key,&v,&ve)) return 0;
    return json_copy_string(v,ve,dst,cap) ? 1 : -1;
}

static int json_member_u32(const mh_u8 *obj, const mh_u8 *obj_end, const char *key, mh_u32 *out)
{
    const mh_u8 *v,*ve;
    if (!json_object_get(obj,obj_end,key,&v,&ve)) return 0;
    return json_u32(v,ve,out) ? 1 : -1;
}

static int level_name_to_index(const char *name, mh_u32 *level_out)
{
    mh_u32 i;
    for (i=0;i<MH_LEVEL_COUNT;++i)
        if (str_ieq(name,MH_LEVEL_NAMES[i])) { *level_out=i; return 1; }
    return 0;
}

static int package_entry_from_json_path(const mh_u8 *obj, const mh_u8 *obj_end, const char *key,
                                        const MHPackageEntry **entry_out)
{
    char path[MH_PACKAGE_ENTRY_NAME_CAP];
    int r=json_member_string(obj,obj_end,key,path,sizeof(path));
    const MHPackageEntry *e;
    if (r<=0) return r;
    if (path_has_parent_ref(path)) return -1;
    e=package_find(path);
    if (!e) return -1;
    *entry_out=e;
    return 1;
}

static int package_validate_terrain(const MHPackageEntry *e)
{
    mh_u32 count, header, i;
    if (!e || e->size<4u) return 0;
    count=buf_u32(e->data,0);
    if (!count || count>MHResourceTerrainCapacity()) return 0;
    header=4u+count*4u;
    if (header>e->size || e->size-header!=count*4096u) return 0;
    for (i=0;i<count;++i) if (buf_u32(e->data,4u+i*4u)!=i*4096u) return 0;
    return 1;
}

static int package_validate_bmp(const MHPackageEntry *e)
{
    mh_u32 pixel_off,width,height,compression;
    mh_u16 bpp;
    if (!e || e->size<0x436u) return 0;
    if (e->data[0]!='B' || e->data[1]!='M') return 0;
    pixel_off=buf_u32(e->data,10u);
    width=buf_u32(e->data,18u);
    height=buf_u32(e->data,22u);
    bpp=buf_u16(e->data,28u);
    compression=buf_u32(e->data,30u);
    if (width!=220u || height!=160u || bpp!=8u || compression!=0u) return 0;
    if (pixel_off<54u+1024u || pixel_off>e->size) return 0;
    return e->size-pixel_off>=width*height;
}

static int package_validate_sprite(const MHPackageEntry *e)
{
    return e && MHResourceValidateSprite(e->data,e->size,(mh_u32 *)0);
}

/* "sounds": [ { "file": entry, "group": n, "x": units, "y": units, "delay_ms": n, "random_ms": n }, ... ]
   The map's own ambient sounds. Positions are in 1/256 cell within the area. */
static int parse_sound_emitters(const mh_u8 *arr, const mh_u8 *arr_end)
{
    const mh_u8 *p=json_ws(arr,arr_end);
    if (p>=arr_end || *p!='[') return 0;
    p=json_ws(p+1,arr_end);
    if (p<arr_end && *p==']') return 1;
    while (p<arr_end) {
        const mh_u8 *ve=json_skip_value(p,arr_end,0);
        char path[MH_PACKAGE_ENTRY_NAME_CAP];
        MHPackageSound *s;
        mh_u32 x=0,y=0,group=0,delay=0,random=0;
        const MHPackageEntry *e;
        if (!ve || *p!='{') return 0;
        if (g_package.sound_count>=MH_PACKAGE_MAX_SOUNDS) return 0;
        if (json_member_string(p,ve,"file",path,sizeof(path))!=1 || path_has_parent_ref(path)) return 0;
        e=package_find(path); if (!e) return 0;
        if (json_member_u32(p,ve,"x",&x)!=1 || json_member_u32(p,ve,"y",&y)!=1 || x>0x7fffu || y>0x7fffu) return 0;
        if (json_member_u32(p,ve,"group",&group)<0 || json_member_u32(p,ve,"delay_ms",&delay)!=1) return 0;
        if (json_member_u32(p,ve,"random_ms",&random)<0) return 0;
        s=&g_package.sounds[g_package.sound_count++];
        s->entry=e; s->handle=0u; s->group=group; s->x=x; s->y=y;
        s->delay_ms=delay<100u?100u:delay; s->random_ms=random; s->scheduled=0; s->next_tick=0u;
        p=json_ws(ve,arr_end);
        if (p<arr_end && *p==']') return 1;
        if (p>=arr_end || *p!=',') return 0;
        p=json_ws(p+1,arr_end);
    }
    return 0;
}

/* A list of cells within a storey: [ { "group": n, "layer": n, "x": n, "y": n, "<key>": n }, ... ],
   for switches (key "channel") and the doors they open (key "lock"). Channels run 6..31; door locks run 0..31. */
static int parse_cells(const mh_u8 *arr, const mh_u8 *arr_end, const char *key, mh_u32 *out, mh_u32 cap, mh_u32 *count)
{
    const mh_u8 *p=json_ws(arr,arr_end);
    if (p>=arr_end || *p!='[') return 0;
    p=json_ws(p+1,arr_end);
    if (p<arr_end && *p==']') return 1;
    while (p<arr_end) {
        const mh_u8 *ve=json_skip_value(p,arr_end,0);
        mh_u32 *c;
        if (!ve || *p!='{' || *count>=cap) return 0;
        c=out+*count*(str_ieq(key,"lock")?6u:5u);
        c[0]=c[1]=0;
        if (json_member_u32(p,ve,"group",&c[0])<0 || c[0]>2u || json_member_u32(p,ve,"layer",&c[1])<0 || c[1]>31u) return 0;
        if (json_member_u32(p,ve,"x",&c[2])!=1 || json_member_u32(p,ve,"y",&c[3])!=1 || c[2]>4095u || c[3]>4095u) return 0;
        if (json_member_u32(p,ve,key,&c[4])!=1 || c[4]<(str_ieq(key,"lock")?0u:6u) || c[4]>31u) return 0;
        if(str_ieq(key,"lock")) { c[5]=0; if(json_member_u32(p,ve,"axis",&c[5])<0 || c[5]>2u)return 0; }
        ++*count;
        p=json_ws(ve,arr_end);
        if (p>=arr_end || *p==']') return p<arr_end && *p==']';
        if (*p!=',') return 0;
        p=json_ws(p+1,arr_end);
    }
    return 0;
}

/* "friends": [ { "group": n, "layer": n, "x": units, "y": units, "type": n, "follow": 0|1 }, ... ]
   x and y are where the map places the object, within its layer. */
static int parse_friends(const mh_u8 *arr, const mh_u8 *arr_end)
{
    const mh_u8 *p=json_ws(arr,arr_end);
    if (p>=arr_end || *p!='[') return 0;
    p=json_ws(p+1,arr_end);
    if (p<arr_end && *p==']') return 1;
    while (p<arr_end) {
        const mh_u8 *ve=json_skip_value(p,arr_end,0);
        MHFriend *f;
        mh_u32 x=0,y=0;
        if (!ve || *p!='{' || g_package.friend_count>=MH_MAX_FRIENDS) return 0;
        f=&g_package.friends[g_package.friend_count];
        zero_bytes(f,sizeof(*f));
        if (json_member_u32(p,ve,"x",&x)!=1 || json_member_u32(p,ve,"y",&y)!=1 || x>0x7fffu || y>0x7fffu) return 0;
        if (json_member_u32(p,ve,"type",&f->type)!=1 || f->type<2u || f->type>255u) return 0;
        if (json_member_u32(p,ve,"group",&f->group)<0 || f->group>2u || json_member_u32(p,ve,"layer",&f->layer)<0 || f->layer>31u) return 0;
        if (json_member_u32(p,ve,"follow",&f->follow)<0) return 0;
        f->x=(mh_i32)x; f->y=(mh_i32)y;
        ++g_package.friend_count;
        p=json_ws(ve,arr_end);
        if (p>=arr_end || *p==']') return p<arr_end && *p==']';
        if (*p!=',') return 0;
        p=json_ws(p+1,arr_end);
    }
    return 0;
}

/* "effects": [ { "group": n, "x": units, "y": units, "z": units, "every": n,
                 "particles": [ { "fx": id, "spread": units }, ... ] }, ... ] */
static int parse_effects(const mh_u8 *arr, const mh_u8 *arr_end)
{
    const mh_u8 *p=json_ws(arr,arr_end);
    if (p>=arr_end || *p!='[') return 0;
    p=json_ws(p+1,arr_end);
    if (p<arr_end && *p==']') return 1;
    while (p<arr_end) {
        const mh_u8 *ve=json_skip_value(p,arr_end,0),*parts,*parts_end,*q;
        MHEffectEmitter *e;
        mh_u32 x=0,y=0,z=0;
        if (!ve || *p!='{' || g_package.effect_count>=MH_EFFECT_MAX_EMITTERS) return 0;
        e=&g_package.effects[g_package.effect_count];
        zero_bytes(e,sizeof(*e));
        if (json_member_u32(p,ve,"x",&x)!=1 || json_member_u32(p,ve,"y",&y)!=1 || x>0x7fffu || y>0x7fffu) return 0;
        if (json_member_u32(p,ve,"z",&z)<0 || z>0x7fffu || json_member_u32(p,ve,"group",&e->group)<0 || e->group>2u) return 0;
        if (json_member_u32(p,ve,"every",&e->every)!=1 || !e->every || e->every>255u) return 0;
        if (!json_object_get(p,ve,"particles",&parts,&parts_end)) return 0;
        q=json_ws(parts,parts_end);
        if (q>=parts_end || *q!='[') return 0;
        q=json_ws(q+1,parts_end);
        while (q<parts_end && *q!=']') {
            const mh_u8 *pe=json_skip_value(q,parts_end,0);
            mh_u32 fx=0,spread=0;
            if (!pe || *q!='{' || e->layer_count>=MH_EFFECT_MAX_LAYERS) return 0;
            if (json_member_u32(q,pe,"fx",&fx)!=1 || !MHEffectIdAllowed(g_api,fx)) return 0;
            if (json_member_u32(q,pe,"spread",&spread)<0 || spread>0x400u) return 0;
            e->fx[e->layer_count]=fx;
            e->spread[e->layer_count]=spread;
            ++e->layer_count;
            q=json_ws(pe,parts_end);
            if (q<parts_end && *q==',') q=json_ws(q+1,parts_end);
        }
        if (!e->layer_count) return 0;
        e->x=(mh_i32)x; e->y=(mh_i32)y; e->z=(mh_i32)z;
        /* Spread emitters that share a rate over the updates, so they do not all puff together. */
        e->phase=(x*7u+y*13u)%e->every;
        ++g_package.effect_count;
        p=json_ws(ve,arr_end);
        if (p>=arr_end || *p==']') return p<arr_end && *p==']';
        if (*p!=',') return 0;
        p=json_ws(p+1,arr_end);
    }
    return 0;
}

/* "triggers": [ { "channel": 6..31, "once": 0|1, "actions": [ action, ... ] }, ... ] where an action is
   { "kind": "break", "group", "layer", "x", "y" }, { "kind": "cell", ..., "definition": id },
   { "kind": "effect", "group", "x", "y", "z" (map units), "particles": [ { "fx", "spread" }, ... ] }
   or { "kind": "reveal", "group", "layer", "x", "y" (map units), "type": map type }. */
static int text_is(const char *s, const char *t)
{
    while (*s && *s==*t) { ++s; ++t; }
    return *s==*t;
}

static int parse_trigger_action(const mh_u8 *p, const mh_u8 *ve, MHTriggerAction *a)
{
    char kind[12];
    zero_bytes(a,sizeof(*a));
    if (json_member_string(p,ve,"kind",kind,sizeof(kind))!=1) return 0;
    if (json_member_u32(p,ve,"group",&a->group)<0 || a->group>2u || json_member_u32(p,ve,"layer",&a->layer)<0 || a->layer>31u) return 0;
    if (json_member_u32(p,ve,"x",&a->x)!=1 || json_member_u32(p,ve,"y",&a->y)!=1 || a->x>0x7fffu || a->y>0x7fffu) return 0;
    if (text_is(kind,"break")) { a->kind=MH_TRIGGER_BREAK; return a->x<4096u && a->y<4096u; }
    if (text_is(kind,"cell")) {
        a->kind=MH_TRIGGER_CELL;
        return a->x<4096u && a->y<4096u && json_member_u32(p,ve,"definition",&a->value)==1 && a->value<2048u;
    }
    if (text_is(kind,"reveal")) {
        a->kind=MH_TRIGGER_REVEAL;
        return json_member_u32(p,ve,"type",&a->value)==1 && a->value<256u;
    }
    if (text_is(kind,"effect")) {
        const mh_u8 *parts,*parts_end,*q;
        mh_u32 z=0;
        MHEffectEmitter *e=&a->effect;
        a->kind=MH_TRIGGER_EFFECT;
        if (json_member_u32(p,ve,"z",&z)<0 || z>0x7fffu) return 0;
        if (!json_object_get(p,ve,"particles",&parts,&parts_end)) return 0;
        q=json_ws(parts,parts_end);
        if (q>=parts_end || *q!='[') return 0;
        q=json_ws(q+1,parts_end);
        while (q<parts_end && *q!=']') {
            const mh_u8 *pe=json_skip_value(q,parts_end,0);
            mh_u32 fx=0,spread=0;
            if (!pe || *q!='{' || e->layer_count>=MH_EFFECT_MAX_LAYERS) return 0;
            if (json_member_u32(q,pe,"fx",&fx)!=1 || !MHEffectIdAllowed(g_api,fx)) return 0;
            if (json_member_u32(q,pe,"spread",&spread)<0 || spread>0x400u) return 0;
            e->fx[e->layer_count]=fx;
            e->spread[e->layer_count]=spread;
            ++e->layer_count;
            q=json_ws(pe,parts_end);
            if (q<parts_end && *q==',') q=json_ws(q+1,parts_end);
        }
        e->group=a->group; e->x=(mh_i32)a->x; e->y=(mh_i32)a->y; e->z=(mh_i32)z; e->every=1u;
        return e->layer_count>0u;
    }
    return 0;
}

static int parse_triggers(const mh_u8 *arr, const mh_u8 *arr_end)
{
    const mh_u8 *p=json_ws(arr,arr_end);
    if (p>=arr_end || *p!='[') return 0;
    p=json_ws(p+1,arr_end);
    if (p<arr_end && *p==']') return 1;
    while (p<arr_end) {
        const mh_u8 *ve=json_skip_value(p,arr_end,0),*acts,*acts_end,*q;
        MHTrigger *t;
        if (!ve || *p!='{' || g_package.trigger_count>=MH_MAX_TRIGGERS) return 0;
        t=&g_package.triggers[g_package.trigger_count];
        zero_bytes(t,sizeof(*t));
        if (json_member_u32(p,ve,"channel",&t->channel)!=1 || t->channel<6u || t->channel>31u) return 0;
        if (json_member_u32(p,ve,"once",&t->once)<0) return 0;
        t->first=g_package.trigger_action_count;
        if (json_object_get(p,ve,"actions",&acts,&acts_end)) {
            q=json_ws(acts,acts_end);
            if (q>=acts_end || *q!='[') return 0;
            q=json_ws(q+1,acts_end);
            while (q<acts_end && *q!=']') {
                const mh_u8 *ae=json_skip_value(q,acts_end,0);
                if (!ae || *q!='{' || g_package.trigger_action_count>=MH_MAX_TRIGGER_ACTIONS) return 0;
                if (!parse_trigger_action(q,ae,&g_package.trigger_actions[g_package.trigger_action_count])) return 0;
                ++g_package.trigger_action_count;
                ++t->count;
                q=json_ws(ae,acts_end);
                if (q<acts_end && *q==',') q=json_ws(q+1,acts_end);
            }
        }
        ++g_package.trigger_count;
        p=json_ws(ve,arr_end);
        if (p>=arr_end || *p==']') return p<arr_end && *p==']';
        if (*p!=',') return 0;
        p=json_ws(p+1,arr_end);
    }
    return 0;
}

/* "animations": [ { "record": n, "base": n, "span": n, "start": n, "ticks": n, "mode": n, "reversed": 0|1 }, ... ] */
static int parse_animations(const mh_u8 *arr, const mh_u8 *arr_end, MHEntityOverride *o)
{
    const mh_u8 *p=json_ws(arr,arr_end);
    if (p>=arr_end || *p!='[') return 0;
    p=json_ws(p+1,arr_end);
    if (p<arr_end && *p==']') return 1;
    while (p<arr_end) {
        const mh_u8 *ve=json_skip_value(p,arr_end,0);
        MHAnimationOverride *a;
        mh_u32 j;
        if (!ve || *p!='{' || o->animation_count>=MH_MAX_TYPE_ANIMATIONS) return 0;
        a=&o->animations[o->animation_count];
        a->reversed=0;
        if (json_member_u32(p,ve,"record",&a->record)!=1 || json_member_u32(p,ve,"base",&a->base)!=1 || json_member_u32(p,ve,"span",&a->span)!=1
            || json_member_u32(p,ve,"start",&a->start)!=1 || json_member_u32(p,ve,"ticks",&a->ticks)!=1 || json_member_u32(p,ve,"mode",&a->mode)!=1
            || json_member_u32(p,ve,"reversed",&a->reversed)<0) return 0;
        /* A record is changed once per type. */
        for (j=0;j<o->animation_count;++j) if (o->animations[j].record==a->record) return 0;
        ++o->animation_count;
        p=json_ws(ve,arr_end);
        if (p>=arr_end || *p==']') return p<arr_end && *p==']';
        if (*p!=',') return 0;
        p=json_ws(p+1,arr_end);
    }
    return 0;
}

/* Frames in the map's own sprite file for each slot it replaces; 0 elsewhere. */
static void package_sprite_frames(mh_u32 *frames)
{
    mh_u32 i;
    for (i=0;i<256u;++i) frames[i]=0u;
    for (i=0;i<g_package.sprite_count;++i) {
        mh_u32 n=0;
        if (MHResourceValidateSprite(g_package.sprites[i].entry->data,g_package.sprites[i].entry->size,&n)) frames[g_package.sprites[i].slot]=n;
    }
}

/* "entity_overrides": [ { "type": n, "health": n, "speed_pct": n, "fire_rate_pct": n, "damage_pct": n, "animations": [...] }, ... ]
   Only "type" is required; each type at most once. */
static int parse_entity_overrides(const mh_u8 *arr, const mh_u8 *arr_end)
{
    static mh_u32 frames[256];
    const mh_u8 *p=json_ws(arr,arr_end);
    if (p>=arr_end || *p!='[') return 0;
    p=json_ws(p+1,arr_end);
    if (p<arr_end && *p==']') return 1;
    while (p<arr_end) {
        const mh_u8 *ve=json_skip_value(p,arr_end,0);
        MHEntityOverride o;
        const mh_u8 *anims,*anims_end;
        mh_u32 i;
        if (!ve || *p!='{' || g_package.entity_override_count>=MH_MAX_ENTITY_OVERRIDES) return 0;
        zero_bytes(&o,sizeof(o));
        o.health=0u; o.speed_pct=100u; o.fire_rate_pct=100u; o.damage_pct=100u;
        if (json_member_u32(p,ve,"type",&o.type)!=1 || !MHEntityOverrideTypeSupported(g_api,o.type)) return 0;
        if (json_member_u32(p,ve,"health",&o.health)<0 || o.health>MH_ENTITY_OVERRIDE_HEALTH_MAX) return 0;
        if (json_member_u32(p,ve,"speed_pct",&o.speed_pct)<0 || json_member_u32(p,ve,"fire_rate_pct",&o.fire_rate_pct)<0 || json_member_u32(p,ve,"damage_pct",&o.damage_pct)<0) return 0;
        if (o.speed_pct<MH_ENTITY_OVERRIDE_PCT_MIN || o.speed_pct>MH_ENTITY_OVERRIDE_PCT_MAX) return 0;
        if (o.fire_rate_pct<MH_ENTITY_OVERRIDE_PCT_MIN || o.fire_rate_pct>MH_ENTITY_OVERRIDE_PCT_MAX) return 0;
        if (o.damage_pct<MH_ENTITY_OVERRIDE_PCT_MIN || o.damage_pct>MH_ENTITY_OVERRIDE_PCT_MAX) return 0;
        for (i=0;i<g_package.entity_override_count;++i) if (g_package.entity_overrides[i].type==o.type) return 0;
        if (json_object_get(p,ve,"animations",&anims,&anims_end)) {
            if (!parse_animations(anims,anims_end,&o)) return 0;
            package_sprite_frames(frames);
            if (!MHEntityOverrideAnimationsValid(g_api,&o,g_package.base_level,frames)) return 0;
        }
        g_package.entity_overrides[g_package.entity_override_count++]=o;
        p=json_ws(ve,arr_end);
        if (p>=arr_end || *p==']') return p<arr_end && *p==']';
        if (*p!=',') return 0;
        p=json_ws(p+1,arr_end);
    }
    return 0;
}

static int parse_sprite_overrides(const mh_u8 *obj, const mh_u8 *obj_end)
{
    const mh_u8 *p,*ks,*ke,*vs,*ve;
    p=json_ws(obj,obj_end);
    if (p>=obj_end || *p!='{') return 0;
    p=json_ws(p+1,obj_end);
    if (p<obj_end && *p=='}') return 1;
    while (p<obj_end) {
        char slot_name[8], path[MH_PACKAGE_ENTRY_NAME_CAP];
        mh_u32 slot=0,i;
        const MHPackageEntry *e;
        if (g_package.sprite_count>=MH_PACKAGE_MAX_SPRITES) return 0;
        ks=p; ke=json_string_end(ks,obj_end); if (!ke) return 0;
        if (!json_copy_string(ks,ke,slot_name,sizeof(slot_name))) return 0;
        if (!slot_name[0]) return 0;
        for (i=0;slot_name[i];++i) {
            if (slot_name[i]<'0'||slot_name[i]>'9') return 0;
            slot=slot*10u+(mh_u32)(slot_name[i]-'0');
            if (slot>255u) return 0;
        }
        for (i=0;i<g_package.sprite_count;++i) if (g_package.sprites[i].slot==slot) return 0;
        p=json_ws(ke,obj_end); if (p>=obj_end || *p!=':') return 0;
        vs=json_ws(p+1,obj_end); ve=json_skip_value(vs,obj_end,0); if (!ve) return 0;
        if (!json_copy_string(vs,ve,path,sizeof(path)) || path_has_parent_ref(path)) return 0;
        e=package_find(path); if (!e || !package_validate_sprite(e)) return 0;
        g_package.sprites[g_package.sprite_count].slot=slot;
        g_package.sprites[g_package.sprite_count].entry=e;
        ++g_package.sprite_count;
        p=json_ws(ve,obj_end);
        if (p>=obj_end || *p=='}') return p<obj_end && *p=='}';
        if (*p!=',') return 0;
        p=json_ws(p+1,obj_end);
    }
    return 0;
}

/* Called only after structural validation has bounded row/object chains. */
static int map_has_player(const mh_u8 *b, mh_u32 group)
{
    mh_u32 go,li,ri,d,bank,obj,height;
    if(group>=buf_u32(b,28)) return 0;
    go=buf_u32(b,32+group*4);
    for(li=0;li<buf_u32(b,go);++li){
        d=go+4+li*128;bank=d+buf_u32(b,d+8);height=buf_u32(b,d+24);
        for(ri=0;ri<height;++ri){
            obj=buf_u32(b,bank+ri*36);if(!obj)continue;obj+=bank;
            for(;;){if(b[obj+4]==1 && !(b[obj+12]&1))return 1;if(!buf_u32(b,obj))break;obj+=36;}
        }
    }
    return 0;
}

static int package_parse_manifest(const MHPackageEntry *manifest, const char **error_out)
{
    const mh_u8 *root,*root_end,*v,*ve,*assets=0,*assets_end=0,*obj=0,*obj_end=0;
    char base_name[32], map_path[MH_PACKAGE_ENTRY_NAME_CAP], mode[32];
    mh_u32 fmt=0, initial=0;
    int r;
    zero_bytes(&g_package,sizeof(g_package));
    if (!manifest || !manifest->size) { *error_out="manifest.json is missing or empty."; return 0; }
    root=json_ws(manifest->data,manifest->data+manifest->size);
    root_end=json_skip_value(root,manifest->data+manifest->size,0);
    if (!root_end || root>=root_end || *root!='{') { *error_out="manifest.json is not valid supported JSON."; return 0; }
    if (json_member_u32(root,root_end,"format",&fmt)!=1 || fmt!=1u) { *error_out="manifest.json must contain format: 1."; return 0; }

    base_name[0]=0;
    r=json_member_string(root,root_end,"base_level",base_name,sizeof(base_name));
    if (r<0) { *error_out="base_level must be an ASCII string."; return 0; }
    if (json_object_get(root,root_end,"assets",&assets,&assets_end)) {
        char asset_base[32];
        if (*assets!='{') { *error_out="assets must be an object."; return 0; }
        asset_base[0]=0;
        r=json_member_string(assets,assets_end,"base",asset_base,sizeof(asset_base));
        if (r<0) { *error_out="assets.base must be an ASCII string."; return 0; }
        if (r==1) {
            if (base_name[0] && !str_ieq(base_name,asset_base)) { *error_out="assets.base and base_level currently must name the same retail level."; return 0; }
            if (!base_name[0]) copy_string(base_name,sizeof(base_name),asset_base);
        }
    }
    if (!base_name[0] || !level_name_to_index(base_name,&g_package.base_level)) { *error_out="A known retail base_level/assets.base is required."; return 0; }
    if (g_package.base_level>=MH_SINGLE_PLAYER_LEVEL_COUNT) { *error_out="Deathmatch base profiles are not supported by the custom campaign loader yet."; return 0; }

    copy_string(map_path,sizeof(map_path),"level.map");
    r=json_member_string(root,root_end,"map",map_path,sizeof(map_path));
    if (r<0 || path_has_parent_ref(map_path)) { *error_out="map must be a safe package-relative path."; return 0; }
    g_package.map=package_find(map_path);
    if (!g_package.map) { *error_out="The MAP entry named by manifest.json is missing."; return 0; }
    if (g_package.map->size>MH_MAP_BUFFER_CAP || !map_structure_sane(g_package.map->data,g_package.map->size)) { *error_out="The packaged MAP failed structural validation."; return 0; }

    r=json_member_u32(root,root_end,"initial_group",&initial);
    if (r<0 || (r==1 && initial>2u)) { *error_out="initial_group must be 0, 1, or 2."; return 0; }
    if (r==1) { g_package.initial_group=initial; g_package.initial_group_set=1; }
    if(r!=1 || !map_has_player(g_package.map->data,initial)) {
        *error_out="The selected initial group needs an enabled player spawn. Rebuild the project in the editor.";return 0;
    }

    g_package.exit_rule=MH_EXIT_INHERIT;
    if (json_object_get(root,root_end,"exit_rule",&obj,&obj_end)) {
        if (*obj!='{') { *error_out="exit_rule must be an object."; return 0; }
        mode[0]=0;
        r=json_member_string(obj,obj_end,"type",mode,sizeof(mode));
        if (r<0) { *error_out="exit_rule.type must be a string."; return 0; }
        if (r==1 && str_ieq(mode,"unconditional")) g_package.exit_rule=MH_EXIT_UNCONDITIONAL;
        else if (r==0 || str_ieq(mode,"inherit")) g_package.exit_rule=MH_EXIT_INHERIT;
        else { *error_out="This build supports exit_rule types inherit and unconditional."; return 0; }
    }

    if (assets) {
        if ((r=package_entry_from_json_path(assets,assets_end,"terrain",&g_package.terrain))<0) { *error_out="assets.terrain does not name an embedded package entry."; return 0; }
        if ((r=package_entry_from_json_path(assets,assets_end,"pal",&g_package.pal))<0) { *error_out="assets.pal does not name an embedded package entry."; return 0; }
        if ((r=package_entry_from_json_path(assets,assets_end,"plt",&g_package.plt))<0) { *error_out="assets.plt does not name an embedded package entry."; return 0; }
        if ((r=package_entry_from_json_path(assets,assets_end,"rmp",&g_package.rmp))<0) { *error_out="assets.rmp does not name an embedded package entry."; return 0; }
        if ((r=package_entry_from_json_path(assets,assets_end,"brt",&g_package.brt))<0) { *error_out="assets.brt does not name an embedded package entry."; return 0; }
        if ((r=package_entry_from_json_path(assets,assets_end,"lmp",&g_package.lmp))<0) { *error_out="assets.lmp does not name an embedded package entry."; return 0; }
        if (json_object_get(assets,assets_end,"sprites",&obj,&obj_end)) {
            if (!parse_sprite_overrides(obj,obj_end)) { *error_out="assets.sprites must map unique slot numbers 0..255 to embedded .B entries."; return 0; }
        }
    }
    if (json_object_get(root,root_end,"sounds",&obj,&obj_end)) {
        if (!parse_sound_emitters(obj,obj_end)) { *error_out="sounds must be a list of at most 48 emitters, each naming an embedded WAV with a position and a delay."; return 0; }
    }
    if (json_object_get(root,root_end,"switches",&obj,&obj_end)) {
        if (!parse_cells(obj,obj_end,"channel",(mh_u32 *)g_package.switches,MH_MAX_SWITCHES,&g_package.switch_count)) { *error_out="switches must list at most 32 cells, each with a channel from 6 to 31."; return 0; }
    }
    if (json_object_get(root,root_end,"doors",&obj,&obj_end)) {
        if (!parse_cells(obj,obj_end,"lock",(mh_u32 *)g_package.switch_doors,MH_MAX_SWITCH_DOORS,&g_package.switch_door_count)) { *error_out="doors must list at most 64 cells, each with a lock from 0 to 31."; return 0; }
    }
    if (json_object_get(root,root_end,"triggers",&obj,&obj_end)) {
        if (!parse_triggers(obj,obj_end)) { *error_out="triggers must list at most 26 triggers, each with a channel from 6 to 31, and at most 128 actions in all: break, cell, effect or reveal, each with its place."; return 0; }
    }
    if (json_object_get(root,root_end,"friends",&obj,&obj_end)) {
        if (!parse_friends(obj,obj_end)) { *error_out="friends must list at most 16 characters, each with its area, storey, position and type."; return 0; }
    }
    if (json_object_get(root,root_end,"effects",&obj,&obj_end)) {
        if (!parse_effects(obj,obj_end)) { *error_out="effects must list at most 96 emitters, each with a position, a rate from 1 to 255 updates and one to three particles from the game's effect table."; return 0; }
    }
    if (json_object_get(root,root_end,"entity_overrides",&obj,&obj_end)) {
        if (!parse_entity_overrides(obj,obj_end)) { *error_out="entity_overrides must list at most 16 entity types, each once, with health up to 255, percentages from 10 to 500, and animations that use the type's own records and frames its sprite file has."; return 0; }
    }
    if (g_package.terrain && !package_validate_terrain(g_package.terrain)) { *error_out="Custom terrain BIN is not a valid 64x64 tile bank, or it holds more tiles than this copy of the game can load."; return 0; }
    if (g_package.pal && g_package.pal->size!=1024u) { *error_out="Custom PAL must be exactly 1024 bytes."; return 0; }
    if (g_package.plt && g_package.plt->size!=1024u) { *error_out="Custom PLT must be exactly 1024 bytes."; return 0; }
    if (g_package.rmp && g_package.rmp->size!=65536u) { *error_out="Custom RMP must be exactly 65536 bytes."; return 0; }
    if (g_package.brt && g_package.brt->size!=73728u) { *error_out="Custom BRT must be exactly 73728 bytes."; return 0; }
    if (g_package.lmp && (!g_package.lmp->size || g_package.lmp->size>0x5000u)) { *error_out="Custom LMP must fit the game's 0x5000-byte LMP allocation."; return 0; }

    if (json_object_get(root,root_end,"briefing",&obj,&obj_end)) {
        if (*obj!='{') { *error_out="briefing must be an object."; return 0; }
        mode[0]=0; r=json_member_string(obj,obj_end,"mode",mode,sizeof(mode));
        if (r<0) { *error_out="briefing.mode must be a string."; return 0; }
        if (r==1 && !str_ieq(mode,"inherit") && !str_ieq(mode,"custom")) { *error_out="briefing.mode must be inherit or custom."; return 0; }
        if (r==0 || str_ieq(mode,"custom")) {
            r=json_member_string(obj,obj_end,"text",g_package.briefing_text,sizeof(g_package.briefing_text));
            if (r<0) { *error_out="briefing.text is too long or contains unsupported JSON escapes."; return 0; }
            if (r==1) g_package.briefing_text_set=1;
            r=json_member_string(obj,obj_end,"title",g_package.briefing_title,sizeof(g_package.briefing_title));
            if (r<0) { *error_out="briefing.title is too long or contains unsupported JSON escapes."; return 0; }
            if (r==1) g_package.briefing_title_set=1;
            if ((r=package_entry_from_json_path(obj,obj_end,"image",&g_package.briefing_image))<0) { *error_out="briefing.image does not name an embedded package entry."; return 0; }
            if (g_package.briefing_image && !package_validate_bmp(g_package.briefing_image)) { *error_out="briefing.image must be an uncompressed 220x160 8-bit BMP."; return 0; }
        }
    }

    if (json_object_get(root,root_end,"debrief",&obj,&obj_end)) {
        mode[0]=0; r=json_member_string(obj,obj_end,"mode",mode,sizeof(mode));
        if (r<0) { *error_out="debrief.mode must be a string."; return 0; }
        if (r==1 && !str_ieq(mode,"inherit")) g_package.custom_debrief_declared=1;
        if (r==0) {
            if (json_object_get(obj,obj_end,"text",&v,&ve) || json_object_get(obj,obj_end,"image",&v,&ve))
                g_package.custom_debrief_declared=1;
        }
        if (g_package.custom_debrief_declared) { *error_out="Custom debrief presentation is reserved by the format but is not runtime-enabled in this build yet. Use debrief.mode=inherit."; return 0; }
    }

    /* on_complete is reserved now so editor projects do not need a schema break later. */
    if (json_object_get(root,root_end,"on_complete",&obj,&obj_end)) {
        mode[0]=0; r=json_member_string(obj,obj_end,"action",mode,sizeof(mode));
        if (r<0 || (r==1 && !str_ieq(mode,"inherit"))) { *error_out="Only on_complete.action=inherit is runtime-enabled in this build."; return 0; }
    }

    g_package.active=1;
    return 1;
}

static int load_mhmap_package(const char *path, const char **error_out)
{
    mh_u32 size=0;
    const MHPackageEntry *manifest;
    g_package_size=0;
    g_package_entry_count=0;
    zero_bytes(&g_package,sizeof(g_package));
    if (!read_file_exact(path,g_package_buffer,MH_PACKAGE_BUFFER_CAP,&size)) {
        *error_out="Could not read the .mhproject package, or it exceeds the 64 MiB project limit.";
        return 0;
    }
    if (!package_parse_zip(g_package_buffer,size)) {
        *error_out="The .mhproject is not a supported stored-entry ZIP package. Rebuild it in the editor.";
        return 0;
    }
    manifest=package_find("manifest.json");
    if (!manifest) { *error_out="The .mhproject package has no manifest.json at its root."; return 0; }
    g_package_size=size;
    {
        const mh_u8 *root=manifest->data,*end=root+manifest->size;
        const MHPackageEntry *project,*runtime;
        char format[32],entry[MH_PACKAGE_ENTRY_NAME_CAP]; mh_u32 checksum;
        if(json_member_string(root,end,"format",format,sizeof(format))!=1 || !str_ieq(format,"mhproject-v2")) {
            *error_out="Reopen this older project in the updated editor and export Playable .mhproject.";return 0;
        }
        if(json_member_string(root,end,"project",entry,sizeof(entry))!=1 || !(project=package_find(entry))) {
            *error_out="The editable project entry is missing.";return 0;
        }
        if(json_member_u32(root,end,"project_crc32",&checksum)!=1 || checksum!=package_crc32(project->data,project->size)) {
            *error_out="Project contents changed after compilation. Rebuild in the editor.";return 0;
        }
        if(json_member_string(root,end,"runtime",entry,sizeof(entry))!=1 || !(runtime=package_find(entry))) {
            static char build_error[2048];
            if(json_member_string(root,end,"build_error",build_error,sizeof(build_error))==1) *error_out=build_error;
            else *error_out="This is an unbuilt project. Export Playable .mhproject in the editor.";
            return 0;
        }
        return package_parse_manifest(runtime,error_out);
    }
}

static int find_mission_for_level(mh_u32 level, mh_u32 *mission_out)
{
    mh_u32 mission;
    mh_u8 value=0;
    for (mission=0;mission<MH_SINGLE_PLAYER_LEVEL_COUNT;++mission) {
        if (!g_api->read_memory(MH_MISSION_LEVEL_BYTE+mission*MH_MISSION_STRIDE,&value,1)) return 0;
        if ((mh_u32)value==level) { *mission_out=mission; return 1; }
    }
    return 0;
}


static void restore_package_patches(void)
{
    mh_u32 address;
    if (!g_api) return;
    if (g_initial_group_patched) {
        address=MH_LEVEL_TABLE+g_package.base_level*MH_LEVEL_STRIDE+0x20u;
        g_api->write_memory(address,&g_original_initial_group,4);
        g_initial_group_patched=0;
    }
    if (g_mission_selector_patched) {
        g_api->write_memory(MH_MISSION_SELECTORS+MH_LEVEL_MINES4,&g_original_mission_selector,1);
        g_mission_selector_patched=0;
    }
    MHEntityOverridesRestore(g_api);
    MHFriendsArm(0,0u);
    MHSwitchesArm(0,0u,0,0u,0,0u,0,0u);
    if (g_briefing_text_patched) {
        address=MH_BRIEFING_TEXT_TABLE+g_package.base_level*4u;
        g_api->write_memory(address,&g_original_briefing_text_ptr,4);
        g_briefing_text_patched=0;
    }
    if (g_briefing_title_patched) {
        if (g_patched_briefing_mission<MH_SINGLE_PLAYER_LEVEL_COUNT) {
            address=MH_MISSION_TITLE_PTR+g_patched_briefing_mission*MH_MISSION_STRIDE;
            g_api->write_memory(address,&g_original_briefing_title_ptr,4);
        }
        g_briefing_title_patched=0;
        g_patched_briefing_mission=0;
    }
}

static int prepare_package_runtime(mh_u32 mission)
{
    mh_u32 level_rec, address, ptr;
    if (!g_api || !g_package.active) return 0;
    level_rec=MH_LEVEL_TABLE+g_package.base_level*MH_LEVEL_STRIDE;
    if (!g_api->read_memory(level_rec,g_package.base_ids,sizeof(g_package.base_ids))) return 0;

    if (g_package.initial_group_set) {
        address=level_rec+0x20u;
        if (!g_api->read_memory(address,&g_original_initial_group,4)) return 0;
        if (!g_api->write_memory(address,&g_package.initial_group,4)) return 0;
        g_initial_group_patched=1;
    }

    /* An exit that is always open works by keeping the mission-complete latch
       set (custom_level_frame). On MINES4 that latch with no escape countdown
       running brings the mine down on the player at once. A custom map has no
       TNT-mine mission, so it takes the shared path instead. */
    if (g_package.exit_rule==MH_EXIT_UNCONDITIONAL && g_package.base_level==MH_LEVEL_MINES4) {
        mh_u8 shared=MH_MISSION_SELECTOR_SHARED;
        if (!g_api->read_memory(MH_MISSION_SELECTORS+MH_LEVEL_MINES4,&g_original_mission_selector,1)) return 0;
        if (g_original_mission_selector==1u) {
            if (!g_api->write_memory(MH_MISSION_SELECTORS+MH_LEVEL_MINES4,&shared,1)) return 0;
            g_mission_selector_patched=1;
        }
    }

    MHEffectEmittersReset();
    MHFriendsArm(g_package.friends,g_package.friend_count);
    MHSwitchesArm(g_package.switches,g_package.switch_count,g_package.switch_doors,g_package.switch_door_count,
                  g_package.triggers,g_package.trigger_count,g_package.trigger_actions,g_package.trigger_action_count);
    if (g_package.entity_override_count) {
        if (!MHEntityOverridesApply(g_api,g_package.entity_overrides,g_package.entity_override_count)) return 0;
        g_api->log("MH Maps: custom entity types applied");
    }

    if (g_package.briefing_text_set) {
        address=MH_BRIEFING_TEXT_TABLE+g_package.base_level*4u;
        if (!g_api->read_memory(address,&g_original_briefing_text_ptr,4)) return 0;
        ptr=(mh_u32)(void *)g_package.briefing_text;
        if (!g_api->write_memory(address,&ptr,4)) return 0;
        g_briefing_text_patched=1;
    }

    if (g_package.briefing_title_set) {
        address=MH_MISSION_TITLE_PTR+mission*MH_MISSION_STRIDE;
        if (!g_api->read_memory(address,&g_original_briefing_title_ptr,4)) return 0;
        ptr=(mh_u32)(void *)g_package.briefing_title;
        if (!g_api->write_memory(address,&ptr,4)) return 0;
        g_patched_briefing_mission=mission;
        g_briefing_title_patched=1;
    }

    if (g_package.briefing_image) {
        address=MH_BRIEFING_BG_TABLE+g_package.base_level*4u;
        if (!g_api->read_memory(address,&g_package.briefing_base_archive_id,4)) return 0;
    }
    return 1;
}

static int g_package_sound_logged;

/* Give back the sound handles of the armed package. Must run while its entries are still in memory. */
static void release_package_sounds(void)
{
    mh_u32 i,j;
    for (i=0;i<g_package.sound_count;++i) {
        mh_u32 handle=g_package.sounds[i].handle;
        if (!handle) continue;
        MHSoundUnloadWav(handle);
        for (j=i;j<g_package.sound_count;++j) if (g_package.sounds[j].handle==handle) g_package.sounds[j].handle=0u;
    }
}

/* Emitters that play the same file share one handle. A WAV the sound system rejects is skipped, not fatal. */
static void load_package_sounds(void)
{
    mh_u32 i,j,loaded=0u;
    for (i=0;i<g_package.sound_count;++i) {
        MHPackageSound *s=&g_package.sounds[i];
        for (j=0;j<i;++j) if (g_package.sounds[j].entry==s->entry) { s->handle=g_package.sounds[j].handle; break; }
        if (j==i) { s->handle=MHSoundLoadWavMemory(s->entry->data,s->entry->size); if (s->handle) ++loaded; else { g_api->log("MH Maps: a custom sound could not be loaded (unsupported WAV, or no free sound slot)"); g_api->log(s->entry->name); } }
    }
    g_package_sound_logged=0;
    if (loaded) g_api->log("MH Maps: custom ambient sounds loaded");
}

static void clear_override(void)
{
    release_package_sounds();
    restore_package_patches();
    g_override_active=0;
    g_override_seen=0;
    g_override_archive_id=0;
    g_override_base_level=0;
    g_package_size=0;
    g_package_entry_count=0;
    zero_bytes(&g_package,sizeof(g_package));
}

static int tick_reached(mh_u32 now, mh_u32 deadline)
{
    return (mh_i32)(now-deadline) >= 0;
}

static int read_confirm_bits(mh_u32 *raw_out, mh_u16 *current_out, mh_u16 *previous_out)
{
    mh_u32 raw=0;
    mh_u16 current=0, previous=0;
    if (!g_api) return 0;
    if (!g_api->read_memory(MH_INPUT_RAW_BITS,&raw,4)) return 0;
    if (!g_api->read_memory(MH_INPUT_CURRENT_BITS,&current,2)) return 0;
    if (!g_api->read_memory(MH_INPUT_PREVIOUS_BITS,&previous,2)) return 0;
    if (raw_out) *raw_out=raw;
    if (current_out) *current_out=current;
    if (previous_out) *previous_out=previous;
    return 1;
}

/* Confirm handling reads only the game's own latched input words, the same
   ones the retail selector at 0x0042D680 tests. The host's key snapshot is
   taken once per presented frame and is not in step with them: requiring both
   meant the one frame carrying the edge was usually rejected, so Return on a
   map row appeared to do nothing. */
static int confirm_input_neutral(void)
{
    mh_u16 current=0;
    if (!read_confirm_bits(0,&current,0)) return 0;
    return (current & MH_INPUT_CONFIRM_MASK)==0u;
}

static int fresh_confirm_edge(void)
{
    mh_u16 current=0, previous=0;
    if (!read_confirm_bits(0,&current,&previous)) return 0;
    return (current & (mh_u16)~previous & MH_INPUT_CONFIRM_MASK) != 0u;
}

static void arm_maps_confirm_gate(void)
{
    mh_u32 now=0;
    g_maps_confirm_armed=0;
    g_maps_confirm_neutral_seen=0;
    if (g_get_tick_count) now=g_get_tick_count();
    g_maps_unlock_tick=now+MH_MAP_CONFIRM_DELAY_MS;
    if (g_api) g_api->log("MH Maps Menu: confirm gate locked for MAPS entry");
}

static void refresh_maps_confirm_gate(void)
{
    mh_u32 now;
    if (g_maps_confirm_armed || !g_api || !g_get_tick_count) return;

    now=g_get_tick_count();
    if (!tick_reached(now,g_maps_unlock_tick)) return;

    /* The timer expiring is not sufficient. The retail selector consumes the
       game's latched RAW/CURRENT/PREVIOUS snapshots, which can trail the
       physical key. Require the game's confirm state itself to become neutral
       after the deadline before allowing any future confirm edge through. */
    if (!confirm_input_neutral()) return;

    g_maps_confirm_neutral_seen=1;
    g_maps_confirm_armed=1;
    g_api->log("MH Maps Menu: confirm gate opened after post-delay neutral input");
}

static int maps_selection_allowed(void)
{
    mh_u32 state=0;
    if (!g_api || !g_api->read_memory(MH_MENU_CURRENT_STATE,&state,4)) return 0;
    if (state!=MH_MAP_MENU_STATE) return 0;
    refresh_maps_confirm_gate();
    return g_maps_confirm_armed && g_maps_confirm_neutral_seen;
}

static void MH_CDECL maps_menu_entered(void)
{
    /* +0x28 is a per-frame callback for the highlighted descriptor, not an
       activation-only callback. Arm only on the actual Enter edge that caused
       the retail selector to enter state 11. */
    if (fresh_confirm_edge()) {
        g_maps_page=0u;
        arm_maps_confirm_gate();
    }
}

static void schedule_original_start_game(void)
{
    mh_u32 one=1u, minus_one=0xffffffffu, action=MH_START_GAME_THUNK, flow=2u, idle=0x384u;
    g_api->write_memory(MH_MENU_TRANSITION_TICKS,&one,4);
    g_api->write_memory(MH_MENU_CURRENT_STATE,&minus_one,4);
    g_api->write_memory(MH_MENU_DELAYED_ACTION,&action,4);
    g_api->write_memory(MH_MENU_PENDING_ACTION,&action,4);
    g_api->write_memory(MH_GAME_FLOW_STATE,&flow,4);
    g_api->write_memory(MH_MENU_STATE11_AUX_ALIAS,&idle,4);
}

/* Validate a package, arm it as the level override and start the game through
   the original START GAME path. On failure the user is told why and stays on
   the menu. */
static int start_map_package(const char *path, const char *name)
{
    mh_u32 base=0, mission=0;
    const char *package_error=0;

    clear_override();
    if (!load_mhmap_package(path,&package_error)) {
        map_error(package_error ? package_error : "The .mhproject package could not be loaded.",name);
        return 0;
    }
    base=g_package.base_level;
    if (!find_mission_for_level(base,&mission)) {
        clear_override();
        map_error("The original mission table has no single-player route to the package base level.",name);
        return 0;
    }
    if (!prepare_package_runtime(mission)) {
        clear_override();
        map_error("Could not prepare the package's inherited retail runtime state.",name);
        return 0;
    }
    if (!g_api->write_memory(MH_CURRENT_MISSION,&mission,4)) {
        clear_override();
        map_error("Could not select the original mission slot for this package base level.",name);
        return 0;
    }

    g_override_archive_id=g_package.base_ids[0];
    g_override_base_level=base;
    g_override_seen=0;
    g_override_active=1;
    load_package_sounds();
    g_api->log("MH Maps Menu: .mhproject package validated and armed");
    g_api->log(path);
    g_api->log(MH_LEVEL_NAMES[base]);
    schedule_original_start_game();
    return 1;
}

static mh_u32 maps_page_count(void)
{
    return g_map_count<=MH_MAPS_ON_ONE_PAGE ? 1u : (g_map_count+MH_MAPS_PER_PAGE-1u)/MH_MAPS_PER_PAGE;
}

static mh_u32 maps_page_first(void)
{
    return maps_page_count()>1u ? g_maps_page*MH_MAPS_PER_PAGE : 0u;
}

/* Maps on the page being shown, starting at maps_page_first(). */
static mh_u32 maps_on_page(void)
{
    mh_u32 size=maps_page_count()>1u ? MH_MAPS_PER_PAGE : MH_MAPS_ON_ONE_PAGE;
    mh_u32 first=maps_page_first(), left=g_map_count>first ? g_map_count-first : 0u;
    return left<size ? left : size;
}

static void MH_CDECL map_selected(void)
{
    mh_u32 sel=0, index;
    char path[MH_PATH_CAP];
    const char *name;

    if (!maps_selection_allowed()) return;
    if (!fresh_confirm_edge()) return;
    if (!g_api->read_memory(MH_MENU_SELECTION,&sel,4)) return;
    /* Row 0 is the title, so the selection counts the map rows from 1. */
    if (sel<1u || sel>maps_on_page()) return;
    index=maps_page_first()+sel-1u;
    if (index>=g_map_count) return;

    name=g_map_names[index];
    if (!copy_path(path,sizeof(path),g_map_paths[index])) {
        map_error("Custom map path is too long.",name);
        return;
    }
    start_map_package(path,name);
}

/* The page row: Return shows the next maps, wrapping round to the first page.
   The row's action re-enters the MAPS state, which is what makes the game
   draw the new names: it draws a menu's text once, when the menu is entered. */
static void MH_CDECL maps_next_page(void)
{
    if (!maps_selection_allowed()) return;
    if (!fresh_confirm_edge()) return;
    g_maps_page=(g_maps_page+1u)%maps_page_count();
    g_maps_page_turned=1;
    /* The same Return must not also start the map that is now under the
       highlight: lock confirm as on entering MAPS. */
    arm_maps_confirm_gate();
    g_api->log("MH Maps Menu: next page of maps");
}

/* ---------------------------------------------------------------- autostart
 *
 * The Workshop's Play button starts the game with MH_AUTOSTART_MAP set to a
 * package path relative to the game folder. The runtime then presses the
 * launcher dialog's default button for the user, skips the logos and the
 * PRESS START screen (see MHDebugMode.c), and starts that package as soon as
 * the main menu is up. It happens once per run; afterwards the menus behave
 * normally.
 */
#define MH_AUTOSTART_ENV          "MH_AUTOSTART_MAP"
/* Set to 1, the launcher dialog is confirmed without starting a map: a normal start, intros and all. */
#define MH_SKIP_LAUNCHER_ENV      "MH_SKIP_LAUNCHER"
#define MH_AUTOSTART_MENU_FRAMES  20u
#define MH_AUTOSTART_DIALOG_MS    20000u
#define MH_DM_GETDEFID            0x0400u
#define MH_DC_HASDEFID            0x534Bu
#define MH_WM_COMMAND             0x0111u
#define MH_IDOK                   1u
#define MH_SMTO_ABORTIFHUNG       0x0002u

typedef void * (MH_STDCALL *PFN_LoadLibraryA)(const char *);
typedef void * (MH_STDCALL *PFN_GetProcAddress)(void *, const char *);
typedef mh_u32 (MH_STDCALL *PFN_GetEnvironmentVariableA)(const char *, char *, mh_u32);
typedef mh_u32 (MH_STDCALL *PFN_ThreadStart)(void *);
typedef void * (MH_STDCALL *PFN_CreateThread)(void *, mh_u32, PFN_ThreadStart, void *, mh_u32, mh_u32 *);
typedef void (MH_STDCALL *PFN_Sleep)(mh_u32);
typedef mh_u32 (MH_STDCALL *PFN_GetCurrentProcessId)(void);
typedef void * (MH_STDCALL *PFN_FindWindowExA)(void *, void *, const char *, const char *);
typedef mh_u32 (MH_STDCALL *PFN_GetWindowThreadProcessId)(void *, mh_u32 *);
typedef int (MH_STDCALL *PFN_IsWindowVisible)(void *);
typedef mh_u32 (MH_STDCALL *PFN_SendMessageTimeoutA)(void *, mh_u32, mh_u32, mh_i32, mh_u32, mh_u32, mh_u32 *);
typedef int (MH_STDCALL *PFN_PostMessageA)(void *, mh_u32, mh_u32, mh_i32);
typedef void * (MH_STDCALL *PFN_GetDlgItem)(void *, int);

static char g_autostart_path[MH_PATH_CAP];
static int g_autostart_requested;
static int g_autostart_pending;
static mh_u32 g_autostart_menu_frames;
static PFN_Sleep g_sleep;
static PFN_GetCurrentProcessId g_get_current_process_id;
static PFN_FindWindowExA g_find_window_ex;
static PFN_GetWindowThreadProcessId g_get_window_thread_process_id;
static PFN_IsWindowVisible g_is_window_visible;
static PFN_SendMessageTimeoutA g_send_message_timeout;
static PFN_PostMessageA g_post_message;
static PFN_GetDlgItem g_get_dlg_item;

int MH_STDCALL MHMapsAutostartRequested(void)
{
    return g_autostart_requested;
}

/* Runs beside the game's own thread: waits for the launcher dialog and
   presses its default button, exactly as the Return key would. */
static mh_u32 MH_STDCALL autostart_launcher_thread(void *unused)
{
    mh_u32 waited=0u, pid=g_get_current_process_id();
    (void)unused;
    while (waited<MH_AUTOSTART_DIALOG_MS) {
        void *dialog=0;
        while ((dialog=g_find_window_ex(0,dialog,"#32770",0))!=0) {
            mh_u32 owner=0u, reply=0u, id=MH_IDOK;
            g_get_window_thread_process_id(dialog,&owner);
            if (owner!=pid || !g_is_window_visible(dialog)) continue;
            if (g_send_message_timeout(dialog,MH_DM_GETDEFID,0u,0,MH_SMTO_ABORTIFHUNG,1000u,&reply) && (reply>>16)==MH_DC_HASDEFID)
                id=reply&0xffffu;
            g_post_message(dialog,MH_WM_COMMAND,id,(mh_i32)g_get_dlg_item(dialog,(int)id));
            return 0u;
        }
        g_sleep(100u);
        waited+=100u;
    }
    return 0u;
}

/* The path comes from outside the game: accept only a .mhproject below the
   game folder (no drive, no leading separator, no ".." component). */
static int autostart_path_allowed(const char *path)
{
    static const char suffix[]=".mhproject";
    mh_u32 n=0u;
    if (!path[0] || path[0]=='\\' || path[0]=='/') return 0;
    while (path[n]) {
        int component_start=(n==0u || path[n-1u]=='\\' || path[n-1u]=='/');
        if (path[n]==':') return 0;
        if (component_start && path[n]=='.' && path[n+1u]=='.' &&
            (path[n+2u]==0 || path[n+2u]=='\\' || path[n+2u]=='/')) return 0;
        ++n;
    }
    if (n<sizeof(suffix)) return 0;
    return str_ieq(path+n-(sizeof(suffix)-1u),suffix);
}

/* Resolve what the launcher thread needs and start it. */
static int start_launcher_thread(void *kernel32, void *user32, PFN_GetProcAddress get_proc)
{
    PFN_CreateThread create_thread=(PFN_CreateThread)get_proc(kernel32,"CreateThread");
    g_sleep=(PFN_Sleep)get_proc(kernel32,"Sleep");
    g_get_current_process_id=(PFN_GetCurrentProcessId)get_proc(kernel32,"GetCurrentProcessId");
    g_find_window_ex=(PFN_FindWindowExA)get_proc(user32,"FindWindowExA");
    g_get_window_thread_process_id=(PFN_GetWindowThreadProcessId)get_proc(user32,"GetWindowThreadProcessId");
    g_is_window_visible=(PFN_IsWindowVisible)get_proc(user32,"IsWindowVisible");
    g_send_message_timeout=(PFN_SendMessageTimeoutA)get_proc(user32,"SendMessageTimeoutA");
    g_post_message=(PFN_PostMessageA)get_proc(user32,"PostMessageA");
    g_get_dlg_item=(PFN_GetDlgItem)get_proc(user32,"GetDlgItem");
    return create_thread && g_sleep && g_get_current_process_id && g_find_window_ex && g_get_window_thread_process_id &&
           g_is_window_visible && g_send_message_timeout && g_post_message && g_get_dlg_item &&
           create_thread(0,0u,autostart_launcher_thread,0,0u,0)!=0;
}

static void autostart_init(const MHHostAPI *api)
{
    PFN_LoadLibraryA load_library=(PFN_LoadLibraryA)(void *)api->symbol("win32.load_library_a");
    PFN_GetProcAddress get_proc=(PFN_GetProcAddress)(void *)api->symbol("win32.get_proc_address");
    PFN_GetEnvironmentVariableA get_env;
    void *kernel32, *user32;
    mh_u32 length;
    char skip[4];

    g_autostart_requested=0;
    g_autostart_pending=0;
    g_autostart_menu_frames=0u;
    if (!load_library || !get_proc) return;
    kernel32=load_library("kernel32.dll");
    user32=load_library("user32.dll");
    if (!kernel32 || !user32) return;
    get_env=(PFN_GetEnvironmentVariableA)get_proc(kernel32,"GetEnvironmentVariableA");
    if (!get_env) return;
    length=get_env(MH_AUTOSTART_ENV,g_autostart_path,sizeof(g_autostart_path));
    if (!length || length>=sizeof(g_autostart_path)) {
        /* No map: only confirm the launcher when asked to (the game checks start the game this way). */
        if (get_env(MH_SKIP_LAUNCHER_ENV,skip,sizeof(skip))==1u && skip[0]=='1' && !start_launcher_thread(kernel32,user32,get_proc))
            api->log("MH Maps: could not press the launcher's start button automatically; press it to continue");
        return;
    }
    if (!autostart_path_allowed(g_autostart_path)) {
        api->log("MH Maps: " MH_AUTOSTART_ENV " ignored; it must be a relative path to a .mhproject inside the game folder");
        return;
    }
    g_autostart_requested=1;
    g_autostart_pending=1;
    api->log("MH Maps: direct start requested");
    api->log(g_autostart_path);
    if (!start_launcher_thread(kernel32,user32,get_proc))
        api->log("MH Maps: could not press the launcher's start button automatically; press it to continue");
}

/* Called from the selector hook: start the requested package once the main
   menu has been on screen, idle, for a few frames. */
static void autostart_poll(mh_u32 state)
{
    mh_u32 transition=0u;
    if (!g_autostart_pending) return;
    /* The transition counter rests at -1 and counts down to 0 while the menu is changing screens. */
    if (state!=0u || !g_main_ready || !g_api->read_memory(MH_MENU_TRANSITION_TICKS,&transition,4) || transition!=0xffffffffu) {
        g_autostart_menu_frames=0u;
        return;
    }
    if (++g_autostart_menu_frames<MH_AUTOSTART_MENU_FRAMES) return;
    g_autostart_pending=0;
    if (start_map_package(g_autostart_path,g_autostart_path))
        g_api->log("MH Maps: direct start armed from the main menu");
}

static const MHPackageEntry *package_generic_override(mh_u32 archive_id)
{
    if (!g_package.active) return 0;
    if (archive_id==g_package.base_ids[0]) return g_package.map;
    if (g_package.pal && archive_id==g_package.base_ids[2]) return g_package.pal;
    if (g_package.plt && archive_id==g_package.base_ids[3]) return g_package.plt;
    if (g_package.rmp && archive_id==g_package.base_ids[5]) return g_package.rmp;
    if (g_package.brt && archive_id==g_package.base_ids[6]) return g_package.brt;
    if (g_package.lmp && archive_id==g_package.base_ids[7]) return g_package.lmp;
    return 0;
}

static int MH_STDCALL map_package_resource_provider(mh_u32 archive_id, void *destination, mh_u32 *decoded_size)
{
    const MHPackageEntry *entry;
    if (!decoded_size || !g_override_active || !g_package.active || !destination) return 0;
    entry=package_generic_override(archive_id);
    if (!entry) return 0;
    copy_bytes(destination,entry->data,entry->size);
    *decoded_size=entry->size;
    if (!g_override_seen && archive_id==g_package.base_ids[0]) {
        g_api->log("MH Maps Menu: packaged MAP substituted through central resource service");
        g_override_seen=1;
    }
    return 1;
}

static int MH_STDCALL map_package_terrain_provider(mh_u32 archive_id,const mh_u8 **decoded_data,mh_u32 *decoded_size)
{
    if(!decoded_data||!decoded_size||!g_override_active||!g_package.active||!g_package.terrain)return 0;
    if(archive_id!=g_package.base_ids[1])return 0;
    *decoded_data=g_package.terrain->data;*decoded_size=g_package.terrain->size;
    g_api->log("MH Maps Menu: custom terrain BIN supplied through central resource service");
    return 1;
}

static int MH_STDCALL map_package_bitmap_provider(mh_u32 archive_id,const mh_u8 **decoded_data,mh_u32 *decoded_size)
{
    if(!decoded_data||!decoded_size||!g_override_active||!g_package.active||!g_package.briefing_image)return 0;
    if(archive_id!=g_package.briefing_base_archive_id)return 0;
    *decoded_data=g_package.briefing_image->data;*decoded_size=g_package.briefing_image->size;
    g_api->log("MH Maps Menu: custom briefing BMP supplied through central resource service");
    return 1;
}

static mh_i32 MH_CDECL level_asset_load_hook(mh_u32 level_index)
{
    mh_i32 result=0;
    mh_u32 i, loose_count;
    if (g_original_level_asset_load) result=g_original_level_asset_load(level_index);

    /* Retail stage resources are now resident. Apply package-level loose .B
       replacements by recovered retail resource name before a selected
       .mhproject applies its explicit runtime-slot overrides. */
    loose_count=MHResourceApplyLooseSpriteOverrides(level_index);
    if (loose_count) g_api->log("MH resources: loose sprite stage overrides installed");

    if (g_override_active && g_package.active && level_index==g_package.base_level) {
        /* CITY1/ALIEN1 can rewrite record +0x20 inside the retail loader.
           Reassert a package-specified group after that code has finished,
           before the caller consumes the stage record. */
        if (g_package.initial_group_set) {
            mh_u32 address=MH_LEVEL_TABLE+g_package.base_level*MH_LEVEL_STRIDE+0x20u;
            g_api->write_memory(address,&g_package.initial_group,4);
        }
        for (i=0;i<g_package.sprite_count;++i)
            if (!MHResourceInstallSpriteSlot(g_package.sprites[i].slot,g_package.sprites[i].entry->data,g_package.sprites[i].entry->size))
                g_api->log("MH Maps Menu: failed installing custom sprite-slot override");
        if (g_package.sprite_count) g_api->log("MH Maps Menu: custom sprite-slot overrides installed through central resource service");
    }
    return result;
}

/* Play the package's own ambient sounds: each emitter in the area the player is in fires on its own
   timer, positioned in the world so the engine's distance and pan rules apply. */
static void package_sounds_frame(const MHHostAPI *api)
{
    static mh_u32 seed;
    mh_u32 i,now,group=0xffffffffu,sfx=1u,ambient=1u;
    if (!g_package.sound_count || !g_get_tick_count || !api->find_player_actor || !api->find_player_actor()) return;
    api->read_memory(MH_SETTING_SFX_VA,&sfx,4);
    api->read_memory(MH_SETTING_AMBIENT_SFX_VA,&ambient,4);
    if (!sfx || !ambient) return;
    if (!api->read_memory(MH_CURRENT_GROUP_VA,&group,4)) return;
    now=g_get_tick_count();
    if (!seed) seed=now|1u;
    for (i=0;i<g_package.sound_count;++i) {
        MHPackageSound *s=&g_package.sounds[i];
        mh_u32 wait;
        if (!s->handle) continue;
        if (s->group!=group) { s->scheduled=0; continue; }
        seed=seed*1664525u+1013904223u;
        if (!s->scheduled) {
            /* Spread the first plays out so emitters sharing a delay do not all fire together. */
            s->next_tick=now+((seed>>8)%s->delay_ms);
            s->scheduled=1;
            continue;
        }
        if (!tick_reached(now,s->next_tick)) continue;
        /* Out of earshot is an ordinary refusal; note the first sound that does start, as evidence the path works. */
        if (MHSoundPlayWavAt(s->handle,(mh_i32)(s->x<<16),(mh_i32)(s->y<<16)) && !g_package_sound_logged) {
            g_package_sound_logged=1;
            api->log("MH Maps: a custom ambient sound started playing");
        }
        wait=s->delay_ms+(s->random_ms?((seed>>8)%s->random_ms):0u);
        s->next_tick=now+wait;
    }
}

static void MH_STDCALL custom_level_frame(const MHHostAPI *api)
{
    mh_u32 one=1u, value=0;
    if (!api || !g_override_active || !g_package.active) return;
    MHSoundPrepareKeyPickups();
    package_sounds_frame(api);
    MHEffectEmittersFrame(api,g_package.effects,g_package.effect_count);
    MHFriendsFrame(api);
    MHSwitchesFrame(api);
    if (g_package.exit_rule==MH_EXIT_UNCONDITIONAL) {
        if (!api->read_memory(MH_EXIT_READY_LATCH,&value,4) || value==0u)
            api->write_memory(MH_EXIT_READY_LATCH,&one,4);
        value=0;
        if (!api->read_memory(MH_MISSION_COMPLETE_LATCH,&value,4) || value==0u)
            api->write_memory(MH_MISSION_COMPLETE_LATCH,&one,4);
    }
}

static int build_main_menu(void)
{
    MHMenuRecord original[7];
    mh_u32 i, state0;
    if (g_main_ready) return 1;

    state0=0;
    if (!g_api->read_memory(MH_MENU_STATE_TABLE,&state0,4) || !state0 || state0==0xffffffffu)
        state0=MH_MENU_ORIGINAL_MAIN;
    for (i=0;i<7;++i)
        if (!read_record(state0+i*MH_MENU_STRIDE,&original[i])) return 0;
    if (original[6].v[M_FLAGS] != 0xffffu) return 0;

    for (i=0;i<5;++i) copy_bytes(&g_main_menu[i],&original[i],MH_MENU_STRIDE);

    copy_bytes(&g_main_menu[5],&original[5],MH_MENU_STRIDE);
    g_main_menu[5].v[M_Y]=0xAAu;
    g_main_menu[5].v[M_TEXT]=(mh_u32)(void *)g_maps_label;
    g_main_menu[5].v[M_ACTION]=MH_MENU_RENDER_INIT;
    g_main_menu[5].v[M_IMMEDIATE]=(mh_u32)(void *)&maps_menu_entered;
    g_main_menu[5].v[M_SECONDARY]=0;
    g_main_menu[5].v[M_NEXT_STATE]=MH_MAP_MENU_STATE;

    copy_bytes(&g_main_menu[6],&original[5],MH_MENU_STRIDE);
    copy_bytes(&g_main_menu[7],&original[6],MH_MENU_STRIDE);

    g_main_ready=1;
    g_api->log("MH Maps Menu: native MAPS row prepared for original main menu");
    return 1;
}

static int build_maps_menu(void)
{
    MHMenuRecord title_proto, row_proto, sentinel;
    mh_u32 state4=0, i, out=0, y;

    scan_maps();
    if (!g_api->read_memory(MH_MENU_STATE_TABLE+4u*4u,&state4,4) || !state4 || state4==0xffffffffu)
        state4=MH_MENU_CHEATS_BASE;
    if (!read_record(state4,&title_proto)) return 0;
    if (!read_record(MH_MENU_ORIGINAL_MAIN+MH_MENU_STRIDE,&row_proto)) return 0;
    zero_bytes(&sentinel,sizeof(sentinel));
    sentinel.v[M_FLAGS]=0xffffu;

    copy_bytes(&g_maps_menu[out],&title_proto,MH_MENU_STRIDE);
    g_maps_menu[out].v[M_TEXT]=(mh_u32)(void *)g_maps_label;
    ++out;

    y=0x44u;
    if (!g_map_count) {
        make_text_row(&g_maps_menu[out],&row_proto,g_empty_label,y);
        ++out; y+=0x12u;
    } else {
        mh_u32 first, shown;
        if (g_maps_page>=maps_page_count()) g_maps_page=0u;
        first=maps_page_first();
        shown=maps_on_page();
        for (i=first;i<first+shown;++i) {
            make_text_row(&g_maps_menu[out],&row_proto,g_map_display_names[i],y);
            /* Font/style 1 uses the retail 8-pixel glyph table. Main-menu
               rows use style 2 (15-pixel glyphs), so this is approximately
               half-height/half-width while remaining inside the native text
               and selector pipeline. */
            g_maps_menu[out].v[M_TYPE]=1u;
            /* Validation/preload occurs before any original transition is
               scheduled, so a bad file leaves the user safely on this menu. */
            g_maps_menu[out].v[M_IMMEDIATE]=(mh_u32)(void *)&map_selected;
            /* Small-font rows sit closer together, which keeps BACK clear of
               the game's key hint at the foot of the screen. */
            ++out; y+=0x10u;
        }
    }

    if (maps_page_count()>1u) {
        /* Letters, digits and spaces only: what the menu font has. */
        char *p=g_page_label;
        mh_u32 page=g_maps_page+1u, pages=maps_page_count();
        const char *text="MORE MAPS  PAGE ";
        while (*text) *p++=*text++;
        if (page>=10u) *p++=(char)('0'+page/10u);
        *p++=(char)('0'+page%10u);
        text=" OF ";
        while (*text) *p++=*text++;
        if (pages>=10u) *p++=(char)('0'+pages/10u);
        *p++=(char)('0'+pages%10u);
        *p=0;
        make_text_row(&g_maps_menu[out],&row_proto,g_page_label,y);
        g_maps_menu[out].v[M_TYPE]=1u;
        g_maps_menu[out].v[M_IMMEDIATE]=(mh_u32)(void *)&maps_next_page;
        g_maps_menu[out].v[M_ACTION]=MH_MENU_RENDER_INIT;
        g_maps_menu[out].v[M_NEXT_STATE]=MH_MAP_MENU_STATE;
        ++out; y+=0x14u;
    }

    make_text_row(&g_maps_menu[out],&row_proto,g_back_label,y);
    g_maps_menu[out].v[M_ACTION]=MH_MENU_RENDER_INIT;
    g_maps_menu[out].v[M_NEXT_STATE]=0u;
    ++out;

    copy_bytes(&g_maps_menu[out],&sentinel,MH_MENU_STRIDE);
    return 1;
}

static void patch_menu_tables(mh_u32 state)
{
    mh_u32 ptr;
    if (!build_main_menu()) return;

    ptr=(mh_u32)(void *)g_main_menu;
    g_api->write_memory(MH_MENU_STATE_TABLE,&ptr,4);

    if (state==MH_MAP_MENU_STATE) {
        build_maps_menu();
        ptr=(mh_u32)(void *)g_maps_menu;
        g_api->write_memory(MH_MENU_STATE_TABLE+MH_MAP_MENU_STATE*4u,&ptr,4);
    }
}

static void suppress_confirm_edge(void)
{
    mh_u16 current=0, previous=0;
    if (!g_api) return;
    if (!g_api->read_memory(MH_INPUT_CURRENT_BITS,&current,2)) return;
    if (!g_api->read_memory(MH_INPUT_PREVIOUS_BITS,&previous,2)) return;

    /* The retail selector detects a fresh confirm with CURRENT & ~PREVIOUS.
       While the MAPS gate is closed, mark only the current confirm bit as
       already seen. Leave the raw and current fields untouched. */
    previous |= (mh_u16)(current & MH_INPUT_CONFIRM_MASK);
    g_api->write_memory(MH_INPUT_PREVIOUS_BITS,&previous,2);
}

static void MH_CDECL menu_selector_hook(void)
{
    mh_u32 state=0;
    if (g_api && g_api->read_memory(MH_MENU_CURRENT_STATE,&state,4)) {
        if (state==MH_MAP_MENU_STATE) {
            refresh_maps_confirm_gate();
            if (!g_maps_confirm_armed)
                suppress_confirm_edge();
        } else {
            g_maps_confirm_armed=0;
            g_maps_confirm_neutral_seen=0;
        }
        autostart_poll(state);
    }

    if (g_original_menu_selector) g_original_menu_selector();
}

static void MH_CDECL menu_render_hook(void)
{
    mh_u32 state=0, saved_alias=0, footer0=0;
    int restore_alias=0;

    if (g_api) {
        g_api->read_memory(MH_MENU_CURRENT_STATE,&state,4);
        if (state==MH_MAP_MENU_STATE && g_last_render_state!=MH_MAP_MENU_STATE &&
            !g_maps_confirm_armed && !g_maps_confirm_neutral_seen) {
            /* Fallback for any future path that reaches state 11 without the
               main-menu immediate callback. Normal MAPS entry arms earlier. */
            arm_maps_confirm_gate();
        }
        g_last_render_state=state;
        if (state==0u && g_override_active) {
            clear_override();
            g_api->log("MH Maps Menu: returned to main menu; custom MAP override cleared");
        }
        patch_menu_tables(state);

        if (state==MH_MAP_MENU_STATE &&
            g_api->read_memory(MH_MENU_STATE11_AUX_ALIAS,&saved_alias,4) &&
            g_api->read_memory(MH_MENU_STATE_AUX_TABLE,&footer0,4) &&
            g_api->write_memory(MH_MENU_STATE11_AUX_ALIAS,&footer0,4)) {
            restore_alias=1;
        }
    }

    if (g_original_menu_render) g_original_menu_render();

    if (restore_alias && g_api)
        g_api->write_memory(MH_MENU_STATE11_AUX_ALIAS,&saved_alias,4);
    if (g_maps_page_turned && state==MH_MAP_MENU_STATE && g_api) {
        mh_u32 first_row=1u;
        g_api->write_memory(MH_MENU_SELECTION,&first_row,4);
        g_maps_page_turned=0;
    }
}

/* ------------------------------------------------------- HUD percentage
 *
 * Six retail themes (CITY1, CITY2, HOSP0, JUNK1, MILIT3, ASTER2; the word at
 * 0x0048E510 + level*4 is 2 for them) show a counter in the HUD as a
 * percentage, done * 100 / total. A custom map in one of those themes need
 * not contain anything that counts, and the game then divided by zero drawing
 * the level's first frame. The 12 bytes at 0x0044406A that compute
 * eax = esi * 100 / edi become a call to this, which says 100% when there is
 * nothing to count. The retail levels always have a total, so they are
 * unaffected.
 */
#define MH_HUD_PERCENTAGE_CODE 0x0044406Au

#if defined(_MSC_VER) && !defined(__clang__)
static __declspec(naked) void hud_percentage(void)
{
    __asm {
        test edi, edi
        jz nothing
        lea eax, [esi+esi*4]
        lea eax, [eax+eax*4]
        shl eax, 2
        cdq
        idiv edi
        ret
    nothing:
        mov eax, 100
        cdq
        ret
    }
}

static int guard_hud_percentage(const MHHostAPI *api)
{
    static const mh_u8 expected[12]={0x8D,0x04,0xB6,0x8D,0x04,0x80,0xC1,0xE0,0x02,0x99,0xF7,0xFF};
    mh_u8 call[12]={0xE8,0,0,0,0,0x90,0x90,0x90,0x90,0x90,0x90,0x90};
    mh_u32 rel=(mh_u32)(void *)&hud_percentage-(MH_HUD_PERCENTAGE_CODE+5u);
    call[1]=(mh_u8)rel; call[2]=(mh_u8)(rel>>8); call[3]=(mh_u8)(rel>>16); call[4]=(mh_u8)(rel>>24);
    return api->patch(MH_HUD_PERCENTAGE_CODE,expected,call,12u);
}
#else
static int guard_hud_percentage(const MHHostAPI *api) { (void)api; return 0; }
#endif

int MH_STDCALL MHMapsMenuSubsystemInit(const MHHostAPI *api)
{
    static const mh_u8 menu_expected[5]={0xA1,0x9C,0xA0,0x62,0x00};
    static const mh_u8 selector_expected[5]={0xA1,0x58,0xA0,0x62,0x00};
    static const mh_u8 level_expected[5]={0x8B,0x44,0x24,0x04,0x53};
    mh_u32 menu_tramp=0, selector_tramp=0;
    mh_u32 level_tramp=0;
    if (!api) return 0;
    g_api=api;

    g_find_first=(PFN_FindFirstFileA)(void *)api->symbol("win32.find_first_file_a");
    g_find_next =(PFN_FindNextFileA)(void *)api->symbol("win32.find_next_file_a");
    g_find_close=(PFN_FindClose)(void *)api->symbol("win32.find_close");
    g_create_file=(PFN_CreateFileA)(void *)api->symbol("win32.create_file_a");
    g_read_file=(PFN_ReadFile)(void *)api->symbol("win32.read_file");
    g_get_file_size=(PFN_GetFileSize)(void *)api->symbol("win32.get_file_size");
    g_get_tick_count=(PFN_GetTickCount)(void *)api->symbol("win32.get_tick_count");
    g_close_handle=(PFN_CloseHandle)(void *)api->symbol("win32.close_handle");
    g_message_box=(PFN_MessageBoxA)(void *)api->symbol("user32.message_box_a");
    if (!g_find_first || !g_find_next || !g_find_close || !g_create_file || !g_read_file ||
        !g_get_file_size || !g_get_tick_count || !g_close_handle) {
        api->log("MH Maps Menu: required filesystem symbols unavailable");
        return 0;
    }

    /* Friends keep working without Developer Tools; it chains onto the same two functions. */
    if (!MHEntityAnimationsInit(api)) api->log("MH Maps: custom enemy animations unavailable (signature mismatch)");
    if (!MHFriendsInit(api)) api->log("MH Maps: friendly characters unavailable (targeting signature mismatch)");

    if (!MHResourceRegisterProvider(map_package_resource_provider,1000,"active .mhproject package")) {
        api->log("MH Maps Menu: could not register package resource provider");
        return 0;
    }
    if (!MHResourceRegisterTerrainProvider(map_package_terrain_provider,1000,"active .mhproject terrain")) {
        api->log("MH Maps Menu: could not register package terrain provider");
        return 0;
    }

    if (!MHResourceRegisterBitmapProvider(map_package_bitmap_provider,1000,"active .mhproject briefing bitmap")) {
        api->log("MH Maps Menu: could not register package bitmap provider");
        return 0;
    }

    if (!api->install_detour(MH_LEVEL_ASSET_LOAD,level_expected,5,(void *)&level_asset_load_hook,&level_tramp)) {
        api->log("MH Maps Menu: level asset loader hook signature mismatch");
        return 0;
    }
    g_original_level_asset_load=(PFN_LevelAssetLoad)(void *)level_tramp;

    if (!api->install_detour(MH_MENU_RENDER_INIT,menu_expected,5,(void *)&menu_render_hook,&menu_tramp)) {
        api->log("MH Maps Menu: menu renderer hook signature mismatch");
        return 0;
    }
    g_original_menu_render=(PFN_MenuRenderInit)(void *)menu_tramp;

    if (!api->install_detour(MH_MENU_SELECTOR,selector_expected,5,(void *)&menu_selector_hook,&selector_tramp)) {
        api->log("MH Maps Menu: menu selector hook signature mismatch");
        return 0;
    }
    g_original_menu_selector=(PFN_MenuSelector)(void *)selector_tramp;

    if (!api->register_frame_callback(&custom_level_frame)) {
        api->log("MH Maps Menu: could not register custom-level frame callback");
        return 0;
    }

    if (!guard_hud_percentage(api))
        api->log("MH Maps: HUD percentage guard not installed; custom maps on six themes may crash");

    clear_override();
    g_maps_confirm_armed=0;
    g_maps_confirm_neutral_seen=0;
    autostart_init(api);
    api->log("MH Maps: .mhproject loader initialized");
    api->log("MH Maps: current projects still inherit a retail base resource set");
    api->log("MH Maps Menu: scanning mods\\<id>\\maps\\*.mhproject");
    return 1;
}

