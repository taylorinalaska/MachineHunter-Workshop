#ifndef MH_RESOURCE_SYSTEM_H
#define MH_RESOURCE_SYSTEM_H

#include "mh_host.h"

#define MH_RESOURCE_INVALID 0xffffffffu
#define MH_RESOURCE_NAME_CAP 16u
#define MH_RESOURCE_LIMIT 682u

typedef struct MHInternalResourceInfo {
    mh_u32 resource;
    char name[MH_RESOURCE_NAME_CAP];
    mh_u32 stored_size;
    mh_u32 archive_offset;
} MHInternalResourceInfo;

typedef int (MH_STDCALL *MHResourceReadProvider)(mh_u32 archive_id, void *destination, mh_u32 *decoded_size);
typedef int (MH_STDCALL *MHTerrainReadProvider)(mh_u32 archive_id, const mh_u8 **decoded_data, mh_u32 *decoded_size);
typedef int (MH_STDCALL *MHBitmapReadProvider)(mh_u32 archive_id, const mh_u8 **decoded_data, mh_u32 *decoded_size);

int MH_STDCALL MHResourceSystemInit(const MHHostAPI *host);
int MH_STDCALL MHResourceRegisterProvider(MHResourceReadProvider provider, mh_i32 priority, const char *name);
int MH_STDCALL MHResourceRegisterTerrainProvider(MHTerrainReadProvider provider, mh_i32 priority, const char *name);
int MH_STDCALL MHResourceRegisterBitmapProvider(MHBitmapReadProvider provider, mh_i32 priority, const char *name);
mh_u32 MH_STDCALL MHResourceCount(void);
int MH_STDCALL MHResourceGet(mh_u32 resource, MHInternalResourceInfo *info);
mh_u32 MH_STDCALL MHResourceFind(const char *name);
int MH_STDCALL MHResourceValidateSprite(const mh_u8 *data, mh_u32 size, mh_u32 *frame_count_out);
int MH_STDCALL MHResourceInstallSpriteSlot(mh_u32 slot, const mh_u8 *data, mh_u32 size);
mh_u32 MH_STDCALL MHResourceApplyLooseSpriteOverrides(mh_u32 level_index);
/* Tiles a terrain bank may hold: 128 in the unmodified engine, MH_TERRAIN_MAX_TILES once the tile table has been moved. */
mh_u32 MH_STDCALL MHResourceTerrainCapacity(void);

#endif
