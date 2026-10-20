#include "mh_host.h"
#include "mh.h"
#include "MHAPI.h"
#include "MHModLoader.h"
#include "MHScriptHost.h"
#include "MHPackageRegistry.h"
#include "MHSoundSystem.h"
#include "MHOptions.h"
#include "MHGameSystems.h"

/*
 * Machine Hunter runtime: the mod loader.
 *
 * A CRT-free 32-bit DLL the patched retail executable loads at startup. This
 * file is the host: the log, guarded memory access, detours, key state and
 * the once-per-frame hook. Everything a player would call a feature lives in
 * a mod under mods\; the runtime only provides the services they share.
 */

typedef mh_u8 u8;
typedef mh_u16 u16;
typedef mh_u32 u32;
typedef mh_i32 i32;
typedef void *PVOID;
typedef void *HANDLE;
typedef void *HMODULE;
typedef int BOOL;

#define STDCALL __stdcall
#define EXPORT __declspec(dllexport)
#define INVALID_HANDLE_VALUE ((HANDLE)(i32)-1)
#define MAX_PATH_ 260

#define GENERIC_WRITE_          0x40000000u
#define GENERIC_READ_           0x80000000u
#define FILE_SHARE_READ_        0x00000001u
#define CREATE_ALWAYS_          2u
#define OPEN_EXISTING_          3u
#define FILE_ATTRIBUTE_NORMAL_  0x00000080u
#define PAGE_EXECUTE_READWRITE_ 0x40u
#define MEM_COMMIT_             0x1000u
#define MEM_RESERVE_             0x2000u
#define ATTACH_PARENT_PROCESS_   0xffffffffu
#define STD_OUTPUT_HANDLE_       0xfffffff5u
#define STD_INPUT_HANDLE_        0xfffffff6u

#define MH_GAME_BASE 0x00400000u
#define MH_PRESENT_WINDOWED 0x00439640u
#define MH_MAX_DETOURS 160u
#define MH_ACTOR_POOL_BASE  0x006203D8u
#define MH_ACTOR_STRIDE     0x000002B4u
#define MH_ACTOR_CAPACITY   0x00000030u
#define MH_ACTOR_ACTIVE_OFF 0x00000058u
#define MH_ACTOR_FLAGS_OFF  0x00000098u
#define MH_ACTOR_PLAYER_BIT 0x80000000u

/* Original executable IAT slots, proven from the supplied retail EXE. */
#define MH_IAT_GETPROCADDRESS  0x0074A59Cu
#define MH_IAT_LOADLIBRARYA    0x0074A5A0u
#define MH_IAT_GETMODULEHANDLE 0x0074A650u

typedef HMODULE (STDCALL *PFN_LoadLibraryA)(const char *);
typedef PVOID   (STDCALL *PFN_GetProcAddress)(HMODULE, const char *);
typedef HMODULE (STDCALL *PFN_GetModuleHandleA)(const char *);

typedef BOOL (STDCALL *PFN_CreateDirectoryA)(const char *, PVOID);
typedef HANDLE (STDCALL *PFN_CreateFileA)(const char *, u32, u32, PVOID, u32, u32, HANDLE);
typedef BOOL (STDCALL *PFN_WriteFile)(HANDLE, const void *, u32, u32 *, PVOID);
typedef BOOL (STDCALL *PFN_ReadFile)(HANDLE, void *, u32, u32 *, PVOID);
typedef u32  (STDCALL *PFN_GetFileSize)(HANDLE, u32 *);
typedef u32  (STDCALL *PFN_GetTickCount)(void);
typedef u32  (STDCALL *PFN_GetModuleFileNameA)(HMODULE, char *, u32);
typedef BOOL (STDCALL *PFN_AttachConsole)(u32);
typedef HANDLE (STDCALL *PFN_GetStdHandle)(u32);
typedef u32 (STDCALL *PFN_ThreadProc)(PVOID);
typedef HANDLE (STDCALL *PFN_CreateThread)(PVOID, u32, PFN_ThreadProc, PVOID, u32, u32 *);
typedef void (STDCALL *PFN_Sleep)(u32);
typedef BOOL (STDCALL *PFN_CloseHandle)(HANDLE);
typedef HANDLE (STDCALL *PFN_FindFirstFileA)(const char *, void *);
typedef BOOL (STDCALL *PFN_FindNextFileA)(HANDLE, void *);
typedef BOOL (STDCALL *PFN_FindClose)(HANDLE);
typedef struct MEMORY_BASIC_INFORMATION_ {
    PVOID BaseAddress;
    PVOID AllocationBase;
    u32 AllocationProtect;
    u32 RegionSize;
    u32 State;
    u32 Protect;
    u32 Type;
} MEMORY_BASIC_INFORMATION_;
typedef BOOL (STDCALL *PFN_VirtualProtect)(PVOID, u32, u32, u32 *);
typedef PVOID (STDCALL *PFN_VirtualAlloc)(PVOID, u32, u32, u32);
typedef u32 (STDCALL *PFN_VirtualQuery)(const void *, MEMORY_BASIC_INFORMATION_ *, u32);
typedef BOOL (STDCALL *PFN_FlushInstructionCache)(HANDLE, const void *, u32);
typedef HANDLE (STDCALL *PFN_GetCurrentProcess)(void);
typedef short (STDCALL *PFN_GetAsyncKeyState)(int);
typedef int (STDCALL *PFN_MessageBoxA)(PVOID, const char *, const char *, u32);

typedef struct FILETIME_ { u32 lo, hi; } FILETIME_;
typedef struct WIN32_FIND_DATAA_ {
    u32 dwFileAttributes;
    FILETIME_ ftCreationTime;
    FILETIME_ ftLastAccessTime;
    FILETIME_ ftLastWriteTime;
    u32 nFileSizeHigh;
    u32 nFileSizeLow;
    u32 dwReserved0;
    u32 dwReserved1;
    char cFileName[MAX_PATH_];
    char cAlternateFileName[14];
} WIN32_FIND_DATAA_;

typedef void (__cdecl *PFN_Present)(void);

static PFN_LoadLibraryA pLoadLibraryA;
static PFN_GetProcAddress pGetProcAddress;
static PFN_GetModuleHandleA pGetModuleHandleA;
static PFN_CreateDirectoryA pCreateDirectoryA;
static PFN_CreateFileA pCreateFileA;
static PFN_WriteFile pWriteFile;
static PFN_ReadFile pReadFile;
static PFN_GetFileSize pGetFileSize;
static PFN_GetTickCount pGetTickCount;
static PFN_GetModuleFileNameA pGetModuleFileNameA;
static PFN_AttachConsole pAttachConsole;
static PFN_GetStdHandle pGetStdHandle;
static PFN_CreateThread pCreateThread;
static PFN_Sleep pSleep;
static PFN_CloseHandle pCloseHandle;
static PFN_FindFirstFileA pFindFirstFileA;
static PFN_FindNextFileA pFindNextFileA;
static PFN_FindClose pFindClose;
static PFN_VirtualProtect pVirtualProtect;
static PFN_VirtualAlloc pVirtualAlloc;
static PFN_VirtualQuery pVirtualQuery;
static PFN_FlushInstructionCache pFlushInstructionCache;
static PFN_GetCurrentProcess pGetCurrentProcess;
static PFN_GetAsyncKeyState pGetAsyncKeyState;
static PFN_MessageBoxA pMessageBoxA;

static HANDLE g_log = (HANDLE)0;
static HANDLE g_console_out = (HANDLE)0;
static MHHostFrameCallback g_frame_callbacks[32];
static u32 g_frame_callback_count = 0;
static u32 g_frame_count = 0;
static u8 g_key_now[256];
static u8 g_key_prev[256];
static PFN_Present g_original_present = (PFN_Present)0;

/* Every detour is remembered so a second mod can hook the same function and
   so a byte patch can still reach code that has been moved to a trampoline. */
typedef struct MHDetour {
    u32 address;
    u32 length;
    u8 original[32];
    u8 *trampoline;
    void *hook;
    int relocated;
} MHDetour;

static MHDetour g_detours[MH_MAX_DETOURS];
static u32 g_detour_count = 0;

static int streq(const char *a, const char *b)
{
    if (!a || !b) return 0;
    while (*a && *b) {
        if (*a != *b) return 0;
        ++a; ++b;
    }
    return *a == *b;
}

static u32 slen(const char *s)
{
    u32 n = 0;
    if (!s) return 0;
    while (s[n]) ++n;
    return n;
}

static void copy_bytes(void *dst, const void *src, u32 n)
{
    u8 *d = (u8 *)dst;
    const u8 *s = (const u8 *)src;
    u32 i;
    for (i = 0; i < n; ++i) d[i] = s[i];
}

static int bytes_equal(const u8 *a, const u8 *b, u32 n)
{
    u32 i;
    for (i = 0; i < n; ++i) if (a[i] != b[i]) return 0;
    return 1;
}



static void STDCALL mh_log(const char *text)
{
    u32 wrote = 0;
    static const char nl[] = "\r\n";
    if (!pWriteFile || !text) return;
    if (g_log && g_log != INVALID_HANDLE_VALUE) {
        pWriteFile(g_log, text, slen(text), &wrote, (PVOID)0);
        pWriteFile(g_log, nl, 2, &wrote, (PVOID)0);
    }
    if (g_console_out && g_console_out != INVALID_HANDLE_VALUE && g_console_out != g_log) {
        pWriteFile(g_console_out, text, slen(text), &wrote, (PVOID)0);
        pWriteFile(g_console_out, nl, 2, &wrote, (PVOID)0);
    }
}


static u32 STDCALL mh_symbol(const char *name)
{
    /* Stable names for proven executable/global addresses. */
    if (streq(name, "window.hwnd"))                  return 0x0067ACECu;
    if (streq(name, "video.fullscreen"))             return 0x0067ACFCu;
    if (streq(name, "video.width"))                  return 0x0048BD40u;
    if (streq(name, "video.height"))                 return 0x0048BD44u;
    if (streq(name, "video.bitmapinfo_ptr"))         return 0x0065A358u;
    if (streq(name, "video.framebuffer_ptr"))        return 0x0065CC84u;
    if (streq(name, "video.present_windowed"))       return 0x00439640u;
    if (streq(name, "render.shading_mode"))           return 0x0048A38Cu;
    if (streq(name, "render.colour_add"))             return 0x0048A390u;
    if (streq(name, "render.lighting_bias"))          return 0x0067B8C0u;
    if (streq(name, "render.raster.off"))             return 0x004309C0u;
    if (streq(name, "render.raster.average"))         return 0x00432110u;
    if (streq(name, "render.raster.gouraud"))         return 0x0042FC80u;
    if (streq(name, "render.shading.average_level"))  return 0x0062C3C4u;
    if (streq(name, "render.shading.gouraud_v0"))     return 0x0062C320u;
    if (streq(name, "render.shading.gouraud_v1"))     return 0x0062C334u;
    if (streq(name, "render.shading.gouraud_v2"))     return 0x0062C348u;
    if (streq(name, "render.shading.gouraud_v3"))     return 0x0062C35Cu;
    if (streq(name, "audio.sound_enabled"))          return 0x006B1014u;
    if (streq(name, "audio.music_backend"))          return 0x0048A0F0u;
    if (streq(name, "cd.state"))                     return 0x0069A850u;
    if (streq(name, "cd.cdaudio_enabled"))           return 0x0047C098u;
    if (streq(name, "archive.file"))                 return 0x00630B00u;
    if (streq(name, "archive.count"))                return 0x00630B04u;
    if (streq(name, "archive.entries"))              return 0x0062CB10u;
    if (streq(name, "input.raw_bits"))               return 0x006BB958u;
    if (streq(name, "input.current_bits"))           return 0x006BB8E4u;
    if (streq(name, "input.previous_bits"))          return 0x006BB940u;
    if (streq(name, "input.keydown_map"))            return 0x0043A43Cu;
    if (streq(name, "input.keyup_map"))              return 0x0043A510u;
    if (streq(name, "menu.main_init"))                return 0x0042C740u;
    if (streq(name, "menu.render_init"))              return 0x0040C050u;
    if (streq(name, "menu.state_table"))              return 0x0048B6E8u;
    if (streq(name, "menu.current_state"))            return 0x0062A09Cu;
    if (streq(name, "menu.current_base"))             return 0x0062A0F4u;
    if (streq(name, "menu.selection"))                return 0x0048A3ACu;
    if (streq(name, "menu.record_count"))             return 0x0048A3B4u;
    if (streq(name, "menu.state_aux_table"))          return 0x0062A228u;
    if (streq(name, "menu.cheats_builder"))           return 0x0042BFE0u;
    if (streq(name, "menu.control_builder"))          return 0x0042C500u;

    /* Resolved Win32 functions used only by built-in runtime subsystems. */
    if (streq(name, "win32.load_library_a"))           return (u32)(PVOID)pLoadLibraryA;
    if (streq(name, "win32.get_proc_address"))          return (u32)(PVOID)pGetProcAddress;
    if (streq(name, "win32.create_file_a"))            return (u32)(PVOID)pCreateFileA;
    if (streq(name, "win32.write_file"))               return (u32)(PVOID)pWriteFile;
    if (streq(name, "win32.read_file"))                return (u32)(PVOID)pReadFile;
    if (streq(name, "win32.get_file_size"))            return (u32)(PVOID)pGetFileSize;
    if (streq(name, "win32.get_tick_count"))           return (u32)(PVOID)pGetTickCount;
    if (streq(name, "win32.close_handle"))             return (u32)(PVOID)pCloseHandle;
    if (streq(name, "user32.message_box_a"))           return (u32)(PVOID)pMessageBoxA;
    if (streq(name, "win32.find_first_file_a"))        return (u32)(PVOID)pFindFirstFileA;
    if (streq(name, "win32.find_next_file_a"))         return (u32)(PVOID)pFindNextFileA;
    if (streq(name, "win32.find_close"))               return (u32)(PVOID)pFindClose;

    /* Gameplay facts recovered directly from executable references. */
    /* 0x006285B8 is the original actor-update iteration cursor. */
    if (streq(name, "gameplay.current_actor_cursor")) return 0x006285B8u;
    if (streq(name, "gameplay.actor_pool"))           return MH_ACTOR_POOL_BASE;
    if (streq(name, "gameplay.actor_update_all"))     return 0x00426A60u;
    if (streq(name, "gameplay.damage_raw"))           return 0x00428D60u;
    if (streq(name, "gameplay.apply_damage"))         return 0x00428E30u;
    if (streq(name, "gameplay.fire_attempt"))          return 0x00413290u;
    if (streq(name, "gameplay.weapon_resource_update")) return 0x004118A0u;
    if (streq(name, "gameplay.weapon_spawn_dispatch")) return 0x0044A140u;
    if (streq(name, "weapon.profile_table"))           return 0x0047CFE0u;
    if (streq(name, "cheat.hacker"))                  return 0x0062A0C0u;
    if (streq(name, "cheat.grimreaper"))              return 0x0062A0D8u;
    if (streq(name, "cheat.invincible"))              return 0x0062A0DCu;
    if (streq(name, "cheat.no_mission"))              return 0x0062A0E0u;
    if (streq(name, "cheat.unlimited_ammo"))          return 0x0062A0E4u;
    if (streq(name, "cheat.lazyplayer"))              return 0x0062A0E8u;
    if (streq(name, "cheat.get_sacked"))              return 0x0062A0ECu;
    if (streq(name, "cheat.demodroids"))              return 0x0062A0F0u;
    return 0;
}

static u32 STDCALL mh_constant(const char *name)
{
    /* Structure offsets are separated from symbols so mods do not confuse an
       offset with an absolute address. */
    if (streq(name, "actor.pool.stride"))              return MH_ACTOR_STRIDE;
    if (streq(name, "actor.pool.capacity"))            return MH_ACTOR_CAPACITY;
    if (streq(name, "actor.active.offset"))            return MH_ACTOR_ACTIVE_OFF;
    if (streq(name, "actor.flags.offset"))             return MH_ACTOR_FLAGS_OFF;
    if (streq(name, "actor.health.offset"))            return 0x00000234u;
    if (streq(name, "actor.guard.offset"))             return 0x00000230u;
    if (streq(name, "actor.inventory_ptr.offset"))     return 0x00000248u;
    if (streq(name, "actor.player_flag"))              return MH_ACTOR_PLAYER_BIT;
    if (streq(name, "actor.position_x.offset"))         return 0x00000000u;
    if (streq(name, "actor.position_y.offset"))         return 0x00000004u;
    if (streq(name, "actor.position_z.offset"))         return 0x00000008u;
    if (streq(name, "actor.facing_angle.offset"))       return 0x0000000Eu;
    if (streq(name, "actor.weapon_event_counter.offset")) return 0x00000254u;
    if (streq(name, "actor.aim_angle.offset"))          return 0x00000270u;
    if (streq(name, "actor.weapon_timer_a.offset"))     return 0x00000274u;
    if (streq(name, "actor.weapon_timer_b.offset"))     return 0x00000278u;
    if (streq(name, "actor.weapon_recent_fire.offset")) return 0x00000280u;
    if (streq(name, "actor.active.type_mask"))          return 0x0000000Fu;
    if (streq(name, "inventory.selected_weapon.offset")) return 0x0000001Cu;
    if (streq(name, "inventory.ammo_base.offset"))     return 0x00000010u;
    if (streq(name, "weapon.count"))                    return 0x00000003u;
    if (streq(name, "weapon.profile.stride"))           return 0x00000070u;
    if (streq(name, "weapon.profile.fire_interval_base.offset")) return 0x00000020u;
    if (streq(name, "weapon.profile.timer_a_initial_base.offset")) return 0x0000002Cu;
    if (streq(name, "weapon.profile.timer_a_repeat_base.offset")) return 0x00000038u;
    if (streq(name, "weapon.profile.resource_cost_base.offset")) return 0x0000004Cu;
    if (streq(name, "weapon.profile.callback.offset"))  return 0x0000005Cu;
    if (streq(name, "menu.descriptor.size"))           return 0x00000034u;
    if (streq(name, "state.snapshot.base"))            return 0x00477000u;
    if (streq(name, "state.snapshot.size"))            return 0x002D3000u;
    return 0;
}

static int readable_range(u32 address, u32 size)
{
    MEMORY_BASIC_INFORMATION_ mbi;
    u32 cur, end, region_end;
    if (!address || !size || !pVirtualQuery) return 0;
    end = address + size;
    if (end < address) return 0;
    cur = address;
    while (cur < end) {
        if (!pVirtualQuery((const void *)cur, &mbi, sizeof(mbi))) return 0;
        if (mbi.State != MEM_COMMIT_) return 0;
        if (mbi.Protect == 0 || (mbi.Protect & 0x01u) || (mbi.Protect & 0x100u)) return 0; /* NOACCESS/GUARD */
        region_end = (u32)mbi.BaseAddress + mbi.RegionSize;
        if (region_end <= cur) return 0;
        cur = region_end < end ? region_end : end;
    }
    return 1;
}

static int STDCALL mh_read_memory(u32 address, void *out, u32 size)
{
    if (!address || !out || !size || !readable_range(address,size)) return 0;
    copy_bytes(out, (const void *)address, size);
    return 1;
}

static int STDCALL mh_write_memory(u32 address, const void *data, u32 size)
{
    u32 old_protect = 0, ignored = 0;
    HANDLE proc;
    if (!address || !data || !size || !pVirtualProtect) return 0;
    if (!pVirtualProtect((PVOID)address, size, PAGE_EXECUTE_READWRITE_, &old_protect)) return 0;
    copy_bytes((void *)address, data, size);
    if (pFlushInstructionCache && pGetCurrentProcess) {
        proc = pGetCurrentProcess();
        pFlushInstructionCache(proc, (const void *)address, size);
    }
    pVirtualProtect((PVOID)address, size, old_protect, &ignored);
    return 1;
}

static int STDCALL mh_make_directory(const char *path)
{
    if (!path || !*path || !pCreateDirectoryA) return 0;
    /* Existing directory and successful creation are both acceptable for the
       mod SDK's use; callers only need a best-effort stable destination. */
    pCreateDirectoryA(path, (PVOID)0);
    return 1;
}

static int STDCALL mh_dump_memory(const char *path, u32 address, u32 size)
{
    HANDLE h;
    u32 wrote = 0;
    if (!path || !*path || !address || !size || !pCreateFileA || !pWriteFile || !pCloseHandle) return 0;
    if (!readable_range(address,size)) return 0;
    h = pCreateFileA(path, GENERIC_WRITE_, FILE_SHARE_READ_, (PVOID)0,
                     CREATE_ALWAYS_, FILE_ATTRIBUTE_NORMAL_, (HANDLE)0);
    if (!h || h == INVALID_HANDLE_VALUE) return 0;
    if (!pWriteFile(h, (const void *)address, size, &wrote, (PVOID)0) || wrote != size) {
        pCloseHandle(h);
        return 0;
    }
    pCloseHandle(h);
    return 1;
}

static MHDetour *detour_at(u32 address)
{
    u32 i;
    for (i = 0; i < g_detour_count; ++i)
        if (address >= g_detours[i].address && address < g_detours[i].address + g_detours[i].length) return &g_detours[i];
    return (MHDetour *)0;
}

/*
 * Redirect the code at `address` to `replacement`. `expected` is the retail
 * bytes being displaced; nothing is written unless they match.
 *
 * The displaced bytes move to a trampoline that jumps back, and its address
 * is returned as the way to call the original. If the address is already
 * detoured the new hook goes in front and is handed the previous hook as its
 * "original", so any number of mods can share a function. A displaced
 * `jmp rel32` (the executable's incremental-link thunks) is re-aimed so its
 * trampoline works; other displaced bytes must not be position dependent.
 */
static int STDCALL mh_install_detour(u32 address, const void *expected, u32 stolen_len,
                                     void *replacement, u32 *trampoline_out)
{
    const u8 *exp = (const u8 *)expected;
    MHDetour *d;
    u8 *tramp;
    u8 patch[32];
    u8 original[32];
    i32 rel;
    u32 i;

    if (!address || !exp || !replacement || !trampoline_out || !pVirtualAlloc) return 0;
    if (stolen_len < 5u || stolen_len > 32u) return 0;

    d = detour_at(address);
    if (d) {
        u32 common = stolen_len < d->length ? stolen_len : d->length;
        if (d->address != address || !bytes_equal(d->original, exp, common)) return 0;
        patch[0] = 0xE9;
        rel = (i32)((u32)(PVOID)replacement - (address + 5u));
        copy_bytes(patch + 1u, &rel, 4);
        if (!mh_write_memory(address, patch, 5u)) return 0;
        *trampoline_out = (u32)(PVOID)d->hook;
        d->hook = replacement;
        return 1;
    }
    for (i = 0; i < g_detour_count; ++i)
        if (g_detours[i].address < address + stolen_len && address < g_detours[i].address + g_detours[i].length) return 0;
    if (g_detour_count >= MH_MAX_DETOURS) return 0;

    if (!mh_read_memory(address, original, stolen_len)) return 0;
    if (!bytes_equal(original, exp, stolen_len)) return 0;

    tramp = (u8 *)pVirtualAlloc((PVOID)0, stolen_len + 5u,
                                MEM_COMMIT_ | MEM_RESERVE_, PAGE_EXECUTE_READWRITE_);
    if (!tramp) return 0;
    copy_bytes(tramp, original, stolen_len);
    tramp[stolen_len] = 0xE9;
    rel = (i32)((address + stolen_len) - ((u32)tramp + stolen_len + 5u));
    copy_bytes(tramp + stolen_len + 1u, &rel, 4);

    d = &g_detours[g_detour_count];
    d->relocated = 0;
    if (stolen_len == 5u && original[0] == 0xE9) {
        copy_bytes(&rel, original + 1u, 4);
        rel = (i32)((address + 5u + (u32)rel) - ((u32)tramp + 5u));
        copy_bytes(tramp + 1u, &rel, 4);
        d->relocated = 1;
    }

    patch[0] = 0xE9;
    rel = (i32)((u32)(PVOID)replacement - (address + 5u));
    copy_bytes(patch + 1u, &rel, 4);
    for (i = 5u; i < stolen_len; ++i) patch[i] = 0x90;
    if (!mh_write_memory(address, patch, stolen_len)) return 0;

    d->address = address;
    d->length = stolen_len;
    copy_bytes(d->original, original, stolen_len);
    d->trampoline = tramp;
    d->hook = replacement;
    ++g_detour_count;
    *trampoline_out = (u32)tramp;
    return 1;
}

/* Where the byte that belongs at `address` lives now: in a trampoline if that code was detoured. */
static u8 *patch_location(u32 address)
{
    MHDetour *d = detour_at(address);
    if (!d) return (u8 *)address;
    if (d->relocated) return (u8 *)0;
    return d->trampoline + (address - d->address);
}

/* Replace `size` bytes at `address` after checking that they are `expected`. */
static int STDCALL mh_patch(u32 address, const void *expected, const void *replacement, u32 size)
{
    const u8 *exp = (const u8 *)expected;
    const u8 *rep = (const u8 *)replacement;
    u32 i;
    if (!address || !exp || !rep || !size || size > 64u || !readable_range(address, size)) return 0;
    for (i = 0; i < size; ++i) {
        const u8 *at = patch_location(address + i);
        if (!at || *at != exp[i]) return 0;
    }
    for (i = 0; i < size; ++i) {
        u8 *at = patch_location(address + i);
        if (at == (u8 *)(address + i)) {
            if (!mh_write_memory(address + i, rep + i, 1u)) return 0;
        } else {
            *at = rep[i];
        }
    }
    return 1;
}

static u32 STDCALL mh_time(void) { return pGetTickCount ? pGetTickCount() : 0u; }

static u32 STDCALL mh_actor_address(u32 index)
{
    if (index >= MH_ACTOR_CAPACITY) return 0;
    return MH_ACTOR_POOL_BASE + index * MH_ACTOR_STRIDE;
}

static u32 STDCALL mh_find_player_actor(void)
{
    u32 i, addr, active, flags;
    for (i = 0; i < MH_ACTOR_CAPACITY; ++i) {
        addr = mh_actor_address(i);
        active = 0; flags = 0;
        if (!mh_read_memory(addr + MH_ACTOR_ACTIVE_OFF, &active, 4)) continue;
        if (!active) continue;
        if (!mh_read_memory(addr + MH_ACTOR_FLAGS_OFF, &flags, 4)) continue;
        if (flags & MH_ACTOR_PLAYER_BIT) return addr;
    }
    return 0;
}

static int STDCALL mh_register_frame_callback(MHHostFrameCallback cb)
{
    if (!cb || g_frame_callback_count >= 32) return 0;
    g_frame_callbacks[g_frame_callback_count++] = cb;
    return 1;
}

static u32 STDCALL mh_frame_count_api(void) { return g_frame_count; }
static int STDCALL mh_key_down(int vk) {
    if (vk < 0 || vk > 255) return 0;
    return g_key_now[vk] != 0;
}
static int STDCALL mh_key_pressed(int vk) {
    if (vk < 0 || vk > 255) return 0;
    return g_key_now[vk] && !g_key_prev[vk];
}

static MHHostAPI g_host = {
    mh_log, mh_symbol, mh_read_memory, mh_write_memory,
    mh_register_frame_callback, mh_frame_count_api, mh_key_down, mh_key_pressed,
    mh_constant, mh_make_directory, mh_dump_memory, mh_install_detour,
    mh_actor_address, mh_find_player_actor,
    mh_patch, mh_time
};

static void update_keys(void)
{
    int i;
    if (!pGetAsyncKeyState) return;
    for (i = 0; i < 256; ++i) {
        g_key_prev[i] = g_key_now[i];
        g_key_now[i] = ((unsigned short)pGetAsyncKeyState(i) & 0x8000u) ? 1 : 0;
    }
}



/* Once per frame, just before the game shows it: keys, subsystems, then mods draw on top. */
static void __cdecl mh_present_hook(void)
{
    u32 i;
    ++g_frame_count;
    update_keys();
    for (i = 0; i < g_frame_callback_count; ++i) {
        if (g_frame_callbacks[i]) g_frame_callbacks[i](&g_host);
    }
    MHDrawFrame();
    MHInputEndFrame();
    if (g_original_present) g_original_present();
}

static int install_present_hook(void)
{
    static const u8 expected[5] = {0xA1, 0x58, 0xA3, 0x65, 0x00};
    u32 tramp = 0;
    if (!mh_install_detour(MH_PRESENT_WINDOWED, expected, 5,
                           (PVOID)&mh_present_hook, &tramp)) return 0;
    g_original_present = (PFN_Present)tramp;
    return 1;
}

static int resolve_win32(void)
{
    HMODULE k32, user32;
    pLoadLibraryA = *(PFN_LoadLibraryA *)MH_IAT_LOADLIBRARYA;
    pGetProcAddress = *(PFN_GetProcAddress *)MH_IAT_GETPROCADDRESS;
    pGetModuleHandleA = *(PFN_GetModuleHandleA *)MH_IAT_GETMODULEHANDLE;
    if (!pLoadLibraryA || !pGetProcAddress || !pGetModuleHandleA) return 0;

    k32 = pGetModuleHandleA("kernel32.dll");
    if (!k32) return 0;
    pCreateDirectoryA = (PFN_CreateDirectoryA)pGetProcAddress(k32, "CreateDirectoryA");
    pCreateFileA = (PFN_CreateFileA)pGetProcAddress(k32, "CreateFileA");
    pWriteFile = (PFN_WriteFile)pGetProcAddress(k32, "WriteFile");
    pReadFile = (PFN_ReadFile)pGetProcAddress(k32, "ReadFile");
    pGetFileSize = (PFN_GetFileSize)pGetProcAddress(k32, "GetFileSize");
    pGetTickCount = (PFN_GetTickCount)pGetProcAddress(k32, "GetTickCount");
    pGetModuleFileNameA = (PFN_GetModuleFileNameA)pGetProcAddress(k32, "GetModuleFileNameA");
    pAttachConsole = (PFN_AttachConsole)pGetProcAddress(k32, "AttachConsole");
    pGetStdHandle = (PFN_GetStdHandle)pGetProcAddress(k32, "GetStdHandle");
    pCreateThread = (PFN_CreateThread)pGetProcAddress(k32, "CreateThread");
    pSleep = (PFN_Sleep)pGetProcAddress(k32, "Sleep");
    pCloseHandle = (PFN_CloseHandle)pGetProcAddress(k32, "CloseHandle");
    pFindFirstFileA = (PFN_FindFirstFileA)pGetProcAddress(k32, "FindFirstFileA");
    pFindNextFileA = (PFN_FindNextFileA)pGetProcAddress(k32, "FindNextFileA");
    pFindClose = (PFN_FindClose)pGetProcAddress(k32, "FindClose");
    pVirtualProtect = (PFN_VirtualProtect)pGetProcAddress(k32, "VirtualProtect");
    pVirtualAlloc = (PFN_VirtualAlloc)pGetProcAddress(k32, "VirtualAlloc");
    pVirtualQuery = (PFN_VirtualQuery)pGetProcAddress(k32, "VirtualQuery");
    pFlushInstructionCache = (PFN_FlushInstructionCache)pGetProcAddress(k32, "FlushInstructionCache");
    pGetCurrentProcess = (PFN_GetCurrentProcess)pGetProcAddress(k32, "GetCurrentProcess");

    user32 = pGetModuleHandleA("user32.dll");
    if (!user32) user32 = pLoadLibraryA("user32.dll");
    if (user32) {
        pGetAsyncKeyState = (PFN_GetAsyncKeyState)pGetProcAddress(user32, "GetAsyncKeyState");
        pMessageBoxA = (PFN_MessageBoxA)pGetProcAddress(user32, "MessageBoxA");
    }

    return pCreateDirectoryA && pCreateFileA && pWriteFile && pReadFile && pGetFileSize && pCloseHandle && pGetModuleFileNameA && pFindFirstFileA &&
           pFindNextFileA && pFindClose && pVirtualProtect && pVirtualAlloc && pVirtualQuery && pGetTickCount;
}


int MH_STDCALL MHMapsMenuSubsystemInit(const MHHostAPI *host);
int MH_STDCALL MHResourceSystemInit(const MHHostAPI *host);

static int runtime_api_self_check(const MHAPI *api)
{
    u32 level,ambient_total=0u;
    if(!api||api->api_version!=MH_API_VERSION){mh_log("[SELFTEST FAIL] public API version");return 0;}
    if(!api->runtime.log||!api->runtime.frame||!api->runtime.subscribe||!api->runtime.unsubscribe){mh_log("[SELFTEST FAIL] runtime service");return 0;}
    if(!api->game.state||!api->map.cell_get||!api->map.entity_cell||!api->entities.get||!api->entities.player){mh_log("[SELFTEST FAIL] gameplay services");return 0;}
    if(!api->sound.retail_count||!api->sound.load_wav||!api->resources.find||!api->catalog.entity_count){mh_log("[SELFTEST FAIL] asset services");return 0;}
    if(!api->options.find||!api->options.info||!api->draw.text||!api->camera.get||!api->engine.detour){mh_log("[SELFTEST FAIL] mod services");return 0;}
    if(api->entities.capacity()!=MH_ACTOR_CAPACITY){mh_log("[SELFTEST FAIL] actor capacity invariant");return 0;}
    if(api->catalog.entity_count()!=115u){mh_log("[SELFTEST FAIL] entity catalog invariant");return 0;}
    if(api->catalog.stage_count()!=25u){mh_log("[SELFTEST FAIL] stage catalog invariant");return 0;}
    if(api->sound.retail_count()!=461u){mh_log("[SELFTEST FAIL] retail sound catalog invariant");return 0;}
    for(level=0u;level<api->catalog.stage_count();++level)ambient_total+=api->catalog.ambient_profile_count(level);
    if(ambient_total!=115u){mh_log("[SELFTEST FAIL] ambient profile catalog invariant");return 0;}
    mh_log("[SELFTEST PASS] API 5 static runtime invariants");
    return 1;
}

EXPORT int STDCALL MHRuntimeInit(void)
{
    if (!resolve_win32()) return 0;
    if (pAttachConsole) pAttachConsole(ATTACH_PARENT_PROCESS_);
    if (pGetStdHandle) g_console_out = pGetStdHandle(STD_OUTPUT_HANDLE_);
    pCreateDirectoryA("mods", (PVOID)0);
    pCreateDirectoryA("logs", (PVOID)0);
    g_log = pCreateFileA("logs\\mh-runtime.log", GENERIC_WRITE_, FILE_SHARE_READ_, (PVOID)0,
                        CREATE_ALWAYS_, FILE_ATTRIBUTE_NORMAL_, (HANDLE)0);
    mh_log("Machine Hunter runtime / mod loader");
    mh_log("Target: retail Windows Machine Hunter executable");

    if (!install_present_hook()) {
        mh_log("Runtime initialization failed: frame hook signature mismatch or Win32 allocation failure");
        return 0;
    }
    mh_log("Frame hook installed at original windowed present routine 0x00439640");

    if (!MHOptionsInit(&g_host)) {
        mh_log("Runtime initialization failed: mod settings");
        return 0;
    }
    if (!MHPackageRegistryInit(&g_host)) {
        mh_log("Runtime initialization failed: package registry");
        return 0;
    }
    if (!MHResourceSystemInit(&g_host)) {
        mh_log("Runtime initialization failed: resource system");
        return 0;
    }
    if (!MHSoundSystemInit(&g_host)) {
        mh_log("Runtime initialization failed: sound system");
        return 0;
    }
    if (!MHMapsMenuSubsystemInit(&g_host)) {
        mh_log("Runtime initialization failed: MAP subsystem");
        return 0;
    }
    if (!MHGameSystemsInit(&g_host)) {
        mh_log("Runtime initialization failed: camera, input and startup services");
        return 0;
    }
    if (!MHAPIInit(&g_host)) {
        mh_log("Runtime initialization failed: public MH API");
        return 0;
    }
    if (!runtime_api_self_check(MHAPIGet())) {
        mh_log("Runtime initialization failed: API self-check");
        return 0;
    }
    if (!MHScriptHostInit(&g_host, MHAPIGet())) {
        mh_log("Runtime initialization failed: script host");
        return 0;
    }
    if (!MHModLoaderInit(&g_host, MHAPIGet())) {
        mh_log("Runtime initialization failed: mod loader");
        return 0;
    }

    MHAPIDispatchRuntimeReady();
    mh_log("Machine Hunter runtime initialized");
    return 1;
}

BOOL STDCALL DllMain(HMODULE module, u32 reason, PVOID reserved)
{
    (void)module; (void)reason; (void)reserved;
    return 1;
}
