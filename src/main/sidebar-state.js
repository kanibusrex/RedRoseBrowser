'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const STATE_FILE = () => path.join(app.getPath('userData'), 'sidebar-state.json');

const DEFAULT_TAB_PANEL_W = 200;
const MIN_TAB_PANEL_W = 160;
const MAX_TAB_PANEL_W = 480;

function clampTabPanelWidth(width) {
  const n = typeof width === 'number' && Number.isFinite(width) ? width : DEFAULT_TAB_PANEL_W;
  return Math.min(MAX_TAB_PANEL_W, Math.max(MIN_TAB_PANEL_W, n));
}

function loadSidebarWidth() {
  try {
    const stored = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    return clampTabPanelWidth(stored?.tabPanelWidth);
  } catch {
    return DEFAULT_TAB_PANEL_W;
  }
}

function saveSidebarWidth(width) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ tabPanelWidth: clampTabPanelWidth(width) }, null, 2), 'utf8');
  } catch {
    /* non-fatal — width just won't survive a restart */
  }
}

module.exports = { loadSidebarWidth, saveSidebarWidth, clampTabPanelWidth, DEFAULT_TAB_PANEL_W, MIN_TAB_PANEL_W, MAX_TAB_PANEL_W };
