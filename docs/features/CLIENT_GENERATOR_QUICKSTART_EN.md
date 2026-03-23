# 🎯 RustDesk Client Generator - Quick Start

## 📌 What is the Client Generator?

The Client Generator is a feature that enables **automatic creation of ready-to-use RustDesk clients** for various platforms (Windows, Linux, Android, macOS). 

Each generated client contains:
- ✅ **Built-in server settings** (ID Server, Relay Server, Key)
- ✅ **Branding** (custom application name)
- ✅ **Ready for immediate use** - no manual configuration required

---

## 🚀 Quick Start (3 steps)

### 1️⃣ Select Platform

Navigate to the **Client Generator** tab in the web panel:

```
http://your-server-ip:21114/ → Client Generator
```

Select the platform:
- 🪟 **Windows** (x64, x86, ARM64)
- 🐧 **Linux** (AppImage, deb, rpm)
- 🤖 **Android** (APK, arm64-v8a, armeabi-v7a)
- 🍎 **macOS** (Intel, Apple Silicon M1/M2)

### 2️⃣ Configure Settings

Enter configuration data:

| Field | Example | Description |
|-------|---------|-------------|
| **ID Server** | `rustdesk.example.com` | Your RustDesk server address |
| **Relay Server** | `rustdesk.example.com` | Relay server (usually the same) |
| **API Key** | `Ab12Cd...` | Public key from hbbs |
| **Application Name** | `MyCompany Remote` | Client name (visible in title bar) |

**Where to find the API Key?**
```bash
# On the server:
cat /var/lib/rustdesk-server/id_ed25519.pub
```

### 3️⃣ Generate & Download

1. Click **Generate Client**
2. Wait 30-120 seconds (depending on platform)
3. **Download** the ready file
4. Distribute to users

---

## 🎯 Typical Scenarios

### Scenario 1: Support for Clients
**Goal:** Create a client for Windows users that connects to your server

```
1. Select: Windows x64
2. ID Server: support.mycompany.com
3. Relay Server: support.mycompany.com  
4. Application Name: MyCompany Support
5. Generate → Download → Send via email
```

**Result:** Customer downloads, runs - and is immediately connected to your server

### Scenario 2: Internal Company Network
**Goal:** Deploy RustDesk in a LAN without internet access

```
1. Select: Windows x64 + Linux AppImage
2. ID Server: 192.168.1.100:21116
3. Relay Server: 192.168.1.100:21117
4. Application Name: Company Remote Desktop
5. Deploy via Group Policy (Windows) + internal repo (Linux)
```

### Scenario 3: MSP/IT Support Company
**Goal:** Different clients for each customer

```
Customer A:
- ID Server: client-a.msp.com
- Application Name: ClientA IT Support

Customer B:
- ID Server: client-b.msp.com  
- Application Name: ClientB IT Support
```

---

## 🛠️ Advanced Configuration

### Custom Branding
```json
{
    "app_name": "MyCompany Remote",
    "icon": "custom_icon.ico",
    "vendor": "MyCompany Ltd."
}
```

### API Usage
```python
import requests

response = requests.post('http://localhost:21114/api/generate-client', json={
    'platform': 'windows-x64',
    'id_server': 'rustdesk.example.com',
    'relay_server': 'rustdesk.example.com',
    'api_key': 'YOUR_PUBLIC_KEY',
    'app_name': 'Custom Client'
})

download_url = response.json()['download_url']
```

---

## ⚠️ Troubleshooting

### Problem: "Key not found"
**Solution:**
1. Check if the key is in the correct format (without `-----BEGIN/END-----`)
2. Ensure you're using the **public** key (`id_ed25519.pub`)
3. Copy without additional spaces

### Problem: Client doesn't connect
**Solution:**
1. Check if ports are open (21116, 21117)
2. Verify the server address is correct
3. Test connection with a standard client first

### Problem: Generation takes a long time
**Solution:**
- Windows: ~30-60 seconds (normal)
- Android: ~90-120 seconds (normal - large file)
- Linux: ~45-75 seconds
- macOS: ~60-90 seconds

### Problem: Downloaded file is damaged
**Solution:**
1. Check available disk space on the server
2. Look for errors in logs: `docker logs rustdesk-console`
3. Try generating again

---

## 📊 Platform Comparison

| Platform | File Size | Generation Time | Note |
|----------|-----------|-----------------|------|
| Windows x64 | ~25 MB | 30-60s | Most popular |
| Windows x86 | ~22 MB | 30-60s | Old systems |
| Linux AppImage | ~30 MB | 45-75s | Universal |
| Android APK | ~40 MB | 90-120s | Requires signing |
| macOS Intel | ~28 MB | 60-90s | Requires certificate |
| macOS M1/M2 | ~28 MB | 60-90s | Apple Silicon |

---

## 🔐 Security

### Best Practices:
1. ✅ Generate a **separate key** for each major customer
2. ✅ Store generated clients in a **secure location**
3. ✅ Use **HTTPS** for the web panel
4. ✅ Limit access to the generator (only authorized personnel)
5. ✅ Version generated clients (e.g., `client-v1.2.3.exe`)

### What NOT to do:
- ❌ Don't publish the private key (`id_ed25519` without `.pub`)
- ❌ Don't use the same key for all customers
- ❌ Don't generate clients on public Wi-Fi networks
- ❌ Don't store clients in unsecured public locations

---

## 📚 Additional Information

- 📖 Full documentation: [CLIENT_GENERATOR.md](CLIENT_GENERATOR.md)
- 🔧 API Configuration: [README.md](../README.md)
- 🐛 Problem Reports: [GitHub Issues](https://github.com/your-repo/issues)

---

**Last Updated:** January 31, 2026  
**Version:** 1.5.0  
**Status:** ✅ Tested and Ready
