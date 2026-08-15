# Generates app icons for the Tauri build (PNG set + multi-size ICO).
Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    # Rounded dark background
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [int]($size * 0.22)
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 38, 46, 66),
        [System.Drawing.Color]::FromArgb(255, 13, 17, 26),
        45)
    $g.FillPath($brush, $path)

    # Harness network motif: 4 nodes connected by lines
    $cx = $size * 0.5
    $cy = $size * 0.5
    $u = $size / 100.0
    $pts = @(
        @($cx, ($cy - 26 * $u)),
        @(($cx - 26 * $u), ($cy + 16 * $u)),
        @(($cx + 26 * $u), ($cy + 16 * $u)),
        @($cx, ($cy + 8 * $u))
    )
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 56, 189, 248), [math]::Max(1.5, $u * 3))
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($pen, [single]$pts[0][0], [single]$pts[0][1], [single]$pts[1][0], [single]$pts[1][1])
    $g.DrawLine($pen, [single]$pts[0][0], [single]$pts[0][1], [single]$pts[2][0], [single]$pts[2][1])
    $g.DrawLine($pen, [single]$pts[1][0], [single]$pts[1][1], [single]$pts[3][0], [single]$pts[3][1])
    $g.DrawLine($pen, [single]$pts[2][0], [single]$pts[2][1], [single]$pts[3][0], [single]$pts[3][1])

    $nodeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 56, 189, 248))
    foreach ($p in $pts) {
        $rad = [math]::Max(2.5, $u * 4.5)
        $g.FillEllipse($nodeBrush, [single]($p[0] - $rad), [single]($p[1] - $rad), [single]($rad * 2), [single]($rad * 2))
    }
    # Center accent dot
    $dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 167, 139, 250))
    $g.FillEllipse($dot, [single]($pts[3][0] - 3 * $u), [single]($pts[3][1] - 3 * $u), [single](6 * $u), [single](6 * $u))

    $g.Dispose()
    return $bmp
}

$dir = Join-Path $PSScriptRoot '..\src-tauri\icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

foreach ($spec in @(
    @('icon.png', 512),
    @('128x128.png', 128),
    @('128x128@2x.png', 256),
    @('32x32.png', 32)
)) {
    $bmp = New-IconBitmap $spec[1]
    $bmp.Save((Join-Path $dir $spec[0]), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $($spec[0])"
}

# Multi-size ICO (PNG-in-ICO, Vista+)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , @($s, $ms.ToArray())
    $bmp.Dispose()
    $ms.Dispose()
}
$ico = Join-Path $dir 'icon.ico'
$fs = [System.IO.File]::Create($ico)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
    $w = if ($p[0] -ge 256) { 0 } else { $p[0] }
    $bw.Write([byte]$w)
    $bw.Write([byte]$w)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$p[1].Length)
    $bw.Write([uint32]$offset)
    $offset += $p[1].Length
}
foreach ($p in $pngs) { $bw.Write($p[1]) }
$bw.Flush()
$fs.Close()
Write-Host "wrote icon.ico ($((Get-Item $ico).Length) bytes)"
Get-ChildItem $dir | Select-Object Name, Length
