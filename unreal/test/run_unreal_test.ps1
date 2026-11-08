# PhonePad in a real Unreal game, end to end, with no window and no phone. It builds the test game (unreal/PhonePadTest, with the
# plugin linked into its Plugins folder) and points it at your relay. Then it starts two scripted phones
# (relay/test/unreal_phones.mjs), runs the game off-screen, and holds the game's log to the script (relay/test/check_unreal_log.mjs).
#   pwsh -File unreal/test/run_unreal_test.ps1 -Relay https://<your relay> -Engine "C:\Program Files\Epic Games\UE_5.7"
#        [-SdksRoot <AutoSDK folder, if the machine has no installed Windows SDK>] [-NoBuild] [-QuitAfter 45]
# Needs: Node 22+, `npm install` in relay/, Unreal 5.7. Run it from native PowerShell.
param(
    [Parameter(Mandatory = $true)][string]$Relay,
    [Parameter(Mandatory = $true)][string]$Engine,
    [string]$SdksRoot = "",
    [switch]$NoBuild,
    [int]$QuitAfter = 45
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$project = Join-Path $root "unreal\PhonePadTest"
$uproject = Join-Path $project "PhonePadTest.uproject"
$exe = Join-Path $Engine "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
if (-not (Test-Path $exe)) { throw "No UnrealEditor-Cmd.exe under $Engine" }
$runDir = Join-Path $root "unreal\test\runs\$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Force $runDir | Out-Null
$log = Join-Path $runDir "game.log"; $sent = Join-Path $runDir "sent.json"

# the test game uses the plugin from this repo, through a junction (not in git)
$link = Join-Path $project "Plugins\PhonePad"
if (-not (Test-Path $link)) { New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null; New-Item -ItemType Junction -Path $link -Target (Join-Path $root "unreal\PhonePad") | Out-Null }
# the plugin's relay, quoted: unquoted, Unreal's config reader takes the // for a comment and leaves "https:"
$ini = Join-Path $project "Config\DefaultGame.ini"
$iniBefore = Get-Content $ini -Raw                # put back at the end: the repo's copy names no relay
(Get-Content $ini) -replace '^RelayUrl=.*$', "RelayUrl=""$Relay""" | Set-Content $ini -Encoding utf8

if (-not $NoBuild) {
    if ($SdksRoot) { $env:UE_SDKS_ROOT = $SdksRoot }
    & (Join-Path $Engine "Engine\Build\BatchFiles\Build.bat") PhonePadTestEditor Win64 Development "-Project=$uproject" -WaitMutex -NoHotReload | Out-File (Join-Path $runDir "build.log")
    if ($LASTEXITCODE -ne 0) { "BUILD FAILED: $runDir\build.log"; exit 1 }
}

$phones = Start-Process node -ArgumentList @((Join-Path $root "relay\test\unreal_phones.mjs"), $log, $Relay, $sent) -WorkingDirectory (Join-Path $root "relay") `
    -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $runDir "phones.out") -RedirectStandardError (Join-Path $runDir "phones.err")
# off-screen (-RenderOffScreen: no window), no dialogs (-unattended), its own log, no sound to the speakers (-DeterministicAudio)
$game = Start-Process $exe -PassThru -NoNewWindow -ArgumentList @($uproject, "/Engine/Maps/Entry", "-game", "-RenderOffScreen", "-unattended",
    "-nosplash", "-DeterministicAudio", "-ResX=1280", "-ResY=720", "-ForceRes", "-ABSLOG=$log", "-PhonePadTestQuitAfter=$QuitAfter")
if (-not $game.WaitForExit(($QuitAfter + 180) * 1000)) { $game.Kill(); "the game ran past its time and was stopped" }
"game: exit=$($game.ExitCode)"
if (-not $phones.WaitForExit(30000)) { $phones.Kill(); "the phone script did not finish" }
Get-Content (Join-Path $runDir "phones.out"), (Join-Path $runDir "phones.err") -ErrorAction SilentlyContinue
Push-Location (Join-Path $root "relay"); node test/check_unreal_log.mjs $log; $code = $LASTEXITCODE; Pop-Location
Set-Content $ini $iniBefore -NoNewline -Encoding utf8
"run folder: $runDir"
exit $code
