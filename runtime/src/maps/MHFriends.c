#include "MHFriends.h"
#include "mh.h"
#include "MHAPI.h"

/* Targeting, as Developer Tools' passive enemies hooks it (mods/dev-tools/mod.c): 0x00429030
   builds every actor's relation to one player slot (target at actor+0xA0+slot*0x18), and
   0x00448440 asks whether an actor can see a player. A friend gets neither. */
#define MH_VA_UPDATE_PLAYER_RELATIONS 0x00429030u
#define MH_VA_SEARCH_PLAYER           0x00448440u
#define MH_RELATION_TABLE             0xA0u
#define MH_RELATION_STRIDE            0x18u
#define MH_PLAYER_SLOTS               8u

#define MH_MAP_BUFFER_PTR             0x00656958u
#define MH_MAP_BUFFER_CAP             0x50000u
#define MH_UPDATE_COUNTER             0x004AFE90u
#define MH_CURRENT_GROUP              0x004B6434u
#define MH_ACTOR_ACTIVE               0x58u

#define CELL                          256
/* About half the screen across is 3.7 cells: a friend further off than this is out of sight. */
#define MH_FRIEND_LEASH               (5 * CELL)
/* Spots it walks to: round a point of the player's trail a cell behind, within this much. */
#define MH_FRIEND_JITTER              (CELL / 2)
/* Close enough to its spot: stop there instead of circling it. */
#define MH_FRIEND_ARRIVED             (CELL / 3)
#define MH_FRIEND_BEHIND              CELL
/* 64 spots a quarter of a cell apart: sixteen cells of where the player has been. */
#define MH_TRAIL                      64u
/* Closer than this to the player, a friend idles and wanders; further, it walks the trail. */
#define MH_FRIEND_NEAR                (7 * CELL / 4)
/* How far ahead along the trail a walking friend aims. */
#define MH_FRIEND_STRIDE              (3 * CELL / 4)
/* Not having got this much closer in STUCK_UPDATES while catching up means stuck. */
#define MH_FRIEND_STUCK_GAIN          (CELL / 4)
#define MH_FRIEND_STUCK_UPDATES       60u
#define MH_ACTOR_HEALTH               0x234u

typedef void   (__cdecl *PFN_UpdateRelations)(mh_u32 player_slot);
typedef mh_u32 (__cdecl *PFN_SearchPlayer)(mh_u32 query_actor, mh_u32 facing, mh_u32 angle, mh_u32 distance);

static PFN_UpdateRelations g_relations_original;
static PFN_SearchPlayer g_search_original;
static int g_hooked;
/* Friends and enemies fight each other. Cleared to make friends merely harmless. */
static int g_fight=1;

static MHFriend *g_friends;
static mh_u32 g_count;
/* Actor addresses of the friends now in play, for the hooks. */
static volatile mh_u32 g_actors[MH_MAX_FRIENDS];

static struct { mh_i32 x, y, z; mh_u32 group, layer; } g_trail[MH_TRAIL];
static mh_u32 g_trail_count, g_trail_next;
static mh_u32 g_last_counter;
/* Game update at which the player arrived in the area they are in. */
static mh_u32 g_arrived_at, g_arrived_group=0xFFFFFFFFu;
static int g_have_counter, g_resolved;
static mh_u32 g_seed=0x9E3779B9u;

static mh_u32 next_random(void)
{
    g_seed=g_seed*1664525u+1013904223u;
    return g_seed>>8;
}


/* The player records (8, from 0x006203D8) and the world's actors (40, from 0x00621978) are
   one array of 0x2B4-byte actors. +0x58 is non-zero while one is in play; bit 0x4000 of it
   marks an actor whose AI takes targets. */
#define MH_ACTORS_BASE        0x006203D8u
#define MH_ACTOR_STRIDE       0x2B4u
#define MH_PLAYER_RECORDS     8u
#define MH_WORLD_ACTORS       40u
#define MH_ACTOR_TAKES_TARGET 0x4000u
/* 0x00428EF0 (thunk 0x00402027) fills a relation from one actor to another: heading at +4,
   3D distance at +8 (in map units), horizontal at +0xC, height at +0x10, and clears +0x14.
   The updater passes (actor, player, actor.w17E - player.w1BA, relation) and then stores the
   player at +0. 0x00401FC8 (thunk) traces the line of sight for a relation and leaves -1 at
   +0x14 when it is clear. The player search uses a scratch relation at 0x006AC520. */
#define MH_VA_RELATION        0x00402027u
#define MH_VA_LINE_OF_SIGHT   0x00401FC8u
#define MH_SCRATCH_RELATION   0x006AC520u
/* Players in the game, the number of relation slots the AI looks at. */
#define MH_PLAYER_COUNT       0x00489A70u
/* How far a friend looks for enemies, and an enemy for friends: about what the game gives robots. */
#define MH_FIGHT_REACH        (8 * CELL)
/* A friendly robot fights with the game's own robot combat AI: the scheduled controller at
   actor+0x88 (called with the actor in 0x006285B8) is switched to 0x004143D0 (thunk
   0x004024AA, what the standard robot's auxiliary definition installs), whose high-level
   substate is the word at +0x266, and back to whatever it had once the enemies are gone.
   The route controller a friend walks with (0x004146A0) only turns to face a target. */
#define MH_ACTOR_AI           0x88u
#define MH_ACTOR_AI_SUBSTATE  0x266u
#define MH_COMBAT_AI          0x004024AAu
/* Fight within this distance of a friend; give up once it is this far from the player. */
#define MH_FRIEND_ENGAGE      (5 * CELL)
#define MH_FRIEND_DISENGAGE   (6 * CELL)
/* Back to following after this many updates with no enemy in reach. */
#define MH_FRIEND_CALM        45u

static mh_i32 distance(mh_i32 dx, mh_i32 dy);

/* Sides. Every actor carries a tag at +0x98 that its shots carry too (the fire code passes it
   on): players 0x80000000 + slot, a robot a small number of its own (seen: 1 and 2). The hit
   test 0x00447A60 (thunk 0x004023FB; args: actor, radius, the target's tag) skips a shot whose
   owner tag equals the target's; tests a shot from a player tag or from 0x7FFFFFFF against
   anyone; and any other shot only against players. So robots only ever hit players.
   Friends keep their own tags (giving one 0x7FFFFFFF crashed the game); instead, around each
   hit test the runtime gives friends' shots a tag for the occasion:
   - testing an enemy: 0x7FFFFFFF, so friends' shots hit it;
   - testing a friend: the friend is tested as player slot 7, so enemies' shots hit it, and
     friends' shots carry that same tag, so they pass through friends;
   - testing the player: nothing, as robots' tags never hit players. */
#define MH_ACTOR_SIDE         0x98u
#define MH_SIDE_PLAYER        0x80000000u
#define MH_SIDE_ANYONE        0x7FFFFFFFu
/* What a friend is tested as: a player tag of the spare slot 7. */
#define MH_SIDE_AS_PLAYER     0x80000007u
#define MH_VA_HIT_TEST        0x00447A60u
/* Live shots: 64 records 0xDC apart; from each record's base, +0x58 is non-zero while it flies
   and +0x78 is its owner's tag. */
#define MH_SHOTS              0x006A8DD0u
#define MH_SHOT_COUNT         64u
#define MH_SHOT_STRIDE        0xDCu
#define MH_SHOT_ACTIVE        0x58u
#define MH_SHOT_OWNER         0x78u

typedef mh_u32 (__cdecl *PFN_HitTest)(mh_u32 actor, mh_u32 radius, mh_u32 side);
static PFN_HitTest g_hit_test_original;

typedef void (__cdecl *PFN_Relation)(mh_u32 from, mh_u32 to, mh_i32 height, mh_u32 relation);
typedef void (__cdecl *PFN_LineOfSight)(mh_u32 from, mh_u32 relation);

static int is_friend(mh_u32 actor)
{
    mh_u32 i;
    if (!actor) return 0;
    for (i=0;i<g_count;++i) if (g_actors[i]==actor) return 1;
    return 0;
}

#define ACTOR(i)      (MH_ACTORS_BASE+(i)*MH_ACTOR_STRIDE)
#define FIELD(a,o,t)  (*(volatile t *)((a)+(o)))

/* An actor in play whose AI takes targets, that is not a friend: an enemy. */
static int is_enemy(mh_u32 actor)
{
    mh_u32 flags=FIELD(actor,MH_ACTOR_ACTIVE,mh_u32);
    return flags && (flags&MH_ACTOR_TAKES_TARGET) && !is_friend(actor);
}

static void relate(mh_u32 from, mh_u32 to, mh_u32 relation)
{
    mh_i32 height=(mh_i32)FIELD(from,0x17Eu,short)-(mh_i32)FIELD(to,0x1BAu,short);
    ((PFN_Relation)MH_VA_RELATION)(from,to,height,relation);
    FIELD(relation,0,mh_u32)=to;
}

/* The nearest actor of `want` (1 enemies, 0 friends) to `actor`, within `reach`, or 0. */
static mh_u32 nearest(mh_u32 actor, int want, mh_i32 reach, mh_i32 *how_far)
{
    mh_u32 i,best=0;
    mh_i32 ax=FIELD(actor,0,mh_i32)>>16,ay=FIELD(actor,4,mh_i32)>>16,best_d=reach;
    for (i=0;i<MH_WORLD_ACTORS;++i) {
        mh_u32 other=ACTOR(MH_PLAYER_RECORDS+i);
        mh_i32 d;
        if (other==actor || !FIELD(other,MH_ACTOR_ACTIVE,mh_u32)) continue;
        if (want ? !is_enemy(other) : !is_friend(other)) continue;
        if (FIELD(other,MH_ACTOR_HEALTH,mh_i32)<=0) continue;
        d=distance((FIELD(other,0,mh_i32)>>16)-ax,(FIELD(other,4,mh_i32)>>16)-ay);
        if (d<best_d) { best_d=d; best=other; }
    }
    if (how_far) *how_far=best_d;
    return best;
}

/* After the game has related every actor to player slot 0: a friend's target is the nearest
   enemy instead of the player (or nothing), and an enemy turns on a friend that is nearer
   than the player. Only slot 0 matters in a one-player game; the AI looks at as many slots
   as there are players. */
static void __cdecl relations_hook(mh_u32 player_slot)
{
    mh_u32 i;
    if (g_relations_original) g_relations_original(player_slot);
    if (player_slot>=MH_PLAYER_SLOTS || !g_count) return;
    for (i=0;i<MH_WORLD_ACTORS;++i) {
        mh_u32 actor=ACTOR(MH_PLAYER_RECORDS+i);
        mh_u32 relation=actor+MH_RELATION_TABLE+player_slot*MH_RELATION_STRIDE;
        mh_u32 flags=FIELD(actor,MH_ACTOR_ACTIVE,mh_u32),target;
        mh_i32 d=0;
        if (!flags || !(flags&MH_ACTOR_TAKES_TARGET)) continue;
        if (is_friend(actor)) {
            target=player_slot==0 && g_fight ? nearest(actor,1,MH_FIGHT_REACH,&d) : 0u;
            if (target) relate(actor,target,relation);
            else FIELD(relation,0,mh_u32)=0u;
        } else if (player_slot==0 && g_fight) {
            target=nearest(actor,0,MH_FIGHT_REACH,&d);
            /* The relation to the player holds its 3D distance at +8, in map units. */
            if (target && (!FIELD(relation,0,mh_u32) || d<FIELD(relation,8,mh_i32))) relate(actor,target,relation);
        }
    }
}

/* Whether a shot's owner tag is a friend's. */
static int friend_shot(mh_u32 owner)
{
    mh_u32 i;
    for (i=0;i<g_count;++i) if (g_actors[i] && FIELD(g_actors[i],MH_ACTOR_SIDE,mh_u32)==owner) return 1;
    return 0;
}

static mh_u32 __cdecl hit_test_hook(mh_u32 actor, mh_u32 radius, mh_u32 side)
{
    mh_u32 k,changed[MH_SHOT_COUNT],owner[MH_SHOT_COUNT],n=0,result,as,test;
    if (!g_hit_test_original) return 0u;
    if (!g_count || !g_fight || (side&MH_SIDE_PLAYER)) return g_hit_test_original(actor,radius,side);
    if (is_friend(actor)) { test=MH_SIDE_AS_PLAYER; as=MH_SIDE_AS_PLAYER; }
    else { test=side; as=MH_SIDE_ANYONE; }
    for (k=0;k<MH_SHOT_COUNT;++k) {
        mh_u32 shot=MH_SHOTS+k*MH_SHOT_STRIDE,o;
        if (!FIELD(shot,MH_SHOT_ACTIVE,mh_u32)) continue;
        o=FIELD(shot,MH_SHOT_OWNER,mh_u32);
        if (o&MH_SIDE_PLAYER || o==MH_SIDE_ANYONE || !friend_shot(o)) continue;
        FIELD(shot,MH_SHOT_OWNER,mh_u32)=as;
        changed[n]=shot; owner[n]=o; ++n;
    }
    result=g_hit_test_original(actor,radius,test);
    for (k=0;k<n;++k) if (FIELD(changed[k],MH_SHOT_OWNER,mh_u32)==as) FIELD(changed[k],MH_SHOT_OWNER,mh_u32)=owner[k];
    return result;
}

/* 0x00448440's test for one candidate: within the angle either side of `facing`, nearer than
   `reach`, and in sight. Leaves the distance in *how_far. */
static int can_see(mh_u32 candidate, mh_u32 query, mh_u32 facing, mh_u32 angle, mh_i32 reach, mh_i32 *how_far)
{
    mh_u32 turn;
    ((PFN_Relation)MH_VA_RELATION)(candidate,query,0,MH_SCRATCH_RELATION);
    turn=(FIELD(MH_SCRATCH_RELATION,4,mh_u32)-facing)&0x7FFu;
    if (turn>0x400u) turn=0x800u-turn;
    if (turn>=angle || FIELD(MH_SCRATCH_RELATION,8,mh_i32)>=reach) return 0;
    FIELD(MH_SCRATCH_RELATION,0,mh_u32)=query;
    ((PFN_LineOfSight)MH_VA_LINE_OF_SIGHT)(candidate,MH_SCRATCH_RELATION);
    if (FIELD(MH_SCRATCH_RELATION,0x14,mh_i32)!=-1) return 0;
    *how_far=FIELD(MH_SCRATCH_RELATION,8,mh_i32);
    return 1;
}

/* "Can this actor see someone to fight?" A friend sees enemies, not the player; an enemy
   sees the player and friends, whichever is nearer. */
static mh_u32 __cdecl search_hook(mh_u32 query_actor, mh_u32 facing, mh_u32 angle, mh_u32 reach)
{
    mh_u32 i,best=0,want;
    mh_i32 best_d=(mh_i32)reach,d;
    int friend_query=is_friend(query_actor);
    if (!g_count || !g_fight) {
        if (friend_query) return 0u;
        return g_search_original ? g_search_original(query_actor,facing,angle,reach) : 0u;
    }
    if (!friend_query) {
        best=g_search_original ? g_search_original(query_actor,facing,angle,reach) : 0u;
        /* The original keeps its distance to itself; measure it again. */
        if (best && !can_see(best,query_actor,facing,angle,(mh_i32)reach,&best_d)) best_d=(mh_i32)reach;
    }
    want=friend_query ? 1u : 0u;
    for (i=0;i<MH_WORLD_ACTORS;++i) {
        mh_u32 other=ACTOR(MH_PLAYER_RECORDS+i);
        if (other==query_actor || !FIELD(other,MH_ACTOR_ACTIVE,mh_u32) || FIELD(other,MH_ACTOR_HEALTH,mh_i32)<=0) continue;
        if (want ? !is_enemy(other) : !is_friend(other)) continue;
        if (can_see(other,query_actor,facing,angle,best_d,&d)) { best=other; best_d=d; }
    }
    return best;
}

int MHFriendsInit(const MHHostAPI *api)
{
    static const mh_u8 relations_expected[8]={0x55,0x8B,0x6C,0x24,0x08,0x8B,0xC5,0x56};
    static const mh_u8 search_expected[8]={0x83,0xEC,0x08,0x53,0x8B,0x5C,0x24,0x14};
    static const mh_u8 hit_test_expected[7]={0x83,0xEC,0x14,0x53,0x55,0x56,0x57};
    mh_u32 tramp=0;
    if (g_hooked) return 1;
    if (!api->install_detour(MH_VA_UPDATE_PLAYER_RELATIONS,relations_expected,8u,(void *)&relations_hook,&tramp)) return 0;
    g_relations_original=(PFN_UpdateRelations)tramp;
    tramp=0;
    if (!api->install_detour(MH_VA_SEARCH_PLAYER,search_expected,8u,(void *)&search_hook,&tramp)) return 0;
    g_search_original=(PFN_SearchPlayer)tramp;
    tramp=0;
    /* Without it friends still fight; their stray shots can then hurt the player. */
    if (api->install_detour(MH_VA_HIT_TEST,hit_test_expected,7u,(void *)&hit_test_hook,&tramp)) g_hit_test_original=(PFN_HitTest)tramp;
    else api->log("MH Maps: friends' shots can hurt the player (hit test signature mismatch)");
    g_hooked=1;
    return 1;
}

void MHFriendsArm(MHFriend *list, mh_u32 count)
{
    mh_u32 i;
    for (i=0;i<MH_MAX_FRIENDS;++i) g_actors[i]=0u;
    g_friends=list;
    g_count=count>MH_MAX_FRIENDS ? MH_MAX_FRIENDS : count;
    for (i=0;i<g_count;++i) { list[i].object=0u; list[i].path=0u; list[i].retarget_at=0u; list[i].holding=0; list[i].stuck_since=0u; list[i].best_gap=0x7FFFFFFF; list[i].dead=0; list[i].fighting=0; list[i].fight_actor=0u;
        list[i].robot=(list[i].type>=2u && list[i].type<=11u) || list[i].type==139u; }
    g_trail_count=g_trail_next=0u;
    g_arrived_group=0xFFFFFFFFu;
    g_have_counter=0;
    g_resolved=0;
}

static mh_u32 map_base(const MHHostAPI *api)
{
    mh_u32 base=0;
    return api->read_memory(MH_MAP_BUFFER_PTR,&base,4) ? base : 0u;
}

static int in_map(mh_u32 base, mh_u32 address, mh_u32 bytes)
{
    return base && address>=base && address-base<=MH_MAP_BUFFER_CAP-bytes;
}

/* The route record an object follows: the engine keeps a pointer to it at object+0x18. */
static mh_u32 route_of(const MHHostAPI *api, mh_u32 base, mh_u32 object)
{
    mh_u32 path=0;
    mh_u16 count=0;
    if (!api->read_memory(object+0x18u,&path,4) || !in_map(base,path,8u)) return 0u;
    if (!api->read_memory(path+2u,&count,2) || (count&0x7FFFu)<1u || (count&0x7FFFu)>64u || !in_map(base,path,8u+(count&0x7FFFu)*8u)) return 0u;
    return path;
}

static char *put_int(char *p, mh_i32 v)
{
    char tmp[12];
    int n=0;
    if (v<0) { *p++='-'; v=-v; }
    do { tmp[n++]=(char)('0'+v%10); v/=10; } while (v && n<11);
    while (n) *p++=tmp[--n];
    return p;
}

/* "first object T at X,Y; friend T at X,Y", for when a friend is not where the manifest says. */
static void wsprintf_like(char *out, mh_u32 t, mh_i32 x, mh_i32 y, mh_u32 ft, mh_i32 fx, mh_i32 fy)
{
    static const char a[]="MH Maps: friend not found; first object type ", b[]=" at ", c[]=", friend type ", d[]=",";
    char *p=out;
    const char *q;
    for (q=a;*q;) *p++=*q++;
    p=put_int(p,(mh_i32)t); for (q=b;*q;) *p++=*q++; p=put_int(p,x); for (q=d;*q;) *p++=*q++; p=put_int(p,y);
    for (q=c;*q;) *p++=*q++;
    p=put_int(p,(mh_i32)ft); for (q=b;*q;) *p++=*q++; p=put_int(p,fx); for (q=d;*q;) *p++=*q++; p=put_int(p,fy);
    *p=0;
}

/* Find each friend's map object: the one of its type standing where it was placed.
   Tried again until every friend is found, as the objects are set up after the map loads. */
static void resolve(const MHHostAPI *api)
{
    const MHAPI *mh=MHAPIGet();
    mh_u32 base=map_base(api),i,j,n,missing=0;
    static int logged;
    if (!mh || !base) return;
    for (i=0;i<g_count;++i) {
        MHFriend *f=&g_friends[i];
        if (f->object) continue;
        n=mh->map.object_count(f->group,f->layer);
        for (j=0;j<n && !f->object;++j) {
            MHMapObject handle=mh->map.object_at(f->group,f->layer,j);
            MHMapObjectState o;
            if (!handle || !mh->map.object_get(handle,&o)) continue;
            if (o.map_type!=f->type || o.position.x/65536L!=f->x || o.position.y/65536L!=f->y) continue;
            f->object=base+handle-1u;
            f->path=f->follow ? route_of(api,base,f->object) : 0u;
            if (f->follow && !f->path) api->log("MH Maps: a following friend has no route to walk; it will stay put");
            /* Until it has somewhere to go, it stands: two identical route points would have a robot circle them. */
            if (f->path) { mh_u16 hold=0; api->write_memory(f->path,&hold,2); }
        }
        if (!f->object) {
            ++missing;
            if (!logged && n) {
                char line[160];
                MHMapObjectState o;
                logged=1;
                if (mh->map.object_get(mh->map.object_at(f->group,f->layer,0),&o)) {
                    wsprintf_like(line,o.map_type,o.position.x/65536L,o.position.y/65536L,f->type,f->x,f->y);
                    api->log(line);
                }
            }
        }
    }
    if (!missing && !g_resolved) { g_resolved=1; api->log("MH Maps: friendly characters ready"); }
}

static mh_i32 distance(mh_i32 dx, mh_i32 dy)
{
    if (dx<0) dx=-dx;
    if (dy<0) dy=-dy;
    /* Close enough to a true distance for leashes and spots. */
    return dx>dy ? dx+dy/2 : dy+dx/2;
}

/* A point on the player's trail `behind` map units back, or the player's own spot. When the
   trail jumps (the player was moved), the point is taken on the way to the next trail spot, so
   it is never further back than asked. */
static void trail_point(mh_i32 px, mh_i32 py, mh_i32 pz, mh_u32 group, mh_i32 behind, mh_i32 *x, mh_i32 *y, mh_i32 *z)
{
    mh_u32 k;
    *x=px; *y=py; *z=pz;
    for (k=1;k<=g_trail_count;++k) {
        mh_u32 at=(g_trail_next+MH_TRAIL-k)%MH_TRAIL;
        mh_i32 d;
        if (g_trail[at].group!=group || g_trail[at].z!=pz) break;
        d=distance(g_trail[at].x-px,g_trail[at].y-py);
        if (d>=behind) {
            *x=px+(g_trail[at].x-px)*behind/d;
            *y=py+(g_trail[at].y-py)*behind/d;
            break;
        }
        *x=g_trail[at].x; *y=g_trail[at].y;
    }
}

/* Route mode word: 1 walks back and forth between the points; 0 (one-way) leaves the
   follower standing at its first point, as every follower tried in the game does. */
static void set_route_mode(const MHHostAPI *api, const MHFriend *f, mh_u16 mode)
{
    api->write_memory(f->path,&mode,2);
}

static void set_route(const MHHostAPI *api, const MHFriend *f, mh_i32 x, mh_i32 y)
{
    const MHAPI *mh=MHAPIGet();
    MHLayerInfo layer;
    mh_u16 count=0;
    mh_u32 k;
    short point[2];
    if (!mh || !mh->map.layer_get(f->group,f->layer,&layer) || !api->read_memory(f->path+2u,&count,2)) return;
    /* Route points are relative to the layer, whose origin is in cells. */
    point[0]=(short)(x-layer.origin_x*CELL);
    point[1]=(short)(y-layer.origin_y*CELL);
    for (k=0;k<(count&0x7FFFu);++k) api->write_memory(f->path+8u+k*8u,point,4);
}

/* Trail spot k back from the newest (0 = newest), or 0 when there is none. */
static int trail_at(mh_u32 k, mh_u32 *slot)
{
    if (k>=g_trail_count) return 0;
    *slot=(g_trail_next+MH_TRAIL-1u-k)%MH_TRAIL;
    return 1;
}

/* The spot on the trail a friend at (ax, ay) should walk to: from the trail spot nearest
   to it, on towards the player, a stride ahead. Walking the player's own path takes it
   round corners and through doors, and up ramps the player climbed. */
static int trail_ahead(mh_i32 ax, mh_i32 ay, mh_u32 group, mh_i32 px, mh_i32 py, mh_i32 pz, mh_i32 behind, mh_i32 *x, mh_i32 *y)
{
    mh_u32 k,slot,best=0xFFFFFFFFu;
    mh_i32 best_d=0x7FFFFFFF;
    for (k=0;trail_at(k,&slot);++k) {
        mh_i32 d;
        if (g_trail[slot].group!=group) break;
        d=distance(g_trail[slot].x-ax,g_trail[slot].y-ay);
        if (d<best_d) { best_d=d; best=k; }
    }
    if (best==0xFFFFFFFFu) return 0;
    for (k=best;;--k) {
        trail_at(k,&slot);
        /* Never on towards the player than its place behind them: it would walk into them. */
        if (distance(g_trail[slot].x-px,g_trail[slot].y-py)<behind) {
            mh_i32 z;
            trail_point(px,py,pz,group,behind,x,y,&z);
            return 1;
        }
        *x=g_trail[slot].x; *y=g_trail[slot].y;
        if (k==0 || distance(*x-ax,*y-ay)>=MH_FRIEND_STRIDE) return 1;
    }
}

static mh_u32 layer_address(const MHHostAPI *api, mh_u32 group, mh_u32 layer)
{
    mh_u32 base=map_base(api),offset=0,count=0;
    if (!base || !api->read_memory(base+0x20u+group*4u,&offset,4) || !offset || offset>=MH_MAP_BUFFER_CAP) return 0u;
    if (!api->read_memory(base+offset,&count,4) || layer>=count || count>64u) return 0u;
    return base+offset+4u+layer*0x80u;
}

/* Take a map record out of its storey's row lists and put it in another's, at (x, y): the
   game wakes objects from the rows round the player, so this is how a friend changes area. */
static void say(const MHHostAPI *api, const char *why)
{
    static const char *last;
    if (why!=last) { last=why; api->log(why); }
}

static int move_record(const MHHostAPI *api, MHFriend *f, mh_u32 group, mh_u32 layer, mh_i32 x, mh_i32 y)
{
    const MHAPI *mh=MHAPIGet();
    MHLayerInfo to;
    mh_u32 to_lp=layer_address(api,group,layer),base=map_base(api);
    mh_u32 rows=0,bank=0,row,link=0,object=0,next=0,head=0,guard,from,from_lp;
    short at[2],route[2];
    if (!mh || !to_lp || !mh->map.layer_get(group,layer,&to)) { say(api,"MH Maps: friend move: no layer"); return 0; }
    if (x<to.origin_x*CELL || y<to.origin_y*CELL || x>=(to.origin_x+(mh_i32)to.width)*CELL || y>=(to.origin_y+(mh_i32)to.height)*CELL) { say(api,"MH Maps: friend move: spot outside the layer"); return 0; }
    /* Unlink: find whatever points at the record (a row head or the record before it). The
       game moves records between storeys and rows as their actors walk, so look everywhere in
       the area. */
    if (!api->read_memory(f->object,&next,4)) return 0;
    for (from=0;from<mh->map.layer_count(f->group) && !link;++from) {
        from_lp=layer_address(api,f->group,from);
        if (!from_lp || !api->read_memory(from_lp+0x18u,&rows,4) || !api->read_memory(from_lp+0x28u,&bank,4) || rows>4096u || !in_map(base,bank,rows*0x24u)) continue;
        for (row=0;row<rows && !link;++row) {
            mh_u32 slot=bank+row*0x24u;
            if (!api->read_memory(slot,&object,4)) break;
            if (object==f->object) { link=slot; break; }
            for (guard=0;object && guard<4096u;++guard) {
                mh_u32 after=0;
                if (!in_map(base,object,0x24u) || !api->read_memory(object,&after,4)) break;
                if (after==f->object) { link=object; break; }
                object=after;
            }
        }
    }
    if (!link) { say(api,"MH Maps: friend move: record not in its rows"); return 0; }
    /* Its new row, before anything is changed. */
    if (!api->read_memory(to_lp+0x18u,&rows,4) || !api->read_memory(to_lp+0x28u,&bank,4) || rows>4096u || !in_map(base,bank,rows*0x24u)) return 0;
    row=(mh_u32)((y-to.origin_y*CELL)/CELL);
    if (row>=rows) { say(api,"MH Maps: friend move: row out of range"); return 0; }
    say(api,"MH Maps: friend moved to another storey or area");
    if (!api->write_memory(link,&next,4)) return 0;
    if (!api->read_memory(bank+row*0x24u,&head,4)) return 0;
    api->write_memory(f->object,&head,4);
    api->write_memory(bank+row*0x24u,&f->object,4);
    at[0]=(short)(x-to.origin_x*CELL);
    at[1]=(short)(y-to.origin_y*CELL);
    api->write_memory(f->object+6u,at,4);
    if (f->path) {
        route[0]=(short)group; route[1]=(short)layer;
        api->write_memory(f->path+4u,route,4);
    }
    f->group=group;
    f->layer=layer;
    return 1;
}

/* Put an awake friend at a spot of the trail, with that spot's height. */
static void place_actor(const MHHostAPI *api, mh_u32 actor, mh_i32 x, mh_i32 y, mh_i32 z)
{
    mh_i32 p[3];
    p[0]=x<<16; p[1]=y<<16; p[2]=z<<16;
    api->write_memory(actor,p,12);
}

/* Whether a spot is clear of the player and of the other friends (where they stand and where they are going). */
static int spot_clear(const MHHostAPI *api, mh_u32 self, mh_i32 x, mh_i32 y, const mh_i32 *player)
{
    mh_u32 j;
    if (distance(player[0]-x,player[1]-y)<CELL) return 0;
    for (j=0;j<g_count;++j) {
        mh_i32 o[2];
        if (j==self || !g_actors[j]) continue;
        if (distance(g_friends[j].target_x-x,g_friends[j].target_y-y)<3*CELL/4) return 0;
        if (api->read_memory(g_actors[j],o,8) && distance((o[0]>>16)-x,(o[1]>>16)-y)<3*CELL/4) return 0;
    }
    return 1;
}

/* Send a friend walking to (x, y), or stand it where it is. */
static void walk_to(const MHHostAPI *api, MHFriend *f, mh_i32 x, mh_i32 y)
{
    f->target_x=x; f->target_y=y;
    set_route(api,f,x,y);
    set_route_mode(api,f,1u);
    f->holding=0;
}

static void stand(const MHHostAPI *api, MHFriend *f, mh_i32 x, mh_i32 y)
{
    f->target_x=x; f->target_y=y;
    set_route(api,f,x,y);
    set_route_mode(api,f,0u);
    f->holding=1;
}

void MHFriendsFrame(const MHHostAPI *api)
{
    mh_u32 counter=0,group=0,player,i,slot;
    mh_i32 pos[3];
    const MHAPI *mh=MHAPIGet();
    MHCellState here;
    if (!g_count || !g_hooked || !mh || !mh->map.loaded()) return;
    if (!g_resolved) resolve(api);
    /* The actors in play now, for the targeting hooks. */
    for (i=0;i<g_count;++i) {
        mh_u32 actor=0,active=0;
        if (g_friends[i].object && api->read_memory(g_friends[i].object+0x14u,&actor,4) && actor && api->read_memory(actor+MH_ACTOR_ACTIVE,&active,4) && active) g_actors[i]=actor;
        else g_actors[i]=0u;
    }
    player=api->find_player_actor ? api->find_player_actor() : 0u;
    if (!player || !api->read_memory(MH_UPDATE_COUNTER,&counter,4) || !api->read_memory(MH_CURRENT_GROUP,&group,4)) return;
    if (!api->read_memory(player,pos,12)) return;
    pos[0]>>=16; pos[1]>>=16; pos[2]>>=16;
    if (!g_have_counter) { g_last_counter=counter; g_have_counter=1; }
    if (counter==g_last_counter) return;   /* paused, or no update since the last frame */
    g_last_counter=counter;
    if (!mh->map.entity_cell(mh->entities.player(),&here)) return;
    if (group!=g_arrived_group) { g_arrived_group=group; g_arrived_at=counter; }

    /* The player's trail: spots the player has stood on are spots a friend can stand on. */
    if (!trail_at(0,&slot) || distance(pos[0]-g_trail[slot].x,pos[1]-g_trail[slot].y)>=CELL/4 || g_trail[slot].group!=group || g_trail[slot].z!=pos[2]) {
        g_trail[g_trail_next].x=pos[0]; g_trail[g_trail_next].y=pos[1]; g_trail[g_trail_next].z=pos[2];
        g_trail[g_trail_next].group=group; g_trail[g_trail_next].layer=here.layer;
        g_trail_next=(g_trail_next+1u)%MH_TRAIL;
        if (g_trail_count<MH_TRAIL) ++g_trail_count;
    }

    for (i=0;i<g_count;++i) {
        MHFriend *f=&g_friends[i];
        mh_i32 a[3],bx,by,bz,gap;
        int elsewhere;
        /* Friends stand a little apart, one behind the other. */
        mh_i32 behind=MH_FRIEND_BEHIND+(mh_i32)i*CELL/2;
        if (!f->object) continue;
        /* A friend whose health runs out dies like anyone else; after that it is left alone,
           or the follow rules would wake it again. */
        if (f->dead) continue;
        if (g_actors[i]) {
            mh_i32 health=1;
            api->read_memory(g_actors[i]+MH_ACTOR_HEALTH,&health,4);
            if (health<=0) {
                f->dead=1;
                g_actors[i]=0u;
                api->log("MH Maps: a friendly character died");
                continue;
            }
        }
        /* A friendly robot with an enemy in reach fights it; following waits until it is over. */
        if (g_actors[i]!=f->fight_actor) { f->fighting=0; f->fight_actor=g_actors[i]; }
        if (g_actors[i] && g_fight && f->robot) {
            mh_u32 actor=g_actors[i];
            mh_i32 d=0,px_gap;
            mh_u32 enemy=nearest(actor,1,MH_FRIEND_ENGAGE,&d);
            px_gap=distance((FIELD(actor,0,mh_i32)>>16)-pos[0],(FIELD(actor,4,mh_i32)>>16)-pos[1]);
            /* Only enemies near the player too: actors far from the player are put to sleep. */
            if (enemy && distance((FIELD(enemy,0,mh_i32)>>16)-pos[0],(FIELD(enemy,4,mh_i32)>>16)-pos[1])>MH_FRIEND_ENGAGE) enemy=0u;
            if (enemy && px_gap<MH_FRIEND_DISENGAGE) {
                f->calm_since=counter;
                if (!f->fighting) {
                    f->saved_ai=FIELD(actor,MH_ACTOR_AI,mh_u32);
                    if (f->saved_ai) {
                        FIELD(actor,MH_ACTOR_AI_SUBSTATE,mh_u16)=0;
                        FIELD(actor,MH_ACTOR_AI,mh_u32)=MH_COMBAT_AI;
                        f->fighting=1;
                    }
                }
            } else if (f->fighting && (counter-f->calm_since>MH_FRIEND_CALM || px_gap>=MH_FRIEND_DISENGAGE)) {
                FIELD(actor,MH_ACTOR_AI,mh_u32)=f->saved_ai;
                FIELD(actor,MH_ACTOR_AI_SUBSTATE,mh_u16)=0;
                f->fighting=0;
                f->retarget_at=0u;
                f->stuck_since=counter;
                f->best_gap=0x7FFFFFFF;
            }
            if (f->fighting) continue;
        }
        if (!f->follow) continue;

        if (f->group!=group || !g_actors[i]) {
            /* In another area, or put to sleep for being far away: move its map record onto the
               trail behind the player and wake it there. */
            if ((counter%15u)==0u) {
                trail_point(pos[0],pos[1],pos[2],group,3*CELL/2,&bx,&by,&bz);
                /* Into a new area it follows once the player has walked on a little, so it comes
                   in behind rather than on top of them; after two seconds it comes anyway. */
                if (f->group!=group && distance(bx-pos[0],by-pos[1])<CELL && counter-g_arrived_at<60u) continue;
                if (f->group!=group || f->layer!=here.layer) {
                    if (!move_record(api,f,group,here.layer,bx,by)) continue;
                } else {
                    MHLayerInfo layer;
                    short at[2];
                    if (!mh->map.layer_get(f->group,f->layer,&layer)) continue;
                    at[0]=(short)(bx-layer.origin_x*CELL);
                    at[1]=(short)(by-layer.origin_y*CELL);
                    api->write_memory(f->object+6u,at,4);
                }
                mh->map.object_spawn((MHMapObject)(f->object-map_base(api)+1u));
                f->retarget_at=0u;
                f->stuck_since=counter;
                f->best_gap=0x7FFFFFFF;
            }
            continue;
        }
        if (!api->read_memory(g_actors[i],a,12)) continue;
        a[0]>>=16; a[1]>>=16; a[2]>>=16;
        gap=distance(a[0]-pos[0],a[1]-pos[1]);
        /* More than half a storey above or below the player: on another storey. */
        elsewhere=a[2]-pos[2]>CELL/2 || pos[2]-a[2]>CELL/2;

        /* Out of sight, or stuck (behind, or on another storey): put it on the trail a little
           behind the player, on the player's storey. */
        if (gap>MH_FRIEND_LEASH || ((gap>MH_FRIEND_NEAR || elsewhere) && counter-f->stuck_since>MH_FRIEND_STUCK_UPDATES)) {
            trail_point(pos[0],pos[1],pos[2],group,behind+CELL/2,&bx,&by,&bz);
            place_actor(api,g_actors[i],bx,by,bz);
            f->retarget_at=0u;
            f->stuck_since=counter;
            f->best_gap=0x7FFFFFFF;
            continue;
        }
        /* Progress, for the stuck rule above: catching up means getting closer, not just moving
           (a character can pace about against a wall). */
        if ((gap<=MH_FRIEND_NEAR && !elsewhere) || gap+MH_FRIEND_STUCK_GAIN<=f->best_gap) {
            f->best_gap=gap;
            f->stuck_since=counter;
        }
        if (!f->path) continue;

        if (gap>MH_FRIEND_NEAR || elsewhere) {
            /* Catching up: walk the player's own trail. */
            if (f->holding || !f->retarget_at || distance(a[0]-f->target_x,a[1]-f->target_y)<MH_FRIEND_ARRIVED || counter>=f->retarget_at) {
                if (trail_ahead(a[0],a[1],group,pos[0],pos[1],pos[2],behind,&bx,&by)) walk_to(api,f,bx,by);
                f->retarget_at=counter+15u;
            }
            continue;
        }
        if (gap<3*CELL/4 && (f->holding || distance(f->target_x-pos[0],f->target_y-pos[1])<CELL)) {
            /* Too close: the player walked up to it, or it was pushed. Step back at once. */
            f->retarget_at=0u;
            f->holding=1;
        }
        if (!f->holding && f->retarget_at && (distance(a[0]-f->target_x,a[1]-f->target_y)<MH_FRIEND_ARRIVED || counter>=f->retarget_at)) {
            /* Arrived, or given up on a spot it cannot quite reach (another friend on it, a wall):
               stand here until the next spot is due. A robot steers like a vehicle and would
               otherwise circle the spot. */
            stand(api,f,a[0],a[1]);
            f->retarget_at=counter+90u+next_random()%90u;
        }
        else if (!f->retarget_at || counter>=f->retarget_at) {
            /* Close by: now and then, a spot of its own near the player, clear of the others. */
            mh_i32 tx=a[0],ty=a[1],tries,d;
            trail_point(pos[0],pos[1],pos[2],group,behind,&bx,&by,&bz);
            /* No trail behind a player who has not moved: take the spot `behind` away from the
               player on the friend's own side instead. */
            d=distance(bx-pos[0],by-pos[1]);
            if (d<behind/2) {
                mh_i32 side=distance(a[0]-pos[0],a[1]-pos[1]);
                if (side<16) { bx=pos[0]-behind; by=pos[1]; }
                else { bx=pos[0]+(a[0]-pos[0])*behind/side; by=pos[1]+(a[1]-pos[1])*behind/side; }
            }
            for (tries=0;tries<8;++tries) {
                tx=bx+(mh_i32)(next_random()%(2u*MH_FRIEND_JITTER+1u))-MH_FRIEND_JITTER;
                ty=by+(mh_i32)(next_random()%(2u*MH_FRIEND_JITTER+1u))-MH_FRIEND_JITTER;
                if (spot_clear(api,i,tx,ty,pos)) break;
            }
            if (tries<8) walk_to(api,f,tx,ty);
            /* At most two and a half seconds' walk to it. */
            f->retarget_at=counter+75u;
        }
    }
}
