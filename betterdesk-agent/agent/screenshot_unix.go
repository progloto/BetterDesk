//go:build !windows

package agent

import (
	"fmt"
	"os/exec"
)

// captureScreenshotPlatform captures a screenshot on Linux/macOS using
// available command-line tools. Returns JPEG bytes.
func captureScreenshotPlatform() ([]byte, error) {
	// macOS: screencapture
	if path, err := exec.LookPath("screencapture"); err == nil {
		cmd := exec.Command(path, "-x", "-t", "jpg", "-")
		out, err := cmd.Output()
		if err == nil && len(out) > 0 {
			return out, nil
		}
	}

	// Linux: import (ImageMagick)
	if path, err := exec.LookPath("import"); err == nil {
		cmd := exec.Command(path, "-window", "root", "jpeg:-")
		out, err := cmd.Output()
		if err == nil && len(out) > 0 {
			return out, nil
		}
	}

	// Linux: scrot
	if path, err := exec.LookPath("scrot"); err == nil {
		cmd := exec.Command(path, "-o", "-", "--quality", "80")
		out, err := cmd.Output()
		if err == nil && len(out) > 0 {
			return out, nil
		}
	}

	// Linux: gnome-screenshot
	if path, err := exec.LookPath("gnome-screenshot"); err == nil {
		cmd := exec.Command(path, "-f", "/dev/stdout")
		out, err := cmd.Output()
		if err == nil && len(out) > 0 {
			return out, nil
		}
	}

	return nil, fmt.Errorf("no screenshot tool available (install scrot, ImageMagick, or gnome-screenshot)")
}
