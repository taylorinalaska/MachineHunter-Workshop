#ifndef MH_GAME_SYSTEMS_H
#define MH_GAME_SYSTEMS_H

#include "mh_host.h"
#include "mh.h"

/*
 * Engine services behind the public camera, input, draw and startup calls.
 * Their hooks are installed once and do nothing until a mod asks for them.
 */

int MH_STDCALL MHGameSystemsInit(const MHHostAPI *host);

/* Camera (MHGameSystems.c). Positions are world units. */
int MH_STDCALL MHCameraGet(MHCameraState *state);
int MH_STDCALL MHCameraSet(const MHPosition *position, mh_i32 zoom);
int MH_STDCALL MHCameraPan(mh_i32 right, mh_i32 down);
void MH_STDCALL MHCameraRelease(void);
int MH_STDCALL MHCameraProject(const MHPosition *world, mh_i32 *screen_x, mh_i32 *screen_y);

/* Input: controls blocked now stay hidden from the game for the next frame. */
void MH_STDCALL MHInputBlock(mh_u32 controls);
mh_u32 MH_STDCALL MHInputBlocked(void);
void MH_STDCALL MHInputEndFrame(void);

/* Startup: skip the logo/intro movies and/or the PRESS START title loop. */
void MH_STDCALL MHStartupSkip(int movies, int title);

/* Drawing (MHDrawSystem.c). MHDrawFrame runs the DRAW events for one frame. */
void MH_STDCALL MHDrawFrame(void);
int MH_STDCALL MHDrawSize(mh_i32 *width, mh_i32 *height);
mh_u32 MH_STDCALL MHDrawColor(mh_u32 rgb);
void MH_STDCALL MHDrawRect(mh_i32 x, mh_i32 y, mh_i32 width, mh_i32 height, mh_u32 color);
void MH_STDCALL MHDrawShade(mh_i32 x, mh_i32 y, mh_i32 width, mh_i32 height, mh_u32 percent);
void MH_STDCALL MHDrawLine(mh_i32 x0, mh_i32 y0, mh_i32 x1, mh_i32 y1, mh_u32 color);
mh_i32 MH_STDCALL MHDrawText(mh_i32 x, mh_i32 y, const char *text, mh_u32 color, mh_u32 scale);
mh_i32 MH_STDCALL MHDrawTextWidth(const char *text, mh_u32 scale);
int MH_STDCALL MHDrawGetTarget(MHDrawTarget *target);

#endif
