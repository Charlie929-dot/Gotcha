/**
 * screen_grab —— 选区截图的系统级抓帧 + 遮罩窗口置顶（N-API addon，Windows only）
 *
 * 为什么新建一个模块（而不是并进 chain_hook）：
 * - chain_hook 的边界是「只装鼠标钩子、只交事件」，别把像素搬进去；
 * - 这个模块要链 d3d11 / windowscodecs / windowsapp，跟事件源不是一件事。
 *
 * 为什么用 **Windows.Graphics.Capture（WGC）** 而不是 DXGI Desktop Duplication：
 * Desktop Duplication 对同一块输出是**独占**的——常驻采集那条 Chromium 屏幕流已经
 * 占着它，再 DuplicateOutput 会直接 DXGI_ERROR_UNSUPPORTED。WGC 走 DWM 合成器，
 * 可以和别的捕获者同时存在，且正是系统自带截图（ScreenClippingHost）用的接口。
 *
 * 口径：
 * - 只抓**一帧**（池子 + 会话即建即拆），不做常驻流；
 * - 输出 JPEG（主进程只做裁剪 / 转 PNG，不再整像素搬进 JS）；
 * - 光标默认不抓（`IsCursorCaptureEnabled(false)`）：裁出来的图不该带一个悬空的指针；
 * - 试着关掉捕获边框（`IsBorderRequired(false)`，Win11 22H2+）；关不掉就接受闪一下，
 *   并在返回值里如实报告，不假装没有；
 * - D3D 设备与 GraphicsCaptureItem 进程级缓存（真机实测：不缓存首次 ~500ms，缓存后 ~70ms）。
 *
 * 另一个导出 `setTopmost(hwnd)` 是给遮罩窗口用的：一次 `SetWindowPos(HWND_TOPMOST)`
 * 替代「Electron setAlwaysOnTop + moveTop + 300ms 轮询」那套。
 * `warmup(x, y)` 只把缓存建好（启动后空闲时调一次），不读像素。
 */

#ifndef UNICODE
#define UNICODE
#endif

#include <windows.h>

#include <d3d11.h>
#include <dxgi.h>
#include <objbase.h>
#include <objidl.h>
#include <oleauto.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <node_api.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <mutex>
#include <string>
#include <vector>

namespace {

using Microsoft::WRL::ComPtr;

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd = winrt::Windows::Graphics::DirectX;
namespace wgdd = winrt::Windows::Graphics::DirectX::Direct3D11;

constexpr const char* kVersion = "0.1.0";

/** 抓帧默认超时：WGC 首帧通常几十毫秒内到，3s 是「明显不正常」的边界 */
constexpr std::uint32_t kDefaultTimeoutMs = 3000;
constexpr std::uint32_t kMinTimeoutMs = 200;
constexpr std::uint32_t kMaxTimeoutMs = 10'000;

/** 取证图 / 选区裁图都走 JPEG 0.92，跟「采集即编码」那条口径对齐 */
constexpr float kJpegQuality = 0.92f;

std::string HresultText(HRESULT hr) {
  char buffer[64] = {};
  std::snprintf(buffer, sizeof(buffer), "0x%08X", static_cast<unsigned int>(hr));
  return std::string(buffer);
}

std::string WinrtText(winrt::hresult_error const& error) {
  std::string text = winrt::to_string(error.message());
  return text.empty() ? HresultText(error.code()) : text + " (" + HresultText(error.code()) + ")";
}

/**
 * COM 套间：N-API 调用可能落在 Electron 主线程（Chromium 已初始化为 STA）或 Node 主线程。
 * 已经初始化过就照用——`RPC_E_CHANGED_MODE` 不是错误，只是套间类型不同。
 */
void EnsureApartment() {
  static std::once_flag once;
  std::call_once(once, [] {
    ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  });
}

HRESULT CreateD3D11Device(ComPtr<ID3D11Device>& device, ComPtr<ID3D11DeviceContext>& context) {
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  D3D_FEATURE_LEVEL levels[] = {
      D3D_FEATURE_LEVEL_11_1,
      D3D_FEATURE_LEVEL_11_0,
      D3D_FEATURE_LEVEL_10_1,
      D3D_FEATURE_LEVEL_10_0,
  };
  HRESULT hr = ::D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, levels,
                                   static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
                                   device.ReleaseAndGetAddressOf(), nullptr,
                                   context.ReleaseAndGetAddressOf());
  if (FAILED(hr)) {
    // 少数虚拟机 / 远程桌面没有硬件设备：退 WARP 再试一次（能不能抓到由调用方验证）
    hr = ::D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, levels,
                             static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
                             device.ReleaseAndGetAddressOf(), nullptr,
                             context.ReleaseAndGetAddressOf());
  }
  return hr;
}

/** 显示器句柄 → GraphicsCaptureItem（WGC 只给了 interop 工厂能建 monitor item） */
wgc::GraphicsCaptureItem CreateCaptureItem(HMONITOR monitor) {
  auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  wgc::GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(interop->CreateForMonitor(
      monitor, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item)));
  return item;
}

/** BGRA 像素 → JPEG（WIC） */
bool EncodeJpeg(const std::uint8_t* pixels, UINT width, UINT height, std::vector<std::uint8_t>& out,
                std::string& error) {
  ComPtr<IWICImagingFactory> factory;
  HRESULT hr = ::CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(factory.GetAddressOf()));
  if (FAILED(hr)) {
    error = "WIC 工厂创建失败 " + HresultText(hr);
    return false;
  }

  ComPtr<IStream> stream;
  hr = ::CreateStreamOnHGlobal(nullptr, TRUE, stream.GetAddressOf());
  if (FAILED(hr)) {
    error = "WIC 内存流创建失败 " + HresultText(hr);
    return false;
  }

  ComPtr<IWICBitmapEncoder> encoder;
  hr = factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.GetAddressOf());
  if (FAILED(hr)) {
    error = "JPEG 编码器创建失败 " + HresultText(hr);
    return false;
  }
  hr = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
  if (FAILED(hr)) {
    error = "JPEG 编码器初始化失败 " + HresultText(hr);
    return false;
  }

  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> properties;
  hr = encoder->CreateNewFrame(frame.GetAddressOf(), properties.GetAddressOf());
  if (FAILED(hr)) {
    error = "JPEG 帧创建失败 " + HresultText(hr);
    return false;
  }
  if (properties) {
    PROPBAG2 option = {};
    option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
    VARIANT value;
    ::VariantInit(&value);
    value.vt = VT_R4;
    value.fltVal = kJpegQuality;
    properties->Write(1, &option, &value);
    ::VariantClear(&value);
  }
  hr = frame->Initialize(properties.Get());
  if (FAILED(hr)) {
    error = "JPEG 帧初始化失败 " + HresultText(hr);
    return false;
  }
  hr = frame->SetSize(width, height);
  if (FAILED(hr)) {
    error = "JPEG 尺寸设置失败 " + HresultText(hr);
    return false;
  }
  WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
  hr = frame->SetPixelFormat(&format);
  if (FAILED(hr)) {
    error = "JPEG 像素格式设置失败 " + HresultText(hr);
    return false;
  }

  ComPtr<IWICBitmap> bitmap;
  hr = factory->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppBGRA, width * 4,
                                       width * height * 4, const_cast<BYTE*>(pixels),
                                       bitmap.GetAddressOf());
  if (FAILED(hr)) {
    error = "WIC 位图创建失败 " + HresultText(hr);
    return false;
  }
  hr = frame->WriteSource(bitmap.Get(), nullptr);
  if (SUCCEEDED(hr)) hr = frame->Commit();
  if (SUCCEEDED(hr)) hr = encoder->Commit();
  if (FAILED(hr)) {
    error = "JPEG 写入失败 " + HresultText(hr);
    return false;
  }

  STATSTG stat = {};
  hr = stream->Stat(&stat, STATFLAG_NONAME);
  if (FAILED(hr) || stat.cbSize.QuadPart == 0) {
    error = "JPEG 输出为空";
    return false;
  }
  out.resize(static_cast<std::size_t>(stat.cbSize.QuadPart));
  LARGE_INTEGER zero = {};
  stream->Seek(zero, STREAM_SEEK_SET, nullptr);
  ULONG read = 0;
  hr = stream->Read(out.data(), static_cast<ULONG>(out.size()), &read);
  if (FAILED(hr) || read != out.size()) {
    error = "JPEG 读取失败";
    out.clear();
    return false;
  }
  return true;
}

/** 一次抓帧的结果 */
struct GrabShared {
  bool ok = false;
  std::string error;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> jpeg;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  RECT monitorRect = {};
  bool cursorCaptured = false;
  bool borderSuppressed = false;
};

/** 把一帧拷到 CPU、编码 JPEG（调用线程 = 创建 D3D 设备的那条，避免跨线程用立即上下文） */
void CaptureFrame(wgc::Direct3D11CaptureFrame const& frame, GrabShared& shared) {
  if (!frame) return;

  auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  ComPtr<ID3D11Texture2D> texture;
  winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(texture.GetAddressOf())));

  D3D11_TEXTURE2D_DESC desc = {};
  texture->GetDesc(&desc);
  if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
    throw winrt::hresult_error(E_FAIL, L"抓帧格式不是 BGRA8（HDR 输出暂不支持）");
  }

  D3D11_TEXTURE2D_DESC stagingDesc = desc;
  stagingDesc.Usage = D3D11_USAGE_STAGING;
  stagingDesc.BindFlags = 0;
  stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  stagingDesc.MiscFlags = 0;

  ComPtr<ID3D11Texture2D> staging;
  HRESULT hr = shared.device->CreateTexture2D(&stagingDesc, nullptr, staging.GetAddressOf());
  if (FAILED(hr)) throw winrt::hresult_error(hr, L"暂存纹理创建失败");

  shared.context->CopyResource(staging.Get(), texture.Get());

  D3D11_MAPPED_SUBRESOURCE mapped = {};
  hr = shared.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(hr)) throw winrt::hresult_error(hr, L"纹理读取失败");

  std::vector<std::uint8_t> pixels(static_cast<std::size_t>(desc.Width) * desc.Height * 4);
  for (UINT row = 0; row < desc.Height; ++row) {
    std::memcpy(pixels.data() + static_cast<std::size_t>(row) * desc.Width * 4,
                static_cast<const std::uint8_t*>(mapped.pData) + static_cast<std::size_t>(row) * mapped.RowPitch,
                static_cast<std::size_t>(desc.Width) * 4);
  }
  shared.context->Unmap(staging.Get(), 0);

  std::vector<std::uint8_t> jpeg;
  std::string error;
  if (!EncodeJpeg(pixels.data(), desc.Width, desc.Height, jpeg, error)) {
    throw winrt::hresult_error(E_FAIL, winrt::to_hstring(error));
  }

  shared.width = desc.Width;
  shared.height = desc.Height;
  shared.jpeg = std::move(jpeg);
  shared.ok = true;
}

/** 进程级缓存：D3D 设备 + 每块显示器的 GraphicsCaptureItem（都只是「句柄」，可跨帧复用） */
struct GrabCache {
  std::mutex mutex;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  wgdd::IDirect3DDevice direct3D{nullptr};
  HMONITOR monitor = nullptr;
  wgc::GraphicsCaptureItem item{nullptr};
};

GrabCache& GetCache() {
  static GrabCache* cache = new GrabCache();  // 故意不释放：进程退出时别在 COM 收尾后再碰 D3D
  return *cache;
}

/** 设备 + 该显示器的 item（没有就建）；失败把原因写进 error */
bool EnsureCache(HMONITOR monitor, GrabCache& cache, std::string& error) {
  if (!cache.device) {
    HRESULT hr = CreateD3D11Device(cache.device, cache.context);
    if (FAILED(hr)) {
      error = "D3D11 设备创建失败 " + HresultText(hr);
      return false;
    }
    ComPtr<IDXGIDevice> dxgiDevice;
    hr = cache.device.As(&dxgiDevice);
    if (FAILED(hr)) {
      error = "取 DXGI 设备失败 " + HresultText(hr);
      return false;
    }
    ComPtr<::IInspectable> rawInspectable;
    hr = ::CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), rawInspectable.GetAddressOf());
    if (FAILED(hr)) {
      error = "CreateDirect3D11DeviceFromDXGIDevice 失败 " + HresultText(hr);
      return false;
    }
    auto inspectable = winrt::Windows::Foundation::IInspectable{
        rawInspectable.Detach(), winrt::take_ownership_from_abi};
    cache.direct3D = inspectable.as<wgdd::IDirect3DDevice>();
  }

  if (!cache.item || cache.monitor != monitor) {
    try {
      cache.item = CreateCaptureItem(monitor);
      cache.monitor = monitor;
    } catch (winrt::hresult_error const& winrtError) {
      cache.item = nullptr;
      cache.monitor = nullptr;
      error = "抓屏会话创建失败（可能被安全桌面 / 独占全屏挡住）：" + WinrtText(winrtError);
      return false;
    }
  }
  return true;
}

/**
 * 抓物理点 (x, y) 所在显示器的一帧。
 *
 * 注意：调用方传的是**物理像素**坐标（Electron 的 DIP 要先 `dipToScreenPoint`），
 * 因为 `MonitorFromPoint` 只认物理坐标；帧尺寸也是物理像素。
 */
bool GrabJpegAt(double x, double y, std::uint32_t timeoutMs, GrabShared& shared) {
  EnsureApartment();

  POINT point = {static_cast<LONG>(x), static_cast<LONG>(y)};
  HMONITOR monitor = ::MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
  if (monitor == nullptr) {
    shared.error = "找不到该坐标所在的显示器";
    return false;
  }
  MONITORINFO info = {};
  info.cbSize = sizeof(info);
  if (::GetMonitorInfoW(monitor, &info)) shared.monitorRect = info.rcMonitor;

  GrabCache& cache = GetCache();
  std::lock_guard<std::mutex> serialize(cache.mutex);
  if (!EnsureCache(monitor, cache, shared.error)) return false;
  shared.device = cache.device;
  shared.context = cache.context;

  auto size = cache.item.Size();
  auto framePool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
      cache.direct3D, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);

  auto session = framePool.CreateCaptureSession(cache.item);
  try {
    session.IsCursorCaptureEnabled(false);
    shared.cursorCaptured = false;
  } catch (...) {
    shared.cursorCaptured = true;
  }
  try {
    // Win11 22H2+：允许应用关掉「正在捕获」的边框；旧系统 / 被拒会抛，接受闪一下
    if (session.IsBorderRequired()) {
      session.IsBorderRequired(false);
    }
    shared.borderSuppressed = true;
  } catch (...) {
    shared.borderSuppressed = false;
  }

  session.StartCapture();

  // 不用 FrameArrived：回调在别的线程上跑，会跨线程碰 D3D 立即上下文（实测会崩）。
  // 帧池自己攒帧，这里在创建线程上按 5ms 间隔轮询取一帧即可。
  std::string error;
  bool got = false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (std::chrono::steady_clock::now() < deadline) {
    wgc::Direct3D11CaptureFrame frame{nullptr};
    try {
      frame = framePool.TryGetNextFrame();
    } catch (winrt::hresult_error const& winrtError) {
      error = WinrtText(winrtError);
      break;
    }
    if (!frame) {
      ::Sleep(5);
      continue;
    }
    try {
      CaptureFrame(frame, shared);
      got = shared.ok;
    } catch (winrt::hresult_error const& winrtError) {
      error = WinrtText(winrtError);
    } catch (std::exception const& stdError) {
      error = stdError.what();
    } catch (...) {
      error = "抓帧时发生未知错误";
    }
    break;
  }

  session.Close();
  framePool.Close();
  if (!got) {
    shared.ok = false;
    shared.error = error.empty()
                       ? "抓帧超时（" + std::to_string(timeoutMs) + "ms 内没有等到新帧）"
                       : error;
  }
  return shared.ok;
}

/* ------------------------------------------------------------------ */
/* N-API 导出                                                          */
/* ------------------------------------------------------------------ */

napi_value Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

bool ReadDouble(napi_env env, napi_value value, double& out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  return napi_get_value_double(env, value, &out) == napi_ok;
}

napi_value MakeBoolean(napi_env env, bool value) {
  napi_value result = nullptr;
  napi_get_boolean(env, value, &result);
  return result;
}

/** 坐标 + 超时的入参校验（grab / warmup 共用） */
bool ReadPointAndTimeout(napi_env env, napi_value* args, std::size_t argc, double& x, double& y,
                         std::uint32_t& timeoutMs, std::string& error) {
  if (argc < 2) {
    error = "需要两个参数：物理坐标 x, y";
    return false;
  }
  if (!ReadDouble(env, args[0], x) || !ReadDouble(env, args[1], y)) {
    error = "坐标必须是数字（物理像素）";
    return false;
  }
  double timeoutValue = static_cast<double>(kDefaultTimeoutMs);
  if (argc >= 3) {
    napi_valuetype timeoutType = napi_undefined;
    if (napi_typeof(env, args[2], &timeoutType) != napi_ok) {
      error = "读取 timeoutMs 失败";
      return false;
    }
    if (timeoutType != napi_undefined && timeoutType != napi_null) {
      if (!ReadDouble(env, args[2], timeoutValue)) {
        error = "timeoutMs 必须是数字";
        return false;
      }
    }
  }
  timeoutMs = kDefaultTimeoutMs;
  if (timeoutValue > 0) {
    timeoutMs = static_cast<std::uint32_t>(timeoutValue);
    if (timeoutMs < kMinTimeoutMs) timeoutMs = kMinTimeoutMs;
    if (timeoutMs > kMaxTimeoutMs) timeoutMs = kMaxTimeoutMs;
  }
  return true;
}

napi_value GrabMonitor(napi_env env, napi_callback_info info) {
  std::size_t argc = 3;
  napi_value args[3] = {};
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok) {
    return Throw(env, "读取参数失败");
  }
  double x = 0;
  double y = 0;
  std::uint32_t timeoutMs = kDefaultTimeoutMs;
  std::string error;
  if (!ReadPointAndTimeout(env, args, argc, x, y, timeoutMs, error)) return Throw(env, error);

  GrabShared shared;
  try {
    GrabJpegAt(x, y, timeoutMs, shared);
  } catch (winrt::hresult_error const& winrtError) {
    return Throw(env, WinrtText(winrtError));
  } catch (std::exception const& stdError) {
    return Throw(env, std::string("抓帧异常：") + stdError.what());
  } catch (...) {
    return Throw(env, "抓帧时发生未知异常");
  }
  if (!shared.ok) return Throw(env, shared.error.empty() ? "抓帧失败" : shared.error);

  napi_value result = nullptr;
  napi_create_object(env, &result);

  napi_value width = nullptr;
  napi_create_uint32(env, shared.width, &width);
  napi_set_named_property(env, result, "width", width);

  napi_value height = nullptr;
  napi_create_uint32(env, shared.height, &height);
  napi_set_named_property(env, result, "height", height);

  napi_value jpeg = nullptr;
  napi_create_buffer_copy(env, shared.jpeg.size(), shared.jpeg.data(), nullptr, &jpeg);
  napi_set_named_property(env, result, "jpeg", jpeg);

  napi_value monitorLeft = nullptr;
  napi_create_int32(env, shared.monitorRect.left, &monitorLeft);
  napi_set_named_property(env, result, "monitorLeft", monitorLeft);

  napi_value monitorTop = nullptr;
  napi_create_int32(env, shared.monitorRect.top, &monitorTop);
  napi_set_named_property(env, result, "monitorTop", monitorTop);

  napi_value cursorCaptured = nullptr;
  napi_get_boolean(env, shared.cursorCaptured, &cursorCaptured);
  napi_set_named_property(env, result, "cursorCaptured", cursorCaptured);

  napi_value borderSuppressed = nullptr;
  napi_get_boolean(env, shared.borderSuppressed, &borderSuppressed);
  napi_set_named_property(env, result, "borderSuppressed", borderSuppressed);

  return result;
}

/** 只把设备与 item 缓存建好（首次 D3D 设备初始化 ~300ms，别让第一次点球等它） */
napi_value Warmup(napi_env env, napi_callback_info info) {
  std::size_t argc = 2;
  napi_value args[2] = {};
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok) {
    return Throw(env, "读取参数失败");
  }
  double x = 0;
  double y = 0;
  std::uint32_t timeoutMs = kDefaultTimeoutMs;
  std::string error;
  if (!ReadPointAndTimeout(env, args, argc, x, y, timeoutMs, error)) return Throw(env, error);

  EnsureApartment();
  POINT point = {static_cast<LONG>(x), static_cast<LONG>(y)};
  HMONITOR monitor = ::MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
  if (monitor == nullptr) return MakeBoolean(env, false);

  GrabCache& cache = GetCache();
  std::lock_guard<std::mutex> serialize(cache.mutex);
  return MakeBoolean(env, EnsureCache(monitor, cache, error));
}

/** HWND 用 BigInt 传：Electron 的 getNativeWindowHandle() 是 8 字节 Buffer，JS 侧读成 BigInt */
bool ReadHwnd(napi_env env, napi_value value, HWND& window, std::string& error) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok) {
    error = "读取 hwnd 失败";
    return false;
  }
  std::uint64_t raw = 0;
  if (type == napi_bigint) {
    bool lossless = false;
    if (napi_get_value_bigint_uint64(env, value, &raw, &lossless) != napi_ok) {
      error = "hwnd 必须是 BigInt / 数字";
      return false;
    }
  } else if (type == napi_number) {
    double number = 0;
    if (napi_get_value_double(env, value, &number) != napi_ok) {
      error = "hwnd 必须是 BigInt / 数字";
      return false;
    }
    raw = static_cast<std::uint64_t>(number);
  } else {
    error = "hwnd 必须是 BigInt / 数字";
    return false;
  }
  window = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(raw));
  return true;
}

/**
 * 一次 SetWindowPos(HWND_TOPMOST)：把窗口抬到置顶带最前面，不抢焦点、不改尺寸位置。
 * 返回是否成功；窗口失效返回 false（调用方可以退回 Electron 的 setAlwaysOnTop + moveTop）。
 */
napi_value SetTopmost(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value args[1] = {};
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 1) {
    return Throw(env, "setTopmost(hwnd) 需要一个参数");
  }
  HWND window = nullptr;
  std::string error;
  if (!ReadHwnd(env, args[0], window, error)) return Throw(env, error);
  if (window == nullptr || !::IsWindow(window)) return MakeBoolean(env, false);
  BOOL ok = ::SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0,
                           SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  return MakeBoolean(env, ok != FALSE);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"grabMonitor", nullptr, GrabMonitor, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"warmup", nullptr, Warmup, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setTopmost", nullptr, SetTopmost, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);

  napi_value version = nullptr;
  napi_create_string_utf8(env, kVersion, NAPI_AUTO_LENGTH, &version);
  napi_set_named_property(env, exports, "version", version);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
