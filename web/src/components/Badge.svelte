<script lang="ts">
  import { officerClassShort, officerClassCss, factionCss, hullTypeLabel, rarityRank } from "../lib/game-enums.js";

  interface Props {
    /** Badge variant */
    kind: "rarity" | "class" | "hull" | "faction" | "group" | "target" | "conflict" | "reservation" | "dock" | "instance";
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
      case "instance": return `#${String(value).replace(/^inst_/, "")}`;
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
        return `badge badge-faction ${factionCss(value as string)}`;
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
      case "instance":
        return "badge badge-instance";
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
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: capitalize;
    white-space: nowrap;
    line-height: 1.4;
  }

  .badge-rarity {
    border: 1px solid currentColor;
  }
  .rarity-common { color: var(--text-muted); }
  .rarity-uncommon { color: var(--accent-green); }
  .rarity-rare { color: var(--accent-blue); }
  .rarity-epic { color: var(--accent-purple); }
  .rarity-legendary { color: var(--accent-gold); }

  .badge-class {
    color: var(--text-primary);
    font-size: 0.7rem;
  }
  .class-cmd { background: var(--accent-red); }
  .class-sci { background: var(--accent-blue); }
  .class-eng { background: var(--accent-green); }

  .badge-hull { color: var(--accent-blue); }
  .badge-faction { color: var(--faction-independent); }
  .faction-federation { color: var(--faction-federation); }
  .faction-klingon { color: var(--faction-klingon); }
  .faction-romulan { color: var(--faction-romulan); }
  .faction-borg { color: var(--faction-borg); }
  .faction-independent { color: var(--faction-independent); }
  .badge-group { color: var(--text-muted); }
  .badge-target { background: none; padding: 0; }
  .badge-conflict { background: none; padding: 0; }
  .badge-reservation { color: var(--accent-gold); background: none; padding: 0; }
  .badge-dock { color: var(--accent-blue); font-size: 0.7rem; }
</style>
