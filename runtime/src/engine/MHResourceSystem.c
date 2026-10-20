#include "mh_host.h"
#include "mh_contract.h"
#include "mh_contract_data.h"
#include "mh_catalog_data.h"
#include "MHPackageRegistry.h"
#include "MHResourceSystem.h"

/*
 * Central DATA.ARC resource service.
 *
 * This module owns the retail generic archive reader hook at 0x00437AB0,
 * archive directory metadata/lookup, deterministic override provider ordering,
 * and package-level loose generic, terrain and retail-named sprite overrides.
 *
 * Public mods never see this interface directly; MHAPI delegates read-only
 * metadata to it and first-party systems register bounded override providers.
 */

#if defined(_MSC_VER) || defined(__clang__)
#define MH_CDECL __cdecl
#else
#define MH_CDECL
#endif

typedef void *MHHandle;
typedef int mh_bool;
typedef mh_u32 (MH_CDECL *PFN_ArchiveRead)(mh_u32 archive_id, void *destination);
typedef mh_u32 (MH_CDECL *PFN_BinArchiveLoad)(mh_u32 archive_id, void *destination, mh_u32 mode);
typedef void * (MH_CDECL *PFN_BmpArchiveLoad)(mh_u32 archive_id, void *destination, mh_u32 apply_palette);
typedef MHHandle (MH_STDCALL *PFN_CreateFileA)(const char *, mh_u32, mh_u32, void *, mh_u32, mh_u32, MHHandle);
typedef mh_bool (MH_STDCALL *PFN_ReadFile)(MHHandle, void *, mh_u32, mh_u32 *, void *);
typedef mh_u32 (MH_STDCALL *PFN_GetFileSize)(MHHandle, mh_u32 *);
typedef mh_bool (MH_STDCALL *PFN_CloseHandle)(MHHandle);

#define MH_ARCHIVE_READ         0x00437AB0u
#define MH_BIN_ARCHIVE_LOAD     0x00437B50u
#define MH_BMP_ARCHIVE_LOAD     0x00437950u
#define MH_ARCHIVE_COUNT        0x00630B04u
#define MH_ARCHIVE_ENTRIES      0x0062CB10u
#define MH_ARCHIVE_ENTRY_STRIDE 0x18u
#define MH_TERRAIN_POINTER_TABLE 0x0067B690u
#define MH_TERRAIN_COUNT         0x0065A338u
/* The retail tile-pointer table ends where the next global begins (0x0067B890). */
#define MH_TERRAIN_RETAIL_TILES  128u
#define MH_TERRAIN_TABLE_REFS    8u
#define MH_RUNTIME_SPRITE_TABLE   0x00656960u
#define MH_DISPLAY_PALETTE_TABLE  0x00631D40u
#define MH_SOURCE_PALETTE_TABLE   0x0065A378u
#define MH_PROVIDER_MAX         8u
#define MH_PATH_CAP             512u
#define MH_SPRITE_CACHE_MAX     64u

#define MH_INVALID_HANDLE ((MHHandle)(mh_i32)-1)
#define MH_GENERIC_READ 0x80000000u
#define MH_FILE_SHARE_READ 0x00000001u
#define MH_OPEN_EXISTING 3u
#define MH_FILE_ATTRIBUTE_NORMAL 0x00000080u
#define MH_INVALID_FILE_SIZE 0xffffffffu

typedef struct MHProvider {
    MHResourceReadProvider callback;
    mh_i32 priority;
    const char *name;
} MHProvider;

typedef struct MHTerrainProvider {
    MHTerrainReadProvider callback;
    mh_i32 priority;
    const char *name;
} MHTerrainProvider;

typedef struct MHBitmapProvider {
    MHBitmapReadProvider callback;
    mh_i32 priority;
    const char *name;
} MHBitmapProvider;

static const MHHostAPI *g_host;
static PFN_ArchiveRead g_original_archive_read;
static PFN_BinArchiveLoad g_original_bin_archive_load;
static PFN_BmpArchiveLoad g_original_bmp_archive_load;
static PFN_CreateFileA g_create_file;
static PFN_ReadFile g_read_file;
static PFN_GetFileSize g_get_file_size;
static PFN_CloseHandle g_close_handle;
static MHProvider g_providers[MH_PROVIDER_MAX];
static mh_u32 g_provider_count;
static MHTerrainProvider g_terrain_providers[MH_PROVIDER_MAX];
static mh_u32 g_terrain_provider_count;
static MHBitmapProvider g_bitmap_providers[MH_PROVIDER_MAX];
static mh_u32 g_bitmap_provider_count;
static mh_u8 g_loose_logged[MH_RESOURCE_LIMIT];
static mh_u8 g_loose_terrain_logged[MH_RESOURCE_LIMIT];
static mh_u8 g_loose_bitmap_logged[MH_RESOURCE_LIMIT];
static mh_u8 g_terrain_scratch[MH_TERRAIN_MAX_DECODED_BYTES];
/*
 * Every instruction that indexes the tile-pointer table, as [reg*4+table]
 * with the table address in bytes 3..6: the texture-cycle swap (four), the
 * terrain loader's store, and three renderer reads. Pointing them at a larger
 * table of our own lifts the engine's 128-tile limit.
 */
static const mh_u32 g_terrain_table_refs[MH_TERRAIN_TABLE_REFS]={
    0x00420671u,0x00420685u,0x0042068Cu,0x0042069Cu,0x00437C12u,0x0043E150u,0x0043E188u,0x0044427Eu
};
static mh_u32 g_terrain_table[MH_TERRAIN_MAX_TILES];
/* Pixels of banks too large for the level arena the retail loader fills. */
static mh_u8 g_terrain_store[MH_TERRAIN_MAX_TILES*MH_TERRAIN_TILE_BYTES];
static mh_u32 g_terrain_table_address=MH_TERRAIN_POINTER_TABLE;
static mh_u32 g_terrain_capacity=MH_TERRAIN_RETAIL_TILES;
static mh_u8 g_bitmap_scratch[MH_BITMAP_MAX_FILE_BYTES];
static mh_u8 g_palette_scratch_a[1024u];
static mh_u8 g_palette_scratch_b[1024u];
static mh_u8 g_sprite_arena[MH_SPRITE_ARENA_BYTES];
static mh_u32 g_sprite_arena_used;
static mh_u8 g_loose_sprite_logged[MH_RESOURCE_LIMIT];
typedef struct MHLooseSpriteCacheEntry { mh_u32 archive_id; const mh_u8 *data; mh_u32 size; } MHLooseSpriteCacheEntry;
static MHLooseSpriteCacheEntry g_sprite_cache[MH_SPRITE_CACHE_MAX];
static mh_u32 g_sprite_cache_count;

static int ascii_lower(int c){return(c>='A'&&c<='Z')?c+('a'-'A'):c;}
static int ends_with_i(const char *s,const char *suffix)
{
    mh_u32 ns=0u,nx=0u,i;
    if(!s||!suffix)return 0;
    while(s[ns])++ns;while(suffix[nx])++nx;if(nx>ns)return 0;
    for(i=0u;i<nx;++i)if(ascii_lower((unsigned char)s[ns-nx+i])!=ascii_lower((unsigned char)suffix[i]))return 0;
    return 1;
}
static int copy_text(char *out,mh_u32 cap,const char *src)
{
    mh_u32 i=0u;if(!out||!cap||!src)return 0;
    while(src[i]){if(i+1u>=cap)return 0;out[i]=src[i];++i;}out[i]=0;return 1;
}
static int append_text(char *out,mh_u32 cap,const char *src)
{
    mh_u32 i=0u,j=0u;if(!out||!cap||!src)return 0;while(i<cap&&out[i])++i;if(i>=cap)return 0;
    while(src[j]){if(i+1u>=cap)return 0;out[i++]=src[j++];}out[i]=0;return 1;
}
static void copy_bytes(void *destination,const void *source,mh_u32 size)
{
    mh_u8 *d=(mh_u8 *)destination;const mh_u8 *s=(const mh_u8 *)source;mh_u32 i;
    for(i=0u;i<size;++i)d[i]=s[i];
}
static mh_u16 read_u16(const mh_u8 *data,mh_u32 offset)
{
    return (mh_u16)((mh_u16)data[offset]|((mh_u16)data[offset+1u]<<8));
}
static mh_u32 read_u32(const mh_u8 *data,mh_u32 offset)
{
    return (mh_u32)data[offset]|((mh_u32)data[offset+1u]<<8)|((mh_u32)data[offset+2u]<<16)|((mh_u32)data[offset+3u]<<24);
}
static int terrain_decoded_valid(const mh_u8 *data,mh_u32 size,mh_u32 *count_out,mh_u32 *header_out)
{
    mh_u32 count,header,i;if(!data||size<4u)return 0;count=read_u32(data,0u);
    if(!count||count>MH_TERRAIN_MAX_TILES)return 0;header=4u+count*4u;
    if(header>size||size-header!=count*MH_TERRAIN_TILE_BYTES)return 0;
    for(i=0u;i<count;++i)if(read_u32(data,4u+i*4u)!=i*MH_TERRAIN_TILE_BYTES)return 0;
    if(count_out)*count_out=count;if(header_out)*header_out=header;return 1;
}
static int archive_name_equal(const char *a,const char *b)
{
    mh_u32 i;if(!a||!b)return 0;
    for(i=0u;i<12u;++i){
        unsigned char ca=(unsigned char)a[i],cb=(unsigned char)b[i];
        if(ca>='A'&&ca<='Z')ca=(unsigned char)(ca+('a'-'A'));
        if(cb>='A'&&cb<='Z')cb=(unsigned char)(cb+('a'-'A'));
        if(ca!=cb)return 0;if(ca==0u)return 1;
    }
    return b[12]==0;
}
static mh_u32 sprite_required_frames(const char *name)
{
    mh_u32 i;if(!name)return 0u;
    for(i=0u;i<MH_SPRITE_CONTAINER_COUNT;++i)
        if(archive_name_equal(MH_SPRITE_CONTAINERS[i].name,name))return MH_SPRITE_CONTAINERS[i].frames;
    return 0u;
}
static const MHGeneratedBitmapResource *bitmap_resource(const char *name)
{
    mh_u32 i;if(!name)return (const MHGeneratedBitmapResource *)0;
    for(i=0u;i<MH_BITMAP_RESOURCE_COUNT;++i)
        if(archive_name_equal(MH_BITMAP_RESOURCES[i].name,name))return &MH_BITMAP_RESOURCES[i];
    return (const MHGeneratedBitmapResource *)0;
}
static int bitmap_decoded_valid(const mh_u8 *data,mh_u32 size,const MHGeneratedBitmapResource *expected,mh_u32 *width_out,mh_u32 *height_out)
{
    mh_u32 pixel_offset,dib_size,width,height,compression,row_bytes,required;mh_u16 planes,bpp;
    if(width_out)*width_out=0u;if(height_out)*height_out=0u;
    if(!data||size<1078u||size>MH_BITMAP_MAX_FILE_BYTES||data[0]!='B'||data[1]!='M')return 0;
    pixel_offset=read_u32(data,10u);dib_size=read_u32(data,14u);width=read_u32(data,18u);height=read_u32(data,22u);
    planes=read_u16(data,26u);bpp=read_u16(data,28u);compression=read_u32(data,30u);
    if(dib_size!=40u||pixel_offset!=1078u||!width||!height||width>65535u||height>65535u)return 0;
    if(planes!=1u||bpp!=MH_BITMAP_BPP||compression!=MH_BITMAP_COMPRESSION)return 0;
    row_bytes=(width+3u)&~3u;if(height>(MH_BITMAP_MAX_FILE_BYTES-pixel_offset)/row_bytes)return 0;
    required=pixel_offset+row_bytes*height;if(required>size)return 0;
    if(expected&&(width!=expected->width||height!=expected->height||bpp!=expected->bpp))return 0;
    if(width_out)*width_out=width;if(height_out)*height_out=height;return 1;
}

int MH_STDCALL MHResourceValidateSprite(const mh_u8 *data,mh_u32 size,mh_u32 *frame_count_out)
{
    mh_u32 n,header,i,off,end,scale,marker,expected,p,out,count;int control;
    if(frame_count_out)*frame_count_out=0u;
    if(!data||size<4u||size>MH_SPRITE_MAX_FILE_BYTES)return 0;
    n=read_u32(data,0u);if(!n||n>MH_SPRITE_MAX_FRAMES)return 0;
    header=4u+n*4u;if(header>size)return 0;
    for(i=0u;i<n;++i){
        off=read_u32(data,4u+i*4u);end=i+1u<n?read_u32(data,8u+i*4u):size;
        if(off<header||end>size||off>end||end-off<8u)return 0;
        scale=read_u32(data,off);marker=read_u32(data,off+4u);
        if(scale!=1u&&scale!=2u&&scale!=4u)return 0;expected=(64u/scale)*(64u/scale);
        if(marker==0xffffffffu){if(expected>end-off-8u)return 0;continue;}
        if(marker!=expected)return 0;p=off+8u;out=0u;
        while(out<expected){
            if(p>=end)return 0;control=(signed char)data[p++];count=control<0?(mh_u32)(-control):(mh_u32)control+2u;
            if(count>expected-out)return 0;out+=count;
            if(control<0){if(count>end-p)return 0;p+=count;}else{if(p>=end)return 0;++p;}
        }
    }
    if(frame_count_out)*frame_count_out=n;return 1;
}

int MH_STDCALL MHResourceInstallSpriteSlot(mh_u32 slot,const mh_u8 *data,mh_u32 size)
{
    mh_u32 ptr;if(slot>255u||!data||!MHResourceValidateSprite(data,size,(mh_u32 *)0)||!g_host||!g_host->write_memory)return 0;
    ptr=(mh_u32)(void *)data;return g_host->write_memory(MH_RUNTIME_SPRITE_TABLE+slot*4u,&ptr,4u);
}
static const MHGeneratedArchiveOverrideContract *override_contract(const char *name)
{
    mh_u32 i;if(!name)return (const MHGeneratedArchiveOverrideContract *)0;
    for(i=0u;i<MH_GENERIC_ARCHIVE_OVERRIDE_COUNT;++i)
        if(ends_with_i(name,MH_GENERIC_ARCHIVE_OVERRIDES[i].extension))return &MH_GENERIC_ARCHIVE_OVERRIDES[i];
    return (const MHGeneratedArchiveOverrideContract *)0;
}
static int generic_override_size_valid(const char *name,mh_u32 size)
{
    const MHGeneratedArchiveOverrideContract *contract=override_contract(name);
    return contract&&size>=contract->min_size&&size<=contract->max_size;
}

mh_u32 MH_STDCALL MHResourceCount(void)
{
    mh_u32 count=0u;
    if(!g_host||!g_host->read_memory||!g_host->read_memory(MH_ARCHIVE_COUNT,&count,4u)||count>MH_RESOURCE_LIMIT)return 0u;
    return count;
}

int MH_STDCALL MHResourceGet(mh_u32 resource,MHInternalResourceInfo *info)
{
    mh_u32 count=MHResourceCount(),entry,i;char name[MH_RESOURCE_NAME_CAP];mh_u32 size=0u,offset=0u;
    if(!info||resource>=count||!g_host||!g_host->read_memory)return 0;
    entry=MH_ARCHIVE_ENTRIES+resource*MH_ARCHIVE_ENTRY_STRIDE;
    if(!g_host->read_memory(entry,name,sizeof(name))||!g_host->read_memory(entry+0x10u,&size,4u)||!g_host->read_memory(entry+0x14u,&offset,4u))return 0;
    info->resource=resource;info->stored_size=size;info->archive_offset=offset;
    for(i=0u;i+1u<MH_RESOURCE_NAME_CAP&&name[i];++i)info->name[i]=name[i];info->name[i]=0;
    return 1;
}

mh_u32 MH_STDCALL MHResourceFind(const char *name)
{
    mh_u32 count=MHResourceCount(),i,entry;char current[MH_RESOURCE_NAME_CAP];
    if(!name||!*name||!g_host||!g_host->read_memory)return MH_RESOURCE_INVALID;
    for(i=0u;i<count;++i){
        entry=MH_ARCHIVE_ENTRIES+i*MH_ARCHIVE_ENTRY_STRIDE;
        if(!g_host->read_memory(entry,current,sizeof(current)))return MH_RESOURCE_INVALID;
        current[MH_RESOURCE_NAME_CAP-1u]=0;
        if(archive_name_equal(current,name))return i;
    }
    return MH_RESOURCE_INVALID;
}

static int MH_STDCALL loose_package_override(mh_u32 archive_id,void *destination,mh_u32 *decoded_size)
{
    MHInternalResourceInfo info;mh_u32 count,i;
    char relative[MH_PATH_CAP],path[MH_PATH_CAP];
    if(!destination||!decoded_size||!g_create_file||!g_read_file||!g_get_file_size||!g_close_handle)return 0;
    if(!MHResourceGet(archive_id,&info)||!override_contract(info.name))return 0;
    count=MHPackageCount();
    /* Packages have a deterministic ID sort. Later IDs win asset conflicts. */
    for(i=count;i>0u;--i){
        const MHPackage *package=MHPackageAt(i-1u);MHHandle h;mh_u32 high=0u,size,got=0u;
        if(!package)continue;
        relative[0]=0;
        if(!copy_text(relative,sizeof(relative),MH_PACKAGE_ARCHIVE_DIR))continue;
        if(!append_text(relative,sizeof(relative),"\\"))continue;
        if(!append_text(relative,sizeof(relative),info.name))continue;
        if(!MHPackagePath(package,relative,path,sizeof(path)))continue;
        h=g_create_file(path,MH_GENERIC_READ,MH_FILE_SHARE_READ,(void *)0,MH_OPEN_EXISTING,MH_FILE_ATTRIBUTE_NORMAL,(MHHandle)0);
        if(!h||h==MH_INVALID_HANDLE)continue;
        size=g_get_file_size(h,&high);
        if(size==MH_INVALID_FILE_SIZE||high||!generic_override_size_valid(info.name,size)){
            g_close_handle(h);
            if(g_host&&g_host->log){g_host->log("MH resources: ignored loose override with invalid size/type");g_host->log(package->id);g_host->log(info.name);}
            continue;
        }
        if(!g_read_file(h,destination,size,&got,(void *)0)||got!=size){g_close_handle(h);if(g_host&&g_host->log)g_host->log("MH resources: failed reading loose override");continue;}
        g_close_handle(h);*decoded_size=size;
        if(archive_id<MH_RESOURCE_LIMIT&&!g_loose_logged[archive_id]){
            g_loose_logged[archive_id]=1u;
            if(g_host&&g_host->log){g_host->log("MH resources: loose archive override applied");g_host->log(package->id);g_host->log(info.name);}
        }
        return 1;
    }
    return 0;
}


static int MH_STDCALL loose_package_terrain(mh_u32 archive_id,const mh_u8 **decoded_data,mh_u32 *decoded_size)
{
    MHInternalResourceInfo info;mh_u32 count,i;
    char relative[MH_PATH_CAP],path[MH_PATH_CAP];
    if(!decoded_data||!decoded_size||!g_create_file||!g_read_file||!g_get_file_size||!g_close_handle)return 0;
    if(!MHResourceGet(archive_id,&info)||!ends_with_i(info.name,MH_TERRAIN_ARCHIVE_EXTENSION))return 0;
    count=MHPackageCount();
    for(i=count;i>0u;--i){
        const MHPackage *package=MHPackageAt(i-1u);MHHandle h;mh_u32 high=0u,size,got=0u;
        if(!package)continue;relative[0]=0;
        if(!copy_text(relative,sizeof(relative),MH_PACKAGE_ARCHIVE_DIR)||!append_text(relative,sizeof(relative),"\\")||!append_text(relative,sizeof(relative),info.name))continue;
        if(!MHPackagePath(package,relative,path,sizeof(path)))continue;
        h=g_create_file(path,MH_GENERIC_READ,MH_FILE_SHARE_READ,(void *)0,MH_OPEN_EXISTING,MH_FILE_ATTRIBUTE_NORMAL,(MHHandle)0);
        if(!h||h==MH_INVALID_HANDLE)continue;
        size=g_get_file_size(h,&high);
        if(size==MH_INVALID_FILE_SIZE||high||size>MH_TERRAIN_MAX_DECODED_BYTES){
            g_close_handle(h);if(g_host&&g_host->log){g_host->log("MH resources: ignored terrain override with invalid size");g_host->log(package->id);g_host->log(info.name);}continue;
        }
        if(!g_read_file(h,g_terrain_scratch,size,&got,(void *)0)||got!=size){g_close_handle(h);if(g_host&&g_host->log)g_host->log("MH resources: failed reading terrain override");continue;}
        g_close_handle(h);
        if(!terrain_decoded_valid(g_terrain_scratch,size,(mh_u32 *)0,(mh_u32 *)0)){
            if(g_host&&g_host->log){g_host->log("MH resources: ignored malformed terrain override");g_host->log(package->id);g_host->log(info.name);}continue;
        }
        *decoded_data=g_terrain_scratch;*decoded_size=size;
        if(archive_id<MH_RESOURCE_LIMIT&&!g_loose_terrain_logged[archive_id]){
            g_loose_terrain_logged[archive_id]=1u;
            if(g_host&&g_host->log){g_host->log("MH resources: loose terrain override applied");g_host->log(package->id);g_host->log(info.name);}
        }
        return 1;
    }
    return 0;
}

static int MH_STDCALL loose_package_bitmap(mh_u32 archive_id,const mh_u8 **decoded_data,mh_u32 *decoded_size)
{
    MHInternalResourceInfo info;const MHGeneratedBitmapResource *expected;mh_u32 count,i;
    char relative[MH_PATH_CAP],path[MH_PATH_CAP];
    if(!decoded_data||!decoded_size||!g_create_file||!g_read_file||!g_get_file_size||!g_close_handle)return 0;
    if(!MHResourceGet(archive_id,&info)||!ends_with_i(info.name,MH_BITMAP_ARCHIVE_EXTENSION))return 0;
    expected=bitmap_resource(info.name);if(!expected)return 0;
    count=MHPackageCount();
    for(i=count;i>0u;--i){
        const MHPackage *package=MHPackageAt(i-1u);MHHandle h;mh_u32 high=0u,size,got=0u;
        if(!package)continue;relative[0]=0;
        if(!copy_text(relative,sizeof(relative),MH_PACKAGE_ARCHIVE_DIR)||!append_text(relative,sizeof(relative),"\\")||!append_text(relative,sizeof(relative),info.name))continue;
        if(!MHPackagePath(package,relative,path,sizeof(path)))continue;
        h=g_create_file(path,MH_GENERIC_READ,MH_FILE_SHARE_READ,(void *)0,MH_OPEN_EXISTING,MH_FILE_ATTRIBUTE_NORMAL,(MHHandle)0);
        if(!h||h==MH_INVALID_HANDLE)continue;
        size=g_get_file_size(h,&high);
        if(size==MH_INVALID_FILE_SIZE||high||!size||size>MH_BITMAP_MAX_FILE_BYTES){
            g_close_handle(h);if(g_host&&g_host->log){g_host->log("MH resources: ignored bitmap override with invalid size");g_host->log(package->id);g_host->log(info.name);}continue;
        }
        if(!g_read_file(h,g_bitmap_scratch,size,&got,(void *)0)||got!=size){g_close_handle(h);if(g_host&&g_host->log)g_host->log("MH resources: failed reading bitmap override");continue;}
        g_close_handle(h);
        if(!bitmap_decoded_valid(g_bitmap_scratch,size,expected,(mh_u32 *)0,(mh_u32 *)0)){
            if(g_host&&g_host->log){g_host->log("MH resources: ignored malformed/incompatible bitmap override");g_host->log(package->id);g_host->log(info.name);}continue;
        }
        *decoded_data=g_bitmap_scratch;*decoded_size=size;
        if(archive_id<MH_RESOURCE_LIMIT&&!g_loose_bitmap_logged[archive_id]){
            g_loose_bitmap_logged[archive_id]=1u;
            if(g_host&&g_host->log){g_host->log("MH resources: loose bitmap override applied");g_host->log(package->id);g_host->log(info.name);}
        }
        return 1;
    }
    return 0;
}

static int loose_sprite_for_binding(const MHGeneratedStageSprite *binding,const mh_u8 **data_out,mh_u32 *size_out)
{
    mh_u32 count,i;if(!binding||!data_out||!size_out||!g_create_file||!g_read_file||!g_get_file_size||!g_close_handle)return 0;
    count=MHPackageCount();
    for(i=count;i>0u;--i){
        const MHPackage *package=MHPackageAt(i-1u);MHHandle h;mh_u32 high=0u,size,got=0u,frames=0u,required;char relative[MH_PATH_CAP],path[MH_PATH_CAP];
        if(!package)continue;relative[0]=0;
        if(!copy_text(relative,sizeof(relative),MH_PACKAGE_ARCHIVE_DIR)||!append_text(relative,sizeof(relative),"\\")||!append_text(relative,sizeof(relative),binding->name))continue;
        if(!MHPackagePath(package,relative,path,sizeof(path)))continue;
        h=g_create_file(path,MH_GENERIC_READ,MH_FILE_SHARE_READ,(void *)0,MH_OPEN_EXISTING,MH_FILE_ATTRIBUTE_NORMAL,(MHHandle)0);
        if(!h||h==MH_INVALID_HANDLE)continue;
        size=g_get_file_size(h,&high);
        if(size==MH_INVALID_FILE_SIZE||high||!size||size>MH_SPRITE_MAX_FILE_BYTES||g_sprite_arena_used>MH_SPRITE_ARENA_BYTES-size){
            g_close_handle(h);if(g_host&&g_host->log){g_host->log("MH resources: ignored sprite override with invalid/excessive size");g_host->log(package->id);g_host->log(binding->name);}continue;
        }
        if(!g_read_file(h,g_sprite_arena+g_sprite_arena_used,size,&got,(void *)0)||got!=size){g_close_handle(h);if(g_host&&g_host->log)g_host->log("MH resources: failed reading sprite override");continue;}
        g_close_handle(h);
        if(!MHResourceValidateSprite(g_sprite_arena+g_sprite_arena_used,size,&frames)){
            if(g_host&&g_host->log){g_host->log("MH resources: ignored malformed sprite override");g_host->log(package->id);g_host->log(binding->name);}continue;
        }
        required=sprite_required_frames(binding->name);
        if(required&&frames<required){
            if(g_host&&g_host->log){g_host->log("MH resources: ignored sprite override with too few frames for retail binding");g_host->log(package->id);g_host->log(binding->name);}continue;
        }
        *data_out=g_sprite_arena+g_sprite_arena_used;*size_out=size;g_sprite_arena_used+=size;
        if(binding->archive_id<MH_RESOURCE_LIMIT&&!g_loose_sprite_logged[binding->archive_id]){
            g_loose_sprite_logged[binding->archive_id]=1u;
            if(g_host&&g_host->log){g_host->log("MH resources: loose sprite override applied");g_host->log(package->id);g_host->log(binding->name);}
        }
        return 1;
    }
    return 0;
}

mh_u32 MH_STDCALL MHResourceApplyLooseSpriteOverrides(mh_u32 level_index)
{
    mh_u32 offset,count,i,j,applied=0u;
    if(level_index>=MH_STAGE_CATALOG_COUNT)return 0u;
    g_sprite_arena_used=0u;g_sprite_cache_count=0u;
    offset=MH_STAGE_SPRITE_OFFSETS[level_index];count=MH_STAGE_SPRITE_COUNTS[level_index];
    for(i=0u;i<count;++i){
        const MHGeneratedStageSprite *binding=&MH_STAGE_SPRITES[offset+i];const mh_u8 *data=(const mh_u8 *)0;mh_u32 size=0u;
        for(j=0u;j<g_sprite_cache_count;++j)if(g_sprite_cache[j].archive_id==binding->archive_id){data=g_sprite_cache[j].data;size=g_sprite_cache[j].size;break;}
        if(!data){
            if(!loose_sprite_for_binding(binding,&data,&size))continue;
            if(g_sprite_cache_count<MH_SPRITE_CACHE_MAX){
                g_sprite_cache[g_sprite_cache_count].archive_id=binding->archive_id;
                g_sprite_cache[g_sprite_cache_count].data=data;
                g_sprite_cache[g_sprite_cache_count].size=size;
                ++g_sprite_cache_count;
            }
        }
        if(MHResourceInstallSpriteSlot(binding->runtime_slot,data,size))++applied;
    }
    return applied;
}

int MH_STDCALL MHResourceRegisterProvider(MHResourceReadProvider provider,mh_i32 priority,const char *name)
{
    mh_u32 i;if(!provider||g_provider_count>=MH_PROVIDER_MAX)return 0;
    i=g_provider_count++;
    while(i>0u&&g_providers[i-1u].priority<priority){g_providers[i]=g_providers[i-1u];--i;}
    g_providers[i].callback=provider;g_providers[i].priority=priority;g_providers[i].name=name;
    /* Stable insertion order is retained for equal priorities. */
    return 1;
}


int MH_STDCALL MHResourceRegisterTerrainProvider(MHTerrainReadProvider provider,mh_i32 priority,const char *name)
{
    mh_u32 i;if(!provider||g_terrain_provider_count>=MH_PROVIDER_MAX)return 0;
    i=g_terrain_provider_count++;
    while(i>0u&&g_terrain_providers[i-1u].priority<priority){g_terrain_providers[i]=g_terrain_providers[i-1u];--i;}
    g_terrain_providers[i].callback=provider;g_terrain_providers[i].priority=priority;g_terrain_providers[i].name=name;
    return 1;
}

int MH_STDCALL MHResourceRegisterBitmapProvider(MHBitmapReadProvider provider,mh_i32 priority,const char *name)
{
    mh_u32 i;if(!provider||g_bitmap_provider_count>=MH_PROVIDER_MAX)return 0;
    i=g_bitmap_provider_count++;
    while(i>0u&&g_bitmap_providers[i-1u].priority<priority){g_bitmap_providers[i]=g_bitmap_providers[i-1u];--i;}
    g_bitmap_providers[i].callback=provider;g_bitmap_providers[i].priority=priority;g_bitmap_providers[i].name=name;
    return 1;
}

/*
 * Move the tile-pointer table into the runtime. All references are checked
 * before any is changed, so a different executable is left exactly as it was
 * (and keeps the 128-tile limit).
 */
static int relocate_terrain_table(const MHHostAPI *host)
{
    mh_u32 i,address,target=(mh_u32)(void *)g_terrain_table,original=MH_TERRAIN_POINTER_TABLE;
    if(!host->read_memory||!host->write_memory)return 0;
    for(i=0u;i<MH_TERRAIN_TABLE_REFS;++i){
        address=0u;
        if(!host->read_memory(g_terrain_table_refs[i]+3u,&address,4u)||address!=MH_TERRAIN_POINTER_TABLE)return 0;
    }
    for(i=0u;i<MH_TERRAIN_TABLE_REFS;++i){
        if(!host->write_memory(g_terrain_table_refs[i]+3u,&target,4u)){
            while(i>0u){--i;host->write_memory(g_terrain_table_refs[i]+3u,&original,4u);}
            return 0;
        }
    }
    g_terrain_table_address=target;g_terrain_capacity=MH_TERRAIN_MAX_TILES;
    return 1;
}

mh_u32 MH_STDCALL MHResourceTerrainCapacity(void)
{
    return g_terrain_capacity;
}

/*
 * Install a decoded bank. Banks the retail engine could hold are copied into
 * the level arena at `destination`, as the retail loader does; larger ones go
 * into the runtime's own store and take nothing from the arena. `used_out`
 * receives the arena bytes consumed, which the level loader adds to its cursor.
 */
static int install_terrain(const mh_u8 *decoded,mh_u32 decoded_size,void *destination,mh_u32 *used_out)
{
    mh_u32 count,header,payload,i,ptr;mh_u16 count16;mh_u8 *base;
    if(!destination||!terrain_decoded_valid(decoded,decoded_size,&count,&header))return 0;
    if(count>g_terrain_capacity||!g_host||!g_host->write_memory)return 0;
    payload=count*MH_TERRAIN_TILE_BYTES;
    base=count<=MH_TERRAIN_RETAIL_TILES?(mh_u8 *)destination:g_terrain_store;
    copy_bytes(base,decoded+header,payload);
    for(i=0u;i<count;++i){
        ptr=(mh_u32)(base+i*MH_TERRAIN_TILE_BYTES);
        if(!g_host->write_memory(g_terrain_table_address+i*4u,&ptr,4u))return 0;
    }
    count16=(mh_u16)count;
    if(!g_host->write_memory(MH_TERRAIN_COUNT,&count16,2u))return 0;
    *used_out=base==g_terrain_store?0u:payload;
    return 1;
}

static mh_u32 MH_CDECL terrain_read_hook(mh_u32 archive_id,void *destination,mh_u32 mode)
{
    mh_u32 i,decoded_size,used;const mh_u8 *decoded;
    if(destination&&mode==0u){
        for(i=0u;i<g_terrain_provider_count;++i){
            decoded=(const mh_u8 *)0;decoded_size=0u;used=0u;
            if(g_terrain_providers[i].callback&&g_terrain_providers[i].callback(archive_id,&decoded,&decoded_size)){
                if(install_terrain(decoded,decoded_size,destination,&used))return used;
                if(g_host&&g_host->log){g_host->log("MH resources: terrain provider returned a BIN that is invalid or has more tiles than this engine can hold");if(g_terrain_providers[i].name)g_host->log(g_terrain_providers[i].name);}
            }
        }
    }
    return g_original_bin_archive_load?g_original_bin_archive_load(archive_id,destination,mode):0u;
}

static void *MH_CDECL bitmap_read_hook(mh_u32 archive_id,void *destination,mh_u32 apply_palette)
{
    mh_u32 i,decoded_size=0u,width=0u,height=0u,pixel_offset=0u,p;const mh_u8 *decoded=(const mh_u8 *)0;
    MHInternalResourceInfo info;const MHGeneratedBitmapResource *expected=(const MHGeneratedBitmapResource *)0;
    if(destination&&MHResourceGet(archive_id,&info))expected=bitmap_resource(info.name);
    if(destination&&expected){
        for(i=0u;i<g_bitmap_provider_count;++i){
            decoded=(const mh_u8 *)0;decoded_size=0u;
            if(g_bitmap_providers[i].callback&&g_bitmap_providers[i].callback(archive_id,&decoded,&decoded_size)){
                if(!bitmap_decoded_valid(decoded,decoded_size,expected,&width,&height)){
                    if(g_host&&g_host->log){g_host->log("MH resources: bitmap provider returned invalid/incompatible BMP");if(g_bitmap_providers[i].name)g_host->log(g_bitmap_providers[i].name);}
                    continue;
                }
                if(apply_palette){
                    if(!g_host||!g_host->read_memory||!g_host->write_memory||
                       !g_host->read_memory(MH_DISPLAY_PALETTE_TABLE,g_palette_scratch_a,1024u)||
                       !g_host->read_memory(MH_SOURCE_PALETTE_TABLE,g_palette_scratch_b,1024u))return (void *)0;
                    for(p=0u;p<MH_BITMAP_PALETTE_ENTRIES;++p){
                        const mh_u8 *src=decoded+54u+p*4u;
                        g_palette_scratch_a[p*4u+0u]=src[2];g_palette_scratch_a[p*4u+1u]=src[1];g_palette_scratch_a[p*4u+2u]=src[0];
                        g_palette_scratch_b[p*4u+0u]=src[2];g_palette_scratch_b[p*4u+1u]=src[1];g_palette_scratch_b[p*4u+2u]=src[0];
                    }
                    if(!g_host->write_memory(MH_DISPLAY_PALETTE_TABLE,g_palette_scratch_a,1024u)||
                       !g_host->write_memory(MH_SOURCE_PALETTE_TABLE,g_palette_scratch_b,1024u))return (void *)0;
                }
                pixel_offset=read_u32(decoded,10u);copy_bytes(destination,decoded+pixel_offset,width*height);return destination;
            }
        }
    }
    return g_original_bmp_archive_load?g_original_bmp_archive_load(archive_id,destination,apply_palette):(void *)0;
}

static mh_u32 MH_CDECL archive_read_hook(mh_u32 archive_id,void *destination)
{
    mh_u32 i,decoded_size=0u;MHInternalResourceInfo info;
    if(destination){
        for(i=0u;i<g_provider_count;++i){
            if(g_providers[i].callback&&g_providers[i].callback(archive_id,destination,&decoded_size)){
                /* Preserve the retail function's return contract: stored archive size. */
                if(MHResourceGet(archive_id,&info))return info.stored_size;
                return decoded_size;
            }
        }
    }
    return g_original_archive_read?g_original_archive_read(archive_id,destination):0u;
}

int MH_STDCALL MHResourceSystemInit(const MHHostAPI *host)
{
    static const mh_u8 archive_expected[5]={0x8B,0x44,0x24,0x04,0x53};
    static const mh_u8 terrain_expected[5]={0x51,0x8B,0x44,0x24,0x08};
    static const mh_u8 bitmap_expected[5]={0x8B,0x44,0x24,0x04,0x53};
    mh_u32 archive_trampoline=0u,terrain_trampoline=0u,bitmap_trampoline=0u,i;
    if(!host||!host->symbol||!host->install_detour||!host->log)return 0;
    g_host=host;g_provider_count=0u;g_terrain_provider_count=0u;g_bitmap_provider_count=0u;
    for(i=0u;i<MH_RESOURCE_LIMIT;++i){g_loose_logged[i]=0u;g_loose_terrain_logged[i]=0u;g_loose_bitmap_logged[i]=0u;g_loose_sprite_logged[i]=0u;}
    g_sprite_arena_used=0u;g_sprite_cache_count=0u;
    g_create_file=(PFN_CreateFileA)(void *)host->symbol("win32.create_file_a");
    g_read_file=(PFN_ReadFile)(void *)host->symbol("win32.read_file");
    g_get_file_size=(PFN_GetFileSize)(void *)host->symbol("win32.get_file_size");
    g_close_handle=(PFN_CloseHandle)(void *)host->symbol("win32.close_handle");
    if(!g_create_file||!g_read_file||!g_get_file_size||!g_close_handle)return 0;
    if(!host->install_detour(MH_ARCHIVE_READ,archive_expected,5u,(void *)&archive_read_hook,&archive_trampoline)){
        host->log("MH resources: archive reader hook signature mismatch");return 0;
    }
    g_original_archive_read=(PFN_ArchiveRead)(void *)archive_trampoline;
    if(!host->install_detour(MH_BIN_ARCHIVE_LOAD,terrain_expected,5u,(void *)&terrain_read_hook,&terrain_trampoline)){
        host->log("MH resources: terrain loader hook signature mismatch");return 0;
    }
    g_original_bin_archive_load=(PFN_BinArchiveLoad)(void *)terrain_trampoline;
    if(relocate_terrain_table(host))host->log("MH resources: tile table relocated; terrain banks may hold up to 1024 tiles");
    else host->log("MH resources: tile table references not recognised; terrain banks stay limited to 128 tiles");
    if(!host->install_detour(MH_BMP_ARCHIVE_LOAD,bitmap_expected,5u,(void *)&bitmap_read_hook,&bitmap_trampoline)){
        host->log("MH resources: bitmap loader hook signature mismatch");return 0;
    }
    g_original_bmp_archive_load=(PFN_BmpArchiveLoad)(void *)bitmap_trampoline;
    if(!MHResourceRegisterProvider(loose_package_override,0,"package loose archive assets"))return 0;
    if(!MHResourceRegisterTerrainProvider(loose_package_terrain,0,"package loose terrain assets"))return 0;
    if(!MHResourceRegisterBitmapProvider(loose_package_bitmap,0,"package loose bitmap assets"))return 0;
    host->log("MH resources: DATA.ARC service initialized");
    host->log("MH resources: loose overrides scan mods\\<id>\\assets\\archive");
    return 1;
}

