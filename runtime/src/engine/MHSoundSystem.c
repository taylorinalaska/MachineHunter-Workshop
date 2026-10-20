#include "mh_host.h"
#include "MHPackageRegistry.h"
#include "MHResourceSystem.h"
#include "MHSoundSystem.h"

typedef void *MHHandle;
typedef int mh_bool;
#define MH_INVALID_HANDLE ((MHHandle)(mh_i32)-1)
#define MH_GENERIC_READ 0x80000000u
#define MH_FILE_SHARE_READ 1u
#define MH_OPEN_EXISTING 3u
#define MH_FILE_ATTRIBUTE_NORMAL 0x80u
#define MH_WAV_INPUT_MAX (12u*1024u*1024u)
#define MH_WAV_PCM_MAX (2u*1024u*1024u)
#define MH_WAV_MAX_SECONDS 60u
#define MH_SOUND_LOAD 0x0044DC00u
#define MH_SOUND_CREATE_BUFFER 0x0044DB20u
#define MH_SOUND_SLOTS_BASE 0x006AD670u
#define MH_SOUND_SLOT_STRIDE 0x20u
#define MH_SOUND_SLOT_COUNT 461u
#define MH_DIRECTSOUND_PTR 0x006B1018u
#define MH_SOUND_ENABLED_PTR 0x006B1014u
#define MH_SOUND_LISTENER_PTR 0x00489A74u
#define MH_CUSTOM_SOUND_MAX 32u
#define MH_CUSTOM_SOUND_VOICES 4u
#define MH_DSBSTATUS_PLAYING 0x00000001u
#define MH_CUSTOM_POSITION_NONE 0u
#define MH_CUSTOM_POSITION_FIXED 1u
#define MH_CUSTOM_POSITION_SOURCE 2u

typedef MHHandle (MH_STDCALL *PFN_CreateFileA)(const char *,mh_u32,mh_u32,void *,mh_u32,mh_u32,MHHandle);
typedef mh_bool (MH_STDCALL *PFN_ReadFile)(MHHandle,void *,mh_u32,mh_u32 *,void *);
typedef mh_u32 (MH_STDCALL *PFN_GetFileSize)(MHHandle,mh_u32 *);
typedef mh_bool (MH_STDCALL *PFN_CloseHandle)(MHHandle);
typedef int (__cdecl *PFN_SoundLoad)(const char *,mh_u32);
typedef int (__cdecl *PFN_CreateSoundBuffer)(void **,mh_u32);
typedef mh_u32 (MH_STDCALL *PFN_DSLock)(void *,mh_u32,mh_u32,void **,mh_u32 *,void **,mh_u32 *,mh_u32);
typedef mh_u32 (MH_STDCALL *PFN_DSUnlock)(void *,void *,mh_u32,void *,mh_u32);
typedef mh_u32 (MH_STDCALL *PFN_DSRelease)(void *);
typedef mh_u32 (MH_STDCALL *PFN_DSDuplicate)(void *,void *,void **);
typedef mh_u32 (MH_STDCALL *PFN_DSGetStatus)(void *,mh_u32 *);
typedef mh_u32 (MH_STDCALL *PFN_DSPlay)(void *,mh_u32,mh_u32,mh_u32);
typedef mh_u32 (MH_STDCALL *PFN_DSSetCurrentPosition)(void *,mh_u32);
typedef mh_u32 (MH_STDCALL *PFN_DSStop)(void *);
typedef mh_u32 (MH_STDCALL *PFN_DSSetVolume)(void *,mh_i32);
typedef mh_u32 (MH_STDCALL *PFN_DSSetPan)(void *,mh_i32);

static const MHHostAPI *g_host;
static PFN_CreateFileA g_create_file;
static PFN_ReadFile g_read_file;
static PFN_GetFileSize g_get_size;
static PFN_CloseHandle g_close;
static PFN_SoundLoad g_original_load;
static mh_u8 g_wav_input[MH_WAV_INPUT_MAX];
static mh_u8 g_pcm[MH_WAV_PCM_MAX];

typedef struct MHWavInfo {mh_u16 channels,bits;mh_u32 rate;const mh_u8 *data;mh_u32 data_size,frames;} MHWavInfo;
typedef struct MHCustomSound {
    mh_u32 generation;
    mh_u32 next_voice;
    int used;
    int materialized;
    /* Either a file path or, for package entries, the WAV bytes themselves. */
    const mh_u8 *memory;
    mh_u32 memory_size;
    char path[MH_PACKAGE_PATH_CAP];
    void *voices[MH_CUSTOM_SOUND_VOICES];
    mh_u8 position_mode[MH_CUSTOM_SOUND_VOICES];
    mh_u32 source_ptr[MH_CUSTOM_SOUND_VOICES];
    mh_u32 owner_ptr[MH_CUSTOM_SOUND_VOICES];
    mh_u32 owner_value[MH_CUSTOM_SOUND_VOICES];
    mh_i32 fixed_x[MH_CUSTOM_SOUND_VOICES];
    mh_i32 fixed_y[MH_CUSTOM_SOUND_VOICES];
} MHCustomSound;
static MHCustomSound g_custom[MH_CUSTOM_SOUND_MAX];
static mh_u32 g_next_generation=1u;
static mh_u16 rd16(const mh_u8 *p){return (mh_u16)((mh_u16)p[0]|((mh_u16)p[1]<<8));}
static mh_u32 rd32(const mh_u8 *p){return (mh_u32)p[0]|((mh_u32)p[1]<<8)|((mh_u32)p[2]<<16)|((mh_u32)p[3]<<24);}
static int eq4(const mh_u8 *p,const char *s){return p[0]==(mh_u8)s[0]&&p[1]==(mh_u8)s[1]&&p[2]==(mh_u8)s[2]&&p[3]==(mh_u8)s[3];}
static int wav_parse(const mh_u8 *b,mh_u32 n,MHWavInfo *w){mh_u32 p=12u,fmt=0u,block=0u,riff_size;const mh_u8 *data=0;mh_u32 data_size=0u;if(!b||!w||n<44u||!eq4(b,"RIFF")||!eq4(b+8,"WAVE"))return 0;riff_size=rd32(b+4u);if(riff_size>n-8u)return 0;while(p+8u<=n){mh_u32 sz=rd32(b+p+4u),next;if(sz>n-(p+8u))return 0;next=p+8u+sz+(sz&1u);if(next<p||next>n)return 0;if(eq4(b+p,"fmt ")){if(sz<16u||rd16(b+p+8u)!=1u)return 0;w->channels=rd16(b+p+10u);w->rate=rd32(b+p+12u);block=rd16(b+p+20u);w->bits=rd16(b+p+22u);fmt=1u;}else if(eq4(b+p,"data")){data=b+p+8u;data_size=sz;}p=next;}if(!fmt||!data||(w->channels!=1u&&w->channels!=2u)||(w->bits!=8u&&w->bits!=16u)||w->rate<8000u||w->rate>48000u)return 0;if(block!=(mh_u32)(w->channels*(w->bits/8u))||!block||data_size<block)return 0;w->frames=data_size/block;if(w->frames>w->rate*MH_WAV_MAX_SECONDS)return 0;w->data=data;w->data_size=data_size;return 1;}
static mh_u8 wav_sample(const MHWavInfo *w,mh_u32 frame){const mh_u8 *p=w->data+frame*w->channels*(w->bits/8u);mh_i32 s;if(w->bits==8u){s=p[0];if(w->channels==2u)s=(s+(mh_i32)p[1])/2;return (mh_u8)s;}s=(mh_i32)(short)rd16(p);if(w->channels==2u)s=(s+(mh_i32)(short)rd16(p+2))/2;s=(s>>8)+128;if(s<0)s=0;if(s>255)s=255;return (mh_u8)s;}
static int wav_convert(const MHWavInfo *w,mh_u32 *out_size){mh_u32 src=0u,phase=0u,out=0u;if(!w||!out_size)return 0;while(src<w->frames){if(out>=MH_WAV_PCM_MAX)return 0;g_pcm[out++]=wav_sample(w,src);phase+=w->rate;while(phase>=22050u){phase-=22050u;++src;if(src>=w->frames)break;}}if(!out)return 0;*out_size=out;return 1;}
static int g_wav_found;
static int wav_read_path(const char *path,mh_u32 *pcm_size)
{
    MHHandle h;mh_u32 high=0u,size,got=0u;MHWavInfo wav;
    g_wav_found=0;
    if(!path||!pcm_size||!g_create_file||!g_read_file||!g_get_size||!g_close)return 0;
    h=g_create_file(path,MH_GENERIC_READ,MH_FILE_SHARE_READ,0,MH_OPEN_EXISTING,MH_FILE_ATTRIBUTE_NORMAL,0);
    if(!h||h==MH_INVALID_HANDLE)return 0;
    g_wav_found=1;
    size=g_get_size(h,&high);
    if(high||!size||size>MH_WAV_INPUT_MAX){g_close(h);return 0;}
    if(!g_read_file(h,g_wav_input,size,&got,0)||got!=size){g_close(h);return 0;}
    g_close(h);
    return wav_parse(g_wav_input,size,&wav)&&wav_convert(&wav,pcm_size);
}
static int safe_audio_relative(const char *s)
{
    mh_u32 i=0u,segment_start=0u,segment_len=0u;
    unsigned char c;
    if(!s||!*s||s[0]=='\\'||s[0]=='/'||(s[0]&&s[1]==':'))return 0;
    while((c=(unsigned char)s[i])!=0u){
        if(c<0x20u||c==':'||c=='*'||c=='?'||c=='"'||c=='<'||c=='>'||c=='|')return 0;
        if(c=='/'||c=='\\'){
            segment_len=i-segment_start;
            if(!segment_len||(segment_len==1u&&s[segment_start]=='.')||(segment_len==2u&&s[segment_start]=='.'&&s[segment_start+1]=='.'))return 0;
            segment_start=i+1u;
        }
        ++i;if(i+1u>=MH_PACKAGE_PATH_CAP)return 0;
    }
    segment_len=i-segment_start;
    if(!segment_len||(segment_len==1u&&s[segment_start]=='.')||(segment_len==2u&&s[segment_start]=='.'&&s[segment_start+1]=='.'))return 0;
    if(i<4u)return 0;
    return s[i-4]=='.'&&(s[i-3]=='w'||s[i-3]=='W')&&(s[i-2]=='a'||s[i-2]=='A')&&(s[i-1]=='v'||s[i-1]=='V');
}
static int copy_text_local(char *out,mh_u32 cap,const char *src)
{
    mh_u32 i=0u;if(!out||!cap||!src)return 0;
    while(src[i]){if(i+1u>=cap)return 0;out[i]=src[i];++i;}out[i]=0;return 1;
}
static int append_text_local(char *out,mh_u32 cap,const char *src)
{
    mh_u32 i=0u,j=0u;if(!out||!cap||!src)return 0;while(i<cap&&out[i])++i;if(i>=cap)return 0;
    while(src[j]){if(i+1u>=cap)return 0;out[i++]=src[j++];}out[i]=0;return 1;
}
static int ends_raw(const char *s){mh_u32 n=0u;while(s&&s[n])++n;if(n<4u)return 0;return s[n-4]=='.'&&(s[n-3]=='R'||s[n-3]=='r')&&(s[n-2]=='A'||s[n-2]=='a')&&(s[n-1]=='W'||s[n-1]=='w');}
static int path_for(const MHPackage *pkg,const char *raw,char *out,mh_u32 cap){char rel[220];mh_u32 i=0u,j=0u;if(!pkg||!raw||!out||!ends_raw(raw))return 0;while("assets\\audio\\"[i]){if(i+1u>=sizeof(rel))return 0;rel[i]="assets\\audio\\"[i];++i;}while(raw[j]&&raw[j]!='.'&&i+5u<sizeof(rel))rel[i++]=raw[j++];rel[i++]='.';rel[i++]='w';rel[i++]='a';rel[i++]='v';rel[i]=0;return MHPackagePath(pkg,rel,out,cap);}
static int load_best_wav(mh_u32 archive_id,mh_u32 *pcm_size,const char **package_id,const char **raw_name){MHInternalResourceInfo info;mh_u32 i,count,high,size,got;int found=0;char path[MH_PACKAGE_PATH_CAP];MHWavInfo wav;if(!MHResourceGet(archive_id,&info)||!ends_raw(info.name))return 0;count=MHPackageCount();for(i=0u;i<count;++i){const MHPackage *pkg=MHPackageAt(i);MHHandle h;if(!pkg||!path_for(pkg,info.name,path,sizeof(path)))continue;h=(MHHandle)0;high=0u;size=0u;got=0u;(void)h;(void)high;(void)size;(void)got;(void)wav;if(!wav_read_path(path,pcm_size)){if(g_host&&g_wav_found)g_host->log("MH sound: ignored invalid WAV replacement");continue;}found=1;if(package_id)*package_id=pkg->id;if(raw_name)*raw_name=info.name;}return found;}
static void copy_bytes(void *d0,const void *s0,mh_u32 n){mh_u8 *d=(mh_u8 *)d0;const mh_u8 *s=(const mh_u8 *)s0;mh_u32 i;for(i=0u;i<n;++i)d[i]=s[i];}
static void release_buffer(void *buf){void **vt;if(!buf)return;vt=*(void ***)buf;((PFN_DSRelease)vt[2])(buf);}
static int install_slot(mh_u32 slot,const mh_u8 *pcm,mh_u32 size){mh_u8 *base;void **primary;void *p1=0,*p2=0;mh_u32 n1=0,n2=0;void *ds;void **dsvt;PFN_CreateSoundBuffer create;PFN_DSLock lock;PFN_DSUnlock unlock;PFN_DSDuplicate dup;if(slot>=MH_SOUND_SLOT_COUNT||!pcm||!size)return 0;base=(mh_u8 *)(MH_SOUND_SLOTS_BASE+slot*MH_SOUND_SLOT_STRIDE);primary=(void **)(base+4);create=(PFN_CreateSoundBuffer)(void *)MH_SOUND_CREATE_BUFFER;if(!create(primary,size)||!*primary)return 0;lock=(PFN_DSLock)(*(void ***)*primary)[11];unlock=(PFN_DSUnlock)(*(void ***)*primary)[19];if(lock(*primary,0u,size,&p1,&n1,&p2,&n2,0u)!=0u){release_buffer(*primary);*primary=0;return 0;}if(n1)copy_bytes(p1,pcm,n1);if(n2)copy_bytes(p2,pcm+n1,n2);if(unlock(*primary,p1,n1,p2,n2)!=0u){release_buffer(*primary);*primary=0;return 0;}*(mh_u16 *)base=1u;ds=*(void **)MH_DIRECTSOUND_PTR;if(!ds)return 1;dsvt=*(void ***)ds;dup=(PFN_DSDuplicate)dsvt[5];if(dup(ds,*primary,(void **)(base+0x0c))!=0u)*(void **)(base+0x0c)=0;if(dup(ds,*primary,(void **)(base+0x14))!=0u)*(void **)(base+0x14)=0;return 1;}
static int ds_available(void){return *(mh_u32 *)MH_SOUND_ENABLED_PTR!=0u&&*(void **)MH_DIRECTSOUND_PTR!=(void *)0;}
static mh_i32 signed_high_word(mh_i32 world){return (mh_i32)(short)(((mh_u32)world)>>16);}
static int spatial_values(mh_i32 source_x,mh_i32 source_y,int starting,mh_i32 *volume,mh_i32 *pan)
{
    mh_u32 listener_ptr=*(mh_u32 *)MH_SOUND_LISTENER_PTR;mh_i32 listener_x,listener_y,dx,dy,p,v;
    if(!listener_ptr||!volume||!pan)return 0;
    listener_x=(mh_i32)*(short *)(listener_ptr+2u);listener_y=(mh_i32)*(short *)(listener_ptr+6u);
    dx=source_x-listener_x;dy=source_y-listener_y;
    if(starting&&(dx>0x800||dx< -0x800||dy>0x800||dy< -0x800))return 0;
    p=dx*16;if(p>10000)p=10000;if(p< -10000)p=-10000;
    v=dx<0?-dx:dx;if(dy<0)dy=-dy;v=-2*(v+dy);if(v< -10000)v=-10000;
    *volume=v;*pan=p;return 1;
}
static void custom_voice_clear_position(MHCustomSound *sound,mh_u32 index)
{
    if(!sound||index>=MH_CUSTOM_SOUND_VOICES)return;
    sound->position_mode[index]=MH_CUSTOM_POSITION_NONE;sound->source_ptr[index]=0u;sound->owner_ptr[index]=0u;sound->owner_value[index]=0u;sound->fixed_x[index]=0;sound->fixed_y[index]=0;
}
static int custom_voice_apply_position(MHCustomSound *sound,mh_u32 index,int starting)
{
    void *voice;void **vt;mh_i32 x,y,volume,pan;mh_u32 owner;
    if(!sound||index>=MH_CUSTOM_SOUND_VOICES||sound->position_mode[index]==MH_CUSTOM_POSITION_NONE)return 1;
    voice=sound->voices[index];if(!voice)return 0;
    if(sound->position_mode[index]==MH_CUSTOM_POSITION_SOURCE){
        if(!sound->source_ptr[index])return 0;
        if(sound->owner_ptr[index]){owner=*(mh_u32 *)sound->owner_ptr[index];if(owner!=sound->owner_value[index])return 0;}
        x=(mh_i32)*(short *)(sound->source_ptr[index]+2u);y=(mh_i32)*(short *)(sound->source_ptr[index]+6u);
    }else{x=sound->fixed_x[index];y=sound->fixed_y[index];}
    if(!spatial_values(x,y,starting,&volume,&pan))return 0;
    vt=*(void ***)voice;
    if(((PFN_DSSetVolume)vt[15])(voice,volume)!=0u)return 0;
    if(((PFN_DSSetPan)vt[16])(voice,pan)!=0u)return 0;
    return 1;
}
static int wav_read_memory(const mh_u8 *data,mh_u32 size,mh_u32 *pcm_size)
{
    MHWavInfo wav;
    if(!data||!pcm_size||!size)return 0;
    return wav_parse(data,size,&wav)&&wav_convert(&wav,pcm_size);
}
static void custom_release_buffers(MHCustomSound *sound)
{
    mh_u32 i;if(!sound)return;
    for(i=0u;i<MH_CUSTOM_SOUND_VOICES;++i){if(sound->voices[i]){void **vt=*(void ***)sound->voices[i];((PFN_DSStop)vt[18])(sound->voices[i]);release_buffer(sound->voices[i]);sound->voices[i]=0;}custom_voice_clear_position(sound,i);}
    sound->materialized=0;sound->next_voice=0u;
}
static int custom_materialize(MHCustomSound *sound)
{
    PFN_CreateSoundBuffer create;PFN_DSDuplicate dup;void *ds;void **dsvt;void *p1=0,*p2=0;mh_u32 n1=0,n2=0,size=0u,i;PFN_DSLock lock;PFN_DSUnlock unlock;
    if(!sound||!sound->used)return 0;if(sound->materialized)return 1;if(!ds_available()||!(sound->memory?wav_read_memory(sound->memory,sound->memory_size,&size):wav_read_path(sound->path,&size)))return 0;
    create=(PFN_CreateSoundBuffer)(void *)MH_SOUND_CREATE_BUFFER;
    if(!create(&sound->voices[0],size)||!sound->voices[0])return 0;
    lock=(PFN_DSLock)(*(void ***)sound->voices[0])[11];unlock=(PFN_DSUnlock)(*(void ***)sound->voices[0])[19];
    if(lock(sound->voices[0],0u,size,&p1,&n1,&p2,&n2,0u)!=0u){custom_release_buffers(sound);return 0;}
    if(n1)copy_bytes(p1,g_pcm,n1);if(n2)copy_bytes(p2,g_pcm+n1,n2);
    if(unlock(sound->voices[0],p1,n1,p2,n2)!=0u){custom_release_buffers(sound);return 0;}
    ds=*(void **)MH_DIRECTSOUND_PTR;dsvt=*(void ***)ds;dup=(PFN_DSDuplicate)dsvt[5];
    for(i=1u;i<MH_CUSTOM_SOUND_VOICES;++i){if(dup(ds,sound->voices[0],&sound->voices[i])!=0u){custom_release_buffers(sound);return 0;}}
    sound->materialized=1;sound->next_voice=0u;return 1;
}
static mh_u32 custom_handle(mh_u32 index,mh_u32 generation){return (generation<<8)|(index+1u);}
static MHCustomSound *custom_from_handle(mh_u32 handle)
{
    mh_u32 slot=(handle&0xffu),generation=(handle>>8);MHCustomSound *sound;
    if(!slot||slot>MH_CUSTOM_SOUND_MAX||!generation)return (MHCustomSound *)0;sound=&g_custom[slot-1u];
    return sound->used&&sound->generation==generation?sound:(MHCustomSound *)0;
}
static int custom_play(MHCustomSound *sound,mh_u8 position_mode,mh_i32 fixed_x,mh_i32 fixed_y,mh_u32 source_ptr,mh_u32 owner_ptr)
{
    mh_u32 i,index,status=0u;void *voice;void **vt;PFN_DSGetStatus get_status;PFN_DSSetCurrentPosition set_pos;PFN_DSPlay play;
    if(!sound||!custom_materialize(sound))return 0;index=sound->next_voice%MH_CUSTOM_SOUND_VOICES;
    for(i=0u;i<MH_CUSTOM_SOUND_VOICES;++i){mh_u32 candidate=(index+i)%MH_CUSTOM_SOUND_VOICES;voice=sound->voices[candidate];vt=*(void ***)voice;get_status=(PFN_DSGetStatus)vt[9];status=0u;if(get_status(voice,&status)==0u&&!(status&MH_DSBSTATUS_PLAYING)){index=candidate;break;}}
    voice=sound->voices[index];vt=*(void ***)voice;((PFN_DSStop)vt[18])(voice);custom_voice_clear_position(sound,index);
    sound->position_mode[index]=position_mode;sound->fixed_x[index]=fixed_x;sound->fixed_y[index]=fixed_y;sound->source_ptr[index]=source_ptr;sound->owner_ptr[index]=owner_ptr;sound->owner_value[index]=owner_ptr?*(mh_u32 *)owner_ptr:0u;
    if(position_mode==MH_CUSTOM_POSITION_NONE){if(((PFN_DSSetVolume)vt[15])(voice,0)!=0u||((PFN_DSSetPan)vt[16])(voice,0)!=0u)return 0;}
    else if(!custom_voice_apply_position(sound,index,1)){custom_voice_clear_position(sound,index);return 0;}
    set_pos=(PFN_DSSetCurrentPosition)vt[13];play=(PFN_DSPlay)vt[12];
    if(set_pos(voice,0u)!=0u){custom_voice_clear_position(sound,index);return 0;}if(play(voice,0u,0u,0u)!=0u){custom_voice_clear_position(sound,index);return 0;}
    sound->next_voice=(index+1u)%MH_CUSTOM_SOUND_VOICES;return 1;
}
mh_u32 MH_STDCALL MHSoundLoadWav(const char *package_id,const char *relative_path)
{
    const MHPackage *pkg;MHCustomSound *sound;char rel[MH_PACKAGE_PATH_CAP];mh_u32 i,size;
    if(!package_id||!safe_audio_relative(relative_path))return 0u;pkg=MHPackageFind(package_id);if(!pkg)return 0u;
    if(!copy_text_local(rel,sizeof(rel),"assets\\audio\\")||!append_text_local(rel,sizeof(rel),relative_path))return 0u;
    for(i=0u;i<MH_CUSTOM_SOUND_MAX;++i)if(!g_custom[i].used)break;if(i==MH_CUSTOM_SOUND_MAX)return 0u;sound=&g_custom[i];
    if(!MHPackagePath(pkg,rel,sound->path,sizeof(sound->path))||!wav_read_path(sound->path,&size))return 0u;
    sound->memory=(const mh_u8 *)0;sound->memory_size=0u;
    sound->generation=g_next_generation++;if(!sound->generation)sound->generation=g_next_generation++;sound->used=1;sound->materialized=0;sound->next_voice=0u;
    if(ds_available()&&!custom_materialize(sound)){sound->used=0;return 0u;}
    return custom_handle(i,sound->generation);
}
mh_u32 MH_STDCALL MHSoundLoadWavMemory(const mh_u8 *data,mh_u32 size)
{
    MHCustomSound *sound;mh_u32 i,pcm=0u;
    if(!wav_read_memory(data,size,&pcm))return 0u;
    for(i=0u;i<MH_CUSTOM_SOUND_MAX;++i)if(!g_custom[i].used)break;if(i==MH_CUSTOM_SOUND_MAX)return 0u;sound=&g_custom[i];
    sound->memory=data;sound->memory_size=size;sound->path[0]=0;
    sound->generation=g_next_generation++;if(!sound->generation)sound->generation=g_next_generation++;sound->used=1;sound->materialized=0;sound->next_voice=0u;
    if(ds_available()&&!custom_materialize(sound)){sound->used=0;sound->memory=(const mh_u8 *)0;return 0u;}
    return custom_handle(i,sound->generation);
}
int MH_STDCALL MHSoundUnloadWav(mh_u32 handle)
{
    MHCustomSound *sound=custom_from_handle(handle);if(!sound)return 0;custom_release_buffers(sound);sound->used=0;sound->path[0]=0;sound->memory=(const mh_u8 *)0;sound->memory_size=0u;return 1;
}
int MH_STDCALL MHSoundPlayWav(mh_u32 handle)
{
    return custom_play(custom_from_handle(handle),MH_CUSTOM_POSITION_NONE,0,0,0u,0u);
}
int MH_STDCALL MHSoundPlayWavAt(mh_u32 handle,mh_i32 world_x,mh_i32 world_y){return custom_play(custom_from_handle(handle),MH_CUSTOM_POSITION_FIXED,signed_high_word(world_x),signed_high_word(world_y),0u,0u);}
int MH_STDCALL MHSoundPlayWavEntity(mh_u32 handle,mh_u32 source_ptr,mh_u32 owner_ptr){if(!source_ptr)return 0;return custom_play(custom_from_handle(handle),MH_CUSTOM_POSITION_SOURCE,0,0,source_ptr,owner_ptr);}
int MH_STDCALL MHSoundStopWav(mh_u32 handle)
{
    MHCustomSound *sound=custom_from_handle(handle);mh_u32 i;int ok=1;if(!sound)return 0;if(!sound->materialized)return 1;
    for(i=0u;i<MH_CUSTOM_SOUND_VOICES;++i)if(sound->voices[i]){void **vt=*(void ***)sound->voices[i];if(((PFN_DSStop)vt[18])(sound->voices[i])!=0u)ok=0;custom_voice_clear_position(sound,i);}return ok;
}

static void MH_STDCALL custom_sound_frame(const MHHostAPI *host)
{
    mh_u32 si,vi,status;void *voice;void **vt;(void)host;
    for(si=0u;si<MH_CUSTOM_SOUND_MAX;++si){MHCustomSound *sound=&g_custom[si];if(!sound->used||!sound->materialized)continue;
        for(vi=0u;vi<MH_CUSTOM_SOUND_VOICES;++vi){if(sound->position_mode[vi]==MH_CUSTOM_POSITION_NONE||!sound->voices[vi])continue;voice=sound->voices[vi];vt=*(void ***)voice;status=0u;
            if(((PFN_DSGetStatus)vt[9])(voice,&status)!=0u||!(status&MH_DSBSTATUS_PLAYING)){custom_voice_clear_position(sound,vi);continue;}
            if(!custom_voice_apply_position(sound,vi,0)){((PFN_DSStop)vt[18])(voice);custom_voice_clear_position(sound,vi);}
        }
    }
}

static int __cdecl sound_load_hook(const char *sample_name,mh_u32 slot){mh_u32 archive_id=MHResourceFind(sample_name),size=0u;const char *pkg=0,*raw=0;if(load_best_wav(archive_id,&size,&pkg,&raw)&&install_slot(slot,g_pcm,size)){if(g_host){g_host->log("MH sound: WAV replacement applied");if(pkg)g_host->log(pkg);if(raw)g_host->log(raw);}return (int)size;}return g_original_load?g_original_load(sample_name,slot):-1;}
static int ensure_retail_feedback(mh_u32 effect_id,const char *sample_name)
{
    if(effect_id>=MH_SOUND_SLOT_COUNT||!sample_name||!ds_available())return 0;
    if(*(mh_u16 *)(MH_SOUND_SLOTS_BASE+effect_id*MH_SOUND_SLOT_STRIDE))return 1;
    if(MHResourceFind(sample_name)==MH_RESOURCE_INVALID)return 0;
    if(sound_load_hook(sample_name,effect_id)<0)return 0;
    return *(mh_u16 *)(MH_SOUND_SLOTS_BASE+effect_id*MH_SOUND_SLOT_STRIDE)!=0;
}

void MH_STDCALL MHSoundPrepareKeyPickups(void)
{
    static const mh_u32 effects[5]={0x76u,0x74u,0x7Bu,0x70u,0x6Cu};
    mh_u32 i,missing=0,ready=0;
    if(!ds_available())return;
    for(i=0;i<5u;++i) {
        mh_u32 effect=effects[i];
        const char *sample=*(const char **)(0x004864E8u+effect*4u);
        if(!*(mh_u16 *)(MH_SOUND_SLOTS_BASE+effect*MH_SOUND_SLOT_STRIDE))missing=1;
        if(ensure_retail_feedback(effect,sample))++ready;
    }
    if(missing&&ready==5u&&g_host)g_host->log("MH sound: keycard collection voices prepared");
}

int MH_STDCALL MHSoundDoorFeedback(mh_u32 effect_id,const char *sample_name)
{
    typedef void (__cdecl *PFN_Feedback)(mh_u32,mh_u32);
    /* Native key warnings expire after two updates in a busy speech queue.
       Retry on approach until the current voice and queued messages finish. */
    if(*(mh_u32 *)0x006B102Cu||*(mh_u32 *)0x006B1024u)return 0;
    if(!ensure_retail_feedback(effect_id,sample_name))return 0;
    ((PFN_Feedback)(void *)0x0044D4E0u)(effect_id,2u);
    return 1;
}

int MH_STDCALL MHSoundSystemInit(const MHHostAPI *host){static const mh_u8 expected[6]={0x55,0x8b,0xec,0x83,0xec,0x10};mh_u32 tramp=0u;if(!host||!host->symbol||!host->install_detour||!host->register_frame_callback)return 0;g_host=host;{mh_u32 ci,cj;for(ci=0u;ci<MH_CUSTOM_SOUND_MAX;++ci){g_custom[ci].used=0;g_custom[ci].materialized=0;g_custom[ci].generation=0u;g_custom[ci].next_voice=0u;g_custom[ci].path[0]=0;for(cj=0u;cj<MH_CUSTOM_SOUND_VOICES;++cj){g_custom[ci].voices[cj]=0;custom_voice_clear_position(&g_custom[ci],cj);}}}g_create_file=(PFN_CreateFileA)(void *)host->symbol("win32.create_file_a");g_read_file=(PFN_ReadFile)(void *)host->symbol("win32.read_file");g_get_size=(PFN_GetFileSize)(void *)host->symbol("win32.get_file_size");g_close=(PFN_CloseHandle)(void *)host->symbol("win32.close_handle");if(!g_create_file||!g_read_file||!g_get_size||!g_close)return 0;if(!host->install_detour(MH_SOUND_LOAD,expected,6u,(void *)&sound_load_hook,&tramp)){host->log("MH sound: retail sample-load hook signature mismatch");return 0;}g_original_load=(PFN_SoundLoad)(void *)tramp;if(!host->register_frame_callback(custom_sound_frame)){host->log("MH sound: custom spatial updater registration failed");return 0;}host->log("MH sound: WAV replacement loader initialized");return 1;}
