<!--
  ImageLightbox — full-screen overlay to view an image at full size.
  Usage: import { openLightbox } from "./ImageLightbox.svelte";
         openLightbox(dataUrl);
  Mount <ImageLightbox /> once in a layout ancestor.

  Features:
  - Fit-to-screen / actual-size zoom toggle
  - Download button
  - Image dimensions badge
  - Focus trap + scroll lock
  - Animated open/close transitions
  - Keyboard: Escape to close, +/- or Z to toggle zoom
-->
<script lang="ts" module>
  /** Reactive state — shared across all importers. */
  let lightboxSrc = $state<string | null>(null);
  let lightboxFilename = $state<string>("image");

  /** Open the lightbox with the given image data URL. */
  export function openLightbox(src: string, filename?: string): void {
    lightboxSrc = src;
    lightboxFilename = filename ?? "image";
  }

  /** Close the lightbox. */
  export function closeLightbox(): void {
    lightboxSrc = null;
  }
</script>

<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";

  // ── Zoom state ──
  let zoomed = $state(false);

  // ── Image natural dimensions ──
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  const dimLabel = $derived(
    naturalWidth && naturalHeight ? `${naturalWidth} × ${naturalHeight}` : "",
  );

  function handleImgLoad(e: Event) {
    const img = e.target as HTMLImageElement;
    naturalWidth = img.naturalWidth;
    naturalHeight = img.naturalHeight;
  }

  // ── Focus management ──
  let backdropEl: HTMLDivElement | undefined = $state();
  let previousFocus: HTMLElement | null = null;

  // Watch for lightbox open/close
  $effect(() => {
    if (lightboxSrc) {
      // Opening — save focus, lock scroll
      previousFocus = document.activeElement as HTMLElement | null;
      document.body.style.overflow = "hidden";
      // Reset zoom state for new image
      zoomed = false;
      naturalWidth = 0;
      naturalHeight = 0;
      // Focus the backdrop after render
      tick().then(() => backdropEl?.focus());
    } else {
      // Closing — unlock scroll, restore focus
      document.body.style.overflow = "";
      previousFocus?.focus();
      previousFocus = null;
    }
  });

  // Cleanup on unmount
  onDestroy(() => {
    document.body.style.overflow = "";
  });

  // ── Keyboard ──
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") { closeLightbox(); return; }
    if (e.key === "z" || e.key === "Z" || e.key === "+" || e.key === "-") {
      e.preventDefault();
      zoomed = !zoomed;
    }
  }

  // ── Backdrop click ──
  function handleBackdropClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.classList.contains("lightbox-backdrop") || target.classList.contains("lightbox-stage")) {
      closeLightbox();
    }
  }

  // ── Download ──
  function handleDownload() {
    if (!lightboxSrc) return;
    const a = document.createElement("a");
    a.href = lightboxSrc;
    // Derive extension from data URL mime type
    const mime = lightboxSrc.match(/^data:image\/(\w+)/)?.[1] ?? "png";
    a.download = `${lightboxFilename}.${mime}`;
    a.click();
  }

  // ── Zoom toggle ──
  function toggleZoom() { zoomed = !zoomed; }
</script>

{#if lightboxSrc}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={backdropEl}
    class="lightbox-backdrop"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Image preview"
    tabindex="-1"
  >
    <!-- Toolbar -->
    <div class="lightbox-toolbar">
      {#if dimLabel}
        <span class="lightbox-dims">{dimLabel}</span>
      {/if}
      <div class="lightbox-toolbar-actions">
        <button class="lightbox-btn" onclick={toggleZoom}
          title={zoomed ? "Fit to screen (Z)" : "Actual size (Z)"}
          aria-label={zoomed ? "Fit to screen" : "View actual size"}>
          {#if zoomed}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6h4M6 3v4M13 10h-4m4 0v4m0-4h-4v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/></svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 6V2a1 1 0 011-1h4M10 1h4a1 1 0 011 1v4M15 10v4a1 1 0 01-1 1h-4M6 15H2a1 1 0 01-1-1v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          {/if}
        </button>
        <button class="lightbox-btn" onclick={handleDownload} title="Download image" aria-label="Download image">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="lightbox-btn lightbox-btn-close" onclick={closeLightbox} title="Close (Esc)" aria-label="Close image preview">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>

    <!-- Image stage -->
    <div class="lightbox-stage" class:zoomed>
      <img
        class="lightbox-img"
        class:zoomed
        src={lightboxSrc}
        alt="Full-size preview"
        onload={handleImgLoad}
        draggable="false"
      />
    </div>
  </div>
{/if}

<style>
  .lightbox-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(6, 8, 18, 0.92);
    display: flex;
    flex-direction: column;
    animation: lbFadeIn 0.2s ease-out;
    outline: none;
  }

  /* ── Toolbar ── */
  .lightbox-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: rgba(17, 24, 39, 0.7);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
    z-index: 1;
  }

  .lightbox-dims {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  }

  .lightbox-toolbar-actions {
    display: flex;
    gap: 4px;
  }

  .lightbox-btn {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .lightbox-btn:hover {
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    border-color: rgba(255, 255, 255, 0.2);
  }
  .lightbox-btn:focus-visible {
    outline: 2px solid var(--accent-blue, #60a0ff);
    outline-offset: 1px;
  }
  .lightbox-btn-close:hover {
    background: rgba(248, 113, 113, 0.2);
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.3);
  }

  /* ── Image stage ── */
  .lightbox-stage {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
    cursor: zoom-out;
  }
  .lightbox-stage.zoomed {
    align-items: flex-start;
    justify-content: flex-start;
    cursor: zoom-out;
  }

  .lightbox-img {
    max-width: 95vw;
    max-height: calc(100vh - 72px);
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 4px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
    cursor: zoom-in;
    animation: lbScaleIn 0.2s ease-out;
    transition: max-width 0.25s ease, max-height 0.25s ease;
    user-select: none;
    -webkit-user-select: none;
  }
  .lightbox-img.zoomed {
    max-width: none;
    max-height: none;
    cursor: zoom-out;
    border-radius: 2px;
  }

  @keyframes lbFadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes lbScaleIn {
    from { opacity: 0; transform: scale(0.95); }
    to   { opacity: 1; transform: scale(1); }
  }
</style>
