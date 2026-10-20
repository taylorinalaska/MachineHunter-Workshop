#ifndef MH_PACKAGE_REGISTRY_H
#define MH_PACKAGE_REGISTRY_H

#include "mh_host.h"
#include "mh_contract.h"

#define MH_PACKAGE_MAX 64u
#define MH_PACKAGE_ID_CAP 96u
#define MH_PACKAGE_PATH_CAP 360u
#define MH_PACKAGE_NAME_CAP 129u
#define MH_PACKAGE_VERSION_CAP 65u
#define MH_PACKAGE_AUTHOR_CAP 129u
#define MH_PACKAGE_DESCRIPTION_CAP 1025u

typedef struct MHPackage {
    char id[MH_PACKAGE_ID_CAP];
    char name[MH_PACKAGE_NAME_CAP];
    char version[MH_PACKAGE_VERSION_CAP];
    char author[MH_PACKAGE_AUTHOR_CAP];
    char description[MH_PACKAGE_DESCRIPTION_CAP];
    char root[MH_PACKAGE_PATH_CAP];
} MHPackage;

int MH_STDCALL MHPackageRegistryInit(const MHHostAPI *host);
mh_u32 MH_STDCALL MHPackageCount(void);
const MHPackage *MH_STDCALL MHPackageAt(mh_u32 index);
const MHPackage *MH_STDCALL MHPackageFind(const char *id);
int MH_STDCALL MHPackagePath(const MHPackage *package,const char *relative_path,char *out,mh_u32 out_capacity);
#endif
