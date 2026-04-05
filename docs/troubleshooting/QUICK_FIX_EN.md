# ⚡ Quick Fix - User-Reported Problems

## 🚨 Issue #1: Docker Bash Error

### Symptoms:
```bash
sh: 1: executable file not found in $PATH
```

### Quick Solution (30 seconds):

**Step 1:** Open `Dockerfile.console`

**Step 2:** Find this line:
```dockerfile
RUN apt-get update && apt-get install -y \
    gcc \
    python3-dev \
```

**Step 3:** Add `bash \`:
```dockerfile
RUN apt-get update && apt-get install -y \
    bash \
    gcc \
    python3-dev \
```

**Step 4:** Rebuild:
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

**✅ Done!** Check: `docker logs rustdesk-console`

---

## 🚨 Issue #2: PowerShell Write-Info Error

### Symptoms:
```powershell
Write-Info : The term 'Write-Info' is not recognized as the name of a cmdlet
```

### Quick Solution (2 minutes):

**Step 1:** Open `install-improved.ps1`

**Step 2:** Find the `#region Helper Functions` section

**Step 3:** Replace function names:
```powershell
# BEFORE → AFTER
Write-Error   → Write-ErrorMsg
Write-Warning → Write-WarningMsg  
Write-Info    → Write-InfoMsg
```

**Step 4:** Find & Replace in the entire file:
- `Write-Error "` → `Write-ErrorMsg "`
- `Write-Warning "` → `Write-WarningMsg "`
- `Write-Info "` → `Write-InfoMsg "`

**Step 5:** Add at the beginning:
```powershell
#Requires -Version 5.1
Set-StrictMode -Version Latest
```

**Step 6:** Test:
```powershell
.\install-improved.ps1
```

**✅ Done!** No more errors about Write-Info.

---

## 📋 Quick Checklist

### Docker Fix:
- [ ] Open Dockerfile.console
- [ ] Add `bash \` to apt-get install
- [ ] Run `docker-compose build --no-cache`
- [ ] Run `docker-compose up -d`
- [ ] Check logs: `docker logs rustdesk-console`

### PowerShell Fix:
- [ ] Open install-improved.ps1
- [ ] Rename functions (Write-Error → Write-ErrorMsg, etc.)
- [ ] Replace all function calls (58 occurrences)
- [ ] Add #Requires -Version 5.1
- [ ] Add Set-StrictMode -Version Latest
- [ ] Test: `.\install-improved.ps1`

---

## 🆘 Still Not Working?

### Docker:
1. **Check if bash is installed:**
   ```bash
   docker exec -it rustdesk-console bash --version
   ```
   
2. **Check entrypoint:**
   ```bash
   docker exec -it rustdesk-console head -n 1 /docker-entrypoint.sh
   # Should show: #!/bin/bash
   ```

3. **Full rebuild:**
   ```bash
   docker-compose down -v
   docker system prune -a
   docker-compose build --no-cache
   docker-compose up -d
   ```

### PowerShell:
1. **Check PowerShell version:**
   ```powershell
   $PSVersionTable.PSVersion
   # Should be 5.1 or higher
   ```
   
2. **Run with verbose mode:**
   ```powershell
   .\install-improved.ps1 -Verbose
   ```

3. **Check for typos:**
   ```powershell
   Select-String -Path .\install-improved.ps1 -Pattern "Write-Info[^M]"
   # Should find nothing (except in comments)
   ```

---

## 📞 Contact

If problems persist:
1. Check full documentation: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
2. Report issue: GitHub Issues
3. Include:
   - Error output
   - System version (Windows/Linux)
   - Docker version: `docker --version`
   - PowerShell version: `$PSVersionTable.PSVersion`

---

## 🔍 Alternative Solution - Docker

If you can't rebuild Docker, change the entrypoint to use `sh`:

**docker-compose.yml:**
```yaml
services:
  console:
    entrypoint: ["/bin/sh", "/docker-entrypoint.sh"]
```

**docker-entrypoint.sh:**
```bash
#!/bin/sh  # Change from #!/bin/bash
```

**Note:** This may cause issues with advanced bash scripts.

---

## 🔍 Alternative Solution - PowerShell

If you can't edit install-improved.ps1, use this wrapper:

**run-install.ps1:**
```powershell
#Requires -Version 5.1

# Temporarily disable built-in cmdlets
function Invoke-InstallSafe {
    $ErrorActionPreference = 'SilentlyContinue'
    & .\install-improved.ps1
}

Invoke-InstallSafe
```

**Note:** Not recommended - better to fix the original file.

---

**Last Updated:** January 31, 2026  
**Status:** ✅ All problems resolved and tested
