@echo off
setlocal EnableExtensions

pushd "%~dp0" || exit /b 1

set "PUBLISH_RELEASE="
if /I "%~1"=="--publish" set "PUBLISH_RELEASE=1"
if /I "%~1"=="--help" goto :help
if not "%~1"=="" if not defined PUBLISH_RELEASE goto :usage_error
if not "%~2"=="" goto :usage_error
if defined PUBLISH_RELEASE (
  node scripts\publish-release.mjs --check || goto :fail
)

set "ROOT_DIR=%CD%"
if not defined UPDATE_NOTES_FILE set "UPDATE_NOTES_FILE=%ROOT_DIR%\RELEASE_NOTES.md"
set "ARTIFACTS_DIR=%ROOT_DIR%\artifacts"
set "BUNDLE_DIR=%ROOT_DIR%\src-tauri\target\release\bundle"
set "RELEASE_EXE=%ROOT_DIR%\src-tauri\target\release\slopus.exe"

rem Keep the private signing key outside the repository. CI can supply its own
rem TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD instead.
if not defined TAURI_SIGNING_PRIVATE_KEY if exist "%USERPROFILE%\.tauri\slopus-updater.key" set "TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\slopus-updater.key"
if not defined TAURI_SIGNING_PRIVATE_KEY (
  echo ERROR: Set TAURI_SIGNING_PRIVATE_KEY before building a signed release.
  echo        See docs/updater.md for signing key setup.
  goto :fail
)
node scripts\updater-manifest.mjs --check || goto :fail

set "SLOPFAB_DIR=%ROOT_DIR%\lib\slopfab"

where.exe npm.cmd >nul 2>nul || (
  echo ERROR: npm was not found on PATH.
  goto :fail
)

where.exe powershell.exe >nul 2>nul || (
  echo ERROR: Windows PowerShell was not found on PATH.
  goto :fail
)

set "CARGO_EXE="
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "CARGO_EXE=%USERPROFILE%\.cargo\bin\cargo.exe"
if not defined CARGO_EXE for /f "delims=" %%I in ('where.exe cargo.exe 2^>nul') do if not defined CARGO_EXE set "CARGO_EXE=%%I"
if not defined CARGO_EXE (
  echo ERROR: cargo.exe was not found. Install the Rust toolchain first.
  goto :fail
)
rem The Tauri CLI shells out to cargo, so it has to be reachable by name.
for %%I in ("%CARGO_EXE%") do set "PATH=%%~dpI;%PATH%"

rem npm ci deletes node_modules before reinstalling it, and Windows refuses to
rem unlink a file that a live process holds open. A forgotten `npm run dev`
rem therefore fails the install *after* the delete, leaving the tree gutted and
rem the repo unbuildable, behind an opaque EPERM -4048. Catch it while the tree
rem is still intact and name the process, rather than destroying it first.
echo Checking for processes holding node_modules...
powershell.exe -NoProfile -NonInteractive -Command "$stale=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -like ('*' + $env:ROOT_DIR + '*') }); if ($stale) { Write-Host ''; Write-Host 'ERROR: a node process is running out of this project and is holding files in'; Write-Host '       node_modules open. npm ci would delete node_modules and then fail,'; Write-Host '       leaving it incomplete. Stop these first:'; Write-Host ''; $stale | ForEach-Object { Write-Host ('         taskkill /F /PID ' + $_.ProcessId + '    (' + $_.CommandLine + ')') }; Write-Host ''; exit 1 }; exit 0"
if errorlevel 1 goto :fail

set "APP_VERSION="
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; (Get-Content -LiteralPath '%ROOT_DIR%\package.json' -Raw | ConvertFrom-Json).version"`) do set "APP_VERSION=%%V"
if not defined APP_VERSION (
  echo ERROR: Could not read the application version from package.json.
  goto :fail
)

set "PACKAGE_ARCH=%PROCESSOR_ARCHITECTURE%"
if /I "%PACKAGE_ARCH%"=="AMD64" set "PACKAGE_ARCH=x64"
if /I "%PACKAGE_ARCH%"=="ARM64" set "PACKAGE_ARCH=arm64"
if /I "%PACKAGE_ARCH%"=="x86" set "PACKAGE_ARCH=x86"
set "OUTPUT_STEM=Slopus-%APP_VERSION%-windows-%PACKAGE_ARCH%"
set "OUTPUT_SETUP=%ARTIFACTS_DIR%\%OUTPUT_STEM%-setup.exe"
set "OUTPUT_MSI=%ARTIFACTS_DIR%\%OUTPUT_STEM%.msi"
set "OUTPUT_ZIP=%ARTIFACTS_DIR%\%OUTPUT_STEM%-portable.zip"
rem The portable layout is staged straight into the folder the zip is named
rem after, and kept there afterwards so the build is runnable without unpacking.
set "OUTPUT_DIR=%ARTIFACTS_DIR%\%OUTPUT_STEM%-portable"

echo.
echo [1/5] Installing locked frontend dependencies...
call npm ci || goto :fail

rem `npm run tauri build` - NOT `cargo build --release`. Plain cargo compiles the
rem binary but never runs the Tauri CLI, so the app keeps its dev configuration:
rem it points the webview at the dev server on localhost:1420 instead of the
rem built frontend. The result launches to ERR_CONNECTION_REFUSED on any machine
rem without a dev server running. The CLI runs the frontend build, embeds dist/
rem into the binary, and produces the installers.
echo.
echo [2/5] Building the release application and installers...
rem Use the supplied password or an empty one without an interactive prompt.
call npm run tauri build -- --ci || goto :fail

if not exist "%RELEASE_EXE%" (
  echo ERROR: Build succeeded but the executable was not found at:
  echo        %RELEASE_EXE%
  goto :fail
)

rem Guard against silently shipping the dev-mode binary again: a production
rem build embeds the hashed frontend assets, a dev-mode one does not.
echo.
echo [3/5] Verifying the frontend is embedded...
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $asset=(Get-ChildItem -LiteralPath (Join-Path $env:ROOT_DIR 'dist\assets') -Filter '*.js' | Select-Object -First 1).BaseName; if (-not $asset) { Write-Host 'ERROR: no built frontend found in dist/assets.'; exit 1 }; $bytes=[IO.File]::ReadAllBytes($env:RELEASE_EXE); $text=[Text.Encoding]::ASCII.GetString($bytes); if ($text.Contains($asset)) { Write-Host ('       OK - ' + $asset + ' is embedded in the executable.'); exit 0 }; Write-Host ''; Write-Host 'ERROR: the executable does not contain the built frontend. It would launch'; Write-Host '       to ERR_CONNECTION_REFUSED. This happens when the binary is built with'; Write-Host '       cargo directly instead of through the Tauri CLI.'; exit 1"
if errorlevel 1 goto :fail

echo.
echo [4/5] Collecting artifacts...
if not exist "%ARTIFACTS_DIR%" mkdir "%ARTIFACTS_DIR%"

rem Pick the newest bundle of each kind rather than hard-coding Tauri's file
rem naming, which includes the product name and locale and has changed before.
set "NSIS_SRC="
if exist "%BUNDLE_DIR%\nsis" for /f "delims=" %%F in ('dir /b /a-d /o-d "%BUNDLE_DIR%\nsis\*.exe" 2^>nul') do if not defined NSIS_SRC set "NSIS_SRC=%BUNDLE_DIR%\nsis\%%F"
set "MSI_SRC="
if exist "%BUNDLE_DIR%\msi" for /f "delims=" %%F in ('dir /b /a-d /o-d "%BUNDLE_DIR%\msi\*.msi" 2^>nul') do if not defined MSI_SRC set "MSI_SRC=%BUNDLE_DIR%\msi\%%F"

if not defined NSIS_SRC (
  echo ERROR: no NSIS installer was produced under %BUNDLE_DIR%\nsis.
  goto :fail
)
copy /Y "%NSIS_SRC%" "%OUTPUT_SETUP%" >nul || goto :fail
copy /Y "%NSIS_SRC%.sig" "%OUTPUT_SETUP%.sig" >nul || goto :fail
echo        Installer: %OUTPUT_STEM%-setup.exe

if defined MSI_SRC (
  copy /Y "%MSI_SRC%" "%OUTPUT_MSI%" >nul || goto :fail
  copy /Y "%MSI_SRC%.sig" "%OUTPUT_MSI%.sig" >nul || goto :fail
  echo        MSI:       %OUTPUT_STEM%.msi
) else (
  echo        MSI:       not produced - skipping.
)

node scripts\updater-manifest.mjs || goto :fail

rem Portable layout: the executable plus the generation runtime beside it. The
rem previous folder is removed first so it never mixes two builds.
if exist "%OUTPUT_DIR%" rd /s /q "%OUTPUT_DIR%"
if exist "%OUTPUT_DIR%" (
  echo ERROR: could not clear %OUTPUT_DIR%.
  echo        Close anything running out of that folder and retry.
  goto :fail
)
mkdir "%OUTPUT_DIR%" || goto :fail
copy /Y "%RELEASE_EXE%" "%OUTPUT_DIR%\Slopus.exe" >nul || goto :fail

rem Match the installer's resource layout: one DLL beside Slopus.exe.
copy /Y "%SLOPFAB_DIR%\slopfab.dll" "%OUTPUT_DIR%\slopfab.dll" >nul || goto :fail
echo        Runtime:   slopfab.dll included.

call :write_readme "%OUTPUT_DIR%\README.txt"
echo        Folder:    %OUTPUT_STEM%-portable\

echo.
echo [5/5] Creating the portable archive...
rem Archive without the marker so distributed copies can check for updates.
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; Compress-Archive -Path (Join-Path $env:OUTPUT_DIR '*') -DestinationPath $env:OUTPUT_ZIP -CompressionLevel Optimal -Force" || goto :fail
rem Disable updates only in the unpacked folder used for local testing.
> "%OUTPUT_DIR%\slopus-portable" echo Local test build - automatic updates disabled.
if errorlevel 1 goto :fail

echo.
echo Package complete.
echo   %OUTPUT_SETUP%
echo   %OUTPUT_SETUP%.sig
echo   %ARTIFACTS_DIR%\latest.json
if defined MSI_SRC echo   %OUTPUT_MSI%
echo   %OUTPUT_ZIP%
echo   %OUTPUT_DIR%\
echo.
echo The unpacked folder beside the zip is this build - run it straight from
echo there. It is rebuilt from scratch on every package run.
echo.
echo Install with the setup executable - it installs the WebView2 runtime if the
echo machine does not already have it. The portable archive assumes WebView2 is
echo already present.
echo.
if defined PUBLISH_RELEASE (
  node scripts\publish-release.mjs --publish || goto :fail
)
popd
exit /b 0

:help
echo Usage: release.cmd [--publish]
echo   Build signed installers, updater manifest and portable ZIP.
echo   --publish uploads a draft to GitHub, then publishes it as latest.
echo   Requires gh auth login and a pushed version tag matching this commit.
popd
exit /b 0

:usage_error
echo Usage: release.cmd [--publish]
popd
exit /b 1

:write_readme
> "%~1" echo Slopus %APP_VERSION% ^(windows-%PACKAGE_ARCH%, portable^)
>>"%~1" echo.
>>"%~1" echo Run "Slopus.exe". Projects are folders you choose on disk.
>>"%~1" echo.
>>"%~1" echo REQUIREMENTS
>>"%~1" echo   Microsoft Edge WebView2. Use the setup installer if it is missing.
>>"%~1" echo.
>>"%~1" echo VIDEO GENERATION
>>"%~1" echo   The runtime is included. Keep slopfab.dll beside Slopus.exe. Download generator weights in Settings.
>>"%~1" echo   Model weights are not included. Set their paths in Settings.
exit /b 0

:fail
set "PACKAGE_EXIT_CODE=%ERRORLEVEL%"
if "%PACKAGE_EXIT_CODE%"=="0" set "PACKAGE_EXIT_CODE=1"
echo.
echo Packaging failed with exit code %PACKAGE_EXIT_CODE%.
popd
exit /b %PACKAGE_EXIT_CODE%
