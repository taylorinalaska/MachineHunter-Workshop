#ifndef MH_OPTIONS_H
#define MH_OPTIONS_H

#include "mh_host.h"
#include "mh.h"

/*
 * Mod settings: which mods are switched off, and the options mods declare.
 *
 * Everything is stored in one text file, mods\settings.cfg, that the Workshop
 * edits too:
 *
 *     disabled = some-mod, another-mod
 *
 *     [free-camera]
 *     speed = 16
 */

#define MH_OPTION_MAX        256u
#define MH_OPTION_CHOICE_MAX 16u

typedef void (MH_STDCALL *MHOptionListener)(MHOption option, mh_i32 value, int action);

int MH_STDCALL MHOptionsInit(const MHHostAPI *host);
int MH_STDCALL MHOptionsModDisabled(const char *mod_id);
void MH_STDCALL MHOptionsSetListener(MHOptionListener listener);

/* `mod_name` is the default section. Returns the existing option if the mod already has that key. */
MHOption MH_STDCALL MHOptionAdd(const char *mod_id, const char *mod_name, const MHOptionSpec *spec);
MHOption MH_STDCALL MHOptionFind(const char *mod_id, const char *key);
/* Put a key option in a "unique" group of its mod: no two in a group share a key. */
void MH_STDCALL MHOptionSetUnique(MHOption option, const char *group);
mh_i32 MH_STDCALL MHOptionGet(MHOption option);
int MH_STDCALL MHOptionSet(MHOption option, mh_i32 value);
int MH_STDCALL MHOptionStep(MHOption option, int direction);
mh_u32 MH_STDCALL MHOptionCount(void);
MHOption MH_STDCALL MHOptionAt(mh_u32 index);
int MH_STDCALL MHOptionGetInfo(MHOption option, MHOptionInfo *info);
const char *MH_STDCALL MHOptionChoice(MHOption option, mh_u32 index);
int MH_STDCALL MHOptionText(MHOption option, char *out, mh_u32 capacity);

/* Key names as written in settings.cfg and mod.json: "F3", "UP", "A", "0x72", "NONE". */
int MH_STDCALL MHKeyCode(const char *name);
const char *MH_STDCALL MHKeyName(int virtual_key);

#endif
