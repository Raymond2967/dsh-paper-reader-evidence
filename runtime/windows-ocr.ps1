param([Parameter(Mandatory)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
        $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Receive-WinRt($Operation, [Type]$ResultType) {
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$bytes = [IO.File]::ReadAllBytes($ImagePath)
$memory = [IO.MemoryStream]::new($bytes)
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
$decoder = Receive-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Receive-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if ($null -eq $engine) { throw 'Windows OCR requires the Simplified Chinese language pack.' }
$result = Receive-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @(
    foreach ($line in $result.Lines) {
        $words = @($line.Words | ForEach-Object {
            $r = $_.BoundingRect
            [ordered]@{ text = $_.Text; box = @($r.X, $r.Y, ($r.X + $r.Width), ($r.Y + $r.Height)) }
        })
        [ordered]@{ text = $line.Text; words = $words }
    }
)
ConvertTo-Json -InputObject $lines -Depth 8 -Compress
