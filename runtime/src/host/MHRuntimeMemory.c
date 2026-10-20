/*
 * Memory primitives for a DLL that links without the C runtime.
 *
 * The compiler still emits calls to memcpy/memset/memmove for struct copies
 * and array initialisers, so the runtime has to supply them itself.
 */

typedef unsigned int mh_size_t;
typedef unsigned char mh_byte;

#if defined(_MSC_VER) && !defined(__clang__)
/* With optimisation on, MSVC treats these names as intrinsics and refuses to
   let them be defined unless they are declared as ordinary functions first. */
void *__cdecl memcpy(void *dst, const void *src, mh_size_t n);
void *__cdecl memset(void *dst, int value, mh_size_t n);
void *__cdecl memmove(void *dst, const void *src, mh_size_t n);
#pragma function(memcpy, memset, memmove)
/* Keep the optimiser from recognising the loops below as memcpy/memset calls,
   which would make these functions call themselves. */
#pragma optimize("", off)
#endif

void *__cdecl memcpy(void *dst, const void *src, mh_size_t n)
{
    mh_byte *d = (mh_byte *)dst;
    const mh_byte *s = (const mh_byte *)src;
    mh_size_t i;
    for (i = 0; i < n; ++i) d[i] = s[i];
    return dst;
}

void *__cdecl memset(void *dst, int value, mh_size_t n)
{
    mh_byte *d = (mh_byte *)dst;
    mh_size_t i;
    for (i = 0; i < n; ++i) d[i] = (mh_byte)value;
    return dst;
}

void *__cdecl memmove(void *dst, const void *src, mh_size_t n)
{
    mh_byte *d = (mh_byte *)dst;
    const mh_byte *s = (const mh_byte *)src;
    mh_size_t i;
    if (d < s) {
        for (i = 0; i < n; ++i) d[i] = s[i];
    } else if (d > s) {
        for (i = n; i > 0; --i) d[i - 1] = s[i - 1];
    }
    return dst;
}
