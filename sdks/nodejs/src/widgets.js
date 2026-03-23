'use strict';

/**
 * Widget definition helpers for CDAP manifest construction.
 */

class Widget {
  constructor(type, id, label, opts = {}) {
    this.type = type;
    this.id = id;
    this.label = label;
    Object.assign(this, opts);
  }

  toJSON() {
    const d = { type: this.type, id: this.id, label: this.label };
    const optionalKeys = [
      'group', 'value', 'readonly', 'unit', 'min', 'max', 'step', 'precision',
      'warning_low', 'warning_high', 'confirm', 'confirm_message', 'style',
      'icon', 'cooldown', 'options', 'chart_type', 'points', 'series',
      'retention', 'columns', 'max_rows', 'sortable', 'permissions',
    ];
    for (const key of optionalKeys) {
      if (this[key] !== undefined && this[key] !== null && this[key] !== 0 && this[key] !== '' && this[key] !== false) {
        d[key] = this[key];
      }
    }
    // Always include permissions if present (even if empty sub-fields)
    if (this.permissions) d.permissions = this.permissions;
    return d;
  }
}

// ── Factory helpers ──────────────────────────────────────────────────

function gauge(id, label, opts = {}) {
  return new Widget('gauge', id, label, {
    unit: '%', min: 0, max: 100, precision: 1,
    permissions: { read: 'viewer' },
    ...opts,
  });
}

function toggle(id, label, opts = {}) {
  return new Widget('toggle', id, label, {
    value: false,
    permissions: { read: 'viewer', control: 'operator' },
    ...opts,
  });
}

function button(id, label, opts = {}) {
  return new Widget('button', id, label, {
    permissions: { control: 'operator' },
    ...opts,
  });
}

function textWidget(id, label, opts = {}) {
  return new Widget('text', id, label, {
    readonly: true,
    permissions: { read: 'viewer' },
    ...opts,
  });
}

function led(id, label, opts = {}) {
  return new Widget('led', id, label, {
    value: false,
    permissions: { read: 'viewer' },
    ...opts,
  });
}

function slider(id, label, opts = {}) {
  return new Widget('slider', id, label, {
    min: 0, max: 100, step: 1,
    permissions: { read: 'viewer', control: 'operator' },
    ...opts,
  });
}

function select(id, label, opts = {}) {
  return new Widget('select', id, label, {
    options: [],
    permissions: { read: 'viewer', control: 'operator' },
    ...opts,
  });
}

function chart(id, label, opts = {}) {
  return new Widget('chart', id, label, {
    chart_type: 'line', points: 60, series: [],
    permissions: { read: 'viewer' },
    ...opts,
  });
}

function table(id, label, opts = {}) {
  return new Widget('table', id, label, {
    columns: [], max_rows: 100, sortable: true,
    permissions: { read: 'viewer' },
    ...opts,
  });
}

module.exports = {
  Widget,
  gauge,
  toggle,
  button,
  textWidget,
  led,
  slider,
  select,
  chart,
  table,
};
