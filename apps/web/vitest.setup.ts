import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// test.globals is off, so @testing-library cannot auto-detect a global afterEach.
afterEach(() => {
  cleanup();
});

// jsdom lacks modal dialog layout; real focus, inertness and scrolling stay unverified.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    return undefined;
  };
}
