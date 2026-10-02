@echo off
setlocal EnableExtensions

pushd "%~dp0" || exit /b 1

if /I "%~1"=="--help" goto :help
if not "%~1"=="" if /I not "%~1"=="--build-only" goto :usage_error
if not "%~2"=="" goto :usage_error

where.exe npm.cmd >nul 2>nul || (
  echo ERROR: npm was not found on PATH. Install Node.js first.
  goto :fail
)

rem Tauri invokes cargo by name; support the default rustup install location.
where.exe cargo.exe >nul 2>nul
if errorlevel 1 if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where.exe cargo.exe >nul 2>nul || (
  echo ERROR: cargo.exe was not found. Install the Rust toolchain first.
  goto :fail
)

if not exist "node_modules\.bin\tauri.cmd" goto :install
if not exist "node_modules\.bin\vite.cmd" goto :install
goto :run

:install
echo Installing locked frontend dependencies...
call npm ci --no-audit --no-fund || goto :fail

:run
rem Embed the frontend so the app uses the same tauri.localhost storage as
rem packaged Slopus. tauri dev uses a separate localhost:1420 storage origin.
rem Debug builds keep Cargo's incremental cache and skip release optimization.
echo Building Slopus from the current source...
call npm run tauri -- build --debug --no-bundle || goto :fail

set "SLOPUS_TARGET_DIR=%CD%\src-tauri\target"
if defined CARGO_TARGET_DIR set "SLOPUS_TARGET_DIR=%CARGO_TARGET_DIR%"
set "SLOPUS_RUN_EXE=%SLOPUS_TARGET_DIR%\debug\slopus.exe"
if not exist "%SLOPUS_RUN_EXE%" (
  echo ERROR: The built executable was not found at "%SLOPUS_RUN_EXE%".
  goto :fail
)
if /I "%~1"=="--build-only" (
  popd
  exit /b 0
)

echo Starting Slopus with your saved projects and settings...
"%SLOPUS_RUN_EXE%"
set "SLOPUS_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %SLOPUS_EXIT_CODE%

:help
echo Usage: run.cmd [--build-only]
echo Builds the latest local source and runs it with packaged Slopus's saved data.
echo --build-only builds without opening the app.
popd
exit /b 0

:usage_error
echo ERROR: Use run.cmd or run.cmd --build-only.

:fail
popd
exit /b 1
