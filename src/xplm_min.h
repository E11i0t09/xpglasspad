// Minimal X-Plane SDK 4.x declarations – only what XPGlassPad uses.
// Signatures follow the official SDK reference (developer.x-plane.com/sdk).
// Windows links against an import library built from xplm_64.def; macOS and Linux
// resolve the symbols at load time from the running X-Plane process.
#pragma once
#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define XPLM_API __declspec(dllimport)
#else
#define XPLM_API
#endif

typedef void *XPLMCommandRef;
typedef void *XPLMDataRef;
typedef void *XPLMFlightLoopID;
typedef void *XPLMAvionicsID;
typedef int   XPLMPluginID;
typedef int   XPLMDeviceID;

enum {
  xplm_device_GNS430_1 = 0, xplm_device_GNS430_2 = 1,
  xplm_device_GNS530_1 = 2, xplm_device_GNS530_2 = 3,
  xplm_device_G1000_PFD_1 = 6, xplm_device_G1000_MFD = 7, xplm_device_G1000_PFD_2 = 8,
};

typedef int  XPLMMouseStatus;
typedef int  XPLMCursorStatus;
typedef char XPLMKeyFlags;
typedef int (*XPLMAvionicsCallback_f)(XPLMDeviceID inDeviceID, int inIsBefore, void *inRefcon);
typedef int (*XPLMAvionicsMouse_f)(int x, int y, XPLMMouseStatus inMouse, void *inRefcon);
typedef int (*XPLMAvionicsMouseWheel_f)(int x, int y, int wheel, int clicks, void *inRefcon);
typedef XPLMCursorStatus (*XPLMAvionicsCursor_f)(int x, int y, void *inRefcon);
typedef int (*XPLMAvionicsKeyboard_f)(char inKey, XPLMKeyFlags inFlags, char inVirtualKey,
                                      void *inRefCon, int losingFocus);

typedef struct {
  int structSize;
  XPLMDeviceID deviceId;
  XPLMAvionicsCallback_f drawCallbackBefore;
  XPLMAvionicsCallback_f drawCallbackAfter;
  XPLMAvionicsMouse_f bezelClickCallback;
  XPLMAvionicsMouse_f bezelRightClickCallback;
  XPLMAvionicsMouseWheel_f bezelScrollCallback;
  XPLMAvionicsCursor_f bezelCursorCallback;
  XPLMAvionicsMouse_f screenTouchCallback;
  XPLMAvionicsMouse_f screenRightTouchCallback;
  XPLMAvionicsMouseWheel_f screenScrollCallback;
  XPLMAvionicsCursor_f screenCursorCallback;
  XPLMAvionicsKeyboard_f keyboardCallback;
  void *refcon;
} XPLMCustomizeAvionics_t;

typedef float (*XPLMFlightLoop_f)(float inElapsedSinceLastCall, float inElapsedTimeSinceLastFlightLoop,
                                  int inCounter, void *inRefcon);

XPLM_API XPLMAvionicsID XPLMRegisterAvionicsCallbacksEx(XPLMCustomizeAvionics_t *inParams);
XPLM_API void  XPLMUnregisterAvionicsCallbacks(XPLMAvionicsID inAvionicsId);
XPLM_API int   XPLMIsAvionicsBound(XPLMAvionicsID inHandle);

XPLM_API XPLMCommandRef XPLMFindCommand(const char *inName);
XPLM_API void  XPLMCommandBegin(XPLMCommandRef inCommand);
XPLM_API void  XPLMCommandEnd(XPLMCommandRef inCommand);
XPLM_API void  XPLMCommandOnce(XPLMCommandRef inCommand);

XPLM_API void  XPLMRegisterFlightLoopCallback(XPLMFlightLoop_f inFlightLoop, float inInterval, void *inRefcon);
XPLM_API void  XPLMUnregisterFlightLoopCallback(XPLMFlightLoop_f inFlightLoop, void *inRefcon);

XPLM_API XPLMDataRef XPLMFindDataRef(const char *inDataRefName);
XPLM_API int   XPLMGetDatab(XPLMDataRef inDataRef, void *outValue, int inOffset, int inMaxBytes);
XPLM_API float XPLMGetElapsedTime(void);

XPLM_API void  XPLMGetNthAircraftModel(int inIndex, char *outFileName, char *outPath);
XPLM_API void  XPLMDebugString(const char *inString);
XPLM_API XPLMPluginID XPLMGetMyID(void);
XPLM_API void  XPLMGetPluginInfo(XPLMPluginID inPlugin, char *outName, char *outFilePath,
                                 char *outSignature, char *outDescription);
XPLM_API void  XPLMEnableFeature(const char *inFeature, int inEnable);

#ifdef __cplusplus
}
#endif
