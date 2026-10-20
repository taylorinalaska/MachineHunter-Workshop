#ifndef DEV_TOOLS_TRACE_H
#define DEV_TOOLS_TRACE_H

/* The event trace (trace.c). */
int DevTraceInit(void);
int DevTraceSetEnabled(int enabled);
void DevTraceInsertMarker(void);
void DevTraceFrame(void);

#endif
