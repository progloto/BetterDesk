package agent

import (
	"fmt"
	"runtime"
)

// BuildManifest creates a CDAP device manifest from agent config and system info.
func BuildManifest(cfg *Config, sys *SystemCollector, version string) map[string]any {
	info := sys.GetInfo()

	// Capabilities based on config
	caps := []string{"telemetry", "commands"}
	if cfg.Terminal {
		caps = append(caps, "remote_desktop") // terminal is part of remote_desktop capability
	}
	if cfg.FileBrowser {
		caps = append(caps, "file_transfer")
	}
	if cfg.Clipboard {
		caps = append(caps, "clipboard")
	}

	// Build widgets
	widgets := buildSystemWidgets(cfg)

	// Build device descriptor
	device := map[string]any{
		"name":     cfg.DeviceName,
		"type":     cfg.DeviceType,
		"vendor":   "BetterDesk",
		"model":    fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
		"firmware": version,
	}
	if info.Hostname != "" {
		device["name"] = info.Hostname
	}
	if cfg.DeviceName != "" {
		device["name"] = cfg.DeviceName
	}
	if len(cfg.Tags) > 0 {
		device["tags"] = cfg.Tags
	}
	device["description"] = fmt.Sprintf("%s %s %s (%s)", info.Platform, info.PlatformVersion, info.OS, info.Arch)

	return map[string]any{
		"manifest_version":   "1.0",
		"device":             device,
		"capabilities":       caps,
		"heartbeat_interval": cfg.HeartbeatSec,
		"widgets":            widgets,
	}
}

func buildSystemWidgets(cfg *Config) []map[string]any {
	var widgets []map[string]any

	// CPU gauge
	widgets = append(widgets, map[string]any{
		"id":           "sys_cpu",
		"type":         "gauge",
		"label":        "CPU Usage",
		"group":        "System",
		"min":          0.0,
		"max":          100.0,
		"unit":         "%",
		"warning_high": 70.0,
		"precision":    1,
		"permissions":  &map[string]string{"read": "viewer"},
	})

	// Memory gauge
	widgets = append(widgets, map[string]any{
		"id":           "sys_memory",
		"type":         "gauge",
		"label":        "Memory Usage",
		"group":        "System",
		"min":          0.0,
		"max":          100.0,
		"unit":         "%",
		"warning_high": 80.0,
		"precision":    1,
		"permissions":  &map[string]string{"read": "viewer"},
	})

	// Disk gauge
	widgets = append(widgets, map[string]any{
		"id":           "sys_disk",
		"type":         "gauge",
		"label":        "Disk Usage",
		"group":        "System",
		"min":          0.0,
		"max":          100.0,
		"unit":         "%",
		"warning_high": 85.0,
		"precision":    1,
		"permissions":  &map[string]string{"read": "viewer"},
	})

	// Uptime text
	widgets = append(widgets, map[string]any{
		"id":          "sys_uptime",
		"type":        "text",
		"label":       "Uptime",
		"group":       "System",
		"readonly":    true,
		"permissions": &map[string]string{"read": "viewer"},
	})

	// Hostname text
	widgets = append(widgets, map[string]any{
		"id":          "sys_hostname",
		"type":        "text",
		"label":       "Hostname",
		"group":       "System",
		"readonly":    true,
		"permissions": &map[string]string{"read": "viewer"},
	})

	// Terminal
	if cfg.Terminal {
		widgets = append(widgets, map[string]any{
			"id":    "sys_terminal",
			"type":  "terminal",
			"label": "Terminal",
			"group": "Access",
			"permissions": &map[string]string{
				"read":    "operator",
				"control": "operator",
				"execute": "admin",
			},
		})
	}

	// File browser
	if cfg.FileBrowser {
		widgets = append(widgets, map[string]any{
			"id":    "sys_files",
			"type":  "file_browser",
			"label": "File Browser",
			"group": "Access",
			"permissions": &map[string]string{
				"read":    "operator",
				"control": "operator",
				"execute": "admin",
			},
		})
	}

	// Screenshot button
	if cfg.Screenshot {
		widgets = append(widgets, map[string]any{
			"id":      "sys_screenshot",
			"type":    "button",
			"label":   "Capture Screenshot",
			"group":   "Tools",
			"icon":    "screenshot_monitor",
			"confirm": false,
			"permissions": &map[string]string{
				"control": "operator",
			},
		})
	}

	// Clipboard
	if cfg.Clipboard {
		widgets = append(widgets, map[string]any{
			"id":       "sys_clipboard",
			"type":     "text",
			"label":    "Clipboard",
			"group":    "Tools",
			"readonly": false,
			"permissions": &map[string]string{
				"read":    "operator",
				"control": "operator",
			},
		})
	}

	return widgets
}
