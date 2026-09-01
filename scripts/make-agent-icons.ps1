# Builds the agent's two tray icons from the branding art.
#
# Two, because the tray has to answer "is it working" at a glance: the coloured
# one means the agent holds its session, the grey one means it does not. Both are
# multi-size so Windows can pick the right one for the tray, the taskbar and the
# Explorer tile, small sizes as uncompressed DIB and large ones as PNG, which is
# what keeps the pair under a hundred kilobytes.
#
#   powershell -ExecutionPolicy Bypass -File scripts/make-agent-icons.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "assets/branding/corin-app-icon-rune-v2.png"
$outputDirectory = Join-Path $root "agent/assets"
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

function Resize-Frame {
    param([System.Drawing.Image] $Image, [int] $Size, [bool] $Grey)

    $frame = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($frame)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $rectangle = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)

    if ($Grey) {
        # Luminance, then dimmed, so "not connected" reads as off rather than as broken.
        $matrix = New-Object System.Drawing.Imaging.ColorMatrix
        $matrix.Matrix00 = 0.26; $matrix.Matrix01 = 0.26; $matrix.Matrix02 = 0.26
        $matrix.Matrix10 = 0.50; $matrix.Matrix11 = 0.50; $matrix.Matrix12 = 0.50
        $matrix.Matrix20 = 0.10; $matrix.Matrix21 = 0.10; $matrix.Matrix22 = 0.10
        $matrix.Matrix33 = 0.85
        $attributes = New-Object System.Drawing.Imaging.ImageAttributes
        $attributes.SetColorMatrix($matrix)
        $graphics.DrawImage($Image, $rectangle, 0, 0, $Image.Width, $Image.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        $attributes.Dispose()
    } else {
        $graphics.DrawImage($Image, $rectangle)
    }

    $graphics.Dispose()
    return $frame
}

# A DIB frame: the 40 byte header, the pixels bottom up as BGRA, then an empty
# AND mask. The doubled height is what the ICO format expects for the two planes.
function Get-DibBytes {
    param([System.Drawing.Bitmap] $Frame)

    $size = $Frame.Width
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write([int]40); $writer.Write([int]$size); $writer.Write([int]($size * 2))
    $writer.Write([int16]1); $writer.Write([int16]32)
    $writer.Write([int]0); $writer.Write([int]($size * $size * 4))
    $writer.Write([int]0); $writer.Write([int]0); $writer.Write([int]0); $writer.Write([int]0)

    $bounds = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $data = $Frame.LockBits($bounds, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $row = New-Object byte[] ($size * 4)
    for ($y = $size - 1; $y -ge 0; $y--) {
        [System.Runtime.InteropServices.Marshal]::Copy([IntPtr]($data.Scan0.ToInt64() + $y * $data.Stride), $row, 0, $row.Length)
        $writer.Write($row)
    }
    $Frame.UnlockBits($data)

    $maskRow = New-Object byte[] ([Math]::Max(4, [Math]::Ceiling($size / 32) * 4))
    for ($y = 0; $y -lt $size; $y++) { $writer.Write($maskRow) }

    $writer.Flush()
    return ,$stream.ToArray()
}

function Get-PngBytes {
    param([System.Drawing.Bitmap] $Frame)
    $stream = New-Object System.IO.MemoryStream
    $Frame.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return ,$stream.ToArray()
}

function Write-Icon {
    param([System.Drawing.Image] $Image, [int[]] $Sizes, [bool] $Grey, [string] $Path)

    $frames = @()
    foreach ($size in $Sizes) {
        $frame = Resize-Frame -Image $Image -Size $size -Grey $Grey
        # PNG above 48 keeps a 256 pixel tile from costing a quarter of a megabyte.
        $bytes = if ($size -gt 48) { Get-PngBytes -Frame $frame } else { Get-DibBytes -Frame $frame }
        $frame.Dispose()
        $frames += , @{ Size = $size; Bytes = $bytes }
    }

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write([int16]0); $writer.Write([int16]1); $writer.Write([int16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
        $dimension = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([int16]1); $writer.Write([int16]32)
        $writer.Write([int]$frame.Bytes.Length); $writer.Write([int]$offset)
        $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
    $writer.Flush()

    [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
    $writer.Dispose()
    Write-Host ("{0}  {1} frames, {2:N0} bytes" -f (Split-Path -Leaf $Path), $frames.Count, (Get-Item $Path).Length)
}

$image = [System.Drawing.Image]::FromFile($source)
Write-Icon -Image $image -Sizes @(16, 20, 24, 32, 48, 64, 128, 256) -Grey $false -Path (Join-Path $outputDirectory "corin.ico")
Write-Icon -Image $image -Sizes @(16, 20, 24, 32, 48) -Grey $true -Path (Join-Path $outputDirectory "corin-idle.ico")
$image.Dispose()
