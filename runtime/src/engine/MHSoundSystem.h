#ifndef MH_SOUND_SYSTEM_H
#define MH_SOUND_SYSTEM_H
#include "mh_host.h"
int MH_STDCALL MHSoundSystemInit(const MHHostAPI *host);
mh_u32 MH_STDCALL MHSoundLoadWav(const char *package_id,const char *relative_path);
/* A WAV already in memory (an entry of a loaded .mhproject). The bytes must stay valid until the handle is unloaded. */
mh_u32 MH_STDCALL MHSoundLoadWavMemory(const mh_u8 *data,mh_u32 size);
int MH_STDCALL MHSoundUnloadWav(mh_u32 handle);
int MH_STDCALL MHSoundPlayWav(mh_u32 handle);
int MH_STDCALL MHSoundPlayWavAt(mh_u32 handle,mh_i32 world_x,mh_i32 world_y);
int MH_STDCALL MHSoundPlayWavEntity(mh_u32 handle,mh_u32 source_ptr,mh_u32 owner_ptr);
int MH_STDCALL MHSoundStopWav(mh_u32 handle);
/* Ensure collection voices exist before the game's native pickup event queues them. */
void MH_STDCALL MHSoundPrepareKeyPickups(void);
/* Load a retail feedback clip on demand, then use the native speech queue. */
int MH_STDCALL MHSoundDoorFeedback(mh_u32 effect_id,const char *sample_name);
#endif
