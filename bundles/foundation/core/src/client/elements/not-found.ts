// <core-not-found>: what an outlet shows when no route matches the window
// path. The URL is left as it is.

import { showContents } from './lifecycle.js';

export class CoreNotFound extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['path'];
  }

  #path = '';

  get path(): string {
    return this.#path;
  }

  set path(value: string) {
    this.#path = String(value);
    this.#render();
  }

  attributeChangedCallback(
    _name: string,
    _old: string | null,
    value: string | null,
  ): void {
    this.path = value ?? '';
  }

  connectedCallback(): void {
    showContents(this);
    this.#render();
  }

  #render(): void {
    if (!this.isConnected) {
      return;
    }

    const status = document.createElement('div');
    const code = document.createElement('code');

    status.setAttribute('role', 'status');
    status.className = 'p-4 text-sm text-muted-foreground';
    code.textContent = this.#path;
    status.append('Nothing is registered at ', code, '.');
    this.replaceChildren(status);
  }
}
