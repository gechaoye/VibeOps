export const ELEMENT_TYPES = [
  'navigation-bar', 'sidebar', 'drawer', 'hamburger', 'tab', 'breadcrumb', 'page-indicator', 'pagination',
  'text-button', 'icon-button', 'floating-button', 'radio', 'checkbox', 'switch',
  'input', 'search-input', 'password-input', 'number-input', 'amount-input', 'url-input', 'email-input', 'phone-input', 'verification-code-input', 'pin-input', 'text-area', 'search',
  'dropdown', 'spinner', 'select', 'date-picker', 'time-picker', 'date-time-picker', 'city-picker', 'number-picker', 'address-picker', 'autocomplete', 'slider',
  'text', 'label', 'title', 'subtitle', 'caption', 'badge', 'static-chip', 'selectable-chip', 'filter-chip', 'action-chip', 'input-chip', 'avatar', 'avatar-group', 'image', 'banner', 'thumbnail', 'preview', 'product-image', 'carousel',
  'list', 'list-item', 'grouped-list', 'swipe-list', 'expandable-list',
  'container', 'card', 'panel', 'section', 'group', 'form', 'grid',
  'dialog', 'alert', 'confirm-dialog', 'bottom-sheet', 'popup', 'tooltip', 'snackbar', 'toast',
  'scroll-view', 'horizontal-scroll', 'recycler-view', 'pager',
  'error', 'warning', 'success', 'info', 'status',
  'progress-bar', 'circular-progress', 'loading', 'skeleton', 'download-progress',
  'video', 'audio', 'image-viewer', 'camera', 'file-preview', 'live-stream', 'screen-share', 'remote-control',
  'map', 'marker', 'location', 'route', 'zoom-control', 'compass',
  'status-bar', 'system-navigation-bar', 'permission-dialog', 'keyboard', 'ime', 'system-dialog', 'notification', 'quick-settings', 'system-date-picker', 'system-picker', 'share-sheet',
  'gesture-region',
  'message-bubble', 'chat-input', 'send-button', 'voice-button', 'emoji-button', 'attachment-button', 'mention', 'reply', 'forward', 'read-status', 'typing-indicator',
  'product-card', 'price', 'discount', 'sku-selector', 'quantity-stepper', 'cart-button', 'buy-button', 'coupon',
  'approval-node', 'approval-status', 'signature', 'department-selector', 'employee-selector', 'date-range',
  'file-item', 'folder', 'file-tree', 'upload', 'download', 'rename', 'move', 'share', 'other',
];

export const WORKER_ACTIONS = ['tap', 'double_tap', 'long_press', 'input', 'delete', 'scroll_vertical', 'scroll_horizontal', 'swipe', 'drag', 'zoom', 'multi_touch'];
export const ELEMENT_ACTIONS = ['none', ...WORKER_ACTIONS];

export function stringUnion(values) {
  return values.map((value) => JSON.stringify(value)).join('|');
}
