# 信息链探针 · UIA 覆盖率（Windows PowerShell 5.1）
#
# 目的：摸清「UIA 抓到多少文本、哪些窗口抓不到」，用来决定 UIA 与 OCR 的分工。
# 每个窗口在独立子进程里测（uia-window.ps1），父进程带超时——UIA 在某些应用上会挂住，
# 不能让它拖死整个采样。
#
# 两种模式：
#   -Once           立刻扫一遍当前所有可见顶层窗口（默认，一分钟内出结果）
#   -Minutes 15     连续采样：盯住前台窗口，每个新 (pid, 标题) 只测一次
#
# 只记录统计：元素数 / 名字字符数 / 密码控件数 / 耗时 / 是否超时。
# 不记录 UI 文本、不截图、不碰应用数据库。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/chain-probe/uia-probe.ps1 -Once
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/chain-probe/uia-probe.ps1 -Minutes 15
#
# 输出：.tmp/chain-probe/uia-<yyyyMMdd-HHmmss>.jsonl

param(
    [switch]$Once,
    [int]$Minutes = 0,
    [string]$OutDir = '',
    [int]$TimeoutSeconds = 10,
    [int]$MaxProbes = 200,
    [int]$MaxElements = 4000
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($OutDir)) {
    $OutDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) '.tmp/chain-probe'
}
if (-not $Once -and $Minutes -le 0) { $Once = $true }

$childScript = Join-Path $PSScriptRoot 'uia-window.ps1'

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowEnum
{
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    /// <summary>前台窗口的 hwnd（连续采样模式只测它）</summary>
    public static long ForegroundHwnd()
    {
        return GetForegroundWindow().ToInt64();
    }

    // 环境块修复用（见 Repair-CaseDuplicateEnv）
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetEnvironmentVariable(string name, string value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetEnvironmentStringsW();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeEnvironmentStringsW(IntPtr block);

    /// <summary>传 null 才是删除；PowerShell 里把 $null 传给 string 参数会变成空串</summary>
    public static bool RemoveEnv(string name) { return SetEnvironmentVariable(name, null); }
    public static bool SetEnv(string name, string value) { return SetEnvironmentVariable(name, value); }

    public static string[] AllEnv()
    {
        IntPtr block = GetEnvironmentStringsW();
        List<string> list = new List<string>();
        if (block == IntPtr.Zero) return list.ToArray();
        int offset = 0;
        while (true)
        {
            IntPtr p = new IntPtr(block.ToInt64() + offset);
            string s = Marshal.PtrToStringUni(p);
            if (string.IsNullOrEmpty(s)) break;
            list.Add(s);
            offset += (s.Length + 1) * 2;
        }
        FreeEnvironmentStringsW(block);
        return list.ToArray();
    }

    public static List<string> VisibleWindows()
    {
        List<string> list = new List<string>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hwnd)) return true;
            if (IsIconic(hwnd)) return true;
            int len = GetWindowTextLength(hwnd);
            if (len <= 0) return true;
            StringBuilder cls = new StringBuilder(256);
            GetClassName(hwnd, cls, cls.Capacity);
            string c = cls.ToString();
            if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Windows.UI.Core.CoreWindow") return true;
            StringBuilder title = new StringBuilder(len + 1);
            GetWindowText(hwnd, title, title.Capacity);
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            string exe = "";
            try
            {
                using (Process p = Process.GetProcessById((int)pid)) { exe = p.ProcessName.ToLowerInvariant(); }
            }
            catch { exe = ""; }
            list.Add("{\"hwnd\":" + hwnd.ToInt64() + ",\"pid\":" + pid + ",\"exe\":\"" + Esc(exe) + "\",\"title\":\"" + Esc(title.ToString()) + "\"}");
            return true;
        }, IntPtr.Zero);
        return list;
    }

    private static string Esc(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        StringBuilder sb = new StringBuilder(s.Length + 8);
        foreach (char ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < ' ') sb.Append(' ');
                    else sb.Append(ch);
                    break;
            }
        }
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

# PowerShell 5.1 的 Start-Process 会把进程环境装进大小写不敏感的字典：同时存在
# HTTP_PROXY 与 http_proxy 这类同形不同大小写的键时，直接抛
# "Item has already been added. Key in dictionary: 'NO_PROXY'"——子进程根本起不来。
# DSH 注入的环境就是这种形态，所以先统一成大写键再拉子进程。
function Repair-CaseDuplicateEnv {
    $map = @{}
    foreach ($entry in [WindowEnum]::AllEnv()) {
        $index = $entry.IndexOf('=')
        if ($index -le 0) { continue }
        $name = $entry.Substring(0, $index)
        $value = $entry.Substring($index + 1)
        $key = $name.ToUpperInvariant()
        if (-not $map.ContainsKey($key)) {
            $map[$key] = @{ value = $value; names = New-Object System.Collections.ArrayList }
        }
        [void]$map[$key].names.Add($name)
        if ($name -ceq $key) { $map[$key].value = $value }
    }
    foreach ($key in @($map.Keys)) {
        $item = $map[$key]
        if ($item.names.Count -le 1) { continue }
        foreach ($name in $item.names) { [void][WindowEnum]::RemoveEnv($name) }
        [void][WindowEnum]::SetEnv($key, $item.value)
        Write-Host ("[uia] env: merged duplicate {0}" -f ($item.names -join ' / '))
    }
}

Repair-CaseDuplicateEnv

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$path = Join-Path $OutDir "uia-$stamp.jsonl"
$writer = New-Object System.IO.StreamWriter($path, $false, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true

$seen = @{}
$probes = 0
$timeouts = 0
$failures = 0
$okCount = 0
$totalChars = 0

function Invoke-UiaProbe([string]$windowJson) {
    $win = ConvertFrom-Json $windowJson
    $key = '{0}|{1}' -f $win.pid, $win.title
    if ($seen.ContainsKey($key)) { return }
    $seen[$key] = $true
    if ($script:probes -ge $MaxProbes) { return }
    $script:probes++

    $tmp = [System.IO.Path]::GetTempFileName()
    $entry = [ordered]@{
        type       = 'uia'
        ts         = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        hwnd       = [long]$win.hwnd
        pid        = [int]$win.pid
        exe        = $win.exe
        title      = $win.title
        ok         = $false
        timedOut   = $false
        elements   = 0
        withName   = 0
        chars      = 0
        password   = 0
        ms         = 0
        error      = $null
    }

    try {
        $proc = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $childScript, '-Hwnd', ([long]$win.hwnd), '-MaxElements', $MaxElements) `
            -RedirectStandardOutput $tmp -NoNewWindow -PassThru
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill() } catch { }
            $entry.timedOut = $true
            $entry.error = 'timeout'
            $script:timeouts++
        }
        else {
            $raw = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
            if ([string]::IsNullOrWhiteSpace($raw)) {
                $entry.error = 'no output'
                $script:failures++
            }
            else {
                $parsed = ConvertFrom-Json $raw
                $entry.ok = [bool]$parsed.ok
                $entry.elements = [int]$parsed.elements
                $entry.withName = [int]$parsed.withName
                $entry.chars = [int]$parsed.chars
                $entry.password = [int]$parsed.password
                $entry.ms = [int]$parsed.ms
                if ($parsed.error) { $entry.error = [string]$parsed.error }
                if ($entry.ok) { $script:okCount++ } else { $script:failures++ }
            }
        }
    }
    catch {
        $entry.error = $_.Exception.Message
        $script:failures++
    }
    finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }

    $script:totalChars += $entry.chars
    Write-Host ("[uia] {0,-16} chars={1,-6} elements={2,-6} {3}ms{4}" -f $entry.exe, $entry.chars, $entry.elements, $entry.ms, $(if ($entry.timedOut) { ' TIMEOUT' } elseif (-not $entry.ok) { ' FAIL' } else { '' }))
    $writer.WriteLine((ConvertTo-Json -InputObject $entry -Compress))
}

try {
    Write-Host ("[uia] writing {0}  timeout={1}s per window" -f $path, $TimeoutSeconds)

    if ($Once) {
        $windows = [WindowEnum]::VisibleWindows()
        Write-Host ("[uia] visible windows: {0}" -f $windows.Count)
        foreach ($w in $windows) { Invoke-UiaProbe $w }
    }
    else {
        $deadline = (Get-Date).AddMinutes($Minutes)
        while ((Get-Date) -lt $deadline) {
            $windows = [WindowEnum]::VisibleWindows()
            $fgHwnd = [WindowEnum]::ForegroundHwnd()
            # 只测前台窗口：连续采样时关心的就是「用户此刻在看什么」
            foreach ($json in $windows) {
                $window = ConvertFrom-Json $json
                if ([long]$window.hwnd -eq $fgHwnd) {
                    Invoke-UiaProbe $json
                    break
                }
            }
            Start-Sleep -Milliseconds 1500
        }
    }
}
finally {
    $writer.Flush()
    $writer.Dispose()
}

$avgChars = if ($okCount -gt 0) { [int]($totalChars / $okCount) } else { 0 }
Write-Host ("[uia] done: probes={0} ok={1} failed={2} timeout={3} avgChars={4}" -f $probes, $okCount, $failures, $timeouts, $avgChars)
Write-Host ("[uia] analyze: npm run chain-probe -- --uia {0}" -f $path)
