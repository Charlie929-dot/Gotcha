# 信息链探针 · UIA 单窗口测量（子进程，由 uia-probe.ps1 拉起）
#
# 只回统计：元素数 / 有名字的元素数 / 名字总字符数 / 密码控件数 / 耗时。
# 不落任何 UI 文本——覆盖率先看「有没有、有多少」，质量另说。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File uia-window.ps1 -Hwnd 123456

param(
    [long]$Hwnd = 0,
    [int]$MaxElements = 4000
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$result) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
}

if ($Hwnd -eq 0) {
    Write-Result @{ ok = $false; error = 'no hwnd'; ms = 0 }
    exit 1
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $cache = New-Object System.Windows.Automation.CacheRequest
    [void]$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
    [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsPasswordProperty)
    [void]$cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)

    $cache.Push()
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
        if ($null -eq $root) { throw 'FromHandle returned null' }

        $all = $root.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        $count = $all.Count
        $limit = [Math]::Min($count, $MaxElements)
        $chars = 0
        $withName = 0
        $password = 0
        $longest = 0
        for ($i = 0; $i -lt $limit; $i++) {
            $info = $all.Item($i).Cached
            $name = $info.Name
            if ($info.IsPassword) { $password++ }
            if (-not [string]::IsNullOrWhiteSpace($name)) {
                $withName++
                $chars += $name.Length
                if ($name.Length -gt $longest) { $longest = $name.Length }
            }
        }
    }
    finally {
        $cache.Pop()
    }

    $sw.Stop()
    Write-Result @{
        ok        = $true
        elements  = $count
        scanned   = $limit
        truncated = ($count -gt $limit)
        withName  = $withName
        chars     = $chars
        longest   = $longest
        password  = $password
        ms        = [int]$sw.ElapsedMilliseconds
    }
}
catch {
    $sw.Stop()
    Write-Result @{ ok = $false; error = $_.Exception.Message; ms = [int]$sw.ElapsedMilliseconds }
    exit 2
}
