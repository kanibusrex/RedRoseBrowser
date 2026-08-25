'use strict';

// Fixed palette for tab groups — deliberately independent of the active
// color theme (see DESIGN.md §8) so group colors stay stable and
// distinguishable no matter which theme is active, matching how
// Chrome/Edge tab groups work. Must match the color *names* TabManager
// accepts (src/main/tab-manager.js GROUP_COLORS) — the hex values here
// are presentation-only, main only ever stores the name.
export const GROUP_COLORS = [
  { name: 'grey', hex: '#5f6368' },
  { name: 'blue', hex: '#1a73e8' },
  { name: 'red', hex: '#d93025' },
  { name: 'yellow', hex: '#f9ab00' },
  { name: 'green', hex: '#1e8e3e' },
  { name: 'pink', hex: '#d01884' },
  { name: 'purple', hex: '#8430ce' },
  { name: 'cyan', hex: '#12b5cb' },
];

export function groupColorHex(name) {
  return (GROUP_COLORS.find((c) => c.name === name) || GROUP_COLORS[0]).hex;
}
