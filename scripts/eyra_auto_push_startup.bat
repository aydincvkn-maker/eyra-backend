@echo off
:: EYRA Auto Push - Bilgisayar acilinca otomatik baslar
:: Backend ve Panel icin auto-commit scriptlerini baslatir

start "EYRA Backend Auto Push" powershell -WindowStyle Minimized -ExecutionPolicy Bypass -File "C:\Users\Casper\Desktop\eyra-backend\scripts\auto_commit_push.ps1"

start "EYRA Panel Auto Push" powershell -WindowStyle Minimized -ExecutionPolicy Bypass -File "C:\Users\Casper\Desktop\eyrapanel\eyra-admin\scripts\auto_commit_push.ps1"
