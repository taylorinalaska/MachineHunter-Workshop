/*
 * Developer Tools: the event trace.
 *
 * While "Runtime trace" is on, every shot fired and every point of damage is
 * written to logs\runtime-trace.log with the caller that asked for it, and
 * the actor pool is watched for changes. The three hooks are installed once
 * and pass straight through while tracing is off.
 */
#include "mh.h"
#include "trace.h"

typedef MHU8 mh_u8;
typedef MHU16 mh_u16;
typedef MHU32 mh_u32;
typedef MHI32 mh_i32;

extern const MHAPI *mh;

#if defined(_MSC_VER) || defined(__clang__)
#define MH_CDECL __cdecl
#else
#define MH_CDECL
#endif

#define MH_GENERIC_WRITE          0x40000000u
#define MH_FILE_SHARE_READ        0x00000001u
#define MH_CREATE_ALWAYS          2u
#define MH_FILE_ATTRIBUTE_NORMAL  0x00000080u
#define MH_INVALID_HANDLE         ((void *)(mh_i32)-1)

void *_ReturnAddress(void);
#pragma intrinsic(_ReturnAddress)

typedef int           (MH_CDECL *MHFireFn)(mh_u32 actor, mh_u32 profile, mh_u32 unused_angle);
typedef unsigned char (MH_CDECL *MHDamageFn)(mh_u32 actor, mh_u32 requested_damage);
typedef void *  (MH_STDCALL *PFN_CreateFileA)(const char *, mh_u32, mh_u32, void *, mh_u32, mh_u32, void *);
typedef int     (MH_STDCALL *PFN_WriteFile)(void *, const void *, mh_u32, mh_u32 *, void *);
typedef int     (MH_STDCALL *PFN_CloseHandle)(void *);

static MHFireFn g_fire_original;
static MHDamageFn g_damage_gate_original;
static MHDamageFn g_damage_raw_original;
static PFN_CreateFileA g_create_file;
static PFN_WriteFile g_write_file;
static PFN_CloseHandle g_close_handle;
static void *g_trace_file;
static int g_trace_enabled;
static int g_hooks_ready;

typedef struct ActorWatch {
    mh_u32 valid;
    mh_u32 active;
    mh_u32 flags;
    mh_i32 hp;
    mh_u32 guard;
    mh_i32 x;
    mh_i32 y;
    mh_i32 z;
    mh_u32 state_fn;
    mh_u32 state_value;
} ActorWatch;

static ActorWatch g_prev[48];
static int g_watch_initialized;

static void copy_actor_watch(ActorWatch *dst, const ActorWatch *src)
{
    dst->valid=src->valid;
    dst->active=src->active;
    dst->flags=src->flags;
    dst->hp=src->hp;
    dst->guard=src->guard;
    dst->x=src->x;
    dst->y=src->y;
    dst->z=src->z;
    dst->state_fn=src->state_fn;
    dst->state_value=src->state_value;
}

static mh_u32 text_len(const char *s)
{
    mh_u32 n=0;
    if (!s) return 0;
    while (s[n]) ++n;
    return n;
}

static void trace_write_line(const char *text)
{
    static const char crlf[2]={'\r','\n'};
    mh_u32 wrote=0;
    if (!g_trace_enabled || !g_trace_file || g_trace_file==MH_INVALID_HANDLE || !g_write_file || !text) return;
    g_write_file(g_trace_file,text,text_len(text),&wrote,0);
    g_write_file(g_trace_file,crlf,2,&wrote,0);
}

static char *append_text(char *p, const char *s)
{
    while (*s) *p++ = *s++;
    *p = 0;
    return p;
}

static char *append_u32(char *p, mh_u32 v)
{
    char tmp[11];
    int n=0, i;
    if (!v) { *p++='0'; *p=0; return p; }
    while (v && n < 10) { tmp[n++] = (char)('0' + (v % 10)); v /= 10; }
    for (i=n-1; i>=0; --i) *p++ = tmp[i];
    *p=0;
    return p;
}

static char *append_i32(char *p, mh_i32 v)
{
    mh_u32 u;
    if (v < 0) {
        *p++='-';
        u=(mh_u32)(-(v+1));
        u+=1u;
    } else u=(mh_u32)v;
    return append_u32(p,u);
}

static char *append_hex8(char *p, mh_u32 v)
{
    static const char H[]="0123456789ABCDEF";
    int i;
    *p++='0'; *p++='x';
    for (i=7;i>=0;--i) *p++=H[(v>>(i*4))&15u];
    *p=0;
    return p;
}

static mh_u32 read_u32(mh_u32 addr)
{
    mh_u32 v=0;
    if (mh) mh->engine.read(addr,&v,4);
    return v;
}

static mh_i32 read_i32(mh_u32 addr)
{
    mh_i32 v=0;
    if (mh) mh->engine.read(addr,&v,4);
    return v;
}

static mh_u16 read_u16(mh_u32 addr)
{
    mh_u16 v=0;
    if (mh) mh->engine.read(addr,&v,2);
    return v;
}

static int actor_is_player(mh_u32 actor)
{
    mh_u32 off, bit;
    if (!actor || !mh) return 0;
    off = mh->engine.constant("actor.flags.offset");
    bit = mh->engine.constant("actor.player_flag");
    return (read_u32(actor+off) & bit) != 0;
}

static int actor_slot(mh_u32 actor)
{
    mh_u32 base=mh->engine.symbol("gameplay.actor_pool");
    mh_u32 stride=mh->engine.constant("actor.pool.stride");
    mh_u32 cap=mh->engine.constant("actor.pool.capacity");
    mh_u32 delta;
    if (!base || !stride || actor < base) return -1;
    delta=actor-base;
    if ((delta % stride) != 0) return -1;
    delta/=stride;
    if (delta >= cap) return -1;
    return (int)delta;
}

static void read_actor_watch(mh_u32 actor, ActorWatch *w)
{
    if (!w) return;
    w->valid=actor ? 1u : 0u;
    if (!actor) {
        w->active=w->flags=w->guard=w->state_fn=w->state_value=0;
        w->hp=w->x=w->y=w->z=0;
        return;
    }
    w->active=read_u32(actor+mh->engine.constant("actor.active.offset"));
    w->flags=read_u32(actor+mh->engine.constant("actor.flags.offset"));
    w->hp=read_i32(actor+mh->engine.constant("actor.health.offset"));
    w->guard=read_u32(actor+mh->engine.constant("actor.guard.offset"));
    w->x=read_i32(actor+mh->engine.constant("actor.position_x.offset"));
    w->y=read_i32(actor+mh->engine.constant("actor.position_y.offset"));
    w->z=read_i32(actor+mh->engine.constant("actor.position_z.offset"));
    w->state_fn=read_u32(actor+0x7Cu);
    w->state_value=read_u32(actor+0x80u);
}

static char *append_actor_identity(char *p, int slot, mh_u32 actor, const ActorWatch *w)
{
    p=append_text(p," slot="); p=append_i32(p,(mh_i32)slot);
    p=append_text(p," actor="); p=append_hex8(p,actor);
    p=append_text(p," player="); p=append_u32(p,(mh_u32)((w->flags & mh->engine.constant("actor.player_flag")) != 0));
    p=append_text(p," active="); p=append_hex8(p,w->active);
    p=append_text(p," profile="); p=append_u32(p,w->active & mh->engine.constant("actor.active.type_mask"));
    p=append_text(p," flags="); p=append_hex8(p,w->flags);
    return p;
}

static void log_actor_event(const char *kind, int slot, mh_u32 actor,
                            const ActorWatch *before, const ActorWatch *after)
{
    char line[512], *p=line;
    const ActorWatch *cur=after ? after : before;
    p=append_text(p,"TRACE "); p=append_text(p,kind);
    p=append_text(p," frame="); p=append_u32(p,mh->runtime.frame());
    p=append_actor_identity(p,slot,actor,cur);
    if (before && after) {
        p=append_text(p," hp="); p=append_i32(p,before->hp); p=append_text(p,"->"); p=append_i32(p,after->hp);
        p=append_text(p," delta="); p=append_i32(p,after->hp-before->hp);
        p=append_text(p," guard="); p=append_u32(p,before->guard); p=append_text(p,"->"); p=append_u32(p,after->guard);
    } else {
        p=append_text(p," hp="); p=append_i32(p,cur->hp);
        p=append_text(p," guard="); p=append_u32(p,cur->guard);
    }
    p=append_text(p," pos="); p=append_i32(p,cur->x); *p++=','; *p=0;
    p=append_i32(p,cur->y); *p++=','; *p=0; p=append_i32(p,cur->z);
    p=append_text(p," statefn="); p=append_hex8(p,cur->state_fn);
    p=append_text(p," state="); p=append_hex8(p,cur->state_value);
    trace_write_line(line);
}

static void log_profile_table(void)
{
    mh_u32 base=mh->engine.symbol("weapon.profile_table");
    mh_u32 stride=mh->engine.constant("weapon.profile.stride");
    mh_u32 interval_base=mh->engine.constant("weapon.profile.fire_interval_base.offset");
    mh_u32 init_base=mh->engine.constant("weapon.profile.timer_a_initial_base.offset");
    mh_u32 repeat_base=mh->engine.constant("weapon.profile.timer_a_repeat_base.offset");
    mh_u32 cost_base=mh->engine.constant("weapon.profile.resource_cost_base.offset");
    mh_u32 cb_off=mh->engine.constant("weapon.profile.callback.offset");
    mh_u32 i,w;
    if (!base || !stride) return;

    for (i=0;i<16u;++i) {
        char line[640], *p=line;
        mh_u32 prof=base+i*stride;
        p=append_text(p,"TRACE PROFILE index="); p=append_u32(p,i);
        p=append_text(p," ptr="); p=append_hex8(p,prof);
        p=append_text(p," callback="); p=append_hex8(p,read_u32(prof+cb_off));
        for (w=0;w<3u;++w) {
            p=append_text(p," w"); p=append_u32(p,w);
            p=append_text(p,"[interval="); p=append_u32(p,read_u32(prof+interval_base+w*4u));
            p=append_text(p,",init="); p=append_u32(p,read_u32(prof+init_base+w*4u));
            p=append_text(p,",repeat="); p=append_u32(p,read_u32(prof+repeat_base+w*4u));
            p=append_text(p,",cost="); p=append_u32(p,read_u32(prof+cost_base+w*4u));
            p=append_text(p,"]");
        }
        trace_write_line(line);
    }
}

static void scan_actor_pool(void)
{
    mh_u32 cap=mh->engine.constant("actor.pool.capacity");
    mh_u32 i;
    if (cap > 48u) cap=48u;
    for (i=0;i<cap;++i) {
        mh_u32 actor=mh->engine.actor(i);
        ActorWatch cur;
        read_actor_watch(actor,&cur);
        if (!g_watch_initialized) {
            copy_actor_watch(&g_prev[i],&cur);
            if (cur.active) log_actor_event("ACTOR_INITIAL",(int)i,actor,0,&cur);
            continue;
        }
        if (!g_prev[i].active && cur.active) {
            log_actor_event("SPAWN",(int)i,actor,0,&cur);
        } else if (g_prev[i].active && !cur.active) {
            log_actor_event("DESPAWN",(int)i,actor,&g_prev[i],0);
        } else if (g_prev[i].active && cur.active) {
            if (g_prev[i].hp != cur.hp) {
                log_actor_event(cur.hp==0 ? "DEATH_HP" : "HP",(int)i,actor,&g_prev[i],&cur);
            }
            if ((g_prev[i].active & mh->engine.constant("actor.active.type_mask")) !=
                (cur.active & mh->engine.constant("actor.active.type_mask")) &&
                (cur.flags & mh->engine.constant("actor.player_flag"))) {
                char line2[320], *q=line2;
                q=append_text(q,"TRACE PLAYER_PROFILE_CHANGE frame="); q=append_u32(q,mh->runtime.frame());
                q=append_text(q," old="); q=append_u32(q,g_prev[i].active & mh->engine.constant("actor.active.type_mask"));
                q=append_text(q," new="); q=append_u32(q,cur.active & mh->engine.constant("actor.active.type_mask"));
                q=append_text(q," hp="); q=append_i32(q,g_prev[i].hp); q=append_text(q,"->"); q=append_i32(q,cur.hp);
                q=append_text(q," pos="); q=append_i32(q,cur.x); *q++=','; *q=0;
                q=append_i32(q,cur.y); *q++=','; *q=0; q=append_i32(q,cur.z);
                trace_write_line(line2);
            }
            if (g_prev[i].active != cur.active || g_prev[i].flags != cur.flags) {
                char line[320], *p=line;
                p=append_text(p,"TRACE ACTOR_META frame="); p=append_u32(p,mh->runtime.frame());
                p=append_text(p," slot="); p=append_u32(p,i);
                p=append_text(p," active="); p=append_hex8(p,g_prev[i].active); p=append_text(p,"->"); p=append_hex8(p,cur.active);
                p=append_text(p," flags="); p=append_hex8(p,g_prev[i].flags); p=append_text(p,"->"); p=append_hex8(p,cur.flags);
                trace_write_line(line);
            }
        }
        copy_actor_watch(&g_prev[i],&cur);
    }
    if (!g_watch_initialized) {
        g_watch_initialized=1;
        trace_write_line("TRACE actor-pool baseline established");
    }
}

static int MH_CDECL trace_fire(mh_u32 actor, mh_u32 profile, mh_u32 unused_angle)
{
    mh_u32 inv_off, weapon_off, ammo_base;
    mh_u32 aim_off, timer_a_off, timer_b_off, recent_off;
    mh_u32 cost_base, interval_base;
    mh_u32 inv=0, before=0, after=0, cost=0, interval=0, aim=0;
    mh_u32 ta=0,tb=0,recent=0, weapon=0;
    int result, slot;
    char line[416], *p;

    if (!g_trace_enabled)
        return g_fire_original ? g_fire_original(actor,profile,unused_angle) : 0;

    inv_off=mh->engine.constant("actor.inventory_ptr.offset");
    weapon_off=mh->engine.constant("inventory.selected_weapon.offset");
    ammo_base=mh->engine.constant("inventory.ammo_base.offset");
    aim_off=mh->engine.constant("actor.aim_angle.offset");
    timer_a_off=mh->engine.constant("actor.weapon_timer_a.offset");
    timer_b_off=mh->engine.constant("actor.weapon_timer_b.offset");
    recent_off=mh->engine.constant("actor.weapon_recent_fire.offset");
    cost_base=mh->engine.constant("weapon.profile.resource_cost_base.offset");
    interval_base=mh->engine.constant("weapon.profile.fire_interval_base.offset");

    if (actor_is_player(actor)) {
        inv=read_u32(actor+inv_off);
        if (inv) {
            weapon=(mh_u32)read_u16(inv+weapon_off);
            before=read_u32(inv+ammo_base+weapon*4u);
        }
    } else weapon=(mh_u32)read_u16(actor+0x296u);

    result = g_fire_original ? g_fire_original(actor,profile,unused_angle) : 0;
    if (!result) return result;

    if (inv) after=read_u32(inv+ammo_base+weapon*4u);
    if (profile) {
        cost=read_u32(profile+cost_base+weapon*4u);
        interval=read_u32(profile+interval_base+weapon*4u);
    }
    aim=read_u32(actor+aim_off);
    ta=read_u32(actor+timer_a_off);
    tb=read_u32(actor+timer_b_off);
    recent=read_u32(actor+recent_off);
    slot=actor_slot(actor);

    p=line;
    p=append_text(p,"TRACE FIRE frame="); p=append_u32(p,mh->runtime.frame());
    p=append_text(p," caller="); p=append_hex8(p,(mh_u32)_ReturnAddress());
    p=append_text(p," slot="); p=append_i32(p,(mh_i32)slot);
    p=append_text(p," actor="); p=append_hex8(p,actor);
    p=append_text(p," player="); p=append_u32(p,(mh_u32)actor_is_player(actor));
    p=append_text(p," weapon="); p=append_u32(p,weapon);
    p=append_text(p," profile="); p=append_hex8(p,profile);
    p=append_text(p," resource="); p=append_u32(p,before); p=append_text(p,"->"); p=append_u32(p,after);
    p=append_text(p," cost="); p=append_u32(p,cost);
    p=append_text(p," interval="); p=append_u32(p,interval);
    p=append_text(p," aim="); p=append_u32(p,aim);
    p=append_text(p," timers="); p=append_u32(p,ta); p=append_text(p,"/"); p=append_u32(p,tb);
    p=append_text(p," recent="); p=append_u32(p,recent);
    trace_write_line(line);
    return result;
}

static void log_damage_call(const char *kind, mh_u32 caller, mh_u32 actor, mh_u32 requested,
                            mh_i32 hp_before, mh_i32 hp_after, mh_u32 result)
{
    char line[384], *p=line;
    int slot=actor_slot(actor);
    p=append_text(p,"TRACE "); p=append_text(p,kind);
    p=append_text(p," frame="); p=append_u32(p,mh->runtime.frame());
    p=append_text(p," caller="); p=append_hex8(p,caller);
    p=append_text(p," slot="); p=append_i32(p,(mh_i32)slot);
    p=append_text(p," actor="); p=append_hex8(p,actor);
    p=append_text(p," player="); p=append_u32(p,(mh_u32)actor_is_player(actor));
    p=append_text(p," requested="); p=append_u32(p,requested);
    p=append_text(p," hp="); p=append_i32(p,hp_before); p=append_text(p,"->"); p=append_i32(p,hp_after);
    p=append_text(p," result="); p=append_u32(p,result);
    p=append_text(p," guard="); p=append_u32(p,read_u32(actor+mh->engine.constant("actor.guard.offset")));
    p=append_text(p," flags="); p=append_hex8(p,read_u32(actor+mh->engine.constant("actor.flags.offset")));
    trace_write_line(line);
}

static unsigned char MH_CDECL trace_damage_gate(mh_u32 actor, mh_u32 requested_damage)
{
    mh_u32 caller, hp_off;
    mh_i32 before, after;
    unsigned char result;
    if (!g_trace_enabled)
        return g_damage_gate_original ? g_damage_gate_original(actor,requested_damage) : 0;
    caller=(mh_u32)_ReturnAddress();
    hp_off=mh->engine.constant("actor.health.offset");
    before=read_i32(actor+hp_off);
    result=g_damage_gate_original ? g_damage_gate_original(actor,requested_damage) : 0;
    after=read_i32(actor+hp_off);
    log_damage_call("DAMAGE_GATE",caller,actor,requested_damage,before,after,(mh_u32)result);
    return result;
}

static unsigned char MH_CDECL trace_damage_raw(mh_u32 actor, mh_u32 requested_damage)
{
    mh_u32 caller, hp_off;
    mh_i32 before, after;
    unsigned char result;
    if (!g_trace_enabled)
        return g_damage_raw_original ? g_damage_raw_original(actor,requested_damage) : 0;
    caller=(mh_u32)_ReturnAddress();
    hp_off=mh->engine.constant("actor.health.offset");
    before=read_i32(actor+hp_off);
    result=g_damage_raw_original ? g_damage_raw_original(actor,requested_damage) : 0;
    after=read_i32(actor+hp_off);
    log_damage_call("DAMAGE_RAW",caller,actor,requested_damage,before,after,(mh_u32)result);
    return result;
}

void DevTraceFrame(void)
{
    if (g_trace_enabled) scan_actor_pool();
}

void DevTraceInsertMarker(void)
{
    char line[96], *p=line;
    if (!g_trace_enabled || !mh) return;
    p=append_text(p,"TRACE MARK frame="); p=append_u32(p,mh->runtime.frame());
    trace_write_line(line);
    mh->runtime.log("Developer Tools: runtime trace marker written");
}

int DevTraceSetEnabled(int enabled)
{
    char line[128], *p;
    if (!mh || !g_hooks_ready) return 0;
    enabled = enabled ? 1 : 0;
    if (enabled == g_trace_enabled) return 1;

    if (enabled) {
        if (!g_create_file || !g_write_file || !g_close_handle) {
            mh->runtime.log("Developer Tools: runtime trace cannot start; Win32 file API unavailable");
            return 0;
        }
        if (g_trace_file && g_trace_file!=MH_INVALID_HANDLE) g_close_handle(g_trace_file);
        g_trace_file = g_create_file("logs\\runtime-trace.log",MH_GENERIC_WRITE,MH_FILE_SHARE_READ,0,
                                    MH_CREATE_ALWAYS,MH_FILE_ATTRIBUTE_NORMAL,0);
        if (!g_trace_file || g_trace_file==MH_INVALID_HANDLE) {
            g_trace_file=0;
            mh->runtime.log("Developer Tools: runtime trace cannot create logs\\runtime-trace.log");
            return 0;
        }
        g_trace_enabled=1;
        g_watch_initialized=0;
        trace_write_line("Machine Hunter runtime trace");
        p=line; p=append_text(p,"TRACE BEGIN frame="); p=append_u32(p,mh->runtime.frame());
        trace_write_line(line);
        log_profile_table();
        mh->runtime.log("Developer Tools: runtime trace ON -> logs\\runtime-trace.log");
        return 1;
    }

    p=line; p=append_text(p,"TRACE END frame="); p=append_u32(p,mh->runtime.frame());
    trace_write_line(line);
    g_trace_enabled=0;
    g_watch_initialized=0;
    if (g_trace_file && g_trace_file!=MH_INVALID_HANDLE && g_close_handle) g_close_handle(g_trace_file);
    g_trace_file=0;
    mh->runtime.log("Developer Tools: runtime trace OFF");
    return 1;
}

static int hook(const char *symbol, const mh_u8 *expected, mh_u32 size, void *replacement, void **original, const char *failure)
{
    if (mh->engine.detour(mh->engine.symbol(symbol), expected, size, replacement, original)) return 1;
    mh->runtime.log(failure);
    return 0;
}

int DevTraceInit(void)
{
    static const mh_u8 fire_expected[7] = {0x53,0x56,0x8B,0x74,0x24,0x0C,0x57};
    static const mh_u8 damage_gate_expected[6] = {0x8B,0x0D,0xDC,0xA0,0x62,0x00};
    static const mh_u8 damage_raw_expected[10] = {0x8B,0x54,0x24,0x04,0x8B,0x82,0x98,0x00,0x00,0x00};
    int hooks = 0;

    g_create_file=(PFN_CreateFileA)(void *)mh->engine.symbol("win32.create_file_a");
    g_write_file=(PFN_WriteFile)(void *)mh->engine.symbol("win32.write_file");
    g_close_handle=(PFN_CloseHandle)(void *)mh->engine.symbol("win32.close_handle");
    g_trace_enabled=0;
    g_trace_file=0;
    g_watch_initialized=0;

    hooks += hook("gameplay.fire_attempt", fire_expected, 7u, (void *)&trace_fire, (void **)&g_fire_original, "Developer Tools: trace fire hook signature mismatch");
    hooks += hook("gameplay.damage_raw", damage_raw_expected, 10u, (void *)&trace_damage_raw, (void **)&g_damage_raw_original, "Developer Tools: trace raw-damage hook signature mismatch");
    hooks += hook("gameplay.apply_damage", damage_gate_expected, 6u, (void *)&trace_damage_gate, (void **)&g_damage_gate_original, "Developer Tools: trace damage-gate hook signature mismatch");

    g_hooks_ready=1;
    return hooks == 3;
}
