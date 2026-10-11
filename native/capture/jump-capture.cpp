// JUMP native screen capture helper (Windows 10 2004+).
//
// Chromium's desktop capturer blocks on the GPU for every frame and then waits
// as long again before the next one (it caps capture at 50% of one core), so a
// game that keeps the GPU busy at 60-100 FPS is streamed at only half its frame
// rate. This helper captures with Windows.Graphics.Capture on its own thread,
// copies each frame into a ring of shared BGRA textures on the GPU, and hands
// their NT handles to the Electron main process, which imports them with the
// `sharedTexture` API. Nothing waits for the GPU on the capture path, so the
// stream follows the game's frame rate.
//
// Usage: jump-capture.exe --pid <electron main pid> [--fps 60]
//          (--monitor-point <x>,<y> | --monitor <index> | --window <hwnd>)
// stdout (one message per line):
//   READY <width> <height>
//   TEX <generation> <slot> <handle> <width> <height>   handle valid in --pid
//   FRAME <generation> <slot> <timestampUs>             copy into slot finished
//   ENDED <reason>                                      the source went away
//   ERROR <step> <code>
// stdin: "REL <generation> <slot>" returns a slot, "STOP" (or EOF) exits.
#include <windows.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

using namespace winrt;
namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd = winrt::Windows::Graphics::DirectX;
namespace d3d = winrt::Windows::Graphics::DirectX::Direct3D11;

struct __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")) IDirect3DDxgiInterfaceAccess : ::IUnknown {
  virtual HRESULT __stdcall GetInterface(GUID const& id, void** object) = 0;
};

namespace {

constexpr int kSlotCount = 6;
enum SlotState { kFree = 0, kCopying = 1, kSent = 2 };

struct Slot {
  com_ptr<ID3D11Texture2D> texture;
  com_ptr<ID3D11Query> query;
  std::atomic<int> state{kFree};
  long long timestampUs = 0;
};

// One set of textures per capture size. A resized window gets a new
// generation; slots of an older generation stay alive until released.
struct Generation {
  int id = 0;
  UINT width = 0;
  UINT height = 0;
  Slot slots[kSlotCount];
};

std::mutex outputLock;
void Emit(const char* format, ...) {
  std::lock_guard<std::mutex> guard(outputLock);
  va_list args;
  va_start(args, format);
  vfprintf(stdout, format, args);
  va_end(args);
  fflush(stdout);
}

struct Options {
  DWORD pid = 0;
  HWND window = nullptr;
  bool hasPoint = false;
  POINT point{0, 0};
  int monitorIndex = 0;
  int maxFps = 60;
};

Options ParseOptions(int argc, wchar_t** argv) {
  Options options;
  for (int i = 1; i + 1 < argc; i += 2) {
    const wchar_t* value = argv[i + 1];
    if (!wcscmp(argv[i], L"--pid")) options.pid = wcstoul(value, nullptr, 10);
    else if (!wcscmp(argv[i], L"--window")) options.window = reinterpret_cast<HWND>(static_cast<uintptr_t>(_wcstoui64(value, nullptr, 10)));
    else if (!wcscmp(argv[i], L"--monitor")) options.monitorIndex = _wtoi(value);
    else if (!wcscmp(argv[i], L"--fps")) options.maxFps = _wtoi(value);
    else if (!wcscmp(argv[i], L"--monitor-point")) {
      options.hasPoint = swscanf_s(value, L"%ld,%ld", &options.point.x, &options.point.y) == 2;
    }
  }
  return options;
}

HMONITOR PickMonitor(const Options& options) {
  if (options.hasPoint) return MonitorFromPoint(options.point, MONITOR_DEFAULTTOPRIMARY);
  std::vector<HMONITOR> monitors;
  EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
    reinterpret_cast<std::vector<HMONITOR>*>(data)->push_back(monitor);
    return TRUE;
  }, reinterpret_cast<LPARAM>(&monitors));
  if (options.monitorIndex >= 0 && options.monitorIndex < static_cast<int>(monitors.size())) return monitors[options.monitorIndex];
  return MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  // Every message is flushed explicitly; buffer the rest of a line.
  setvbuf(stdout, nullptr, _IOFBF, 1 << 14);
  init_apartment(apartment_type::multi_threaded);
  const Options options = ParseOptions(argc, argv);
  HANDLE target = OpenProcess(PROCESS_DUP_HANDLE, FALSE, options.pid);
  if (!target) { Emit("ERROR open-process %lu\n", GetLastError()); return 2; }
  if (!wgc::GraphicsCaptureSession::IsSupported()) { Emit("ERROR unsupported 0\n"); return 2; }

  com_ptr<ID3D11Device> device;
  com_ptr<ID3D11DeviceContext> context;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                 nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put());
  if (FAILED(hr)) { Emit("ERROR d3d11 %ld\n", hr); return 2; }
  device.as<ID3D10Multithread>()->SetMultithreadProtected(TRUE);
  com_ptr<::IInspectable> inspectable;
  check_hresult(CreateDirect3D11DeviceFromDXGIDevice(device.as<IDXGIDevice>().get(), inspectable.put()));
  const auto winrtDevice = inspectable.as<d3d::IDirect3DDevice>();

  wgc::GraphicsCaptureItem item{nullptr};
  try {
    const auto interop = get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    if (options.window) check_hresult(interop->CreateForWindow(options.window, guid_of<wgc::GraphicsCaptureItem>(), put_abi(item)));
    else check_hresult(interop->CreateForMonitor(PickMonitor(options), guid_of<wgc::GraphicsCaptureItem>(), put_abi(item)));
  } catch (hresult_error const& error) {
    Emit("ERROR capture-item %ld\n", static_cast<long>(error.code()));
    return 2;
  }

  std::mutex generationLock;
  std::vector<std::shared_ptr<Generation>> generations;  // current is back()
  int nextGenerationId = 1;
  auto createGeneration = [&](UINT width, UINT height) -> std::shared_ptr<Generation> {
    auto generation = std::make_shared<Generation>();
    generation->id = nextGenerationId++;
    generation->width = width;
    generation->height = height;
    for (int i = 0; i < kSlotCount; i++) {
      Slot& slot = generation->slots[i];
      D3D11_TEXTURE2D_DESC desc{};
      desc.Width = width;
      desc.Height = height;
      desc.MipLevels = 1;
      desc.ArraySize = 1;
      desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      desc.SampleDesc.Count = 1;
      desc.Usage = D3D11_USAGE_DEFAULT;
      desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
      desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
      check_hresult(device->CreateTexture2D(&desc, nullptr, slot.texture.put()));
      HANDLE local = nullptr;
      check_hresult(slot.texture.as<IDXGIResource1>()->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &local));
      HANDLE remote = nullptr;
      const BOOL duplicated = DuplicateHandle(GetCurrentProcess(), local, target, &remote, 0, FALSE, DUPLICATE_SAME_ACCESS);
      CloseHandle(local);
      if (!duplicated) throw hresult_error(HRESULT_FROM_WIN32(GetLastError()));
      D3D11_QUERY_DESC queryDesc{D3D11_QUERY_EVENT, 0};
      check_hresult(device->CreateQuery(&queryDesc, slot.query.put()));
      Emit("TEX %d %d %llu %u %u\n", generation->id, i, static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(remote)), width, height);
    }
    return generation;
  };

  auto size = item.Size();
  // H.264 needs even dimensions; an odd last row/column is dropped.
  try {
    generations.push_back(createGeneration(static_cast<UINT>(size.Width) & ~1u, static_cast<UINT>(size.Height) & ~1u));
  } catch (hresult_error const& error) {
    Emit("ERROR textures %ld\n", static_cast<long>(error.code()));
    return 2;
  }

  auto pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(winrtDevice, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
  auto session = pool.CreateCaptureSession(item);
  try { session.IsCursorCaptureEnabled(true); } catch (...) {}
  try {
    wgc::GraphicsCaptureAccess::RequestAccessAsync(wgc::GraphicsCaptureAccessKind::Borderless).get();
    session.IsBorderRequired(false);
  } catch (...) {}
  // Windows 11 24H2 otherwise limits delivery to the display refresh steps it
  // chooses; ask for every frame and pace below.
  try { session.MinUpdateInterval(winrt::Windows::Foundation::TimeSpan{std::chrono::milliseconds(1)}); } catch (...) {}

  std::atomic<bool> running{true};
  // Frame pacing: a 70 FPS game streamed at 60 keeps 6 of every 7 frames in
  // phase instead of handing WebRTC a 70 FPS burst to thin out unevenly.
  const long long periodUs = options.maxFps > 0 ? 1000000LL / options.maxFps : 0;
  const long long toleranceUs = periodUs / 8;
  long long nextDueUs = 0;
  winrt::Windows::Graphics::SizeInt32 poolSize = size;
  int nextSlot = 0;

  // The parent answers ENDED with STOP, which ends the stdin loop below.
  item.Closed([&](auto&&, auto&&) {
    running = false;
    Emit("ENDED closed\n");
  });

  pool.FrameArrived([&](wgc::Direct3D11CaptureFramePool const& sender, auto&&) {
    auto frame = sender.TryGetNextFrame();
    if (!frame || !running) return;
    const auto contentSize = frame.ContentSize();
    if (contentSize.Width != poolSize.Width || contentSize.Height != poolSize.Height) {
      if (contentSize.Width < 2 || contentSize.Height < 2) return;  // minimized window
      poolSize = contentSize;
      sender.Recreate(winrtDevice, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, contentSize);
      try {
        auto next = createGeneration(static_cast<UINT>(contentSize.Width) & ~1u, static_cast<UINT>(contentSize.Height) & ~1u);
        std::lock_guard<std::mutex> guard(generationLock);
        generations.push_back(next);
      } catch (hresult_error const& error) {
        Emit("ERROR resize %ld\n", static_cast<long>(error.code()));
      }
      return;
    }
    const long long nowUs = frame.SystemRelativeTime().count() / 10;
    if (periodUs && nowUs < nextDueUs - toleranceUs) return;

    std::shared_ptr<Generation> generation;
    {
      std::lock_guard<std::mutex> guard(generationLock);
      generation = generations.back();
    }
    int chosen = -1;
    for (int n = 0; n < kSlotCount; n++) {
      const int candidate = (nextSlot + n) % kSlotCount;
      int expected = kFree;
      if (generation->slots[candidate].state.compare_exchange_strong(expected, kCopying)) { chosen = candidate; break; }
    }
    // Every slot is still held by the encoder: drop this frame rather than
    // overwrite one that is being read.
    if (chosen < 0) return;
    nextSlot = (chosen + 1) % kSlotCount;
    nextDueUs = nowUs > nextDueUs + periodUs ? nowUs + periodUs : nextDueUs + periodUs;

    com_ptr<ID3D11Texture2D> source;
    frame.Surface().as<IDirect3DDxgiInterfaceAccess>()->GetInterface(guid_of<ID3D11Texture2D>(), source.put_void());
    Slot& slot = generation->slots[chosen];
    slot.timestampUs = nowUs;
    const D3D11_BOX box{0, 0, 0, generation->width, generation->height, 1};
    context->CopySubresourceRegion(slot.texture.get(), 0, 0, 0, 0, source.get(), 0, &box);
    context->End(slot.query.get());
    context->Flush();
  });

  // Announce a frame only after its copy finished on the GPU: the importer
  // reads the texture from another device without a keyed mutex.
  std::thread completion([&] {
    while (running) {
      bool pending = false;
      {
        std::lock_guard<std::mutex> guard(generationLock);
        for (auto& generation : generations) {
          for (int i = 0; i < kSlotCount; i++) {
            Slot& slot = generation->slots[i];
            if (slot.state.load() != kCopying) continue;
            pending = true;
            if (context->GetData(slot.query.get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH) == S_OK) {
              slot.state = kSent;
              Emit("FRAME %d %d %lld\n", generation->id, i, slot.timestampUs);
            }
          }
        }
        // Retire older generations once the encoder returned all their slots.
        while (generations.size() > 1) {
          const auto& oldest = generations.front();
          bool busy = false;
          for (const auto& slot : oldest->slots) busy = busy || slot.state.load() != kFree;
          if (busy) break;
          generations.erase(generations.begin());
        }
      }
      if (pending) SwitchToThread();
      else Sleep(1);
    }
  });

  try {
    session.StartCapture();
  } catch (hresult_error const& error) {
    Emit("ERROR start %ld\n", static_cast<long>(error.code()));
    running = false;
    completion.join();
    return 2;
  }
  Emit("READY %u %u\n", generations.back()->width, generations.back()->height);

  char line[128];
  while (running && fgets(line, sizeof line, stdin)) {
    int generationId = 0;
    int slotIndex = -1;
    if (sscanf_s(line, "REL %d %d", &generationId, &slotIndex) == 2) {
      std::lock_guard<std::mutex> guard(generationLock);
      for (auto& generation : generations) {
        if (generation->id == generationId && slotIndex >= 0 && slotIndex < kSlotCount) generation->slots[slotIndex].state = kFree;
      }
    } else if (!strncmp(line, "STOP", 4)) {
      break;
    }
  }
  running = false;
  try { session.Close(); } catch (...) {}
  try { pool.Close(); } catch (...) {}
  completion.join();
  CloseHandle(target);
  return 0;
}
