#include "mh_host.h"
#include "mh.h"
#include "MHModLoader.h"
#include "MHScriptHost.h"
#include "MHPackageRegistry.h"

/* Loads code from the one canonical package registry. A package may contain
   mod.dll, main.lua, maps and/or assets without requiring separate loaders. */

typedef void *MHModule;
typedef MHModule (MH_STDCALL *PFN_LoadLibraryA)(const char *);
typedef void *(MH_STDCALL *PFN_GetProcAddress)(MHModule, const char *);
typedef int (MH_STDCALL *PFN_MHModInit)(const MHModContext *context);

int MH_STDCALL MHModLoaderInit(const MHHostAPI *host, const MHAPI *api)
{
    PFN_LoadLibraryA load_library;
    PFN_GetProcAddress get_proc;
    mh_u32 i, count, native_loaded=0u, script_loaded=0u, failed=0u;
    char path[MH_PACKAGE_PATH_CAP];

    if(!host||!api||!host->symbol||!host->log)return 0;
    load_library=(PFN_LoadLibraryA)(void *)host->symbol("win32.load_library_a");
    get_proc=(PFN_GetProcAddress)(void *)host->symbol("win32.get_proc_address");
    if(!load_library||!get_proc)return 0;

    count=MHPackageCount();
    for(i=0u;i<count;++i){
        const MHPackage *package=MHPackageAt(i);
        MHModule module;
        PFN_MHModInit init;
        int script_result;
        if(!package)continue;

        if(!MHPackagePath(package,MH_PACKAGE_NATIVE_ENTRY,path,sizeof(path))){++failed;continue;}
        module=load_library(path);
        if(module){
            init=(PFN_MHModInit)get_proc(module,"MHModInit");
            if(!init){host->log("MH mods: mod.dll is missing MHModInit");host->log(package->id);++failed;}
            else{
                MHModContext context;
                context.mh=api;
                context.mod.id=package->id;context.mod.name=package->name;context.mod.version=package->version;
                context.mod.author=package->author;context.mod.description=package->description;context.mod.root=package->root;
                host->log("MH mods: initializing native code");host->log(package->id);
                if(init(&context))++native_loaded;
                else{host->log("MH mods: MHModInit returned failure");host->log(package->id);++failed;}
            }
        }

        script_result=MHScriptHostTryLoad(package);
        if(script_result>0)++script_loaded;else if(script_result<0)++failed;
    }

    if(native_loaded)host->log("MH mods: native code initialized");
    if(script_loaded)host->log("MH mods: Lua scripts initialized");
    if(failed)host->log("MH mods: one or more packages failed to initialize");
    return 1;
}
