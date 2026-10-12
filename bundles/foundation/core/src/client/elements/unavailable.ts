// <core-unavailable>: what ui/v1.create returns for a tag no active bundle
// owns. Hidden and empty, so an absent optional piece does not disturb a
// layout; `data-tag` names the tag that was asked for.

export class CoreUnavailable extends HTMLElement {
  get tag(): string | null {
    return this.getAttribute('data-tag');
  }

  connectedCallback(): void {
    if (!this.hidden) {
      this.hidden = true;
    }
  }
}
