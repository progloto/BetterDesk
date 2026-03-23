'use strict';

const { CDAPBridge } = require('./bridge');
const { WidgetType, Action, Severity, createMessage, parseMessage } = require('./protocol');
const { Widget, gauge, toggle, button, textWidget, led, slider, select, chart, table } = require('./widgets');

module.exports = {
  CDAPBridge,
  Widget,
  WidgetType,
  Action,
  Severity,
  createMessage,
  parseMessage,
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
