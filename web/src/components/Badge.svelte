<script lang="ts">
  import { officerClassShort, officerClassCss, hullTypeLabel, rarityRank } from "../lib/game-enums.js";

  interface Props {
    /** Badge variant */
    kind: "rarity" | "class" | "hull" | "faction" | "group" | "target" | "conflict" | "reservation" | "dock";
    /** Raw value — meaning depends on kind */
    value: string | number | null | undefined;
    /** Optional explicit label (overrides auto-generated) */
    label?: string;
  }

  let { kind, value, label }: Props = $props();

  const display = $derived.by(() => {
    if (label) return label;
    if (value == null) return "";
    switch (kind) {
      case "rarity": return String(value);
      case "class": return officerClassShort(value as number);
      case "hull": return hullTypeLabel(value as number);
      case "faction": return String(value);
      case "group": return String(value);
      case "target": return "🎯";
      case "conflict": return "⚠️";
      case "reservation": return value ? "🔒" : "🔓";
      case "dock": return `Dock ${value}`;
      default: return String(value);
    }
  });

  const cssClass = $derived.by(() => {
    switch (kind) {
      case "rarity": {
        const r = String(value ?? "").toLowerCase();
        return `badge badge-rarity rarity-${r}`;
      }
      case "class":
        return `badge badge-class ${officerClassCss(value as number)}`;
      case "hull":
        return "badge badge-hull";
      case "faction":
        return "badge badge-faction";
      case "group":
        return "badge badge-group";
      case "target":
        return "badge badge-target";
      case "conflict":
        return "badge badge-conflict";
      case "reservation":
        return `badge badge-reservation ${value ? "locked" : ""}`;
      case "dock":
        return "badge badge-dock";
      default:
        return "badge";
    }
  });
</script>

{#if display}
  <span class={cssClass}>{display}</span>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.15em 0.45em;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: capitalize;
    white-space: nowrap;
    line-height: 1.4;
  }

  .badge-rarity {
    border: 1px solid currentColor;
  }
  .rarity-common { color: var(--lcars-text-dim, #889); }
  .rarity-uncommon { color: #4caf50; }
  .rarity-rare { color: #2196f3; }
  .rarity-epic { color: #9c27b0; }
  .rarity-legendary { color: var(--lcars-gold, #f1a731); }

  .badge-class {
    color: #fff;
    font-size: 0.7rem;
  }
  .class-cmd { background: #c62828; }
  .class-sci { background: #1565c0; }
  .class-eng { background: #2e7d32; }

  .badge-hull { color: var(--lcars-blue, #99f); }
  .badge-faction { color: var(--lcars-blue, #99f); }
  .badge-group { color: var(--lcars-text-dim, #889); }
  .badge-target { background: none; padding: 0; }
  .badge-conflict { background: none; padding: 0; }
  .badge-reservation { color: var(--lcars-gold, #f1a731); background: none; padding: 0; }
  .badge-dock { color: var(--lcars-blue, #99f); font-size: 0.7rem; }
</style>
