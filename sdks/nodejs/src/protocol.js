'use strict';

/**
 * CDAP protocol constants, message helpers, and auth payload builders.
 */

// ── Widget types ─────────────────────────────────────────────────────

const WidgetType = Object.freeze({
  TOGGLE: 'toggle',
  GAUGE: 'gauge',
  BUTTON: 'button',
  LED: 'led',
  CHART: 'chart',
  SELECT: 'select',
  SLIDER: 'slider',
  TEXT: 'text',
  TABLE: 'table',
  TERMINAL: 'terminal',
  DESKTOP: 'desktop',
  VIDEO_STREAM: 'video_stream',
  FILE_BROWSER: 'file_browser',
});

// ── Command actions ──────────────────────────────────────────────────

const Action = Object.freeze({
  SET: 'set',
  TRIGGER: 'trigger',
  EXECUTE: 'execute',
  RESET: 'reset',
  QUERY: 'query',
});

// ── Severities ───────────────────────────────────────────────────────

const Severity = Object.freeze({
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
});

// ── Message envelope ─────────────────────────────────────────────────

function createMessage(type, payload, id) {
  const msg = { type, payload, timestamp: new Date().toISOString() };
  if (id) msg.id = id;
  return JSON.stringify(msg);
}

function parseMessage(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString());
  return {
    type: data.type || '',
    payload: data.payload || {},
    id: data.id || null,
    timestamp: data.timestamp || null,
  };
}

// ── Auth payload builders ────────────────────────────────────────────

function authApiKey(key, deviceId = '', clientVersion = '1.0.0') {
  return { method: 'api_key', key, device_id: deviceId, client_version: clientVersion };
}

function authDeviceToken(token, deviceId = '', clientVersion = '1.0.0') {
  return { method: 'device_token', token, device_id: deviceId, client_version: clientVersion };
}

function authUserPassword(username, password, deviceId = '', clientVersion = '1.0.0') {
  return { method: 'user_password', username, password, device_id: deviceId, client_version: clientVersion };
}

module.exports = {
  WidgetType,
  Action,
  Severity,
  createMessage,
  parseMessage,
  authApiKey,
  authDeviceToken,
  authUserPassword,
};
