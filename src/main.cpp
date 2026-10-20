// XPGlassPad – X-Plane 12 plugin
// Streams the built-in G1000 (PFD1/PFD2/MFD) and GNS430/530 screens to an iPad web app
// and executes the bezel key/knob commands coming back from it.
//
// How it works
//  * For every supported built-in device we register an avionics "draw after" callback
//    (SDK 4, XPLMRegisterAvionicsCallbacksEx). Inside that callback X-Plane has the
//    device's own render target bound, so we can read the finished screen with
//    glReadPixels – no popups, no second monitor, independent of the camera view.
//  * Reading only happens while an iPad is actually watching that device (throttled
//    to the configured fps). Optional PBO mode makes the read asynchronous.
//  * JPEG encoding runs on a worker thread, HTTP (cpp-httplib) on its own threads.
//  * XPLMIsAvionicsBound() tells which devices the loaded aircraft actually uses –
//    that's how the web app knows what to show.
//  * All X-Plane API calls (commands, datarefs) happen on the main thread via a queue.

#if defined(_WIN32)
  #define WIN32_LEAN_AND_MEAN
  #ifndef _WIN32_WINNT
  #define _WIN32_WINNT 0x0A00
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  #define PLUGIN_API extern "C" __declspec(dllexport)
  #define GLAPIENTRY_ APIENTRY
#else
  #include <arpa/inet.h>
  #include <dlfcn.h>
  #include <netdb.h>
  #include <sys/socket.h>
  #include <unistd.h>
  #define PLUGIN_API extern "C" __attribute__((visibility("default")))
  #define GLAPIENTRY_
#endif

#include "xplm_min.h"

#define CPPHTTPLIB_THREAD_POOL_COUNT 12
#include "httplib.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "stb_image_write.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------- OpenGL (all entry points loaded at runtime,
// so the plugin doesn't need GL headers/libs and works on Windows, macOS and Linux alike)
typedef unsigned int GLenum;
typedef unsigned int GLuint;
typedef int GLint;
typedef int GLsizei;
typedef unsigned char GLboolean;
typedef ptrdiff_t GLsizeiptr_;
#define GL_VIEWPORT 0x0BA2
#define GL_PACK_ALIGNMENT 0x0D05
#define GL_PACK_ROW_LENGTH 0x0D02
#define GL_PACK_SKIP_ROWS 0x0D03
#define GL_PACK_SKIP_PIXELS 0x0D04
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401
#define GL_PIXEL_PACK_BUFFER 0x88EB
#define GL_PIXEL_PACK_BUFFER_BINDING 0x88ED
#define GL_STREAM_READ 0x88E1
#define GL_READ_ONLY 0x88B8
#define GL_READ_FRAMEBUFFER_ 0x8CA8
#define GL_DRAW_FRAMEBUFFER_BINDING_ 0x8CA6
#define GL_READ_FRAMEBUFFER_BINDING_ 0x8CAA

typedef void(GLAPIENTRY_ *PFN_GetIntegerv)(GLenum, GLint *);
typedef void(GLAPIENTRY_ *PFN_PixelStorei)(GLenum, GLint);
typedef void(GLAPIENTRY_ *PFN_ReadPixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *);
typedef void(GLAPIENTRY_ *PFN_BindFramebuffer)(GLenum, GLuint);
typedef void(GLAPIENTRY_ *PFN_BindBuffer)(GLenum, GLuint);
typedef void(GLAPIENTRY_ *PFN_GenBuffers)(GLsizei, GLuint *);
typedef void(GLAPIENTRY_ *PFN_BufferData)(GLenum, GLsizeiptr_, const void *, GLenum);
typedef void *(GLAPIENTRY_ *PFN_MapBuffer)(GLenum, GLenum);
typedef GLboolean(GLAPIENTRY_ *PFN_UnmapBuffer)(GLenum);
static PFN_GetIntegerv glGetIntegerv_;
static PFN_PixelStorei glPixelStorei_;
static PFN_ReadPixels glReadPixels_;
static PFN_BindFramebuffer pglBindFramebuffer;
static PFN_BindBuffer pglBindBuffer;
static PFN_GenBuffers pglGenBuffers;
static PFN_BufferData pglBufferData;
static PFN_MapBuffer pglMapBuffer;
static PFN_UnmapBuffer pglUnmapBuffer;
static bool gGLLoaded = false, gGLOk = false, gPBOAvailable = false;

static void *glProc(const char *name) {
#if defined(_WIN32)
  static HMODULE gl = LoadLibraryA("opengl32.dll");  // already loaded by X-Plane; just gets the handle
  if (!gl) return nullptr;
  typedef PROC(WINAPI * WglGetProc)(LPCSTR);
  static WglGetProc wgp = (WglGetProc)(void *)GetProcAddress(gl, "wglGetProcAddress");
  void *p = wgp ? (void *)wgp(name) : nullptr;
  if (!p || p == (void *)1 || p == (void *)2 || p == (void *)3 || p == (void *)-1)
    p = (void *)GetProcAddress(gl, name);  // GL 1.1 functions are exported directly
  return p;
#elif defined(__APPLE__)
  return dlsym(RTLD_DEFAULT, name);
#else
  void *p = dlsym(RTLD_DEFAULT, name);
  if (p) return p;
  static void *lib = dlopen("libGL.so.1", RTLD_LAZY | RTLD_GLOBAL);
  if (!lib) return nullptr;
  typedef void *(*GetProc)(const unsigned char *);
  static GetProc gp = (GetProc)dlsym(lib, "glXGetProcAddressARB");
  p = dlsym(lib, name);
  if (!p && gp) p = gp((const unsigned char *)name);
  return p;
#endif
}

static void loadGL() {
  if (gGLLoaded) return;
  gGLLoaded = true;
  glGetIntegerv_ = (PFN_GetIntegerv)glProc("glGetIntegerv");
  glPixelStorei_ = (PFN_PixelStorei)glProc("glPixelStorei");
  glReadPixels_ = (PFN_ReadPixels)glProc("glReadPixels");
  pglBindFramebuffer = (PFN_BindFramebuffer)glProc("glBindFramebuffer");
  if (!pglBindFramebuffer) pglBindFramebuffer = (PFN_BindFramebuffer)glProc("glBindFramebufferEXT");
  pglBindBuffer = (PFN_BindBuffer)glProc("glBindBuffer");
  pglGenBuffers = (PFN_GenBuffers)glProc("glGenBuffers");
  pglBufferData = (PFN_BufferData)glProc("glBufferData");
  pglMapBuffer = (PFN_MapBuffer)glProc("glMapBuffer");
  pglUnmapBuffer = (PFN_UnmapBuffer)glProc("glUnmapBuffer");
  gGLOk = glGetIntegerv_ && glPixelStorei_ && glReadPixels_;
  gPBOAvailable = pglBindBuffer && pglGenBuffers && pglBufferData && pglMapBuffer && pglUnmapBuffer;
}

// ---------------------------------------------------------------- config
struct Config {
  int port = 8090;
  int fps = 20;             // max capture rate per watched device
  int quality = 80;         // JPEG quality
  bool pbo = true;          // asynchronous readback
  int watchTimeout = 3;     // seconds without client request -> stop capturing
} gCfg;

static std::string gPluginDir;  // ...\Resources\plugins\XPGlassPad\  (with trailing slash)

static double nowSec() {
  using namespace std::chrono;
  return duration<double>(steady_clock::now().time_since_epoch()).count();
}

// ---------------------------------------------------------------- logging (main thread flush)
static std::mutex gLogMx;
static std::deque<std::string> gLogQ;
static void logq(const std::string &s) {
  std::lock_guard<std::mutex> l(gLogMx);
  gLogQ.push_back("XPGlassPad: " + s + "\n");
}
static void flushLog() {
  std::deque<std::string> q;
  {
    std::lock_guard<std::mutex> l(gLogMx);
    q.swap(gLogQ);
  }
  for (auto &s : q) XPLMDebugString(s.c_str());
}

// ---------------------------------------------------------------- devices
struct Device {
  int id;
  const char *key;     // url key
  const char *name;    // display name
  const char *kind;    // g1000 | gns430 | gns530
  const char *prefix;  // command prefix
  XPLMAvionicsID av = nullptr;
  std::atomic<int> bound{0};
  std::atomic<double> lastWanted{0};
  // capture state (render thread only)
  double lastCapture = 0;
  GLuint pbo = 0;
  int pboW = 0, pboH = 0;
  bool pboPending = false;
  // raw frame handed to encoder
  std::mutex rawMx;
  std::vector<uint8_t> raw;
  int rawW = 0, rawH = 0;
  bool rawFresh = false;
  // encoded frame
  std::mutex jpgMx;
  std::condition_variable jpgCv;
  std::string jpg;
  uint64_t seq = 0;
  int w = 0, h = 0;
  // stats
  std::atomic<uint64_t> captures{0};
  std::atomic<double> readMs{0};
  std::atomic<double> lastDraw{0};
};

static Device gDev[] = {
    {xplm_device_G1000_PFD_1, "pfd1", "G1000 PFD 1", "g1000", "sim/GPS/g1000n1_"},
    {xplm_device_G1000_MFD, "mfd", "G1000 MFD", "g1000", "sim/GPS/g1000n3_"},
    {xplm_device_G1000_PFD_2, "pfd2", "G1000 PFD 2", "g1000", "sim/GPS/g1000n2_"},
    {xplm_device_GNS530_1, "gns530_1", "GNS 530 #1", "gns530", "sim/GPS/g430n1_"},
    {xplm_device_GNS430_1, "gns430_1", "GNS 430 #1", "gns430", "sim/GPS/g430n1_"},
    {xplm_device_GNS530_2, "gns530_2", "GNS 530 #2", "gns530", "sim/GPS/g430n2_"},
    {xplm_device_GNS430_2, "gns430_2", "GNS 430 #2", "gns430", "sim/GPS/g430n2_"},
};
static const int kNumDev = sizeof(gDev) / sizeof(gDev[0]);

static Device *findDev(const std::string &key) {
  for (auto &d : gDev)
    if (key == d.key) return &d;
  return nullptr;
}

// encoder thread
static std::mutex gEncMx;
static std::condition_variable gEncCv;
static std::atomic<bool> gRunning{false};
static std::thread gEncThread;

static void submitRaw(Device *d, const uint8_t *px, int w, int h) {
  {
    std::lock_guard<std::mutex> l(d->rawMx);
    d->raw.assign(px, px + (size_t)w * h * 4);
    d->rawW = w;
    d->rawH = h;
    d->rawFresh = true;
  }
  gEncCv.notify_one();
}

static void stbWrite(void *ctx, void *data, int size) {
  ((std::string *)ctx)->append((const char *)data, size);
}

static void encoderLoop() {
  std::vector<uint8_t> buf;
  while (gRunning) {
    {
      std::unique_lock<std::mutex> l(gEncMx);
      gEncCv.wait_for(l, std::chrono::milliseconds(200));
    }
    for (auto &d : gDev) {
      int w, h;
      {
        std::lock_guard<std::mutex> l(d.rawMx);
        if (!d.rawFresh) continue;
        buf.swap(d.raw);
        w = d.rawW;
        h = d.rawH;
        d.rawFresh = false;
      }
      // force opaque (alpha ignored by JPEG anyway) – GL rows are bottom-up -> flip on write
      std::string out;
      out.reserve(200000);
      stbi_flip_vertically_on_write(1);
      stbi_write_jpg_to_func(stbWrite, &out, w, h, 4, buf.data(), gCfg.quality);
      {
        std::lock_guard<std::mutex> l(d.jpgMx);
        d.jpg.swap(out);
        d.seq++;
        d.w = w;
        d.h = h;
      }
      d.jpgCv.notify_all();
    }
  }
}

// ---------------------------------------------------------------- capture (render callback)
static int drawAfter(XPLMDeviceID, int isBefore, void *ref) {
  if (isBefore) return 1;
  Device *d = (Device *)ref;
  double t = nowSec();
  d->lastDraw = t;
  if (t - d->lastWanted > gCfg.watchTimeout) {
    return 1;
  }
  if (t - d->lastCapture < 1.0 / gCfg.fps) return 1;
  d->lastCapture = t;
  loadGL();
  if (!gGLOk) return 1;

  GLint vp[4] = {0, 0, 0, 0};
  glGetIntegerv_(GL_VIEWPORT, vp);
  int x = vp[0], y = vp[1], w = vp[2], h = vp[3];
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return 1;

  // make sure we read from the surface X-Plane just drew into
  GLint drawFbo = 0, readFbo = 0, packBuf = 0, align = 4, rowLen = 0, skipR = 0, skipP = 0;
  glGetIntegerv_(GL_DRAW_FRAMEBUFFER_BINDING_, &drawFbo);
  glGetIntegerv_(GL_READ_FRAMEBUFFER_BINDING_, &readFbo);
  glGetIntegerv_(GL_PIXEL_PACK_BUFFER_BINDING, &packBuf);
  glGetIntegerv_(GL_PACK_ALIGNMENT, &align);
  glGetIntegerv_(0x0D02 /*GL_PACK_ROW_LENGTH*/, &rowLen);
  glGetIntegerv_(0x0D03 /*GL_PACK_SKIP_ROWS*/, &skipR);
  glGetIntegerv_(0x0D04 /*GL_PACK_SKIP_PIXELS*/, &skipP);
  if (pglBindFramebuffer && drawFbo != readFbo) pglBindFramebuffer(GL_READ_FRAMEBUFFER_, drawFbo);
  glPixelStorei_(GL_PACK_ALIGNMENT, 1);
  glPixelStorei_(GL_PACK_ROW_LENGTH, 0);
  glPixelStorei_(GL_PACK_SKIP_ROWS, 0);
  glPixelStorei_(GL_PACK_SKIP_PIXELS, 0);

  double t0 = nowSec();
  if (gCfg.pbo && gPBOAvailable) {
    if (!d->pbo) pglGenBuffers(1, &d->pbo);
    pglBindBuffer(GL_PIXEL_PACK_BUFFER, d->pbo);
    // 1) harvest the frame requested during the previous capture (long finished by now)
    if (d->pboPending) {
      void *p = pglMapBuffer(GL_PIXEL_PACK_BUFFER, GL_READ_ONLY);
      if (p) submitRaw(d, (const uint8_t *)p, d->pboW, d->pboH);
      pglUnmapBuffer(GL_PIXEL_PACK_BUFFER);
      d->pboPending = false;
    }
    // 2) queue the next asynchronous read
    if (w != d->pboW || h != d->pboH) {
      pglBufferData(GL_PIXEL_PACK_BUFFER, (GLsizeiptr_)w * h * 4, nullptr, GL_STREAM_READ);
      d->pboW = w;
      d->pboH = h;
    }
    glReadPixels_(x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, (void *)0);
    d->pboPending = true;
    pglBindBuffer(GL_PIXEL_PACK_BUFFER, packBuf);
  } else {
    static std::vector<uint8_t> tmp;
    tmp.resize((size_t)w * h * 4);
    if (pglBindBuffer && packBuf) pglBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    glReadPixels_(x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, tmp.data());
    if (pglBindBuffer && packBuf) pglBindBuffer(GL_PIXEL_PACK_BUFFER, packBuf);
    submitRaw(d, tmp.data(), w, h);
  }
  double ms = (nowSec() - t0) * 1000.0;
  d->readMs = d->readMs * 0.9 + ms * 0.1;
  d->captures++;

  glPixelStorei_(GL_PACK_ALIGNMENT, align);
  glPixelStorei_(GL_PACK_ROW_LENGTH, rowLen);
  glPixelStorei_(GL_PACK_SKIP_ROWS, skipR);
  glPixelStorei_(GL_PACK_SKIP_PIXELS, skipP);
  if (pglBindFramebuffer && drawFbo != readFbo) pglBindFramebuffer(GL_READ_FRAMEBUFFER_, readFbo);
  return 1;
}

// ---------------------------------------------------------------- command queue (main thread)
struct CmdReq {
  std::string name;
  int mode;  // 0 once, 1 begin, 2 end
  int n;
};
static std::mutex gCmdMx;
static std::deque<CmdReq> gCmdQ;
static std::map<std::string, XPLMCommandRef> gCmdCache;
static std::map<XPLMCommandRef, double> gHeld;  // begin time

static XPLMCommandRef cmdRef(const std::string &n) {
  auto it = gCmdCache.find(n);
  if (it != gCmdCache.end()) return it->second;
  XPLMCommandRef r = XPLMFindCommand(n.c_str());
  gCmdCache[n] = r;
  if (!r) logq("unknown command " + n);
  return r;
}

// ---------------------------------------------------------------- aircraft info
static std::mutex gAcfMx;
static std::string gAcfName, gAcfFile;
static XPLMDataRef gUiNameRef = nullptr;

static std::string jsonEsc(const std::string &s) {
  std::string o;
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) o += ' ';
    else o += (char)c;
  }
  return o;
}

static void updateAircraft() {
  char file[512] = {0}, path[1024] = {0};
  XPLMGetNthAircraftModel(0, file, path);
  char ui[256] = {0};
  if (!gUiNameRef) gUiNameRef = XPLMFindDataRef("sim/aircraft/view/acf_ui_name");
  if (gUiNameRef) XPLMGetDatab(gUiNameRef, ui, 0, 255);
  std::lock_guard<std::mutex> l(gAcfMx);
  gAcfFile = file;
  gAcfName = ui[0] ? ui : file;
}

static double gLastSlow = 0;
static float flightLoop(float, float, int, void *) {
  // commands
  std::deque<CmdReq> q;
  {
    std::lock_guard<std::mutex> l(gCmdMx);
    q.swap(gCmdQ);
  }
  double t = nowSec();
  for (auto &c : q) {
    XPLMCommandRef r = cmdRef(c.name);
    if (!r) continue;
    if (c.mode == 0) {
      for (int i = 0; i < c.n; i++) XPLMCommandOnce(r);
    } else if (c.mode == 1) {
      if (!gHeld.count(r)) { XPLMCommandBegin(r); gHeld[r] = t; }
    } else {
      if (gHeld.count(r)) { XPLMCommandEnd(r); gHeld.erase(r); }
    }
  }
  // safety: never keep a command held forever (lost "end" from a dropped connection)
  for (auto it = gHeld.begin(); it != gHeld.end();) {
    if (t - it->second > 15.0) { XPLMCommandEnd(it->first); it = gHeld.erase(it); }
    else ++it;
  }
  if (t - gLastSlow > 1.0) {
    gLastSlow = t;
    for (auto &d : gDev) d.bound = d.av ? XPLMIsAvionicsBound(d.av) : 0;
    updateAircraft();
  }
  flushLog();
  return -1.0f;
}

// ---------------------------------------------------------------- HTTP
static httplib::Server *gSvr = nullptr;
static std::thread gHttpThread;

static std::string statusJson() {
  std::ostringstream o;
  std::string n, f;
  {
    std::lock_guard<std::mutex> l(gAcfMx);
    n = gAcfName;
    f = gAcfFile;
  }
  double t = nowSec();
  o << "{\"plugin\":\"XPGlassPad\",\"version\":\"1.0\",\"aircraft\":\"" << jsonEsc(n)
    << "\",\"acf\":\"" << jsonEsc(f) << "\",\"fps\":" << gCfg.fps << ",\"pbo\":" << (gCfg.pbo && gPBOAvailable ? "true" : "false")
    << ",\"devices\":[";
  bool first = true;
  for (auto &d : gDev) {
    if (!first) o << ",";
    first = false;
    int w, h;
    {
      std::lock_guard<std::mutex> l(d.jpgMx);
      w = d.w;
      h = d.h;
    }
    o << "{\"key\":\"" << d.key << "\",\"name\":\"" << d.name << "\",\"kind\":\"" << d.kind
      << "\",\"prefix\":\"" << d.prefix << "\",\"bound\":" << (d.bound ? "true" : "false")
      << ",\"drawing\":" << ((t - d.lastDraw) < 2.0 ? "true" : "false") << ",\"w\":" << w << ",\"h\":" << h
      << ",\"captures\":" << d.captures.load() << ",\"readMs\":" << (int)(d.readMs * 100) / 100.0 << "}";
  }
  o << "]}";
  return o.str();
}

static void startHttp() {
  gSvr = new httplib::Server();
  auto &svr = *gSvr;
  svr.set_keep_alive_max_count(1000);
  svr.set_mount_point("/", gPluginDir + "web");
  svr.set_file_extension_and_mimetype_mapping("webmanifest", "application/manifest+json");
  svr.set_post_routing_handler([](const httplib::Request &, httplib::Response &res) {
    if (!res.has_header("Cache-Control")) res.set_header("Cache-Control", "no-cache");
  });

  svr.Get("/api/status", [](const httplib::Request &, httplib::Response &res) {
    res.set_content(statusJson(), "application/json");
  });

  // long-poll: returns the newest JPEG with seq > after (waits up to 1.5 s)
  svr.Get(R"(/frame/([a-z0-9_]+))", [](const httplib::Request &req, httplib::Response &res) {
    Device *d = findDev(req.matches[1]);
    if (!d) { res.status = 404; return; }
    uint64_t after = req.has_param("after") ? std::stoull(req.get_param_value("after")) : 0;
    d->lastWanted = nowSec();
    std::unique_lock<std::mutex> l(d->jpgMx);
    d->jpgCv.wait_for(l, std::chrono::milliseconds(1500), [&] { return d->seq > after && !d->jpg.empty(); });
    if (d->seq <= after || d->jpg.empty()) { res.status = 204; return; }
    res.set_header("X-Seq", std::to_string(d->seq));
    res.set_header("Cache-Control", "no-store");
    res.set_header("Access-Control-Expose-Headers", "X-Seq");
    res.set_content(d->jpg, "image/jpeg");
  });

  // /api/cmd?c=sim/GPS/g1000n1_ent&m=once|begin|end&n=1
  svr.Get("/api/cmd", [](const httplib::Request &req, httplib::Response &res) {
    std::string c = req.get_param_value("c");
    std::string m = req.has_param("m") ? req.get_param_value("m") : "once";
    int n = req.has_param("n") ? atoi(req.get_param_value("n").c_str()) : 1;
    if (c.empty() || c.size() > 200 || n < 1 || n > 50) { res.status = 400; return; }
    CmdReq r{c, m == "begin" ? 1 : (m == "end" ? 2 : 0), n};
    {
      std::lock_guard<std::mutex> l(gCmdMx);
      gCmdQ.push_back(r);
    }
    res.set_content("ok", "text/plain");
  });

  gHttpThread = std::thread([] {
    if (!gSvr->listen("0.0.0.0", gCfg.port))
      logq("could not open port " + std::to_string(gCfg.port) + " (in use?) – change it in config.ini");
  });
}

static void stopHttp() {
  if (!gSvr) return;
  gSvr->stop();
  for (auto &d : gDev) d.jpgCv.notify_all();
  if (gHttpThread.joinable()) gHttpThread.join();
  delete gSvr;
  gSvr = nullptr;
}

static void logAddresses() {
  char host[256] = {0};
  if (gethostname(host, sizeof host) != 0) return;
  addrinfo hints{}, *res = nullptr;
  hints.ai_family = AF_INET;
  if (getaddrinfo(host, nullptr, &hints, &res) != 0) return;
  for (addrinfo *p = res; p; p = p->ai_next) {
    char ip[64];
    inet_ntop(AF_INET, &((sockaddr_in *)p->ai_addr)->sin_addr, ip, sizeof ip);
    logq(std::string("open on iPad:  http://") + ip + ":" + std::to_string(gCfg.port) + "/");
  }
  logq(std::string("or:            http://") + host + ".local:" + std::to_string(gCfg.port) + "/");
  freeaddrinfo(res);
}

static void loadConfig() {
  std::ifstream f(gPluginDir + "config.ini");
  std::string line;
  while (std::getline(f, line)) {
    if (line.empty() || line[0] == '#' || line[0] == ';') continue;
    auto eq = line.find('=');
    if (eq == std::string::npos) continue;
    std::string k = line.substr(0, eq), v = line.substr(eq + 1);
    auto trim = [](std::string &s) {
      while (!s.empty() && isspace((unsigned char)s.back())) s.pop_back();
      while (!s.empty() && isspace((unsigned char)s.front())) s.erase(0, 1);
    };
    trim(k);
    trim(v);
    if (k == "port") gCfg.port = atoi(v.c_str());
    else if (k == "fps") gCfg.fps = std::max(1, std::min(60, atoi(v.c_str())));
    else if (k == "jpeg_quality") gCfg.quality = std::max(30, std::min(95, atoi(v.c_str())));
    else if (k == "readback") gCfg.pbo = (v != "sync");
    else if (k == "watch_timeout") gCfg.watchTimeout = std::max(1, atoi(v.c_str()));
  }
}

// ---------------------------------------------------------------- plugin entry points
PLUGIN_API int XPluginStart(char *outName, char *outSig, char *outDesc) {
  strcpy(outName, "XPGlassPad");
  strcpy(outSig, "de.juliusdemant.xpglasspad");
  strcpy(outDesc, "G1000 / GNS430 / GNS530 on the iPad");
  XPLMEnableFeature("XPLM_USE_NATIVE_PATHS", 1);

  char path[1024] = {0};
  XPLMGetPluginInfo(XPLMGetMyID(), nullptr, path, nullptr, nullptr);
  std::string p = path;  // ...\XPGlassPad\64\win.xpl
  for (int i = 0; i < 2; i++) {
    auto s = p.find_last_of("\\/");
    if (s != std::string::npos) p = p.substr(0, s);
  }
  gPluginDir = p + "/";
  loadConfig();

  gRunning = true;
  gEncThread = std::thread(encoderLoop);
  startHttp();
  logAddresses();
  XPLMRegisterFlightLoopCallback(flightLoop, -1.0f, nullptr);
  flushLog();
  return 1;
}

PLUGIN_API void XPluginStop(void) {
  XPLMUnregisterFlightLoopCallback(flightLoop, nullptr);
  stopHttp();
  gRunning = false;
  gEncCv.notify_all();
  if (gEncThread.joinable()) gEncThread.join();
}

PLUGIN_API int XPluginEnable(void) {
  for (auto &d : gDev) {
    XPLMCustomizeAvionics_t p;
    memset(&p, 0, sizeof p);
    p.structSize = sizeof p;
    p.deviceId = d.id;
    p.drawCallbackAfter = drawAfter;
    p.refcon = &d;
    d.av = XPLMRegisterAvionicsCallbacksEx(&p);
    if (!d.av) logq(std::string("could not hook ") + d.name);
  }
  return 1;
}

PLUGIN_API void XPluginDisable(void) {
  for (auto &d : gDev) {
    if (d.av) XPLMUnregisterAvionicsCallbacks(d.av);
    d.av = nullptr;
    d.bound = 0;
    d.pbo = 0;  // GL objects die with the context; don't touch GL here
    d.pboPending = false;
    d.pboW = d.pboH = 0;
  }
}

PLUGIN_API void XPluginReceiveMessage(XPLMPluginID, int, void *) {}
