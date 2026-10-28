@echo off
cd /d "%~dp0"
set "PEC_CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%PEC_CSC%" set "PEC_CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%PEC_CSC%" (
  echo O compilador do .NET Framework nao foi encontrado neste Windows.
  exit /b 1
)
"%PEC_CSC%" /nologo /target:winexe /platform:anycpu /codepage:65001 /out:Importador_PEC.exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Core.dll /reference:System.Security.dll Interface.cs WindowsCredentials.cs
exit /b %errorlevel%
