# ShieldGuard — Complete Setup & Deployment Guide
## Full-Stack Mobile Protection System

---

## ARCHITECTURE OVERVIEW

```
 Your Phone (Protected)          Backend Server               Dashboard (PC/Phone)
 ┌─────────────────────┐        ┌────────────────┐           ┌──────────────────┐
 │  Android APK        │◄──WS──►│  Node.js       │◄───WS────►│  Web Dashboard   │
 │  ProtectionService  │        │  + WebSocket   │           │  (HTML file)     │
 │  StreamingService   │        │  + REST API    │           │                  │
 │  FcmService         │◄──FCM──│  + FCM relay   │           │                  │
 └─────────────────────┘        └───────┬────────┘           └──────────────────┘
                                        │
                               ┌────────▼────────┐
                               │   Firebase       │
                               │  • Firestore DB  │
                               │  • Storage       │
                               │  • FCM           │
                               │  • Auth          │
                               └─────────────────┘
```

---

## STEP 1 — Firebase Setup (15 minutes)

1. Go to https://console.firebase.google.com
2. Create a new project: **ShieldGuard**
3. Enable these services:
   - **Firestore Database** → Start in production mode
   - **Storage** → Default bucket
   - **Authentication** → Enable Email/Password
   - **Cloud Messaging** (FCM) → Already enabled

4. **For the Android app:**
   - Add Android app → package: `com.shieldguard`
   - Download `google-services.json`
   - Place it at: `android/app/google-services.json`

5. **For the backend server:**
   - Project Settings → Service Accounts → Generate new private key
   - Save as: `backend/config/firebase-service-account.json`

6. **Deploy Firestore security rules:**
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules
   ```

---

## STEP 2 — Backend Server Setup

### Option A: Run locally (for testing)
```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your values
node src/server.js
```

### Option B: Deploy to Railway (recommended, free tier available)
```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
# Set env vars in Railway dashboard
```

### Option C: Deploy to VPS (DigitalOcean / Hetzner)
```bash
# On your VPS:
git clone your-repo /opt/shieldguard
cd /opt/shieldguard/backend
npm install --production

# Install PM2 for process management
npm install -g pm2
pm2 start src/server.js --name shieldguard
pm2 startup && pm2 save

# Install Nginx as reverse proxy
# /etc/nginx/sites-available/shieldguard:
server {
    listen 443 ssl;
    server_name your-domain.com;

    location /ws {
        proxy_pass         http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_read_timeout 86400;
    }

    location /api {
        proxy_pass http://localhost:3001;
    }
}
```

---

## STEP 3 — Android App Setup

### Prerequisites
- Android Studio Hedgehog or newer
- Android SDK 34
- JDK 17

### Build steps
```bash
cd android

# 1. Place google-services.json in app/
# 2. Edit app/src/main/java/com/shieldguard/util/PrefsManager.kt
#    Set the default serverUrl to your deployed backend URL

# 3. Build debug APK
./gradlew assembleDebug

# APK output: app/build/outputs/apk/debug/app-debug.apk

# 4. Build release APK (requires signing keystore)
./gradlew assembleRelease
```

### Install on target phone
```bash
# Via ADB (USB debug mode)
adb install app/build/outputs/apk/debug/app-debug.apk

# Or copy APK to phone and open with file manager
# Enable "Install from unknown sources" in Settings first
```

---

## STEP 4 — First Run (on the protected phone)

1. Open **ShieldGuard** app
2. Enter your email and create a password
3. Tap **Activate Device Admin** → confirm in system dialog
4. The app will:
   - Register the device with your backend
   - Save the SIM ICCID as the "trusted" SIM
   - Start the background protection service
   - Request all required permissions (location, camera, mic)
5. Enable **Hide app icon** in settings for stealth mode

---

## STEP 5 — Dashboard Access

Open the `mobile_protector_dashboard.html` file in any browser.

**Connect to your backend:**
1. Click Settings → Server URL
2. Enter: `wss://your-domain.com/ws`
3. Log in with your email/password
4. Your device should appear as "Online"

---

## FEATURE REFERENCE

| Feature | How It Works | Android API Used |
|---------|-------------|-----------------|
| Live GPS tracking | Polls LocationManager every N seconds, pushes to Firestore + WebSocket | `LocationManager` |
| Location history | All coordinates stored in Firestore with timestamps | Firestore |
| Geofence alerts | Server-side distance calculation from home coordinates | `Location.distanceBetween()` |
| Live camera feed | WebRTC peer connection, H.264 encoded, streamed to dashboard | `Camera2 API + WebRTC` |
| Screen mirroring | MediaProjection captures display, streamed via WebRTC | `MediaProjectionManager` |
| Photo capture | CameraX silent capture, uploaded to Firebase Storage | `CameraX` |
| Remote lock | Device Admin API `lockNow()` | `DevicePolicyManager` |
| Remote wipe | Device Admin API `wipeData()` — irreversible | `DevicePolicyManager` |
| Sound alarm | Sets alarm stream to max volume, plays alarm ringtone | `AudioManager` |
| Wrong PIN capture | `DeviceAdminReceiver.onPasswordFailed()` triggers front camera | `DeviceAdminReceiver` |
| SIM change detect | Polls `TelephonyManager.simSerialNumber` every 5 sec | `TelephonyManager` |
| Push commands (offline) | FCM high-priority data message wakes device | Firebase FCM |
| Auto-start on boot | `BOOT_COMPLETED` broadcast receiver | `BroadcastReceiver` |
| Service persistence | AlarmManager reschedules if service is killed | `AlarmManager` |
| Screen message | Overlay Activity with custom text | `Activity` |
| Text-to-speech | Android TTS engine speaks message aloud | `TextToSpeech` |

---

## PERMISSIONS EXPLAINED

| Permission | Why Needed |
|-----------|-----------|
| `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` | GPS tracking even when screen is off |
| `CAMERA` | Photo capture + live camera stream |
| `RECORD_AUDIO` | Audio in live stream |
| `FOREGROUND_SERVICE` | Keep service alive |
| `RECEIVE_BOOT_COMPLETED` | Auto-start after reboot |
| `READ_PHONE_STATE` | SIM ICCID monitoring |
| `BIND_DEVICE_ADMIN` | Remote lock and wipe |
| `INTERNET` | WebSocket + Firebase |

---

## SECURITY NOTES

1. **All communication is encrypted** — WebSocket over TLS (wss://), Firebase uses TLS
2. **JWT authentication** — dashboard login required, tokens expire in 7 days
3. **Firestore rules** — only the owner email can read device data
4. **Remote wipe is irreversible** — confirmation modal in dashboard required
5. **Stealth mode** — app icon can be hidden from launcher
6. **Uninstall protection** — Device Admin prevents uninstall without PIN
7. **Use this only on devices you own** — deploying on someone else's device is illegal

---

## WEBRTC NOTES

For camera/screen streaming through strict NATs (mobile networks, corporate WiFi),
you'll need a TURN server. Free options:
- **Metered.ca** — free TURN server (1 GB/month free)
- **Twilio STUN/TURN** — pay-as-you-go
- **coturn** — self-host on your VPS

Add TURN credentials to `StreamingService.kt` `iceServers` list.

---

## FILE STRUCTURE

```
shieldguard/
├── android/
│   └── app/src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/shieldguard/
│       │   ├── service/
│       │   │   ├── ProtectionService.kt     ← Core background service
│       │   │   ├── StreamingService.kt      ← WebRTC camera/screen
│       │   │   ├── FcmService.kt            ← Push commands
│       │   │   ├── WebSocketClient.kt       ← Real-time connection
│       │   │   ├── DeviceAdminReceiver.kt   ← Lock/wipe capability
│       │   │   └── Receivers.kt             ← Boot + SIM receivers
│       │   └── util/
│       │       └── PrefsManager.kt          ← Settings + models
│       └── res/xml/
│           └── device_admin_policies.xml
├── backend/
│   ├── src/server.js                        ← Main server (WS + REST + FCM)
│   ├── config/
│   │   ├── firestore.rules                  ← Security rules
│   │   └── firebase-service-account.json   ← (you add this)
│   ├── package.json
│   └── .env.example
└── SETUP.md                                 ← This file
```
