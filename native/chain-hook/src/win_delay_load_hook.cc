/**
 * Windows addon 的 delay-load 钩子（等价于 node-gyp 的 `lib/win_delay_load_hook.cc`，MIT）
 *
 * 为什么需要：addon 用 `/DELAYLOAD:node.exe` 链接，N-API 符号名义上来自 `node.exe`。
 * 但真正加载我们的可能是 `electron.exe`。这个钩子把 `node.exe` 的请求重定向到
 * **当前宿主进程**（`GetModuleHandle(NULL)`），于是一份 `.node` 既能在 Node 里跑，
 * 也能在 Electron 里跑，不需要 electron-rebuild。
 *
 * 只做 x64：本项目没有 32 位目标，node-gyp 原文件里 x86 那套 thunk 处理不需要。
 */
#include <windows.h>
#include <delayimp.h>

static FARPROC WINAPI load_exe_hook(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary) return nullptr;
  if (info == nullptr || info->szDll == nullptr) return nullptr;
  if (_stricmp(info->szDll, "node.exe") != 0) return nullptr;
  HMODULE host = GetModuleHandleW(nullptr);
  if (host == nullptr) return nullptr;
  return reinterpret_cast<FARPROC>(host);
}

extern "C" const PfnDliHook __pfnDliNotifyHook2 = load_exe_hook;
