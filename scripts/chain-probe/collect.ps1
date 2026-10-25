# 信息链探针 · 采集器（Windows PowerShell 5.1）
#
# 目的：验证「焦点窗口占用段」能不能切准——先拿到真实的前台窗口变化与输入事件流。
# 口径见 docs/chain-probe.md。这是一次性验证脚本，不进主程序、不读写应用数据库。
#
# 记录什么：前台窗口变化（hwnd / pid / exe / 标题 / 窗口矩形）、鼠标移动（按像素步长抽稀）、
#           左 / 右 / 中键按下、滚轮、空闲 / 返回。
# 不记录什么：键盘（不装键盘钩子）、屏幕内容、截图、OCR 文本、剪贴板、URL。
# 标题默认记录（切段要用），-NoTitles 可改成空串。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/chain-probe/collect.ps1 -Minutes 30
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/chain-probe/collect.ps1 -Seconds 20
#
# 输出：.tmp/chain-probe/collect-<yyyyMMdd-HHmmss>.jsonl（.tmp 已 gitignore）

param(
    [int]$Minutes = 30,
    [int]$Seconds = 0,
    [string]$OutDir = '',
    [switch]$NoTitles,
    [int]$MoveStepPx = 4,
    [int]$IdleSeconds = 60,
    [int]$PollMs = 250,
    [int]$MaxEvents = 500000
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($OutDir)) {
    $OutDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.tmp/chain-probe'
}

$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ChainProbe
{
    public static readonly ConcurrentQueue<string> Events = new ConcurrentQueue<string>();
    public static int MoveStepPx = 4;
    public static bool NoTitles = false;
    public static int MaxEvents = 500000;
    public static int Dropped = 0;

    private const int WH_MOUSE_LL = 14;
    private const uint WM_MOUSEMOVE = 0x0200;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_RBUTTONDOWN = 0x0204;
    private const uint WM_MBUTTONDOWN = 0x0207;
    private const uint WM_MOUSEWHEEL = 0x020A;
    private const uint WM_MOUSEHWHEEL = 0x020E;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint lPrivate; }

    private delegate IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam);
    private delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    private static MouseProc _mouseProc;
    private static WinEventProc _winEventProc;
    private static IntPtr _mouseHook = IntPtr.Zero;
    private static IntPtr _winHook = IntPtr.Zero;
    private static int _lastMoveX = int.MinValue;
    private static int _lastMoveY = int.MinValue;
    private static IntPtr _lastHwnd = IntPtr.Zero;
    private static string _lastTitle = null;
    private static readonly Dictionary<uint, string> _exeCache = new Dictionary<uint, string>();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, MouseProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint filterMin, uint filterMax, uint remove);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventProc proc, uint idProcess, uint idThread, uint flags);

    public static long NowMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    public static bool Start()
    {
        _mouseProc = new MouseProc(MouseProcImpl);
        _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, IntPtr.Zero, 0);
        _winEventProc = new WinEventProc(WinEventProcImpl);
        _winHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _winEventProc, 0, 0, WINEVENT_OUTOFCONTEXT);
        return _mouseHook != IntPtr.Zero && _winHook != IntPtr.Zero;
    }

    public static void Stop()
    {
        if (_mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(_mouseHook); _mouseHook = IntPtr.Zero; }
        if (_winHook != IntPtr.Zero) { UnhookWindowsHookEx(_winHook); _winHook = IntPtr.Zero; }
    }

    public static int Pump(int timeoutMs)
    {
        int handled = 0;
        Stopwatch sw = Stopwatch.StartNew();
        MSG msg;
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
                handled++;
            }
            else
            {
                Thread.Sleep(1);
            }
        }
        return handled;
    }

    public static int IdleMs()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) return 0;
        return unchecked((int)((uint)Environment.TickCount - info.dwTime));
    }

    public static string SessionJson()
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"type\":\"session\",\"ts\":").Append(NowMs());
        sb.Append(",\"os\":\"").Append(Esc(Environment.OSVersion.VersionString)).Append('"');
        sb.Append(",\"screen\":[").Append(GetSystemMetrics(SM_CXSCREEN)).Append(',').Append(GetSystemMetrics(SM_CYSCREEN)).Append(']');
        sb.Append(",\"moveStepPx\":").Append(MoveStepPx);
        sb.Append(",\"titles\":").Append(NoTitles ? "false" : "true").Append('}');
        return sb.ToString();
    }

    // 标题变化不会触发前台变更事件：由调用方定时轮询，只有 (hwnd, title) 变了才返回一行
    public static string PollForeground()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        string title = SafeTitle(hwnd);
        if (hwnd == _lastHwnd)
        {
            if (!NoTitles && title != null && title != _lastTitle)
            {
                _lastTitle = title;
                return WindowJson(hwnd, "title");
            }
            return null;
        }
        _lastHwnd = hwnd;
        _lastTitle = title;
        return WindowJson(hwnd, "fg");
    }

    public static string CurrentForegroundJson()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        // 起点行同时把状态记账，否则紧接着的轮询会把同一个窗口再报一次
        _lastHwnd = hwnd;
        _lastTitle = SafeTitle(hwnd);
        return WindowJson(hwnd, "fg");
    }

    private static void WinEventProcImpl(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (hwnd == IntPtr.Zero) return;
        if (hwnd == _lastHwnd) return;
        _lastHwnd = hwnd;
        _lastTitle = SafeTitle(hwnd);
        Enqueue(WindowJson(hwnd, "fg"));
    }

    private static IntPtr MouseProcImpl(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            uint message = (uint)wParam.ToInt32();
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            switch (message)
            {
                case WM_MOUSEMOVE:
                    if (_lastMoveX == int.MinValue || Math.Abs(data.pt.X - _lastMoveX) >= MoveStepPx || Math.Abs(data.pt.Y - _lastMoveY) >= MoveStepPx)
                    {
                        _lastMoveX = data.pt.X;
                        _lastMoveY = data.pt.Y;
                        Enqueue("{\"type\":\"move\",\"ts\":" + NowMs() + ",\"x\":" + data.pt.X + ",\"y\":" + data.pt.Y + "}");
                    }
                    break;
                case WM_LBUTTONDOWN:
                    Enqueue(ClickJson("left", data.pt));
                    break;
                case WM_RBUTTONDOWN:
                    Enqueue(ClickJson("right", data.pt));
                    break;
                case WM_MBUTTONDOWN:
                    Enqueue(ClickJson("middle", data.pt));
                    break;
                case WM_MOUSEWHEEL:
                    Enqueue(WheelJson(data, false));
                    break;
                case WM_MOUSEHWHEEL:
                    Enqueue(WheelJson(data, true));
                    break;
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static string ClickJson(string button, POINT pt)
    {
        return "{\"type\":\"click\",\"ts\":" + NowMs() + ",\"button\":\"" + button + "\",\"x\":" + pt.X + ",\"y\":" + pt.Y + "}";
    }

    private static string WheelJson(MSLLHOOKSTRUCT data, bool horizontal)
    {
        int delta = (short)((data.mouseData >> 16) & 0xFFFF);
        return "{\"type\":\"wheel\",\"ts\":" + NowMs() + ",\"delta\":" + delta + (horizontal ? ",\"axis\":\"h\"" : "") + ",\"x\":" + data.pt.X + ",\"y\":" + data.pt.Y + "}";
    }

    private static void Enqueue(string line)
    {
        if (Events.Count >= MaxEvents) { Dropped++; return; }
        Events.Enqueue(line);
    }

    private static string WindowJson(IntPtr hwnd, string type)
    {
        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);
        RECT rect;
        GetWindowRect(hwnd, out rect);
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"type\":\"").Append(type).Append("\",\"ts\":").Append(NowMs());
        sb.Append(",\"hwnd\":").Append(hwnd.ToInt64());
        sb.Append(",\"pid\":").Append(pid);
        sb.Append(",\"exe\":\"").Append(Esc(ExeName(pid))).Append('"');
        if (!NoTitles) sb.Append(",\"title\":\"").Append(Esc(SafeTitle(hwnd))).Append('"');
        sb.Append(",\"bounds\":[").Append(rect.Left).Append(',').Append(rect.Top).Append(',')
          .Append(rect.Right - rect.Left).Append(',').Append(rect.Bottom - rect.Top).Append("]}");
        return sb.ToString();
    }

    private static string SafeTitle(IntPtr hwnd)
    {
        if (NoTitles) return "";
        int len = GetWindowTextLength(hwnd);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string ExeName(uint pid)
    {
        if (pid == 0) return "";
        string cached;
        if (_exeCache.TryGetValue(pid, out cached)) return cached;
        string name = "";
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                name = p.ProcessName.ToLowerInvariant();
            }
        }
        catch
        {
            name = "";
        }
        _exeCache[pid] = name;
        return name;
    }

    private static string Esc(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        StringBuilder sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append(' ');
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[ChainProbe]::MoveStepPx = $MoveStepPx
[ChainProbe]::NoTitles = [bool]$NoTitles
[ChainProbe]::MaxEvents = $MaxEvents

if (-not [ChainProbe]::Start()) {
    Write-Error 'hook install failed (mouse or foreground hook returned null)'
    exit 1
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$path = Join-Path $OutDir "collect-$stamp.jsonl"
$writer = New-Object System.IO.StreamWriter($path, $false, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $false

$counts = @{ session = 0; fg = 0; title = 0; move = 0; click = 0; wheel = 0; idle = 0; active = 0 }
$total = 0

function Write-Line([string]$line) {
    if ([string]::IsNullOrEmpty($line)) { return }
    $writer.WriteLine($line)
    $script:total++
    $t = $line.Split('"')[3]
    if ($counts.ContainsKey($t)) { $counts[$t]++ }
}

try {
    Write-Line ([ChainProbe]::SessionJson())
    # 记录起点：当前前台窗口先落一行，避免第一段没有起点
    Write-Line ([ChainProbe]::CurrentForegroundJson())

    $start = Get-Date
    $deadline = if ($Seconds -gt 0) { $start.AddSeconds($Seconds) } else { $start.AddMinutes($Minutes) }
    $idleState = $false
    $lastFlush = Get-Date
    $lastReport = Get-Date

    Write-Host ("[collect] writing {0}" -f $path)
    Write-Host ("[collect] duration {0}, moveStep {1}px, idle {2}s, titles={3}" -f $(if ($Seconds -gt 0) { "$Seconds s" } else { "$Minutes min" }), $MoveStepPx, $IdleSeconds, (-not $NoTitles))

    while ((Get-Date) -lt $deadline) {
        [void][ChainProbe]::Pump($PollMs)
        Write-Line ([ChainProbe]::PollForeground())

        $line = $null
        while ([ChainProbe]::Events.TryDequeue([ref]$line)) { Write-Line $line }

        $idleMs = [ChainProbe]::IdleMs()
        $isIdle = $idleMs -ge ($IdleSeconds * 1000)
        if ($isIdle -and -not $idleState) {
            Write-Line ("{""type"":""idle"",""ts"":" + [ChainProbe]::NowMs() + ",""idleMs"":" + $idleMs + "}")
            $idleState = $true
        } elseif (-not $isIdle -and $idleState) {
            Write-Line ("{""type"":""active"",""ts"":" + [ChainProbe]::NowMs() + "}")
            $idleState = $false
        }

        $now = Get-Date
        if (($now - $lastFlush).TotalSeconds -ge 2) { $writer.Flush(); $lastFlush = $now }
        if (($now - $lastReport).TotalSeconds -ge 15) {
            $elapsed = [int]($now - $start).TotalSeconds
            Write-Host ("[collect] {0}s  fg={1} title={2} move={3} click={4} wheel={5} total={6}" -f $elapsed, $counts.fg, $counts.title, $counts.move, $counts.click, $counts.wheel, $total)
            $lastReport = $now
        }
    }
}
finally {
    [ChainProbe]::Stop()
    $writer.Flush()
    $writer.Dispose()
}

Write-Host ("[collect] done: {0} records -> {1}" -f $total, $path)
Write-Host ("[collect] fg={0} title={1} move={2} click={3} wheel={4} idle={5} dropped={6}" -f $counts.fg, $counts.title, $counts.move, $counts.click, $counts.wheel, $counts.idle, [ChainProbe]::Dropped)
Write-Host ("[collect] analyze: npm run chain-probe -- {0}" -f $path)
