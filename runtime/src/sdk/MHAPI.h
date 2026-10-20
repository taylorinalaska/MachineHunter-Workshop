#ifndef MH_RUNTIME_PUBLIC_API_H
#define MH_RUNTIME_PUBLIC_API_H

#include "mh_host.h"
#include "mh.h"

int MH_STDCALL MHAPIInit(const MHHostAPI *host);
const MHAPI *MH_STDCALL MHAPIGet(void);
void MH_STDCALL MHAPIDispatchRuntimeReady(void);
/* Send an event that carries only the current level and group. */
void MH_STDCALL MHAPIDispatchSimple(MHEventType type);

#endif
