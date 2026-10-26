/**
 * chain_hook —— 信息链的系统事件源（N-API addon，Windows only）
 *
 * 设计边界（D41）：
 * - **只装鼠标低级钩子**（`WH_MOUSE_LL`），不装键盘钩子；键盘输入只通过
 *   `GetLastInputInfo` 的 tick 前进被间接感知，**不碰任何按键内容**。
 * - 原生层只做 OS 管道：把「前台窗口 / 移动 / 点击 / 滚轮」与「最近输入 tick」交出去。
 *   合并、判空闲、切段、截图策略全在 TS（`src/chain/hook/adapter.ts` + `segmenter.ts`）。
 * - 用 N-API（ABI 稳定）：同一份 `.node` 同时给 Node 24 与 Electron 45 用，不做 electron-rebuild。
 *
 * 线程模型：钩子必须装在**有消息循环**的线程上，所以 start() 起一条专门线程，
 * 在里面装钩子并跑 `GetMessage` 循环；stop() 用 `PostThreadMessage(WM_QUIT)` 收掉它。
 * 事件通过 `napi_threadsafe_function`（非阻塞）回到 JS 线程。
 */

#include <node_api.h>
#include <windows.h>
#include <winver.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <iterator>
#include <map>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr const char* kVersion = "0.1.0";

/** 指针移动的最小上报距离：低于这个就当没动（钩子 125Hz，全报会把队列和主线程灌满） */
constexpr int kMoveMinDeltaPx = 4;

enum class EventKind { Foreground, Move, Click, Wheel };

struct EventPayload {
  EventKind kind = EventKind::Move;
  double ts = 0;
  // 前台窗口
  int32_t pid = 0;
  int64_t hwnd = 0;
  std::string exe;
  std::string title;
  std::string app;
  // 指针
  int32_t x = 0;
  int32_t y = 0;
  int32_t delta = 0;
  int32_t button = 0;  // 0 左 / 1 右 / 2 中
};

napi_threadsafe_function g_tsfn = nullptr;
std::thread g_thread;
DWORD g_threadId = 0;
HHOOK g_mouseHook = nullptr;
HWINEVENTHOOK g_winEvent = nullptr;
HANDLE g_readyEvent = nullptr;
std::atomic<bool> g_running{false};

// 安装结果：装不上必须让 JS 知道，不能静默变成「跑起来了但一条事件都没有」
bool g_mouseHookOk = false;
bool g_winEventOk = false;
DWORD g_installError = 0;

// 诊断计数：钩子被调了几次、投递成功几次、失败几次（区分「没回调」和「回调了但没到 JS」）
std::atomic<long> g_mouseCalls{0};
std::atomic<long> g_foregroundCalls{0};
std::atomic<long> g_emitOk{0};
std::atomic<long> g_emitFail{0};

// 移动抽稀状态（钩子线程独占，不必加锁）
POINT g_lastMovePoint = {0, 0};
bool g_hasLastMove = false;

// exe 全路径 → 应用显示名（FileDescription）缓存；只在钩子线程用
std::map<std::wstring, std::string> g_appNameCache;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

double NowMs() {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER ticks;
  ticks.LowPart = ft.dwLowDateTime;
  ticks.HighPart = ft.dwHighDateTime;
  // 100ns since 1601-01-01 → ms since 1970-01-01
  return static_cast<double>((ticks.QuadPart - 116444736000000000ULL) / 10000ULL);
}

std::string ToUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr,
                                nullptr);
  if (size <= 0) return {};
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
  return out;
}

std::string ToLowerAscii(std::string text) {
  for (char& ch : text) {
    if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
  }
  return text;
}

/** 取进程 exe 的 base name（小写、不含 .exe）；拿不到返回空 */
std::string ProcessExeName(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return {};
  wchar_t path[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(std::size(path));
  BOOL ok = QueryFullProcessImageNameW(process, 0, path, &size);
  CloseHandle(process);
  if (!ok) return {};
  std::wstring full(path, size);
  size_t slash = full.find_last_of(L"\\/");
  std::wstring base = slash == std::wstring::npos ? full : full.substr(slash + 1);
  std::string name = ToLowerAscii(ToUtf8(base));
  if (name.size() > 4 && name.compare(name.size() - 4, 4, ".exe") == 0) name.erase(name.size() - 4);
  return name;
}

/** 进程 exe 的完整路径（缓存键用）；拿不到返回空 */
std::wstring ProcessImagePath(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return {};
  wchar_t path[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(std::size(path));
  BOOL ok = QueryFullProcessImageNameW(process, 0, path, &size);
  CloseHandle(process);
  if (!ok) return {};
  return std::wstring(path, size);
}

/**
 * 读 exe 的 `FileDescription`（就是任务管理器里显示的名字，与 active-win 的 owner.name 同源）。
 * 读不到就返回空串，由调用方回退到 exe 名——不编造。
 */
std::string FileDescriptionOf(const std::wstring& path) {
  DWORD ignored = 0;
  DWORD size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
  if (size == 0) return {};
  std::vector<BYTE> buffer(size);
  if (!GetFileVersionInfoW(path.c_str(), 0, size, buffer.data())) return {};

  WORD* translation = nullptr;
  UINT translationSize = 0;
  if (!VerQueryValueW(buffer.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<LPVOID*>(&translation),
                      &translationSize) ||
      translationSize < sizeof(WORD) * 2) {
    return {};
  }
  wchar_t key[128];
  swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription", translation[0], translation[1]);

  wchar_t* description = nullptr;
  UINT descriptionSize = 0;
  if (!VerQueryValueW(buffer.data(), key, reinterpret_cast<LPVOID*>(&description), &descriptionSize) ||
      descriptionSize == 0 || description == nullptr) {
    return {};
  }
  // 别用 descriptionSize 算长度：对字符串值它到底是字节还是字符，文档与实测不一致
  // （记事本这里给的是 4，即「3 字符 + 结尾」，按字节算会截成「记」）。直接用 NUL 结尾。
  return ToUtf8(std::wstring(description));
}

/** 应用显示名：FileDescription 优先，回退到 exe 名；两者都没有就空（JS 侧记 null） */
std::string AppNameOf(DWORD pid, const std::string& exeName) {
  std::wstring path = ProcessImagePath(pid);
  if (path.empty()) return exeName;
  auto cached = g_appNameCache.find(path);
  if (cached != g_appNameCache.end()) return cached->second;
  std::string description = FileDescriptionOf(path);
  std::string name = description.empty() ? exeName : description;
  g_appNameCache[path] = name;
  return name;
}

/* ------------------------------------------------------------------ */
/* 投递到 JS                                                           */
/* ------------------------------------------------------------------ */

const char* KindName(EventKind kind) {
  switch (kind) {
    case EventKind::Foreground:
      return "foreground";
    case EventKind::Move:
      return "move";
    case EventKind::Click:
      return "click";
    case EventKind::Wheel:
      return "wheel";
  }
  return "move";
}

void Emit(EventPayload* payload) {
  if (g_tsfn == nullptr || !g_running.load()) {
    g_emitFail.fetch_add(1);
    delete payload;
    return;
  }
  // 队列满了就丢这条（采集是尽力而为；宁可少一条事件，也不能阻塞钩子线程）
  if (napi_call_threadsafe_function(g_tsfn, payload, napi_tsfn_nonblocking) != napi_ok) {
    g_emitFail.fetch_add(1);
    delete payload;
    return;
  }
  g_emitOk.fetch_add(1);
}

void SetNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value number;
  napi_create_double(env, value, &number);
  napi_set_named_property(env, object, key, number);
}

void SetString(napi_env env, napi_value object, const char* key, const std::string& value) {
  napi_value string;
  napi_create_string_utf8(env, value.c_str(), value.size(), &string);
  napi_set_named_property(env, object, key, string);
}

void CallJs(napi_env env, napi_value js_callback, void* /*context*/, void* data) {
  EventPayload* payload = static_cast<EventPayload*>(data);
  if (payload == nullptr) return;

  if (env != nullptr && js_callback != nullptr) {
    napi_value event;
    if (napi_create_object(env, &event) == napi_ok) {
      SetString(env, event, "type", KindName(payload->kind));
      SetNumber(env, event, "ts", payload->ts);
      switch (payload->kind) {
        case EventKind::Foreground:
          SetNumber(env, event, "pid", payload->pid);
          SetNumber(env, event, "hwnd", static_cast<double>(payload->hwnd));
          SetString(env, event, "exe", payload->exe);
          SetString(env, event, "title", payload->title);
          SetString(env, event, "app", payload->app);
          break;
        case EventKind::Move:
        case EventKind::Click:
        case EventKind::Wheel:
          SetNumber(env, event, "x", payload->x);
          SetNumber(env, event, "y", payload->y);
          if (payload->kind == EventKind::Click) {
            SetString(env, event, "button",
                      payload->button == 1 ? "right" : (payload->button == 2 ? "middle" : "left"));
          }
          if (payload->kind == EventKind::Wheel) SetNumber(env, event, "delta", payload->delta);
          break;
      }
      napi_value global;
      napi_value undefined;
      napi_get_global(env, &global);
      napi_get_undefined(env, &undefined);
      napi_call_function(env, global, js_callback, 1, &event, nullptr);
    }
  }
  delete payload;
}

/* ------------------------------------------------------------------ */
/* 钩子回调                                                            */
/* ------------------------------------------------------------------ */

void EmitForeground(HWND hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0) return;

  std::string exe = ProcessExeName(pid);
  std::wstring title;
  int length = GetWindowTextLengthW(hwnd);
  if (length > 0) {
    title.resize(static_cast<size_t>(length) + 1);
    int copied = GetWindowTextW(hwnd, title.data(), length + 1);
    title.resize(copied > 0 ? static_cast<size_t>(copied) : 0);
  }

  auto* payload = new EventPayload();
  payload->kind = EventKind::Foreground;
  payload->ts = NowMs();
  payload->pid = static_cast<int32_t>(pid);
  payload->hwnd = static_cast<int64_t>(reinterpret_cast<intptr_t>(hwnd));
  payload->exe = exe;
  payload->title = ToUtf8(title);
  payload->app = AppNameOf(pid, exe);
  Emit(payload);
}

void CALLBACK WinEventProc(HWINEVENTHOOK, DWORD event, HWND hwnd, LONG idObject, LONG idChild, DWORD, DWORD) {
  g_foregroundCalls.fetch_add(1);
  if (event != EVENT_SYSTEM_FOREGROUND) return;
  if (hwnd == nullptr) return;
  // 前台事件应当只报窗口本身；其它对象的事件直接忽略
  if (idObject != OBJID_WINDOW || idChild != CHILDID_SELF) return;
  EmitForeground(hwnd);
}

LRESULT CALLBACK MouseProc(int code, WPARAM message, LPARAM data) {
  g_mouseCalls.fetch_add(1);
  if (code == HC_ACTION) {
    auto* info = reinterpret_cast<MSLLHOOKSTRUCT*>(data);
    if (info != nullptr) {
      switch (message) {
        case WM_MOUSEMOVE: {
          if (!g_hasLastMove) {
            g_lastMovePoint = info->pt;
            g_hasLastMove = true;
            break;
          }
          int dx = info->pt.x - g_lastMovePoint.x;
          int dy = info->pt.y - g_lastMovePoint.y;
          if (dx > -kMoveMinDeltaPx && dx < kMoveMinDeltaPx && dy > -kMoveMinDeltaPx && dy < kMoveMinDeltaPx) {
            break;
          }
          g_lastMovePoint = info->pt;
          auto* payload = new EventPayload();
          payload->kind = EventKind::Move;
          payload->ts = NowMs();
          payload->x = info->pt.x;
          payload->y = info->pt.y;
          Emit(payload);
          break;
        }
        case WM_LBUTTONDOWN:
        case WM_RBUTTONDOWN:
        case WM_MBUTTONDOWN: {
          auto* payload = new EventPayload();
          payload->kind = EventKind::Click;
          payload->ts = NowMs();
          payload->x = info->pt.x;
          payload->y = info->pt.y;
          payload->button = message == WM_RBUTTONDOWN ? 1 : (message == WM_MBUTTONDOWN ? 2 : 0);
          Emit(payload);
          break;
        }
        case WM_MOUSEWHEEL: {
          auto* payload = new EventPayload();
          payload->kind = EventKind::Wheel;
          payload->ts = NowMs();
          payload->x = info->pt.x;
          payload->y = info->pt.y;
          payload->delta = GET_WHEEL_DELTA_WPARAM(info->mouseData);
          Emit(payload);
          break;
        }
        default:
          break;
      }
    }
  }
  return CallNextHookEx(g_mouseHook, code, message, data);
}

/* ------------------------------------------------------------------ */
/* 钩子线程                                                            */
/* ------------------------------------------------------------------ */

void ThreadMain() {
  g_threadId = GetCurrentThreadId();
  // 先把消息队列建出来，否则 PostThreadMessage(WM_QUIT) 可能落空
  MSG message;
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

  // 不跳过本进程：用户切到自己（记忆球）的窗口也是一段真实的占用
  g_winEvent = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, WinEventProc, 0, 0,
                               WINEVENT_OUTOFCONTEXT);
  g_winEventOk = g_winEvent != nullptr;
  if (!g_winEventOk) g_installError = GetLastError();

  // 低级鼠标钩子的钩子过程在本 DLL（.node）里，hMod 必须是**本模块**的句柄。
  // 传 GetModuleHandle(nullptr) 拿到的是宿主 exe（node.exe），系统在 exe 里找不到过程 → 安装失败。
  HMODULE selfModule = nullptr;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                     reinterpret_cast<LPCWSTR>(&MouseProc), &selfModule);
  g_mouseHook = SetWindowsHookExW(WH_MOUSE_LL, MouseProc, selfModule, 0);
  g_mouseHookOk = g_mouseHook != nullptr;
  if (!g_mouseHookOk && g_installError == 0) g_installError = GetLastError();

  SetEvent(g_readyEvent);

  while (g_running.load()) {
    BOOL result = GetMessageW(&message, nullptr, 0, 0);
    if (result == 0 || result == -1) break;
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  if (g_mouseHook != nullptr) {
    UnhookWindowsHookEx(g_mouseHook);
    g_mouseHook = nullptr;
  }
  if (g_winEvent != nullptr) {
    UnhookWinEvent(g_winEvent);
    g_winEvent = nullptr;
  }
}

void StopInternal() {
  if (!g_running.exchange(false)) return;
  if (g_thread.joinable()) {
    PostThreadMessageW(g_threadId, WM_QUIT, 0, 0);
    g_thread.join();
  }
  if (g_tsfn != nullptr) {
    napi_release_threadsafe_function(g_tsfn, napi_tsfn_release);
    g_tsfn = nullptr;
  }
  if (g_readyEvent != nullptr) {
    CloseHandle(g_readyEvent);
    g_readyEvent = nullptr;
  }
  g_hasLastMove = false;
}

void CleanupHook(void* /*arg*/) { StopInternal(); }

/* ------------------------------------------------------------------ */
/* N-API 导出                                                          */
/* ------------------------------------------------------------------ */

napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "start(callback) 需要一个回调");
    return nullptr;
  }
  napi_valuetype type = napi_undefined;
  napi_typeof(env, argv[0], &type);
  if (type != napi_function) {
    napi_throw_type_error(env, nullptr, "start(callback) 参数必须是函数");
    return nullptr;
  }
  if (g_running.load()) return nullptr;  // 幂等

  napi_value name;
  napi_create_string_utf8(env, "chain_hook", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs, &g_tsfn) !=
      napi_ok) {
    napi_throw_error(env, nullptr, "无法创建线程安全回调");
    return nullptr;
  }

  g_readyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  g_installError = 0;
  g_mouseHookOk = false;
  g_winEventOk = false;
  g_running.store(true);
  g_thread = std::thread(ThreadMain);
  if (g_readyEvent != nullptr) {
    WaitForSingleObject(g_readyEvent, 5000);
  }

  // 装不上就等于「永远没有事件」，必须当场报错，别让它看起来像是跑着的
  if (!g_mouseHookOk && !g_winEventOk) {
    StopInternal();
    char message[256];
    snprintf(message, sizeof(message), "钩子安装失败（Win32 错误码 %lu）：鼠标与前台窗口都没装上",
             static_cast<unsigned long>(g_installError));
    napi_throw_error(env, nullptr, message);
    return nullptr;
  }
  return nullptr;
}

napi_value Stop(napi_env /*env*/, napi_callback_info /*info*/) {
  StopInternal();
  return nullptr;
}

/** 诊断用：当前钩子状态（`start()` 之后看它是否真装上了） */
napi_value Status(napi_env env, napi_callback_info /*info*/) {
  napi_value result;
  napi_create_object(env, &result);
  napi_value flag;
  napi_get_boolean(env, g_mouseHookOk, &flag);
  napi_set_named_property(env, result, "mouseHook", flag);
  napi_get_boolean(env, g_winEventOk, &flag);
  napi_set_named_property(env, result, "foregroundHook", flag);
  napi_value running;
  napi_get_boolean(env, g_running.load(), &running);
  napi_set_named_property(env, result, "running", running);
  SetNumber(env, result, "lastError", static_cast<double>(g_installError));
  SetNumber(env, result, "threadId", static_cast<double>(g_threadId));
  SetNumber(env, result, "mouseCalls", static_cast<double>(g_mouseCalls.load()));
  SetNumber(env, result, "foregroundCalls", static_cast<double>(g_foregroundCalls.load()));
  SetNumber(env, result, "emitOk", static_cast<double>(g_emitOk.load()));
  SetNumber(env, result, "emitFail", static_cast<double>(g_emitFail.load()));
  return result;
}

napi_value LastInputTickMs(napi_env env, napi_callback_info /*info*/) {
  LASTINPUTINFO info;
  info.cbSize = sizeof(LASTINPUTINFO);
  double tick = 0;
  if (GetLastInputInfo(&info)) tick = static_cast<double>(info.dwTime);
  napi_value result;
  napi_create_double(env, tick, &result);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"lastInputTickMs", nullptr, LastInputTickMs, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);

  napi_value version;
  napi_create_string_utf8(env, kVersion, NAPI_AUTO_LENGTH, &version);
  napi_set_named_property(env, exports, "version", version);

  // 进程退出前把钩子收掉，别让线程在 env 拆掉之后还往 JS 投递
  napi_add_env_cleanup_hook(env, CleanupHook, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
