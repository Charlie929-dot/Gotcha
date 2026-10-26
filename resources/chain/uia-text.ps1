param()

# 信息链 · UIA 文本长驻服务（契约 §2.4 / D43）
# 协议（与 resources/ocr/winrt-ocr.ps1 同构，行式 JSON）：
#   启动输出 {"ready":true}
#   请求  {"id":1,"hwnd":123456,"maxElements":4000,"maxChars":100000}
#   成功  {"id":1,"ok":true,"ms":823,"text":"..","chars":1234,"elements":97,"scanned":97,"truncated":false,"password":0}
#   失败  {"id":1,"ok":false,"ms":12,"error":".."}
# 只回文本与统计，不落盘、不写日志；stderr 留给调用方丢弃。
# 纪律：密码控件（IsPassword）一律不取文本；元素数 / 字符数都有上限，超了标 truncated。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

[Console]::Out.WriteLine('{"ready":true}')

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $hwnd = [long]$req.hwnd
        if ($hwnd -eq 0) { throw 'no hwnd' }
        $maxElements = if ($null -ne $req.maxElements) { [int]$req.maxElements } else { 4000 }
        $maxChars = if ($null -ne $req.maxChars) { [int]$req.maxChars } else { 100000 }

        $cache = New-Object System.Windows.Automation.CacheRequest
        [void]$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
        [void]$cache.Add([System.Windows.Automation.AutomationElement]::IsPasswordProperty)
        [void]$cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)

        $parts = New-Object System.Collections.Generic.List[string]
        $password = 0
        $truncated = $false
        $count = 0
        $chars = 0

        $cache.Push()
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
            if ($null -eq $root) { throw 'FromHandle returned null' }
            $all = $root.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            $count = $all.Count
            $limit = [Math]::Min($count, $maxElements)
            if ($count -gt $limit) { $truncated = $true }

            for ($i = 0; $i -lt $limit; $i++) {
                $el = $all.Item($i)
                $info = $el.Cached
                # 密码控件的名字与值都不取（契约 D43）
                if ($info.IsPassword) {
                    $password++
                    continue
                }
                $value = $null
                $name = $info.Name
                if (-not [string]::IsNullOrWhiteSpace($name)) { $value = $name }
                # 输入框的正文在 ValuePattern 里，Name 往往为空；只对 Edit 取，避免每个元素都多一次 RPC
                if ($info.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
                    try {
                        $pattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                        $current = $pattern.Current.Value
                        if (-not [string]::IsNullOrWhiteSpace($current) -and $current -ne $name) {
                            if ([string]::IsNullOrWhiteSpace($value)) { $value = $current }
                            else { $value = $value + "`n" + $current }
                        }
                    }
                    catch {
                        # 元素在读取期间失效（页面重绘 / 控件重建）就跳过它，不整次失败
                    }
                }
                if ($null -eq $value) { continue }
                if (($chars + $value.Length) -gt $maxChars) {
                    $room = [Math]::Max(0, $maxChars - $chars)
                    if ($room -gt 0) { $parts.Add($value.Substring(0, $room)) }
                    $chars = $maxChars
                    $truncated = $true
                    break
                }
                $parts.Add($value)
                $chars += $value.Length
            }
        }
        finally {
            $cache.Pop()
        }

        $text = $parts -join "`n"
        $sw.Stop()
        $resp = [ordered]@{
            id        = $id
            ok        = $true
            ms        = [int]$sw.ElapsedMilliseconds
            text      = $text
            chars     = $text.Length
            elements  = $count
            scanned   = [Math]::Min($count, $maxElements)
            truncated = $truncated
            password  = $password
        }
    }
    catch {
        $sw.Stop()
        $resp = [ordered]@{
            id    = $id
            ok    = $false
            ms    = [int]$sw.ElapsedMilliseconds
            error = $_.Exception.Message
        }
    }
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))
}
