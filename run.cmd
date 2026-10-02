@echo off
setlocal EnableExtensions

pushd "%~dp0" || exit /b 1

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
rem Vite serves current UI sources; Cargo rebuilds only changed Rust code.
rem Keep hot reload running and avoid release builds, bundling, and packaging.
echo Starting Slopus from the current source...
call npm run tauri -- dev %*
set "SLOPUS_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %SLOPUS_EXIT_CODE%

:fail
popd
exit /b 1
