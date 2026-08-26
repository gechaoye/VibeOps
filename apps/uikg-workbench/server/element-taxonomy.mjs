export const ELEMENT_TYPES = [
  'navigation-bar', 'sidebar', 'drawer', 'hamburger', 'tab', 'breadcrumb', 'page-indicator', 'pagination',
  'text-button', 'icon-button', 'floating-button', 'switch', 'slider',
  'input', 'text-area', 'rich-text-input',
  'dropdown-selector', 'radio', 'checkbox', 'wheel-picker', 'date-picker', 'time-picker', 'date-time-picker', 'number-picker', 'cascader', 'tag-selector', 'segmented-selector',
  'text', 'static-label', 'title', 'subtitle', 'caption', 'badge', 'avatar', 'image', 'banner', 'thumbnail', 'preview', 'carousel',
  'avatar-group', 'list', 'list-item', 'grouped-list', 'swipe-list', 'expandable-list',
  'card', 'panel', 'section', 'form', 'table', 'chart', 'audio', 'video', 'image-viewer', 'file-preview',
  'dialog', 'confirm-dialog', 'bottom-sheet', 'popover', 'floating-card', 'toast',
  'progress-bar', 'loading',
  'map', 'marker', 'location', 'route', 'zoom-control', 'compass',
  'status-bar', 'system-navigation-bar', 'permission-dialog', 'keyboard', 'ime', 'system-dialog', 'notification', 'quick-settings', 'system-date-picker', 'system-picker', 'share-sheet',
  'gesture-region',
];

export const RECOGNITION_ACTIONS = ['tap', 'double_tap', 'long_press', 'input', 'scroll_vertical', 'scroll_horizontal', 'swipe', 'drag', 'zoom', 'multi_touch'];
export const ELEMENT_ACTIONS = ['none', ...RECOGNITION_ACTIONS];

export function stringUnion(values) {
  return values.map((value) => JSON.stringify(value)).join('|');
}
