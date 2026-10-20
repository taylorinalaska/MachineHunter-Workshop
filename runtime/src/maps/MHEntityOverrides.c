#include "MHEntityOverrides.h"
#include "mh_catalog_data.h"

/* Map type table: 16 bytes per type, descriptor pointer at +4. */
#define MH_ENTITY_TYPE_TABLE   0x00494548u
#define MH_ENTITY_TYPE_COUNT   150u
/* Actor descriptors (0x20 bytes): maximum health is the u16 at +0x16. */
#define MH_DESCRIPTOR_HEALTH   0x16u
/* The controllable bodies: form f (1..10) has its descriptor at FORM_DESCRIPTORS + (f-1)*0x20.
   Form 1 is the player's own human body and is never changed. */
#define MH_FORM_DESCRIPTORS    0x0047CE40u
#define MH_FORM_COUNT          10u
/* Body profile of form f at BODY_PROFILES + f*0x70 (its first dword points back at the
   descriptor): +0x10 acceleration, +0x14 reverse speed cap, +0x18 forward speed cap,
   +0x20..+0x28 game updates between shots at weapon power 1..3. */
#define MH_BODY_PROFILES       0x0047CFE0u
#define MH_BODY_PROFILE_STRIDE 0x70u
/* Projectile descriptors (0x48 bytes), three per form (one per weapon power level):
   impact damage is the dword at +0x18. */
#define MH_PROJECTILE_STRIDE   0x48u
#define MH_PROJECTILE_DAMAGE   0x18u
/* Descriptors live in the executable's data; anything else is refused. */
#define MH_DATA_LOW            0x00470000u
#define MH_DATA_HIGH           0x004A0000u

/* Per-form animation records (16 bytes, no slot of their own; the actor keeps its
   descriptor's): standing, walking, upper body while walking and while standing
   (0x004134A0 picks these as the body stops and moves), upper body firing (0x00413290)
   and dying (0x004129C0). */
static const mh_u32 k_form_animations[6] = { 0x0047C710u, 0x0047C8B0u, 0x0047C7E0u, 0x0047C980u, 0x0047C640u, 0x0047CBB0u };
#define MH_FORM_ANIMATION_STRIDE 0x10u
/* Descriptor-style animation records (0x1C bytes) start with their sprite slot. */
#define MH_DESCRIPTOR_ANIMATIONS 0x18u

static const mh_u32 k_projectiles[MH_FORM_COUNT + 1u] = {
    0u, 0x0048F030u, 0x0048F108u, 0x0048F1E0u, 0x0048F2B8u, 0x0048F468u,
    0x0048F540u, 0x0048F618u, 0x0048F6F0u, 0x0048F810u, 0x0048F8E8u
};

/* Animations are given per type. When an actor starts an animation the game copies a record
   into one of the actor's own blocks (actor+0x160, actor+0x19C) and never looks at the record
   again: 0x0040A3C0 takes a record with its sprite slot, 0x0040A320 a body form's record
   without one. So the records stay as they are, and the actors of a custom type are handed
   copies with its changes. Actors are told apart by the descriptor they were made from
   (0x00426410's first argument; every actor, map-placed or spawned, is made there). */
#define MH_VA_CREATE_ACTOR        0x00426410u
#define MH_VA_INSTALL_RECORD      0x0040A3C0u
#define MH_VA_INSTALL_FORM_RECORD 0x0040A320u
#define MH_ACTOR_BLOCK_A          0x160u
#define MH_ACTOR_BLOCK_B          0x19Cu
#define MH_MAX_TRACKED_ACTORS     256u

typedef mh_u32 (__cdecl *PFN_CreateActor)(mh_u32 descriptor, mh_u32 a2, mh_u32 actor, mh_u32 a4, mh_u32 a5);
typedef mh_u32 (__cdecl *PFN_InstallRecord)(mh_u32 record, mh_u32 block);

typedef struct MHTypeRecord {
    mh_u32 descriptor;
    mh_u32 record;
    mh_u8 bytes[0x1C];
} MHTypeRecord;

typedef struct MHTrackedActor {
    mh_u32 actor;
    mh_u32 descriptor;
} MHTrackedActor;

static PFN_CreateActor g_create_original;
static PFN_InstallRecord g_install_original;
static PFN_InstallRecord g_install_form_original;
static int g_animation_hooked;
static MHTypeRecord g_type_records[MH_MAX_ENTITY_OVERRIDES * MH_MAX_TYPE_ANIMATIONS];
static mh_u32 g_type_record_count;
static MHTrackedActor g_tracked[MH_MAX_TRACKED_ACTORS];
static mh_u32 g_tracked_count;

typedef struct MHUndo {
    mh_u32 address;
    mh_u32 original;
    mh_u32 size;
} MHUndo;

/* Per override: health, three speed fields, three fire intervals and three damages. */
static MHUndo g_undo[MH_MAX_ENTITY_OVERRIDES * 10u];
static mh_u32 g_undo_count;

static int patch(const MHHostAPI *api, mh_u32 address, mh_u32 value, mh_u32 size)
{
    mh_u32 original=0;
    if (g_undo_count>=sizeof(g_undo)/sizeof(g_undo[0])) return 0;
    if (!api->read_memory(address,&original,size)) return 0;
    if (!api->write_memory(address,&value,size)) return 0;
    g_undo[g_undo_count].address=address;
    g_undo[g_undo_count].original=original;
    g_undo[g_undo_count].size=size;
    ++g_undo_count;
    return 1;
}

static mh_u32 scale(mh_u32 value, mh_u32 pct)
{
    mh_u32 out=value*pct/100u;
    return value && !out ? 1u : out;
}

static int descriptor_of(const MHHostAPI *api, mh_u32 type, mh_u32 *out)
{
    mh_u32 d=0;
    if (type==0u || type>=MH_ENTITY_TYPE_COUNT) return 0;
    if (!api->read_memory(MH_ENTITY_TYPE_TABLE+type*16u+4u,&d,4)) return 0;
    if (d<MH_DATA_LOW || d+0x20u>MH_DATA_HIGH) return 0;
    *out=d;
    return 1;
}

/* The robot body (2..10) a descriptor belongs to, or 0. */
static mh_u32 form_of(mh_u32 descriptor)
{
    mh_u32 f;
    for (f=2u;f<=MH_FORM_COUNT;++f) if (descriptor==MH_FORM_DESCRIPTORS+(f-1u)*0x20u) return f;
    return 0u;
}

/* Whether `record` is a per-form record of `form`. */
static int form_record(mh_u32 form, mh_u32 record)
{
    mh_u32 i;
    if (!form) return 0;
    for (i=0;i<sizeof(k_form_animations)/sizeof(k_form_animations[0]);++i) if (record==k_form_animations[i]+form*MH_FORM_ANIMATION_STRIDE) return 1;
    return 0;
}

/* The sprite slots a descriptor draws from (its two animation records), or 0xFFFF. */
static void descriptor_slots(const MHHostAPI *api, mh_u32 d, mh_u32 *a, mh_u32 *b)
{
    mh_u32 record=0;
    mh_u16 slot=0;
    *a=*b=0xFFFFu;
    if (api->read_memory(d+MH_DESCRIPTOR_ANIMATIONS,&record,4) && record>=MH_DATA_LOW && record+0x1Cu<=MH_DATA_HIGH && api->read_memory(record,&slot,2)) *a=slot;
    if (api->read_memory(d+MH_DESCRIPTOR_ANIMATIONS+4u,&record,4) && record>=MH_DATA_LOW && record+0x1Cu<=MH_DATA_HIGH && api->read_memory(record,&slot,2)) *b=slot;
}

static int names_equal(const char *a, const char *b)
{
    while (*a && *b) {
        char x=*a++, y=*b++;
        if (x>='a'&&x<='z') x=(char)(x-32);
        if (y>='a'&&y<='z') y=(char)(y-32);
        if (x!=y) return 0;
    }
    return *a==*b;
}

/* Frames in the sprite file a level loads into a slot. */
static mh_u32 retail_frames(mh_u32 level, mh_u32 slot)
{
    mh_u32 i,j;
    if (level>=MH_STAGE_CATALOG_COUNT) return 0;
    for (i=MH_STAGE_SPRITE_OFFSETS[level];i<(mh_u32)MH_STAGE_SPRITE_OFFSETS[level]+MH_STAGE_SPRITE_COUNTS[level];++i) {
        if (MH_STAGE_SPRITES[i].runtime_slot!=slot) continue;
        for (j=0;j<MH_SPRITE_CONTAINER_COUNT;++j) if (names_equal(MH_SPRITE_CONTAINERS[j].name,MH_STAGE_SPRITES[i].name)) return MH_SPRITE_CONTAINERS[j].frames;
    }
    return 0;
}

int MHEntityOverrideAnimationsValid(const MHHostAPI *api, const MHEntityOverride *o, mh_u32 level, const mh_u32 *package_frames)
{
    mh_u32 d,form,slot_a,slot_b,i;
    if (!o->animation_count) return 1;
    if (!g_animation_hooked || o->animation_count>MH_MAX_TYPE_ANIMATIONS || !descriptor_of(api,o->type,&d)) return 0;
    form=form_of(d);
    descriptor_slots(api,d,&slot_a,&slot_b);
    for (i=0;i<o->animation_count;++i) {
        const MHAnimationOverride *a=&o->animations[i];
        mh_u32 slot,frames,mode_word=0;
        mh_u16 record_slot=0;
        if (a->record<MH_DATA_LOW || a->record+0x1Cu>MH_DATA_HIGH || (a->record&1u)) return 0;
        if (form_record(form,a->record)) {
            slot=slot_a;
            if (!api->read_memory(a->record,&mode_word,2)) return 0;
        } else {
            if (!api->read_memory(a->record,&record_slot,2) || !api->read_memory(a->record+2u,&mode_word,2)) return 0;
            slot=record_slot;
            if (slot!=slot_a && slot!=slot_b) return 0;
        }
        if (slot>255u) return 0;
        frames=package_frames[slot] ? package_frames[slot] : retail_frames(level,slot);
        if (!frames || !a->span || a->base+a->span>frames || a->start>=a->span || !a->ticks || a->ticks>255u) return 0;
        /* Modes 4..6 hand over to game code when they end: keep them. Otherwise hold, loop or back and forth. */
        if ((mode_word&0x0Fu)>=4u ? a->mode!=(mode_word&0x0Fu) : (a->mode<1u || a->mode>3u)) return 0;
    }
    return 1;
}

int MHEntityOverrideTypeSupported(const MHHostAPI *api, mh_u32 type)
{
    mh_u32 d;
    return descriptor_of(api,type,&d) && d!=MH_FORM_DESCRIPTORS;
}

int MHEntityOverridesApply(const MHHostAPI *api, const MHEntityOverride *list, mh_u32 count)
{
    mh_u32 done[MH_MAX_ENTITY_OVERRIDES];
    mh_u32 done_count=0u,i,j,k;
    int ok=1;
    if (!api || count>MH_MAX_ENTITY_OVERRIDES) return 0;
    for (i=0;i<count;++i) {
        const MHEntityOverride *o=&list[i];
        mh_u32 d,form,value;
        int seen=0;
        if (!descriptor_of(api,o->type,&d) || d==MH_FORM_DESCRIPTORS) { ok=0; continue; }
        /* Types that share a descriptor share their numbers: change it once. */
        for (j=0;j<done_count;++j) if (done[j]==d) seen=1;
        if (seen) continue;
        done[done_count++]=d;
        if (o->health && !patch(api,d+MH_DESCRIPTOR_HEALTH,o->health,2)) ok=0;
        form=form_of(d);
        if (!form) continue;
        if (o->speed_pct!=100u) {
            mh_u32 profile=MH_BODY_PROFILES+form*MH_BODY_PROFILE_STRIDE;
            for (k=0x10u;k<=0x18u;k+=4u) {
                if (!api->read_memory(profile+k,&value,4) || !patch(api,profile+k,scale(value,o->speed_pct),4)) ok=0;
            }
        }
        if (o->fire_rate_pct!=100u) {
            mh_u32 profile=MH_BODY_PROFILES+form*MH_BODY_PROFILE_STRIDE;
            for (k=0x20u;k<=0x28u;k+=4u) {
                /* A higher rate is a shorter wait between shots. */
                if (!api->read_memory(profile+k,&value,4) || !patch(api,profile+k,scale(value,10000u/o->fire_rate_pct),4)) ok=0;
            }
        }
        if (o->damage_pct!=100u) {
            for (k=0;k<3u;++k) {
                mh_u32 at=k_projectiles[form]+k*MH_PROJECTILE_STRIDE+MH_PROJECTILE_DAMAGE;
                if (!api->read_memory(at,&value,4) || !patch(api,at,scale(value,o->damage_pct),4)) ok=0;
            }
        }
    }
    /* Animations: copies of the records with the type's changes, handed to its actors as they start them. */
    g_tracked_count=0u;
    g_type_record_count=0u;
    for (i=0;i<count;++i) {
        mh_u32 d,form;
        if (!list[i].animation_count) continue;
        if (!g_animation_hooked || !descriptor_of(api,list[i].type,&d)) { ok=0; continue; }
        form=form_of(d);
        for (j=0;j<list[i].animation_count;++j) {
            const MHAnimationOverride *a=&list[i].animations[j];
            MHTypeRecord *r=&g_type_records[g_type_record_count];
            /* Per-form records are 16 bytes and start with the mode word; descriptor records are 0x1C and start with the slot. */
            int form_rec=form_record(form,a->record);
            mh_u32 size=form_rec ? 0x10u : 0x1Cu, mode_at=form_rec ? 0u : 2u;
            mh_u32 mode_word;
            if (g_type_record_count>=sizeof(g_type_records)/sizeof(g_type_records[0]) || !api->read_memory(a->record,r->bytes,size)) { ok=0; continue; }
            mode_word=(mh_u32)r->bytes[mode_at]|((mh_u32)r->bytes[mode_at+1u]<<8);
            mode_word=(mode_word&~0x800Fu)|(a->mode&0x0Fu)|(a->reversed?0x8000u:0u);
            r->bytes[mode_at]=(mh_u8)mode_word; r->bytes[mode_at+1u]=(mh_u8)(mode_word>>8);
            r->bytes[0x08]=(mh_u8)a->start; r->bytes[0x09]=(mh_u8)(a->start>>8);
            r->bytes[0x0A]=(mh_u8)a->base;  r->bytes[0x0B]=(mh_u8)(a->base>>8);
            r->bytes[0x0C]=(mh_u8)a->span;  r->bytes[0x0D]=(mh_u8)(a->span>>8);
            r->bytes[0x0E]=(mh_u8)a->ticks; r->bytes[0x0F]=(mh_u8)(a->ticks>>8);
            r->descriptor=d;
            r->record=a->record;
            ++g_type_record_count;
        }
    }
    return ok;
}

void MHEntityOverridesRestore(const MHHostAPI *api)
{
    if (!api) return;
    g_type_record_count=0u;
    g_tracked_count=0u;
    while (g_undo_count) {
        --g_undo_count;
        api->write_memory(g_undo[g_undo_count].address,&g_undo[g_undo_count].original,g_undo[g_undo_count].size);
    }
}

/* The copy of `record` for the actor whose block is `block`, or 0. */
static mh_u32 type_record(mh_u32 record, mh_u32 block)
{
    mh_u32 i,j;
    for (i=0;i<g_tracked_count;++i) {
        mh_u32 actor=g_tracked[i].actor;
        if (block!=actor+MH_ACTOR_BLOCK_A && block!=actor+MH_ACTOR_BLOCK_B) continue;
        for (j=0;j<g_type_record_count;++j)
            if (g_type_records[j].descriptor==g_tracked[i].descriptor && g_type_records[j].record==record) return (mh_u32)(void *)g_type_records[j].bytes;
        return 0u;
    }
    return 0u;
}

static mh_u32 __cdecl create_actor_hook(mh_u32 descriptor, mh_u32 a2, mh_u32 actor, mh_u32 a4, mh_u32 a5)
{
    mh_u32 i;
    if (g_type_record_count) {
        /* Actors are reused: forget whatever this one was before. */
        for (i=0;i<g_tracked_count;++i) if (g_tracked[i].actor==actor) { g_tracked[i]=g_tracked[--g_tracked_count]; break; }
        for (i=0;i<g_type_record_count;++i) if (g_type_records[i].descriptor==descriptor) break;
        if (i<g_type_record_count && g_tracked_count<MH_MAX_TRACKED_ACTORS) {
            g_tracked[g_tracked_count].actor=actor;
            g_tracked[g_tracked_count].descriptor=descriptor;
            ++g_tracked_count;
        }
    }
    return g_create_original(descriptor,a2,actor,a4,a5);
}

static mh_u32 __cdecl install_hook(mh_u32 record, mh_u32 block)
{
    mh_u32 copy=g_type_record_count ? type_record(record,block) : 0u;
    return g_install_original(copy ? copy : record,block);
}

static mh_u32 __cdecl install_form_hook(mh_u32 record, mh_u32 block)
{
    mh_u32 copy=g_type_record_count ? type_record(record,block) : 0u;
    return g_install_form_original(copy ? copy : record,block);
}

int MHEntityAnimationsInit(const MHHostAPI *api)
{
    static const mh_u8 create_expected[6]={0x53,0x56,0x8B,0x74,0x24,0x14};
    static const mh_u8 install_expected[6]={0x53,0x56,0x8B,0x74,0x24,0x10};
    static const mh_u8 install_form_expected[6]={0x8B,0x4C,0x24,0x04,0x85,0xC9};
    mh_u32 create=0,install=0,install_form=0;
    if (g_animation_hooked) return 1;
    if (!api->install_detour(MH_VA_CREATE_ACTOR,create_expected,6u,(void *)&create_actor_hook,&create)) return 0;
    g_create_original=(PFN_CreateActor)create;
    if (!api->install_detour(MH_VA_INSTALL_RECORD,install_expected,6u,(void *)&install_hook,&install)) return 0;
    g_install_original=(PFN_InstallRecord)install;
    if (!api->install_detour(MH_VA_INSTALL_FORM_RECORD,install_form_expected,6u,(void *)&install_form_hook,&install_form)) return 0;
    g_install_form_original=(PFN_InstallRecord)install_form;
    g_animation_hooked=1;
    return 1;
}
