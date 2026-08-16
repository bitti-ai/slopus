@echo off
setlocal EnableExtensions

pushd "%~dp0" || exit /b 1

set "ROOT_DIR=%CD%"
set "ARTIFACTS_DIR=%ROOT_DIR%\artifacts"
set "RELEASE_EXE=%ROOT_DIR%\src-tauri\target\release\pol-studio.exe"

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
set "OUTPUT_STEM=Pol-Studio-%APP_VERSION%-windows-%PACKAGE_ARCH%"
set "OUTPUT_EXE=%ARTIFACTS_DIR%\%OUTPUT_STEM%.exe"
set "OUTPUT_ZIP=%ARTIFACTS_DIR%\%OUTPUT_STEM%.zip"

echo.
echo [1/4] Installing locked frontend dependencies...
call npm ci || goto :fail

echo.
echo [2/4] Building the production frontend...
call npm run build || goto :fail

echo.
echo [3/4] Building the release executable...
"%CARGO_EXE%" build --release --locked --manifest-path "%ROOT_DIR%\src-tauri\Cargo.toml" || goto :fail

if not exist "%RELEASE_EXE%" (
  echo ERROR: Release build succeeded but the executable was not found at:
  echo        %RELEASE_EXE%
  goto :fail
)

if not exist "%ARTIFACTS_DIR%" mkdir "%ARTIFACTS_DIR%" || goto :fail
copy /Y "%RELEASE_EXE%" "%OUTPUT_EXE%" >nul || goto :fail

echo.
echo [4/4] Creating the ZIP archive...
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath '%OUTPUT_EXE%' -DestinationPath '%OUTPUT_ZIP%' -CompressionLevel Optimal -Force" || goto :fail

echo.
echo Package complete.
echo EXE: %OUTPUT_EXE%
echo ZIP: %OUTPUT_ZIP%
echo.
popd
exit /b 0

:fail
set "PACKAGE_EXIT_CODE=%ERRORLEVEL%"
if "%PACKAGE_EXIT_CODE%"=="0" set "PACKAGE_EXIT_CODE=1"
echo.
echo Packaging failed with exit code %PACKAGE_EXIT_CODE%.
popd
exit /b %PACKAGE_EXIT_CODE%
