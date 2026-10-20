/* Behavioral tests of custom-map key retention and approach feedback. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "MHSwitches.h"
#include "MHAPI.h"

static MHAPI mh;
static mh_u32 access_mask, feedback_count, open_count;
void MHTestOpenSequence(mh_u32 cell,mh_u32 layer,const mh_i32 *position)
{ assert(cell==0x200000u);assert(layer==0x100104u);assert(position[0]==128L*65536L);++open_count; }
static int feedback_ready;
static mh_i32 player_y=358L*65536L;
static mh_i32 player_x=128L*65536L;
static mh_u16 panel_mask=0x0FF0u;
static int MH_STDCALL read_memory(mh_u32 address,void *out,mh_u32 size)
{
    mh_u32 value=0;
    if(address==0x004A09D4u)value=access_mask;
    else if(address==0x00656958u)value=0x100000u;
    else if(address==0x100020u)value=0x100u;
    else if(address==0x100100u)value=1u;
    else if(address==0x100118u||address==0x10011Cu)value=8u;
    else if(address==0x100160u)value=0x200000u;
    else if(address==0x200000u)value=1u;
    else if(address==0x004B6414u)value=0x300000u;
    else if(address==0x300008u)value=0x1005u;
    else if(address==0x30000Au)value=panel_mask;
    memcpy(out,&value,size);return 1;
}
static int MH_STDCALL write_memory(mh_u32 address,const void *data,mh_u32 size)
{
    if(address==0x004A09D4u){assert(size==4u);memcpy(&access_mask,data,size);}return 1;
}
static void MH_STDCALL log_message(const char *message){(void)message;}
static int MH_STDCALL loaded(void){return 1;}
static MHEntity MH_STDCALL player(void){return 1u;}
static int MH_STDCALL cell(MHEntity entity,MHCellState *state)
{
    (void)entity;memset(state,0,sizeof(*state));state->y=1;return 1;
}
static int MH_STDCALL entity_get(MHEntity entity,MHEntityState *state)
{
    (void)entity;memset(state,0,sizeof(*state));state->position.x=player_x;state->position.y=player_y;return 1;
}
static int MH_STDCALL sound_get(MHU32 effect,MHSoundEffectInfo *info)
{
    info->effect_id=effect;info->sample_name="ENG_006B.RAW";return 1;
}
const MHAPI *MH_STDCALL MHAPIGet(void){return &mh;}
void MHEffectBurst(const MHEffectEmitter *effect){(void)effect;}
int MH_STDCALL MHSoundDoorFeedback(mh_u32 effect,const char *sample)
{
    assert(effect==0x77u);assert(strcmp(sample,"ENG_006B.RAW")==0);if(!feedback_ready)return 0;++feedback_count;return 1;
}
int main(void)
{
    MHHostAPI host;
    MHSwitchDoor door={0,0,0,0,1,1};
    memset(&host,0,sizeof(host));memset(&mh,0,sizeof(mh));
    host.read_memory=read_memory;host.write_memory=write_memory;host.log=log_message;
    mh.map.loaded=loaded;mh.map.entity_cell=cell;mh.entities.player=player;mh.entities.get=entity_get;mh.sound.retail_get=sound_get;
    MHSwitchesArm(0,0,&door,1,0,0,0,0);
    MHSwitchesFrame(&host);assert(feedback_count==0u);
    feedback_ready=1;MHSwitchesFrame(&host);assert(feedback_count==1u);
    MHSwitchesFrame(&host);assert(feedback_count==1u);
    player_y=384L*65536L;MHSwitchesFrame(&host);
    player_y=358L*65536L;MHSwitchesFrame(&host);assert(feedback_count==2u);
    access_mask=1u;MHSwitchesFrame(&host);assert(feedback_count==2u);assert(open_count==1u);
    panel_mask=0u;MHSwitchesFrame(&host);assert(open_count==2u);
    player_y=384L*65536L;MHSwitchesFrame(&host);assert(open_count==2u);
    player_y=358L*65536L;panel_mask=0x0FF0u;
    access_mask=0u;MHSwitchesFrame(&host);assert(access_mask==1u);assert(feedback_count==2u);
    MHSwitchesRevokeKeys(1u);access_mask=0u;MHSwitchesFrame(&host);assert(access_mask==0u);assert(feedback_count==3u);
    access_mask=1u;MHSwitchesFrame(&host);
    MHSwitchesResetKeys();access_mask=0u;MHSwitchesFrame(&host);assert(access_mask==0u);
    panel_mask=0x9FF9u;access_mask=1u;
    MHSwitchesArm(0,0,&door,1,0,0,0,0);
    { mh_u32 before=open_count;MHSwitchesFrame(&host);assert(open_count==before+1u); }
    door.lock=0;access_mask=0;
    MHSwitchesArm(0,0,&door,1,0,0,0,0);
    { mh_u32 before=open_count;MHSwitchesFrame(&host);assert(open_count==before+1u); }
    door.axis=2;player_x=358L*65536L;player_y=128L*65536L;panel_mask=0xFFFFu;
    MHSwitchesArm(0,0,&door,1,0,0,0,0);
    { mh_u32 before=open_count;MHSwitchesFrame(&host);assert(open_count==before+1u); }
    { mh_u32 gate; for(gate=1;gate<=31u;++gate) {
        mh_u32 before=open_count;
        door.lock=gate;access_mask=1u<<(gate-1u);
        MHSwitchesArm(0,0,&door,1,0,0,0,0);MHSwitchesFrame(&host);
        assert(open_count==before+1u);
    } }
    puts("PASS: retained key after unexpected clear; explicit revocation; fresh map reset; feedback once per approach; no warning with key; approach opens authorized door through animation and ignores distant player");
    return 0;
}
