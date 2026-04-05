# CDAP REST API Reference

All CDAP management endpoints require API key authentication via `X-API-Key` header.

Base URL: `http://your-server:21114/api`

## Endpoints

### Gateway Status

```
GET /api/cdap/status
```

Returns CDAP gateway status and connected device count.

**Response:**
```json
{
    "enabled": true,
    "connected_devices": 5,
    "uptime_seconds": 86400,
    "version": "0.3.0"
}
```

### List Connected Devices

```
GET /api/cdap/devices
```

Returns all currently connected CDAP devices.

**Response:**
```json
{
    "devices": [
        {
            "id": "CDAP-6A9A5452",
            "name": "Office Workstation",
            "type": "os_agent",
            "version": "1.0.0",
            "platform": "linux/amd64",
            "connected_at": "2026-03-21T10:30:00Z",
            "capabilities": ["telemetry", "commands", "terminal"],
            "widget_count": 9
        }
    ]
}
```

### Device Info

```
GET /api/cdap/devices/{id}/info
```

Returns detailed info for a specific connected device.

**Response:**
```json
{
    "id": "CDAP-6A9A5452",
    "name": "Office Workstation",
    "type": "os_agent",
    "version": "1.0.0",
    "platform": "linux/amd64",
    "connected_at": "2026-03-21T10:30:00Z",
    "capabilities": ["telemetry", "commands", "terminal", "file_transfer"],
    "uptime": "3d 12h 45m"
}
```

### Device Manifest

```
GET /api/cdap/devices/{id}/manifest
```

Returns the full device manifest including widget definitions.

### Device Widget State

```
GET /api/cdap/devices/{id}/state
```

Returns current widget values for the device.

**Response:**
```json
{
    "values": {
        "sys_cpu": 23.5,
        "sys_memory": 67.2,
        "sys_disk": 45.0,
        "sys_hostname": "office-pc",
        "sys_uptime": "3d 12h"
    },
    "updated_at": "2026-03-21T10:35:00Z"
}
```

### Send Command

```
POST /api/cdap/devices/{id}/command
```

Send a command to a connected device. Requires `operator` role.

**Request:**
```json
{
    "command": "system_reboot",
    "args": {}
}
```

**Response:**
```json
{
    "command_id": 42,
    "status": "sent"
}
```

### Audio Session (WebSocket)

```
GET /api/cdap/devices/{id}/audio
Upgrade: websocket
```

WebSocket endpoint for bidirectional audio streaming. Requires `operator` role.

**Protocol:**
1. Client sends `{ type: "init" }` to start audio session
2. Server responds `{ type: "ready", codec: "pcm", sample_rate: 48000, channels: 1 }`
3. Client sends/receives `{ type: "audio_frame", data: "<base64>", timestamp: 123 }`
4. Client sends `{ type: "close" }` to end session

## Error Responses

All errors follow a consistent format:

```json
{
    "error": "device_not_found",
    "message": "Device CDAP-XXXX is not connected"
}
```

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 401 | `unauthorized` | Missing or invalid API key |
| 403 | `forbidden` | Insufficient role for operation |
| 404 | `device_not_found` | Device not connected |
| 503 | `cdap_disabled` | CDAP gateway not enabled |
