(() => {
  if (customElements.get('mobius-desktop-page-actions')) return;

  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      :host {
        position: relative;
        display: inline-flex;
        height: 100%;
        flex: none;
        pointer-events: auto;
        color: inherit;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      button {
        all: unset;
        cursor: pointer;
        color: inherit;
        font: inherit;
      }
      .trigger {
        width: var(--mobius-page-actions-width, 38px);
        height: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.12s ease;
      }
      .trigger:hover,
      .trigger[aria-expanded="true"] {
        background: var(--mobius-page-actions-hover, rgba(148, 163, 184, 0.15));
      }
      .trigger svg {
        width: 12px;
        height: 12px;
      }
      .menu {
        position: absolute;
        top: 100%;
        right: 0;
        z-index: 2147483001;
        width: 144px;
        padding: 4px 0;
        overflow: hidden;
        border: 1px solid var(--mobius-page-actions-border, rgba(148, 163, 184, 0.24));
        border-radius: 6px;
        color: var(--mobius-page-actions-color, #e5e7eb);
        background: var(--mobius-page-actions-bg, #111827);
        box-shadow: 0 12px 32px rgba(2, 6, 23, 0.34);
      }
      .menu[hidden] { display: none; }
      .item {
        width: 100%;
        min-height: 17px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        font-size: 12px;
        line-height: 18px;
      }
      .item:hover,
      .item:focus-visible {
        background: var(--mobius-page-actions-hover, rgba(148, 163, 184, 0.15));
        outline: none;
      }
      .icon {
        width: 16px;
        flex: none;
        text-align: center;
        font-size: 15px;
        line-height: 1;
      }
    </style>
    <button type="button" class="trigger" title="页面操作" aria-label="打开页面操作菜单" aria-haspopup="menu" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
        <path d="M5 7h14M5 12h14M5 17h14"></path>
      </svg>
    </button>
    <div class="menu" role="menu" hidden>
      <button type="button" class="item" role="menuitem" data-page-action="reload"><span class="icon" aria-hidden="true">↻</span><span>刷新</span></button>
      <button type="button" class="item" role="menuitem" data-page-action="zoom-in"><span class="icon" aria-hidden="true">＋</span><span>放大</span></button>
      <button type="button" class="item" role="menuitem" data-page-action="zoom-out"><span class="icon" aria-hidden="true">－</span><span>缩小</span></button>
      <button type="button" class="item" role="menuitem" data-page-action="back"><span class="icon" aria-hidden="true">←</span><span>后退</span></button>
      <button type="button" class="item" role="menuitem" data-page-action="welcome"><span class="icon" aria-hidden="true">⌂</span><span>返回欢迎页</span></button>
    </div>
  `;

  class MobiusDesktopPageActions extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).append(template.content.cloneNode(true));
      this.trigger = this.shadowRoot.querySelector('.trigger');
      this.menu = this.shadowRoot.querySelector('.menu');
      this.handleDocumentPointerDown = (event) => {
        if (!event.composedPath().includes(this)) this.closeMenu();
      };
      this.handleDocumentKeyDown = (event) => {
        if (event.key === 'Escape') this.closeMenu();
      };
      this.trigger.addEventListener('click', () => this.toggleMenu());
      this.shadowRoot.querySelectorAll('[data-page-action]').forEach((button) => {
        button.addEventListener('click', () => this.runAction(button.dataset.pageAction));
      });
    }

    connectedCallback() {
      document.addEventListener('pointerdown', this.handleDocumentPointerDown);
      document.addEventListener('keydown', this.handleDocumentKeyDown);
    }

    disconnectedCallback() {
      document.removeEventListener('pointerdown', this.handleDocumentPointerDown);
      document.removeEventListener('keydown', this.handleDocumentKeyDown);
    }

    toggleMenu() {
      const open = this.menu.hasAttribute('hidden');
      if (open) this.openMenu();
      else this.closeMenu();
    }

    openMenu() {
      this.menu.removeAttribute('hidden');
      this.trigger.setAttribute('aria-expanded', 'true');
    }

    closeMenu() {
      this.menu.setAttribute('hidden', '');
      this.trigger.setAttribute('aria-expanded', 'false');
    }

    runAction(action) {
      this.closeMenu();
      const event = new CustomEvent('mobius-page-action', {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: { action },
      });
      if (!this.dispatchEvent(event)) return;

      if (action === 'back') {
        const fallback = this.getAttribute('back-fallback') || '/';
        const before = location.href;
        if (history.length > 1) {
          history.back();
          window.setTimeout(() => {
            if (location.href === before) location.assign(fallback);
          }, 700);
        } else {
          location.assign(fallback);
        }
      } else if (action === 'reload') {
        location.reload();
      } else if (action === 'zoom-in') {
        try { void window.mobiusDesktop?.windowZoomIn?.(); } catch (_) {}
      } else if (action === 'zoom-out') {
        try { void window.mobiusDesktop?.windowZoomOut?.(); } catch (_) {}
      } else if (action === 'welcome') {
        location.assign(this.getAttribute('welcome-path') || '/welcome');
      }
    }
  }

  customElements.define('mobius-desktop-page-actions', MobiusDesktopPageActions);
})();
