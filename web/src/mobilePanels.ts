export type MobilePanel = 'search' | 'view' | 'info' | 'credits' | '';

/** One mobile overlay at a time; CSS keeps the desktop layout independent. */
export function setMobilePanel(root: HTMLElement, panel: MobilePanel): void {
  root.dataset.mobilePanel = panel;
  root.dispatchEvent(new Event('mobile-panel-change'));
}
