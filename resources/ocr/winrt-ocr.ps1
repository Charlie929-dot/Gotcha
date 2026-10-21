param()

# WinRT OCR 长驻服务（gotcha M1a Phase 2a 结论）
# 协议：启动输出 {"ready":true}；之后每行读 {"id":..,"path":"..."}，
#       输出 {"id":..,"ok":true,"ms":..,"text":".."} 或 {"id":..,"ok":false,"error":".."}
# 只做 OCR，不写日志、不回传图片；stderr 留给调用方丢弃。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) {
  [Console]::Error.WriteLine('no OCR engine available')
  exit 2
}

[Console]::Out.WriteLine('{"ready":true}')

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($req.path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $resp = [ordered]@{ id = $id; ok = $true; ms = $sw.ElapsedMilliseconds; text = $result.Text }
  } catch {
    $resp = [ordered]@{ id = $id; ok = $false; ms = $sw.ElapsedMilliseconds; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))
}
