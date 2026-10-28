@echo off
cd /d "%~dp0"
python local_app.py bpa
if errorlevel 1 pause
