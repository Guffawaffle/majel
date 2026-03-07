/**
 * boot-screen.ts — Controls the HTML boot screen rendered from index.html.
 *
 * The boot screen is pure HTML/CSS (no Svelte), visible before JS loads.
 * This module advances step indicators and removes the screen when done.
 */

function getStep(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `#boot-steps .lcars-step[data-step="${name}"]`
  );
}

/** Mark a step as actively running (sweep animation). */
export function bootStepActive(name: string): void {
  const el = getStep(name);
  if (!el) return;
  el.className = "lcars-step step-active";
  const indicator = el.querySelector(".step-indicator");
  if (indicator) indicator.innerHTML = '<span class="step-sweep"></span>';
}

/** Mark a step as completed. */
export function bootStepDone(name: string): void {
  const el = getStep(name);
  if (!el) return;
  el.className = "lcars-step step-done";
  const indicator = el.querySelector(".step-indicator");
  if (indicator) indicator.textContent = "■";
}

/** Mark a step as errored. */
export function bootStepError(name: string): void {
  const el = getStep(name);
  if (!el) return;
  el.className = "lcars-step step-error";
  const indicator = el.querySelector(".step-indicator");
  if (indicator) indicator.textContent = "✕";

  const status = document.getElementById("boot-status");
  if (status) {
    status.textContent = "FAULT";
    status.style.color = "#f87171";
  }
}

/** Fade out and remove the boot screen entirely. */
export function bootScreenDismiss(): void {
  const boot = document.getElementById("boot-screen");
  if (!boot) return;
  boot.classList.add("boot-done");
  setTimeout(() => boot.remove(), 350);
}
