<#
  Build the release zips.

  This exists because the packaging steps are easy to get wrong in ways nothing catches
  until a user reports it:

    - the version lives in six places and they drift (README badge, README headline,
      index.js CONFIG.VERSION, docs/ARCHITECTURE.md, docs/VENCORD-PLUGIN.md,
      the devbuild installer README)
    - the Tier 1 bundle MUST be built --standalone --disable-updater. A plain build drops a
      git-updater dist into the non-git %APPDATA%\Vencord and Vencord errors on every launch
      (issue #39); --standalone alone is worse, its HTTP updater silently reverts the dist to
      vanilla and deletes the plugin. Only both flags together are safe for a copy-in-place
      install, and the only way to tell is the banner at the top of dist/patcher.js.
    - the devbuild installer ships a copy of the plugin sources, which moved to the repo root
      in v4.9.7 so UserpluginInstaller can clone the repo directly (#42)

  Run from anywhere. Does not build Vencord: point -BundleDist at a dist/ you already built
  with `pnpm build --standalone --disable-updater`, or skip the bundle with -SkipBundle.
#>
[CmdletBinding()]
param(
    [string] $BundleDist,
    [switch] $SkipBundle
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Repo 'tools'

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Good($m) { Write-Host "  $m" -ForegroundColor Green }
function Die($m) { Write-Host ""; Write-Host "  ERROR: $m" -ForegroundColor Red; exit 1 }

# ---- 1. version, and every place that has to agree with it -----------------------
$indexJs = Join-Path $Repo 'index.js'
$m = [regex]::Match((Get-Content $indexJs -Raw), 'VERSION:\s*"(v[0-9]+\.[0-9]+\.[0-9]+)"')
if (-not $m.Success) { Die "couldn't read CONFIG.VERSION out of index.js" }
$Version = $m.Groups[1].Value
Info "Version from index.js: $Version"

$checks = @(
    # The README carries the version in its badge only. It used to repeat it in the headline
    # too, until that line went with the rewrite that pulled the marketing voice out.
    @{ File = 'README.md';                              Pattern = "badge/$Version-5865F2" }
    @{ File = 'docs/VENCORD-PLUGIN.md';                 Pattern = "in sync with userscript $Version" }
    @{ File = 'docs/ARCHITECTURE.md';                   Pattern = "Last reviewed against .index\.js. \*\*$Version\*\*" }
    @{ File = 'tools/orion-devbuild-installer/README.txt'; Pattern = "Version: $Version" }
)
$drift = @()
foreach ($c in $checks) {
    $p = Join-Path $Repo $c.File
    if (-not (Test-Path $p)) { $drift += "$($c.File) is missing"; continue }
    if (-not (Select-String -Path $p -Pattern $c.Pattern -Quiet)) { $drift += "$($c.File) does not mention $Version" }
}
if ($drift) { $drift | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }; Die "version drift, fix these before packaging" }
Good "all version references agree"

# ---- 2. stage the plugin sources into the devbuild installer ---------------------
# They live at the repo ROOT (not vencord-plugin/) since v4.9.7 so UserpluginInstaller
# can clone the repo straight into src/userplugins. The installer scripts copy this
# staged folder into <clone>/src/userplugins/orionQuests.
Info "Staging plugin sources for the devbuild installer..."
$stage = Join-Path $Tools 'orion-devbuild-installer\plugin'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$entry = Join-Path $Repo 'index.tsx'
if (-not (Test-Path $entry)) { Die "index.tsx not found at the repo root. Did the plugin sources move again?" }
Get-ChildItem $Repo -File | Where-Object { $_.Extension -in '.ts', '.tsx' } | ForEach-Object {
    Copy-Item $_.FullName $stage
}
Copy-Item (Join-Path $Repo 'docs\VENCORD-PLUGIN.md') (Join-Path $stage 'README.md')
$staged = (Get-ChildItem $stage -File).Count
if ($staged -lt 9) { Die "only $staged plugin files staged, expected the full set" }
Good "$staged files staged"

# ---- 3. the Tier 1 bundle must be a standalone, updater-disabled build -----------
if (-not $SkipBundle) {
    $bundleDir = Join-Path $Tools 'orion-vencord-bundle'
    $dist = Join-Path $bundleDir 'dist'
    if ($BundleDist) {
        Info "Refreshing the bundle dist from $BundleDist ..."
        if (-not (Test-Path (Join-Path $BundleDist 'patcher.js'))) { Die "$BundleDist has no patcher.js" }
        if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $dist | Out-Null
        Get-ChildItem $BundleDist -File | Where-Object { $_.Name -notlike '*.map' } | ForEach-Object { Copy-Item $_.FullName $dist }
    }
    if (-not (Test-Path (Join-Path $dist 'patcher.js'))) { Die "no bundle dist. Build it with 'pnpm build --standalone --disable-updater' and pass -BundleDist <clone>\dist" }

    # the banner is a few `//` lines and the order isn't fixed (Standalone, Platform,
    # Updater Disabled), so read past all of them rather than assuming a line count
    $banner = (Get-Content (Join-Path $dist 'patcher.js') -TotalCount 10) -join "`n"
    if ($banner -notmatch 'Standalone:\s*true')      { Die "bundle dist is NOT a --standalone build. It would break Vencord's updater (#39)." }
    if ($banner -notmatch 'Updater Disabled:\s*true'){ Die "bundle dist is NOT --disable-updater. Its HTTP updater would revert the dist to vanilla and delete the plugin (#39)." }
    if (-not (Select-String -Path (Join-Path $dist 'renderer.js') -Pattern 'OrionQuests' -SimpleMatch -Quiet)) { Die "the plugin is not in the bundle dist" }
    Good "bundle dist is standalone + updater-disabled and contains the plugin"
}

# ---- 4. zip ---------------------------------------------------------------------
$targets = @('orion-vencord-bundle', 'orion-relay', 'orion-devbuild-installer')
if ($SkipBundle) { $targets = $targets | Where-Object { $_ -ne 'orion-vencord-bundle' } }

Info "Building zips..."
$results = foreach ($n in $targets) {
    $zip = Join-Path $Tools "$n-$Version.zip"
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $Tools "$n\*") -DestinationPath $zip -CompressionLevel Optimal
    [pscustomobject]@{ Name = Split-Path $zip -Leaf; Bytes = (Get-Item $zip).Length; SHA256 = (Get-FileHash $zip -Algorithm SHA256).Hash }
}
$results += [pscustomobject]@{ Name = 'index.js'; Bytes = (Get-Item $indexJs).Length; SHA256 = (Get-FileHash $indexJs -Algorithm SHA256).Hash }

Write-Host ""
$results | Format-Table -AutoSize
Write-Host "Release assets for $Version are ready in tools\." -ForegroundColor Green
