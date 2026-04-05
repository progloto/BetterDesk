# 🔒 Secure Port Configuration - BetterDesk Console

## 📊 Analiza Portów RustDesk (Oficjalna Dokumentacja)

### 🌍 **PORTY PUBLICZNE** (muszą być wystawione do internetu)

Zgodnie z [oficjalną dokumentacją RustDesk](https://rustdesk.com/docs/en/self-host/):

```
TCP 21115 - HBBS Signal Server (główny port sygnałowy)
TCP 21116 - HBBS Signal Server  
TCP 21117 - HBBR Relay Server (główny port relay)
UDP 21116 - NAT traversal (UDP hole punching)

OPCJONALNE (tylko dla Web Client):
TCP 21118 - WebSocket dla web client
TCP 21119 - WebSocket relay dla web client
```

**Minimalne wymaganie:** TCP 21115-21117 + UDP 21116

### ⚠️ **PORT KONFLIKTOWY** (RustDesk Pro)

```
TCP 21114 - HTTP API (tylko w RustDesk Pro, wymaga SSL proxy!)
```

**Problem:** RustDesk Pro używa portu 21114 dla swojego API, który:
- Jest przeznaczony do ekspozycji publicznej (z SSL proxy)
- Koliduje z naszym lokalnym API
- Nie jest bezpieczny bez autentykacji

---

## ✅ **NASZE ROZWIĄZANIE: Port Lokalny**

### 🔐 Port 21120 - HTTP API (Localhost Only)

**Konfiguracja:**
```rust
// src/main.rs
const API_PORT: u16 = 21120;  // Localhost-only API port

// src/http_api.rs
let addr = SocketAddr::from(([127, 0, 0, 1], port));  // 127.0.0.1 TYLKO!
```

**Dlaczego 21120?**
- ✅ Nie koliduje z żadnym portem RustDesk (21114-21119)
- ✅ W zakresie prywatnym (powyżej 21119)
- ✅ Łatwy do zapamiętania (21120 = 211**20**)
- ✅ Nie wymaga ekspozycji do internetu

### 🏗️ Architektura Bezpieczeństwa

```
┌─────────────────────────────────────────────────────────┐
│                    INTERNET (WAN)                        │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
         ┌─────────────────────────────┐
         │   FIREWALL / ROUTER         │
         │   Forward tylko:            │
         │   - TCP 21115-21117         │
         │   - UDP 21116               │
         │   (opcja: TCP 21118-21119)  │
         └──────────┬──────────────────┘
                    │
         ╔══════════▼════════════════════════════╗
         ║      SERVER (192.168.x.x)             ║
         ║                                       ║
         ║  ┌────────────────────────────────┐  ║
         ║  │  HBBS (21115-21116)            │  ║ ← Publiczne
         ║  │  HBBR (21117)                  │  ║
         ║  └────────────────────────────────┘  ║
         ║                                       ║
         ║  ┌────────────────────────────────┐  ║
         ║  │  HTTP API (21120)              │  ║ ← TYLKO LOCALHOST
         ║  │  Bind: 127.0.0.1               │  ║
         ║  │  ✗ NIE dostępne z WAN          │  ║
         ║  └──────────────┬─────────────────┘  ║
         ║                 │ localhost          ║
         ║                 ▼                    ║
         ║  ┌────────────────────────────────┐  ║
         ║  │  Flask Web Console (5000)      │  ║ ← TYLKO LOCALHOST
         ║  │  Bind: 127.0.0.1               │  ║
         ║  │  ✗ NIE dostępne z WAN          │  ║
         ║  └────────────────────────────────┘  ║
         ║                 ▲                    ║
         ║                 │ SSH tunnel (8080)  ║
         ╚═════════════════│════════════════════╝
                           │
                ┌──────────┴─────────────┐
                │  ADMIN (lokalny PC)    │
                │  ssh -L 8080:localhost:5000 server
                │  http://localhost:8080 │
                └────────────────────────┘
```

---

## 🛡️ **Zalety Nowej Konfiguracji**

### 1. **Bezpieczeństwo Warstwowe**

```bash
# Port 21120 - NIE jest dostępny z internetu
❯ curl http://YOUR_PUBLIC_IP:21120/api/health
# Connection refused (firewall blokuje)

# Działa TYLKO lokalnie
❯ ssh server
❯ curl http://localhost:21120/api/health
# {"success":true,"data":"RustDesk API is running"}
```

### 2. **Brak Kolizji z RustDesk Pro**

Jeśli kiedykolwiek zdecydujesz się na upgrade do RustDesk Pro:
- Ich API na 21114 ✅ działa
- Nasze API na 21120 ✅ działa
- Zero konfliktów!

### 3. **Żadnych Zmian w Firewallu**

```bash
# Firewall - NIE MUSISZ dodawać 21120!
# Port jest lokalny, więc nie potrzebuje forwarding

# Wymagane porty (bez zmian):
sudo ufw allow 21115:21117/tcp
sudo ufw allow 21116/udp
```

### 4. **Automatyczna Ochrona**

Binding na `127.0.0.1` oznacza:
- ✅ Nawet jeśli zapomnisz o firewall - API niedostępne z zewnątrz
- ✅ Nawet jeśli ktoś przejmie router - nie dotrze do API
- ✅ Defense in depth - wielowarstwowe zabezpieczenia

---

## 📋 **Konfiguracja Krok po Kroku**

### 1. Rekompiluj z Nowymi Portami

```bash
# Linux
cd hbbs-patch
bash build.sh

# Windows
cd hbbs-patch
.\build-windows-local.ps1
```

### 2. Zainstaluj Nowe Binaria

```bash
# Linux
sudo ./install-improved.sh

# Windows (Administrator)
.\install-improved.ps1
```

### 3. Weryfikuj Konfigurację

```bash
# Sprawdź, czy API nasłuchuje TYLKO na localhost
sudo netstat -tulpn | grep 21120
# Powinno pokazać: tcp 127.0.0.1:21120 ... LISTEN

# Test z serwera (powinno działać)
curl http://localhost:21120/api/health

# Test z innego komputera (powinno NIE działać)
curl http://192.168.x.x:21120/api/health
# curl: (7) Failed to connect
```

### 4. Firewall (Opcjonalny - dla pewności)

Mimo że API już jest na localhost, możesz dodatkowo zablokować:

```bash
# Linux
sudo ufw deny 21120
# Windows
New-NetFirewallRule -DisplayName "Block HBBS API" -Direction Inbound -LocalPort 21120 -Protocol TCP -Action Block
```

---

## 🔧 **Dostęp do Konsoli Web (dla Adminów)**

### Opcja 1: SSH Tunnel (Zalecane)

```bash
# Z lokalnego PC
ssh -L 8080:localhost:5000 user@your-server

# W przeglądarce
http://localhost:8080
```

**Zalety:**
- ✅ Szyfrowane połączenie (SSH)
- ✅ Autentykacja (klucz SSH)
- ✅ Zero ekspozycji na internet

### Opcja 2: Reverse Proxy z SSL (Produkcja)

```nginx
# /etc/nginx/sites-available/rustdesk-console
server {
    listen 443 ssl http2;
    server_name rustdesk-console.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Autentykacja Basic Auth
    auth_basic "RustDesk Admin";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**Setup:**
```bash
# Utwórz użytkownika
sudo htpasswd -c /etc/nginx/.htpasswd admin

# Testuj konfigurację
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

### Opcja 3: VPN (Najbezpieczniejsza)

```bash
# Połącz przez WireGuard/OpenVPN
# Wtedy masz dostęp do 192.168.x.x:5000 jakbyś był w sieci lokalnej
```

---

## 🔍 **Monitorowanie i Logi**

### Sprawdź Status API

```bash
# Linux
sudo journalctl -u rustdesksignal -f | grep "HTTP API"

# Powinno pokazać:
# HTTP API server listening on 127.0.0.1:21120 (localhost only)
```

### Monitoring Połączeń

```bash
# Kto łączy się z API?
sudo ss -tunap | grep 21120

# Wszystkie połączenia powinny być z 127.0.0.1
```

---

## 📊 **Porównanie: Przed vs Po**

| Aspekt | PRZED (21114) | PO (21120) |
|--------|---------------|------------|
| **Binding** | 0.0.0.0 (wszystkie interfejsy) | 127.0.0.1 (tylko localhost) |
| **Dostęp z WAN** | ✗ TAK (niebezpieczne!) | ✅ NIE (bezpieczne) |
| **Wymaga firewall** | ⚠️ KRYTYCZNE | ✅ Opcjonalne (już bezpieczne) |
| **Kolizja z Pro** | ✗ TAK (konflikt na 21114) | ✅ NIE (21120 wolny) |
| **Autentykacja** | ✗ BRAK | ✅ Niepotrzebna (localhost only) |
| **Ekspozycja danych** | 🔴 WYSOKA | 🟢 ŻADNA |
| **Setup complexity** | ⚠️ Wymaga zabezpieczeń | ✅ Secure by default |

---

## ✅ **Checklist Bezpieczeństwa**

Po wdrożeniu sprawdź:

- [ ] API nasłuchuje na 127.0.0.1:21120 (nie 0.0.0.0)
- [ ] `curl http://localhost:21120/api/health` działa na serwerze
- [ ] `curl http://public-ip:21120` NIE działa z zewnątrz
- [ ] Flask konsola działa przez SSH tunnel
- [ ] Firewall przepuszcza tylko 21115-21117 (nie 21120)
- [ ] Logi nie pokazują błędów bindu
- [ ] RustDesk klienci łączą się normalnie (21115-21117)

---

## 🎯 **Podsumowanie**

### Było (Niebezpieczne):
```
HTTP API 21114 → 0.0.0.0 → INTERNET → ❌ Wyciek danych
```

### Jest (Bezpieczne):
```
HTTP API 21120 → 127.0.0.1 → Tylko localhost → ✅ Bezpieczne
                     ↓
                Flask 5000 → 127.0.0.1 → SSH Tunnel → Admin PC
```

### Rezultat:
- 🟢 **Zero ekspozycji API na internet**
- 🟢 **Brak kolizji z RustDesk Pro**
- 🟢 **Secure by default**
- 🟢 **Żadnych zmian w firewallu**
- 🟢 **Konsola dostępna przez SSH tunnel**

**To jest idealne rozwiązanie dla self-hosted RustDesk!** 🎉

---

**Data:** 10 stycznia 2026  
**Autor:** GitHub Copilot  
**Wersja:** 2.0 - Localhost API Edition
