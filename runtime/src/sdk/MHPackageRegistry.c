#include "MHPackageRegistry.h"
#include "MHOptions.h"

/* One package registry for every runtime subsystem. A package is accepted only
   when mods\\<id>\\mod.json exists, is valid JSON, declares format mhmod-1,
   and its manifest id matches the directory name exactly. Mods listed as
   disabled in mods\\settings.cfg are left out entirely: no code, maps or
   assets of theirs are used. */

typedef void *MHHandle;
typedef int mh_bool;

#define MH_INVALID_HANDLE ((MHHandle)(mh_i32)-1)
#define MH_FILE_ATTRIBUTE_DIRECTORY 0x10u
#define MH_GENERIC_READ 0x80000000u
#define MH_FILE_SHARE_READ 0x00000001u
#define MH_OPEN_EXISTING 3u
#define MH_FILE_ATTRIBUTE_NORMAL 0x00000080u
#define MH_INVALID_FILE_SIZE 0xffffffffu
#define MH_MANIFEST_MAX 16384u
#define MH_MAX_PATH 260u

typedef struct MHFileTime { mh_u32 lo, hi; } MHFileTime;
typedef struct MHFindDataA {
    mh_u32 attributes;
    MHFileTime creation, access, write;
    mh_u32 size_high, size_low, reserved0, reserved1;
    char filename[MH_MAX_PATH];
    char alt_filename[14];
} MHFindDataA;

typedef MHHandle (MH_STDCALL *PFN_FindFirstFileA)(const char *, MHFindDataA *);
typedef mh_bool (MH_STDCALL *PFN_FindNextFileA)(MHHandle, MHFindDataA *);
typedef mh_bool (MH_STDCALL *PFN_FindClose)(MHHandle);
typedef MHHandle (MH_STDCALL *PFN_CreateFileA)(const char *, mh_u32, mh_u32, void *, mh_u32, mh_u32, MHHandle);
typedef mh_bool (MH_STDCALL *PFN_ReadFile)(MHHandle, void *, mh_u32, mh_u32 *, void *);
typedef mh_u32 (MH_STDCALL *PFN_GetFileSize)(MHHandle, mh_u32 *);
typedef mh_bool (MH_STDCALL *PFN_CloseHandle)(MHHandle);

typedef struct MHJson {
    const char *p;
    const char *end;
} MHJson;

static const MHHostAPI *g_host;
static MHPackage g_packages[MH_PACKAGE_MAX];
static mh_u32 g_package_count;
static char g_manifest_buffer[MH_MANIFEST_MAX + 1u];

static int ascii_lower(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }
static int compare_names(const char *a, const char *b)
{
    int ca, cb;
    while (*a || *b) {
        ca=ascii_lower((unsigned char)*a); cb=ascii_lower((unsigned char)*b);
        if (ca<cb) return -1; if (ca>cb) return 1;
        if (*a) ++a; if (*b) ++b;
    }
    return 0;
}
static int text_equal(const char *a,const char *b)
{
    if(!a||!b)return 0; while(*a&&*b&&*a==*b){++a;++b;} return *a==0&&*b==0;
}
static int copy_text(char *out,mh_u32 cap,const char *src)
{
    mh_u32 i=0u; if(!out||!cap||!src)return 0;
    while(src[i]){if(i+1u>=cap)return 0;out[i]=src[i];++i;}out[i]=0;return 1;
}
static int append_text(char *out,mh_u32 cap,const char *src)
{
    mh_u32 i=0u,j=0u;while(i<cap&&out[i])++i;if(i>=cap||!src)return 0;
    while(src[j]){if(i+1u>=cap)return 0;out[i++]=src[j++];}out[i]=0;return 1;
}
static int valid_id(const char *id)
{
    mh_u32 i=0u; unsigned char c;
    if(!id||!*id)return 0;
    while((c=(unsigned char)id[i])!=0u){
        if(i+1u>=MH_PACKAGE_ID_CAP)return 0;
        if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'||c=='.'))return 0;
        ++i;
    }
    return 1;
}
static void copy_id(char *dst,const char *src){mh_u32 i=0u;while(src[i]&&i+1u<MH_PACKAGE_ID_CAP){dst[i]=src[i];++i;}dst[i]=0;}
static void copy_package(MHPackage *dst,const MHPackage *src)
{
    copy_text(dst->id,sizeof(dst->id),src->id);
    copy_text(dst->name,sizeof(dst->name),src->name);
    copy_text(dst->version,sizeof(dst->version),src->version);
    copy_text(dst->author,sizeof(dst->author),src->author);
    copy_text(dst->description,sizeof(dst->description),src->description);
    copy_text(dst->root,sizeof(dst->root),src->root);
}
static void sort_packages(void)
{
    mh_u32 i,j; MHPackage temp;
    for(i=1u;i<g_package_count;++i){
        copy_package(&temp,&g_packages[i]); j=i;
        while(j>0u&&compare_names(temp.id,g_packages[j-1u].id)<0){copy_package(&g_packages[j],&g_packages[j-1u]);--j;}
        copy_package(&g_packages[j],&temp);
    }
}

static void json_ws(MHJson *j){while(j->p<j->end&&(*j->p==' '||*j->p=='\t'||*j->p=='\r'||*j->p=='\n'))++j->p;}
static int json_string(MHJson *j,char *out,mh_u32 cap)
{
    mh_u32 n=0u; char c;
    if(j->p>=j->end||*j->p!='\"')return 0;++j->p;
    while(j->p<j->end){
        c=*j->p++;
        if(c=='\"'){if(out){if(n>=cap)return 0;out[n]=0;}return 1;}
        if((unsigned char)c<0x20u)return 0;
        if(c=='\\'){
            if(j->p>=j->end)return 0;c=*j->p++;
            if(c=='\"'||c=='\\'||c=='/'){}
            else if(c=='b')c='\b';else if(c=='f')c='\f';else if(c=='n')c='\n';else if(c=='r')c='\r';else if(c=='t')c='\t';
            else return 0; /* package IDs/format never require unicode escapes */
        }
        if(out){if(n+1u>=cap)return 0;out[n++]=c;}
    }
    return 0;
}
static int json_skip_value(MHJson *j,int depth);
static int json_skip_object(MHJson *j,int depth)
{
    char key[64]; if(depth>16||j->p>=j->end||*j->p!='{')return 0;++j->p;json_ws(j);
    if(j->p<j->end&&*j->p=='}'){++j->p;return 1;}
    for(;;){
        if(!json_string(j,key,sizeof(key)))return 0;json_ws(j);if(j->p>=j->end||*j->p!=':')return 0;++j->p;json_ws(j);
        if(!json_skip_value(j,depth+1))return 0;json_ws(j);
        if(j->p>=j->end)return 0;if(*j->p=='}'){++j->p;return 1;}if(*j->p!=',')return 0;++j->p;json_ws(j);
    }
}
static int json_skip_array(MHJson *j,int depth)
{
    if(depth>16||j->p>=j->end||*j->p!='[')return 0;++j->p;json_ws(j);
    if(j->p<j->end&&*j->p==']'){++j->p;return 1;}
    for(;;){if(!json_skip_value(j,depth+1))return 0;json_ws(j);if(j->p>=j->end)return 0;if(*j->p==']'){++j->p;return 1;}if(*j->p!=',')return 0;++j->p;json_ws(j);}
}
static int json_literal(MHJson *j,const char *text)
{
    const char *p=text;
    while(*p){if(j->p>=j->end||*j->p!=*p)return 0;++j->p;++p;}
    return 1;
}
static int json_number(MHJson *j)
{
    const char *p=j->p;
    if(p<j->end&&*p=='-')++p;
    if(p>=j->end)return 0;
    if(*p=='0')++p;
    else { if(*p<'1'||*p>'9')return 0; do{++p;}while(p<j->end&&*p>='0'&&*p<='9'); }
    if(p<j->end&&*p=='.'){++p;if(p>=j->end||*p<'0'||*p>'9')return 0;do{++p;}while(p<j->end&&*p>='0'&&*p<='9');}
    if(p<j->end&&(*p=='e'||*p=='E')){++p;if(p<j->end&&(*p=='+'||*p=='-'))++p;if(p>=j->end||*p<'0'||*p>'9')return 0;do{++p;}while(p<j->end&&*p>='0'&&*p<='9');}
    j->p=p;return 1;
}
static int json_skip_value(MHJson *j,int depth)
{
    if(depth>16)return 0;json_ws(j);if(j->p>=j->end)return 0;
    if(*j->p=='\"')return json_string(j,(char *)0,0u);
    if(*j->p=='{')return json_skip_object(j,depth);
    if(*j->p=='[')return json_skip_array(j,depth);
    if(*j->p=='t')return json_literal(j,"true");
    if(*j->p=='f')return json_literal(j,"false");
    if(*j->p=='n')return json_literal(j,"null");
    return json_number(j);
}
/* A string that is cut to fit rather than refused; used for display text. */
static int json_text(MHJson *j,char *out,mh_u32 cap)
{
    mh_u32 n=0u; char c;
    if(j->p>=j->end||*j->p!='\"')return 0;++j->p;
    while(j->p<j->end){
        c=*j->p++;
        if(c=='\"'){out[n]=0;return 1;}
        if((unsigned char)c<0x20u)return 0;
        if(c=='\\'){
            if(j->p>=j->end)return 0;c=*j->p++;
            if(c=='u'){mh_u32 k;for(k=0u;k<4u;++k){if(j->p>=j->end)return 0;++j->p;}c='?';}
            else if(c=='n'||c=='r'||c=='t'||c=='b'||c=='f')c=' ';
        }
        if(n+1u<cap)out[n++]=c;
    }
    return 0;
}
/* An integer; a fraction or exponent is accepted and dropped. */
static int json_integer(MHJson *j,mh_i32 *out)
{
    const char *start=j->p; mh_u32 value=0u; int negative=0;
    if(!json_number(j))return 0;
    if(*start=='-'){negative=1;++start;}
    while(start<j->p&&*start>='0'&&*start<='9'){if(value<200000000u)value=value*10u+(mh_u32)(*start-'0');++start;}
    *out=negative?-(mh_i32)value:(mh_i32)value;
    return 1;
}
static int json_bool(MHJson *j,int *out)
{
    if(j->p<j->end&&*j->p=='t'){*out=1;return json_literal(j,"true");}
    if(j->p<j->end&&*j->p=='f'){*out=0;return json_literal(j,"false");}
    return 0;
}
static int same_text_i(const char *a,const char *b){return compare_names(a,b)==0;}

#define OPTION_TEXT_CAP 41u
#define OPTION_CHOICE_CAP 25u

/* One entry of "options". Returns 0 only when the JSON itself is malformed;
   an option that makes no sense is logged and skipped. */
static int parse_option(MHJson *j,const MHPackage *package)
{
    static char choice_text[MH_OPTION_CHOICE_MAX][OPTION_CHOICE_CAP];
    const char *choice_list[MH_OPTION_CHOICE_MAX];
    char name[32],key[OPTION_TEXT_CAP],label[OPTION_TEXT_CAP],section[OPTION_CHOICE_CAP],type[12],default_text[OPTION_CHOICE_CAP],unique[OPTION_CHOICE_CAP];
    MHOption option;
    MHOptionSpec spec; mh_i32 default_number=0; mh_u32 choice_count=0u,i;
    int default_kind=0,flag=0,usable=1; /* default_kind: 1 bool/number, 2 text */
    key[0]=0;label[0]=0;section[0]=0;type[0]=0;default_text[0]=0;unique[0]=0;
    spec.flags=0u;spec.min=0;spec.max=100;spec.step=1;
    if(j->p>=j->end||*j->p!='{')return 0;++j->p;json_ws(j);
    if(j->p<j->end&&*j->p=='}'){++j->p;return 1;}
    for(;;){
        if(!json_string(j,name,sizeof(name)))return 0;json_ws(j);if(j->p>=j->end||*j->p!=':')return 0;++j->p;json_ws(j);
        if(text_equal(name,"key")){if(!json_text(j,key,sizeof(key)))return 0;}
        else if(text_equal(name,"label")){if(!json_text(j,label,sizeof(label)))return 0;}
        else if(text_equal(name,"section")){if(!json_text(j,section,sizeof(section)))return 0;}
        else if(text_equal(name,"unique")){if(!json_text(j,unique,sizeof(unique)))return 0;}
        else if(text_equal(name,"type")){if(!json_text(j,type,sizeof(type)))return 0;}
        else if(text_equal(name,"min")){if(!json_integer(j,&spec.min))return 0;}
        else if(text_equal(name,"max")){if(!json_integer(j,&spec.max))return 0;}
        else if(text_equal(name,"step")){if(!json_integer(j,&spec.step))return 0;}
        else if(text_equal(name,"restart")){if(!json_bool(j,&flag))return 0;if(flag)spec.flags|=MH_OPTION_RESTART;}
        else if(text_equal(name,"hidden")){if(!json_bool(j,&flag))return 0;if(flag)spec.flags|=MH_OPTION_HIDDEN;}
        else if(text_equal(name,"saved")){if(!json_bool(j,&flag))return 0;if(!flag)spec.flags|=MH_OPTION_SESSION;}
        else if(text_equal(name,"default")){
            if(j->p<j->end&&*j->p=='\"'){if(!json_text(j,default_text,sizeof(default_text)))return 0;default_kind=2;}
            else if(j->p<j->end&&(*j->p=='t'||*j->p=='f')){if(!json_bool(j,&flag))return 0;default_number=flag;default_kind=1;}
            else{if(!json_integer(j,&default_number))return 0;default_kind=1;}
        }
        else if(text_equal(name,"choices")){
            if(j->p>=j->end||*j->p!='[')return 0;++j->p;json_ws(j);
            if(j->p<j->end&&*j->p==']')++j->p;
            else for(;;){
                char spare[OPTION_CHOICE_CAP];
                if(!json_text(j,choice_count<MH_OPTION_CHOICE_MAX?choice_text[choice_count]:spare,OPTION_CHOICE_CAP))return 0;
                if(choice_count<MH_OPTION_CHOICE_MAX)++choice_count;
                json_ws(j);if(j->p>=j->end)return 0;if(*j->p==']'){++j->p;break;}if(*j->p!=',')return 0;++j->p;json_ws(j);
            }
        }
        else if(!json_skip_value(j,1))return 0;
        json_ws(j);if(j->p>=j->end)return 0;if(*j->p=='}'){++j->p;break;}if(*j->p!=',')return 0;++j->p;json_ws(j);
    }

    if(text_equal(type,"toggle"))spec.type=MH_OPTION_TOGGLE;
    else if(text_equal(type,"choice"))spec.type=MH_OPTION_CHOICE;
    else if(text_equal(type,"number"))spec.type=MH_OPTION_NUMBER;
    else if(text_equal(type,"key"))spec.type=MH_OPTION_KEY;
    else if(text_equal(type,"action"))spec.type=MH_OPTION_ACTION;
    else{spec.type=MH_OPTION_ACTION;usable=0;}
    for(i=0u;i<choice_count;++i)choice_list[i]=choice_text[i];
    spec.key=key;spec.label=label;spec.section=section;spec.choices=choice_list;spec.choice_count=choice_count;
    spec.default_value=default_number;
    if(default_kind==2){
        if(spec.type==MH_OPTION_CHOICE){for(i=0u;i<choice_count;++i)if(same_text_i(default_text,choice_text[i]))spec.default_value=(mh_i32)i;}
        else if(spec.type==MH_OPTION_KEY){int vk=MHKeyCode(default_text);spec.default_value=vk<0?0:vk;}
        else if(spec.type==MH_OPTION_TOGGLE)spec.default_value=same_text_i(default_text,"on")||same_text_i(default_text,"true");
    }
    option=usable?MHOptionAdd(package->id,package->name,&spec):MH_INVALID_OPTION;
    if(!option){
        g_host->log("MH packages: an entry in \"options\" is not usable and was skipped");g_host->log(package->id);
    }
    else if(unique[0])MHOptionSetUnique(option,unique);
    return 1;
}
static void register_options(const char *at,const char *end,const MHPackage *package)
{
    MHJson j;
    if(!at)return;
    j.p=at;j.end=end;
    if(j.p>=j.end||*j.p!='[')return;++j.p;json_ws(&j);
    if(j.p<j.end&&*j.p==']')return;
    for(;;){
        if(!parse_option(&j,package))return;
        json_ws(&j);if(j.p>=j.end||*j.p!=',')return;++j.p;json_ws(&j);
    }
}

static int parse_manifest(const char *data,mh_u32 size,const char *directory_id,MHPackage *package,const char **options_out)
{
    MHJson j; char key[64],format[32],id[MH_PACKAGE_ID_CAP];
    int got_format=0,got_id=0,got_name=0,got_version=0,got_author=0,got_description=0;
    if(!package)return 0;
    *options_out=(const char *)0;
    package->name[0]=0;package->version[0]=0;package->author[0]=0;package->description[0]=0;
    j.p=data;j.end=data+size;
    if(size>=3u&&(unsigned char)j.p[0]==0xefu&&(unsigned char)j.p[1]==0xbbu&&(unsigned char)j.p[2]==0xbfu)j.p+=3;
    json_ws(&j);if(j.p>=j.end||*j.p!='{')return 0;++j.p;json_ws(&j);
    if(j.p<j.end&&*j.p=='}')return 0;
    for(;;){
        if(!json_string(&j,key,sizeof(key)))return 0;json_ws(&j);if(j.p>=j.end||*j.p!=':')return 0;++j.p;json_ws(&j);
        if(text_equal(key,"format")){if(got_format||!json_string(&j,format,sizeof(format)))return 0;got_format=1;}
        else if(text_equal(key,"id")){if(got_id||!json_string(&j,id,sizeof(id)))return 0;got_id=1;}
        else if(text_equal(key,"name")){if(got_name||!json_string(&j,package->name,sizeof(package->name)))return 0;got_name=1;}
        else if(text_equal(key,"version")){if(got_version||!json_string(&j,package->version,sizeof(package->version)))return 0;got_version=1;}
        else if(text_equal(key,"author")){if(got_author||!json_string(&j,package->author,sizeof(package->author)))return 0;got_author=1;}
        else if(text_equal(key,"description")){if(got_description||!json_string(&j,package->description,sizeof(package->description)))return 0;got_description=1;}
        else if(text_equal(key,"options")){if(j.p>=j.end||*j.p!='[')return 0;*options_out=j.p;if(!json_skip_value(&j,1))return 0;}
        else if(!json_skip_value(&j,1))return 0; /* a key from a newer format, or a mod's own notes */
        json_ws(&j);if(j.p>=j.end)return 0;if(*j.p=='}'){++j.p;break;}if(*j.p!=',')return 0;++j.p;json_ws(&j);
    }
    json_ws(&j);if(j.p!=j.end)return 0;
    if(!(got_format&&got_id&&got_name&&package->name[0]&&text_equal(format,MH_PACKAGE_FORMAT)&&text_equal(id,directory_id)&&valid_id(id)))return 0;
    if(!got_version&&!copy_text(package->version,sizeof(package->version),"0.1.0"))return 0;
    return 1;
}

static int read_manifest(const MHHostAPI *host,const char *path,const char *directory_id,MHPackage *package)
{
    PFN_CreateFileA create_file=(PFN_CreateFileA)(void *)host->symbol("win32.create_file_a");
    PFN_ReadFile read_file=(PFN_ReadFile)(void *)host->symbol("win32.read_file");
    PFN_GetFileSize get_size=(PFN_GetFileSize)(void *)host->symbol("win32.get_file_size");
    PFN_CloseHandle close_handle=(PFN_CloseHandle)(void *)host->symbol("win32.close_handle");
    MHHandle h;mh_u32 high=0u,size,got=0u;
    if(!create_file||!read_file||!get_size||!close_handle)return -1;
    h=create_file(path,MH_GENERIC_READ,MH_FILE_SHARE_READ,(void *)0,MH_OPEN_EXISTING,MH_FILE_ATTRIBUTE_NORMAL,(MHHandle)0);
    if(!h||h==MH_INVALID_HANDLE)return 0; /* ordinary non-package directory */
    size=get_size(h,&high);if(size==MH_INVALID_FILE_SIZE||high||!size||size>MH_MANIFEST_MAX){close_handle(h);return -1;}
    if(!read_file(h,g_manifest_buffer,size,&got,(void *)0)||got!=size){close_handle(h);return -1;}close_handle(h);g_manifest_buffer[size]=0;
    {
        const char *options=(const char *)0;
        if(!parse_manifest(g_manifest_buffer,size,directory_id,package,&options))return -1;
        register_options(options,g_manifest_buffer+size,package);
    }
    return 1;
}

int MH_STDCALL MHPackagePath(const MHPackage *package,const char *relative_path,char *out,mh_u32 cap)
{
    if(!package||!relative_path||!out||!cap)return 0;
    if(!copy_text(out,cap,package->root))return 0;
    if(*relative_path){if(!append_text(out,cap,"\\"))return 0;if(!append_text(out,cap,relative_path))return 0;}
    return 1;
}

int MH_STDCALL MHPackageRegistryInit(const MHHostAPI *host)
{
    PFN_FindFirstFileA find_first;PFN_FindNextFileA find_next;PFN_FindClose find_close;MHFindDataA fd;MHHandle h;char manifest[MH_PACKAGE_PATH_CAP];
    if(!host||!host->symbol||!host->log)return 0;g_host=host;g_package_count=0u;
    find_first=(PFN_FindFirstFileA)(void *)host->symbol("win32.find_first_file_a");find_next=(PFN_FindNextFileA)(void *)host->symbol("win32.find_next_file_a");find_close=(PFN_FindClose)(void *)host->symbol("win32.find_close");
    if(!find_first||!find_next||!find_close)return 0;if(host->make_directory)host->make_directory("mods");
    h=find_first("mods\\*",&fd);if(h==MH_INVALID_HANDLE){host->log("MH packages: no package directory entries");return 1;}
    do{
        MHPackage *p;if(!(fd.attributes&MH_FILE_ATTRIBUTE_DIRECTORY))continue;if(fd.filename[0]=='.'&&(fd.filename[1]==0||(fd.filename[1]=='.'&&fd.filename[2]==0)))continue;
        if(!valid_id(fd.filename)){host->log("MH packages: ignored folder with invalid package ID");host->log(fd.filename);continue;}
        if(MHOptionsModDisabled(fd.filename)){host->log("MH packages: switched off in mods\\settings.cfg");host->log(fd.filename);continue;}
        if(g_package_count>=MH_PACKAGE_MAX){host->log("MH packages: package limit reached");break;}
        p=&g_packages[g_package_count];copy_id(p->id,fd.filename);p->root[0]=0;copy_text(p->root,sizeof(p->root),"mods\\");append_text(p->root,sizeof(p->root),p->id);
        {
            int manifest_status;
            if(!MHPackagePath(p,MH_PACKAGE_MANIFEST,manifest,sizeof(manifest)))continue;
            manifest_status=read_manifest(host,manifest,p->id,p);
            if(manifest_status==0)continue;
            if(manifest_status<0){host->log("MH packages: ignored package with invalid mod.json");host->log(p->id);continue;}
        }
        ++g_package_count;
    }while(find_next(h,&fd));find_close(h);sort_packages();
    if(g_package_count){mh_u32 i;host->log("MH packages: package registry initialized");for(i=0u;i<g_package_count;++i){host->log("MH packages: accepted");host->log(g_packages[i].id);}}
    else host->log("MH packages: no valid packages found");return 1;
}

mh_u32 MH_STDCALL MHPackageCount(void){return g_package_count;}
const MHPackage *MH_STDCALL MHPackageAt(mh_u32 index){return index<g_package_count?&g_packages[index]:(const MHPackage *)0;}
const MHPackage *MH_STDCALL MHPackageFind(const char *id)
{
    mh_u32 i;
    if(!id)return (const MHPackage *)0;
    for(i=0u;i<g_package_count;++i)if(text_equal(g_packages[i].id,id))return &g_packages[i];
    return (const MHPackage *)0;
}
