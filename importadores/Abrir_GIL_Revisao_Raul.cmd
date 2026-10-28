@echo off
cd /d "%~dp0"
python local_app.py gil
if errorlevel 1 pause
