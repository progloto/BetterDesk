# Documentation

This directory contains comprehensive documentation for BetterDesk Console, organized by topic.

## Setup & Installation

- **[Installation Guide](setup/INSTALLATION_V1.4.0.md)** — Full installation instructions
- **[Update Guide](setup/UPDATE_GUIDE.md)** — Updating existing installations
- **[Build Guide](setup/BUILD_GUIDE.md)** — Building from source
- **[Synology Installation](setup/SYNOLOGY_INSTALLATION.md)** — NAS-specific setup
- **[HTTPS Setup](setup/HTTPS_SETUP.md)** — SSL/TLS certificate configuration

## Docker

- **[Docker Support](docker/DOCKER_SUPPORT.md)** — Docker installation guide
- **[Docker Quick Start](docker/DOCKER_QUICKSTART.md)** — 30-second quick start with pre-built images
- **[Docker Troubleshooting](docker/DOCKER_TROUBLESHOOTING.md)** — Docker-specific issues & fixes
- **[Docker Migration](docker/DOCKER_MIGRATION.md)** — Migrating from existing RustDesk Docker

## Features

- **[Client Generator](features/CLIENT_GENERATOR.md)** — Custom client generator
- **[Client Generator Quick Start](features/CLIENT_GENERATOR_QUICKSTART_EN.md)** — Quick start guide
- **[Device ID Change](features/ID_CHANGE_FEATURE.md)** — Device ID change feature
- **[Status Tracking v3](features/STATUS_TRACKING_v3.md)** — Device status tracking system
- **[CDAP / Custom Device API](features/CUSTOM_DEVICE_API.md)** — Custom Device Access Protocol
- **[Web Remote Client](features/WEB_REMOTE_CLIENT_PLAN.md)** — Browser-based remote desktop

## Architecture

- **[Project Structure](architecture/PROJECT_STRUCTURE.md)** — Codebase overview
- **[BetterDesk Client](architecture/BETTERDESK_CLIENT_ARCHITECTURE.md)** — Desktop client architecture
- **[BetterDesk v3 Overview](architecture/BETTERDESK_v3_OVERVIEW.md)** — v3 architecture summary
- **[CDAP Protocol](architecture/CDAP_PROTOCOL.md)** — CDAP wire protocol specification
- **[CDAP Implementation](architecture/CDAP_IMPLEMENTATION_PLAN.md)** — CDAP implementation plan
- **[Port Security](architecture/PORT_SECURITY.md)** — Port configuration & security

## Troubleshooting

- **[General Troubleshooting](troubleshooting/TROUBLESHOOTING_EN.md)** — Common issues & solutions
- **[Key Troubleshooting](troubleshooting/KEY_TROUBLESHOOTING.md)** — Key and encryption issues
- **[Quick Fix](troubleshooting/QUICK_FIX_EN.md)** — Quick fixes for common problems

## Performance

- **[GPU Optimization](performance/GPU_OPTIMIZATION_EN.md)** — GPU optimization guide
- **[GPU Quick Fix](performance/GPU_FIX_QUICKSTART_EN.md)** — Quick GPU fix
- **[Optimization Summary](performance/OPTIMIZATION_SUMMARY_EN.md)** — Performance optimization overview

## Development

- **[Contributing](development/CONTRIBUTING.md)** — Contribution guidelines
- **[Translation Guide](development/CONTRIBUTING_TRANSLATIONS.md)** — Adding new languages
- **[Translation Summary](development/TRANSLATION_SUMMARY.md)** — Translation coverage status
- **[Changelog](development/CHANGELOG.md)** — Version history

## Enterprise

- **[Enterprise Roadmap](enterprise/ENTERPRISE_ROADMAP.md)** — Future enterprise features

---

> **Note:** The original Rust-based HBBS patch has been replaced by the [Go server](../betterdesk-server/) and moved to `archive/`. See the main [README](../README.md) for current architecture.
