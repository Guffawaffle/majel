<!--
  LoadingScreen.svelte — LCARS-style boot sequence display.
  Shows animated system initialization steps during app startup.
-->
<script lang="ts">
  export type BootStep = { label: string; status: "pending" | "active" | "done" | "error" };

  interface Props {
    steps: BootStep[];
    error?: string | null;
  }

  let { steps, error = null }: Props = $props();

  const stardate = (() => {
    const now = new Date();
    const y = now.getFullYear();
    const frac = ((now.getTime() - new Date(y, 0, 1).getTime()) / (365.25 * 86_400_000)).toFixed(1);
    return `${y - 1900}${frac.slice(1)}`;
  })();
</script>

<div class="lcars-boot" role="status" aria-live="polite" aria-label="System loading">
  <!-- Top frame bar -->
  <div class="lcars-frame-top">
    <div class="lcars-elbow lcars-elbow-tl"></div>
    <div class="lcars-bar lcars-bar-top"></div>
    <div class="lcars-cap lcars-cap-tr"></div>
  </div>

  <div class="lcars-body">
    <!-- Left rail -->
    <div class="lcars-rail">
      <div class="lcars-block lcars-block-gold"></div>
      <div class="lcars-block lcars-block-blue"></div>
      <div class="lcars-block lcars-block-purple"></div>
      <div class="lcars-block lcars-block-gold lcars-block-grow"></div>
    </div>

    <!-- Main content area -->
    <div class="lcars-content">
      <div class="lcars-header">
        <span class="lcars-title">ARIADNE</span>
        <span class="lcars-subtitle">FLEET INTELLIGENCE SYSTEM</span>
      </div>

      <div class="lcars-readout">
        <div class="lcars-readout-row">
          <span class="lcars-label">STARDATE</span>
          <span class="lcars-value">{stardate}</span>
        </div>
        <div class="lcars-readout-row">
          <span class="lcars-label">STATUS</span>
          <span class="lcars-value" class:lcars-error={!!error}>
            {error ? "FAULT" : "INITIALIZING"}
          </span>
        </div>
      </div>

      <div class="lcars-steps">
        {#each steps as step, i}
          <div
            class="lcars-step"
            class:step-pending={step.status === "pending"}
            class:step-active={step.status === "active"}
            class:step-done={step.status === "done"}
            class:step-error={step.status === "error"}
          >
            <span class="step-indicator">
              {#if step.status === "done"}
                ■
              {:else if step.status === "active"}
                <span class="step-sweep"></span>
              {:else if step.status === "error"}
                ✕
              {:else}
                □
              {/if}
            </span>
            <span class="step-id">{String(i + 1).padStart(2, "0")}</span>
            <span class="step-label">{step.label}</span>
          </div>
        {/each}
      </div>

      {#if error}
        <div class="lcars-error-detail">{error}</div>
      {/if}

      <div class="lcars-scan">
        <div class="lcars-scanline"></div>
      </div>
    </div>
  </div>

  <!-- Bottom frame bar -->
  <div class="lcars-frame-bottom">
    <div class="lcars-elbow lcars-elbow-bl"></div>
    <div class="lcars-bar lcars-bar-bottom"></div>
    <div class="lcars-cap lcars-cap-br"></div>
  </div>
</div>

<style>
  /* ── Container ─────────────────────────────────────────── */
  .lcars-boot {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-primary, #0a0e1a);
    font-family: "Century Gothic", "URW Gothic", "Apple SD Gothic Neo", system-ui, sans-serif;
    overflow: hidden;
    user-select: none;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Top / Bottom frame bars ───────────────────────────── */
  .lcars-frame-top,
  .lcars-frame-bottom {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
  }

  .lcars-elbow {
    width: 120px;
    height: 40px;
    flex-shrink: 0;
  }

  .lcars-elbow-tl {
    background: var(--accent-gold, #f0a030);
    border-bottom-right-radius: 32px;
  }
  .lcars-elbow-bl {
    background: var(--accent-gold, #f0a030);
    border-top-right-radius: 32px;
  }

  .lcars-bar {
    flex: 1;
    height: 14px;
  }
  .lcars-bar-top {
    background: var(--accent-gold, #f0a030);
    border-bottom-left-radius: 8px;
    border-bottom-right-radius: 8px;
    align-self: flex-start;
  }
  .lcars-bar-bottom {
    background: var(--accent-blue, #60a0ff);
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    align-self: flex-end;
  }

  .lcars-cap {
    width: 60px;
    height: 14px;
    flex-shrink: 0;
  }
  .lcars-cap-tr {
    background: var(--accent-gold, #f0a030);
    border-bottom-left-radius: 8px;
    border-bottom-right-radius: 14px;
    align-self: flex-start;
  }
  .lcars-cap-br {
    background: var(--accent-blue, #60a0ff);
    border-top-left-radius: 8px;
    border-top-right-radius: 14px;
    align-self: flex-end;
  }

  /* ── Body: rail + content ──────────────────────────────── */
  .lcars-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* ── Left rail (color blocks) ──────────────────────────── */
  .lcars-rail {
    width: 120px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 0;
    flex-shrink: 0;
  }

  .lcars-block {
    width: 100%;
    border-top-right-radius: 16px;
    border-bottom-right-radius: 16px;
  }
  .lcars-block-gold   { background: var(--accent-gold, #f0a030); height: 48px; }
  .lcars-block-blue   { background: var(--accent-blue, #60a0ff); height: 32px; }
  .lcars-block-purple  { background: var(--accent-purple, #a78bfa); height: 24px; }
  .lcars-block-grow   { flex: 1; min-height: 48px; }

  /* ── Content area ──────────────────────────────────────── */
  .lcars-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 32px;
    gap: 28px;
    min-width: 0;
  }

  /* ── Header ────────────────────────────────────────────── */
  .lcars-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  .lcars-title {
    font-size: 36px;
    font-weight: 700;
    color: var(--accent-gold, #f0a030);
    letter-spacing: 12px;
    text-indent: 12px;
  }

  .lcars-subtitle {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, #8494a7);
    letter-spacing: 6px;
    text-indent: 6px;
    text-transform: uppercase;
  }

  /* ── Readout rows ──────────────────────────────────────── */
  .lcars-readout {
    display: flex;
    gap: 32px;
  }

  .lcars-readout-row {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }

  .lcars-label {
    font-size: 10px;
    font-weight: 700;
    color: var(--accent-blue, #60a0ff);
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  .lcars-value {
    font-size: 13px;
    color: var(--text-secondary, #94a3b8);
    font-variant-numeric: tabular-nums;
    letter-spacing: 1px;
  }

  .lcars-value.lcars-error {
    color: var(--accent-red, #f87171);
  }

  /* ── Boot steps ────────────────────────────────────────── */
  .lcars-steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    max-width: 380px;
  }

  .lcars-step {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 13px;
    letter-spacing: 1px;
    transition: opacity 0.2s ease, background 0.2s ease, color 0.2s ease;
  }

  .step-pending {
    opacity: 0.3;
    color: var(--text-muted, #8494a7);
  }

  .step-active {
    opacity: 1;
    color: var(--accent-gold, #f0a030);
    background: rgba(240, 160, 48, 0.06);
  }

  .step-done {
    opacity: 0.7;
    color: var(--accent-green, #34d399);
  }

  .step-error {
    opacity: 1;
    color: var(--accent-red, #f87171);
    background: rgba(248, 113, 113, 0.06);
  }

  .step-indicator {
    width: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    flex-shrink: 0;
  }

  .step-id {
    font-size: 10px;
    font-weight: 700;
    color: var(--accent-blue, #60a0ff);
    opacity: 0.6;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .step-label {
    text-transform: uppercase;
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 1.5px;
  }

  /* ── Sweep animation for active step ───────────────────── */
  .step-sweep {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--accent-gold, #f0a030);
    animation: sweep 0.8s ease-in-out infinite;
  }

  @keyframes sweep {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.3; transform: scale(0.7); }
  }

  /* ── Error detail ──────────────────────────────────────── */
  .lcars-error-detail {
    font-size: 13px;
    color: var(--accent-red, #f87171);
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.2);
    border-radius: 6px;
    padding: 12px 20px;
    max-width: 420px;
    text-align: center;
    line-height: 1.6;
  }

  /* ── Animated scan bar ─────────────────────────────────── */
  .lcars-scan {
    width: 100%;
    max-width: 380px;
    height: 3px;
    background: rgba(96, 160, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
    position: relative;
  }

  .lcars-scanline {
    position: absolute;
    width: 40%;
    height: 100%;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--accent-blue, #60a0ff) 50%,
      transparent 100%
    );
    border-radius: 2px;
    animation: scan 1.8s ease-in-out infinite;
  }

  @keyframes scan {
    0% { left: -40%; }
    100% { left: 100%; }
  }

  /* ── Mobile ────────────────────────────────────────────── */
  @media (max-width: 600px) {
    .lcars-rail { width: 60px; }
    .lcars-elbow { width: 60px; height: 28px; }
    .lcars-title { font-size: 24px; letter-spacing: 8px; text-indent: 8px; }
    .lcars-subtitle { font-size: 9px; letter-spacing: 4px; }
    .lcars-content { padding: 24px 16px; gap: 20px; }
    .lcars-readout { flex-direction: column; gap: 8px; }
    .lcars-block-gold { height: 32px; }
    .lcars-block-blue { height: 24px; }
    .lcars-block-purple { height: 18px; }
  }
</style>
