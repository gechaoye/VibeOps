export const ELEMENT_TYPES = [
  'navigation-bar', 'bottom-navigation', 'tab', 'back', 'close', 'menu', 'hamburger', 'breadcrumb', 'pagination', 'stepper', 'sidebar', 'page-indicator',
  'button', 'primary-button', 'secondary-button', 'text-button', 'icon-button', 'floating-button', 'menu-button', 'menu-item', 'danger-button', 'link-button', 'icon', 'checkbox', 'radio', 'switch', 'toggle-button',
  'input', 'search-input', 'password-input', 'number-input', 'amount-input', 'url-input', 'email-input', 'phone-input', 'verification-code-input', 'pin-input', 'text-area', 'search',
  'dropdown', 'spinner', 'select', 'date-picker', 'time-picker', 'date-time-picker', 'city-picker', 'number-picker', 'address-picker', 'autocomplete', 'slider',
  'text', 'label', 'title', 'subtitle', 'caption', 'badge', 'static-chip', 'selectable-chip', 'filter-chip', 'action-chip', 'input-chip', 'avatar', 'avatar-group', 'image', 'banner', 'thumbnail', 'preview', 'product-image',
  'list', 'list-item', 'grouped-list', 'swipe-list', 'expandable-list',
  'container', 'card', 'panel', 'section', 'group', 'form', 'grid',
  'dialog', 'alert', 'confirm-dialog', 'bottom-sheet', 'popup', 'tooltip', 'snackbar', 'toast',
  'scroll-view', 'horizontal-scroll', 'recycler-view', 'carousel', 'pager',
  'error', 'warning', 'success', 'info', 'status',
  'progress-bar', 'circular-progress', 'loading', 'skeleton', 'download-progress',
  'video', 'audio', 'image-viewer', 'camera', 'file-preview',
  'map', 'marker', 'location', 'route', 'zoom-control', 'compass',
  'status-bar', 'system-navigation-bar', 'permission-dialog', 'keyboard', 'ime', 'system-dialog', 'notification', 'quick-settings', 'system-date-picker', 'system-picker', 'share-sheet',
  'gesture-region',
  'message-bubble', 'chat-input', 'send-button', 'voice-button', 'emoji-button', 'attachment-button', 'mention', 'reply', 'forward', 'read-status', 'typing-indicator',
  'product-card', 'price', 'discount', 'sku-selector', 'quantity-stepper', 'cart-button', 'buy-button', 'coupon',
  'approval-node', 'approval-status', 'signature', 'department-selector', 'employee-selector', 'date-range',
  'file-item', 'folder', 'file-tree', 'upload', 'download', 'rename', 'move', 'share', 'other',
];

export const SCOUT_ACTIONS = [
  'tap', 'double_tap', 'long_press',
  'input', 'clear', 'submit', 'toggle', 'select',
  'open', 'close', 'back', 'expand', 'collapse', 'previous', 'next',
  'scroll_vertical', 'scroll_horizontal', 'swipe', 'drag', 'fling', 'pinch', 'zoom', 'rotate', 'multi_touch',
  'play', 'pause', 'seek', 'fullscreen', 'volume', 'capture', 'record', 'switch_camera', 'flash',
  'upload', 'download', 'rename', 'move', 'share', 'other',
];

export function stringUnion(values) {
  return values.map((value) => JSON.stringify(value)).join('|');
}
