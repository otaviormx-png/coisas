@echo off
cd /d "%~dp0"
if not exist "Importador_PEC.exe" call "Compilar_Interface.cmd"
if not exist "Importador_PEC.exe" (
  echo Nao foi possivel preparar a janela do aplicativo.
  pause
  exit /b 1
)
start "" "%~dp0Importador_PEC.exe" bpa
