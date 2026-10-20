#ifndef MH_SCRIPT_HOST_H
#define MH_SCRIPT_HOST_H

#include "mh_host.h"
#include "mh.h"
#include "MHPackageRegistry.h"

/* Missing lua54.dll disables scripting without preventing map/native packages. */
int MH_STDCALL MHScriptHostInit(const MHHostAPI *host, const MHAPI *api);

/* Returns 1 loaded, 0 no main.lua/Lua unavailable, -1 on script failure. */
int MH_STDCALL MHScriptHostTryLoad(const MHPackage *package);

#endif
