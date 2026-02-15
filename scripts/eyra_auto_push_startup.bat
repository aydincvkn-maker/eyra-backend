@echo off
:: EYRA Auto Push - Bilgisayar acilinca otomatik baslar
:: Sadece Backend icin auto-commit scriptini baslatir

start "EYRA Backend Auto Push" powershell -WindowStyle Minimized -ExecutionPolicy Bypass -File "C:\Users\Casper\Desktop\eyra-backend\scripts\auto_commit_push.ps1"
