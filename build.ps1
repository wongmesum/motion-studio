# PowerShell script untuk membungkus Motion Studio menjadi ZIP di Windows
$ErrorActionPreference = "Stop"
Write-Host "📦 Building motion-studio.zip..." -ForegroundColor Cyan

$ZipPath = Join-Path $PSScriptRoot "motion-studio.zip"
if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}

$ExcludeDirs = @(".git", "node_modules", "frames", "cache")
$Files = Get-ChildItem -Path $PSScriptRoot -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($PSScriptRoot.Length + 1)
    $parts = $rel -split '[\\/]'
    $skip = $false
    foreach ($p in $parts) {
        if ($ExcludeDirs -contains $p) { $skip = $true; break }
    }
    (-not $skip) -and ($_.Name -ne "motion-studio.zip")
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($File in $Files) {
        $RelPath = $File.FullName.Substring($PSScriptRoot.Length + 1) -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, $File.FullName, $RelPath) | Out-Null
    }
} finally {
    $Archive.Dispose()
}

$SizeKB = [math]::Round((Get-Item $ZipPath).Length / 1KB, 1)
Write-Host "✅ Done: motion-studio.zip ($SizeKB KB)" -ForegroundColor Green
