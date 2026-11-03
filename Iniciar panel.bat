@echo off
setlocal
cd /d "%~dp0"

echo.
echo  Panel del local
echo  ===============
echo.

set "PYEXE="

rem 1) Lanzador oficial de Python en Windows
where py >nul 2>&1 && set "PYEXE=py -3"

rem 2) Instalaciones por usuario
for %%D in (314 313 312 311 310) do (
  if not defined PYEXE if exist "%LocalAppData%\Programs\Python\Python%%D\python.exe" set "PYEXE=%LocalAppData%\Programs\Python\Python%%D\python.exe"
)

rem 3) Runtime incluido en esta computadora (DeepSeek Harness)
if not defined PYEXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "PYEXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

rem 4) Python en el PATH (si no es el acceso directo de la Microsoft Store)
if not defined PYEXE (
  python --version >nul 2>&1 && set "PYEXE=python"
)

if not defined PYEXE (
  echo  No encuentro Python instalado en esta computadora.
  echo.
  echo  Instalalo desde https://www.python.org/downloads/ 
  echo  ^(marcando "Add Python to PATH"^) y volve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

echo  Usando: %PYEXE%
echo  Abriendo http://127.0.0.1:8787/ ...
echo  Deja esta ventana abierta mientras usas el panel. Ctrl+C para detener.
echo.

%PYEXE% run.py --sync --open
if errorlevel 1 (
  echo.
  echo  El panel se cerro con un error. Revisa el mensaje de arriba.
  pause
)
