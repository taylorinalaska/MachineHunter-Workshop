#ifndef MH_HOST_H
#define MH_HOST_H

/*
 * Internal Machine Hunter runtime host interface, used by the runtime's own
 * subsystems. Mods do not see this header: they get the public MHAPI from
 * mh.h, whose `engine` member offers the same memory and detour services.
 */

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_MSC_VER) || defined(__clang__)
#define MH_STDCALL __stdcall
#define MH_EXPORT __declspec(dllexport)
#else
#define MH_STDCALL
#define MH_EXPORT
#endif

typedef unsigned char  mh_u8;
typedef unsigned short mh_u16;
typedef unsigned long  mh_u32;
typedef signed long    mh_i32;


typedef struct MHHostAPI MHHostAPI;
typedef void (MH_STDCALL *MHHostFrameCallback)(const MHHostAPI *host);

struct MHHostAPI {
    void   (MH_STDCALL *log)(const char *text);
    mh_u32 (MH_STDCALL *symbol)(const char *name);
    int    (MH_STDCALL *read_memory)(mh_u32 address, void *out, mh_u32 size);
    int    (MH_STDCALL *write_memory)(mh_u32 address, const void *data, mh_u32 size);

    int    (MH_STDCALL *register_frame_callback)(MHHostFrameCallback callback);
    mh_u32 (MH_STDCALL *frame_count)(void);
    int    (MH_STDCALL *key_down)(int virtual_key);
    int    (MH_STDCALL *key_pressed)(int virtual_key);

    mh_u32 (MH_STDCALL *constant)(const char *name);
    int    (MH_STDCALL *make_directory)(const char *path);
    int    (MH_STDCALL *dump_memory)(const char *path, mh_u32 address, mh_u32 size);

    /* Chains onto an existing detour at the same address; see MHRuntime.c. */
    int    (MH_STDCALL *install_detour)(mh_u32 address,
                                        const void *expected,
                                        mh_u32 stolen_len,
                                        void *replacement,
                                        mh_u32 *trampoline_out);

    mh_u32 (MH_STDCALL *actor_address)(mh_u32 index);
    mh_u32 (MH_STDCALL *find_player_actor)(void);

    /* Checked byte replacement that follows code moved by a detour. */
    int    (MH_STDCALL *patch)(mh_u32 address, const void *expected, const void *replacement, mh_u32 size);
    mh_u32 (MH_STDCALL *time)(void);
};

#ifdef __cplusplus
}
#endif

#endif
