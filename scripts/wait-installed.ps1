# YASA PRESENTS
# wait-installed.ps1: install ANI-MATE silently and wait until it has really finished.
#
#     .\scripts\wait-installed.ps1 -Installer .\ANI-MATE-Setup-0.7.2.exe -Version 0.7.2
#
# The installer's first process hands the work to another and exits, so waiting for it
# says nothing: on 2026-11-14 the step after it looked for the app four seconds too early
# and found none. And twice the same day the installer of the release that was being
# upgraded FROM started on CI's machine and installed nothing at all. So this waits for
# what matters (the installed program is there, it is the version asked for, no installer
# or uninstaller is still running, and that has held for a few seconds), says what the
# installer's exit code was when it does not get there, and tries up to three times.
# Used by .github/workflows/smoke.yml.
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Version
)

function Find-Installed { Get-ChildItem "$env:LOCALAPPDATA\Programs\*\ANI-MATE.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Find-Busy { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'setup|^Un_|^Au_|nsis' } }

Write-Host "installer: $Installer ($((Get-Item $Installer).Length) bytes)"
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
    $deadline = (Get-Date).AddSeconds(150)
    $steady = 0
    while ((Get-Date) -lt $deadline) {
        $exe = Find-Installed
        if ($exe -and -not (Find-Busy) -and ($exe.VersionInfo.ProductVersion -like "$Version*")) { $steady++ } else { $steady = 0 }
        if ($steady -ge 3) {
            # A silent install does not start the app, but if one is up it would get in the way.
            Get-Process 'ANI-MATE' -ErrorAction SilentlyContinue | Stop-Process -Force
            Write-Host "installed on attempt ${attempt}: $($exe.FullName), version $($exe.VersionInfo.ProductVersion)"
            Get-ChildItem "$env:LOCALAPPDATA\Programs" | Select-Object -ExpandProperty FullName
            exit 0
        }
        Start-Sleep -Seconds 2
    }
    $code = if ($p.HasExited) { $p.ExitCode } else { 'still running' }
    $found = Find-Installed
    Write-Host "attempt ${attempt}: ANI-MATE $Version was not installed after 150 seconds. Installer exit code: $code. Installed now: $(if ($found) { $found.VersionInfo.ProductVersion } else { 'nothing' })"
    Find-Busy | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 5
}
Write-Host "ANI-MATE $Version could not be installed in three attempts."
exit 1
