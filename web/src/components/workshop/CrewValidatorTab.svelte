<script lang="ts">
  /**
   * CrewValidatorTab.svelte — "Does this crew work?" validation matrix.
   * ADR-034 Phase C (#134).
   *
   * Rendered inside WorkshopView in Basic mode.
   * User picks 3 officers + target context → sees per-ability evaluation matrix.
   */
  import "../../styles/workshop-shared.css";
  import "../../styles/crew-validator.css";
  import { INTENT_CATALOG } from "../../lib/intent-catalog.js";
  import type { BridgeSlot, CatalogOfficer } from "../../lib/types.js";
  import { getEffectBundleManager, type EffectBundleData } from "../../lib/effect-bundle-adapter.js";
  import { validateCrew, type CrewValidation } from "../../lib/crew-validator.js";

  interface Props {
    officers: CatalogOfficer[];
  }

  const { officers }: Props = $props();

  const SLOTS: BridgeSlot[] = ["captain", "bridge_1", "bridge_2"];
  const SLOT_LABEL: Record<BridgeSlot, string> = {
    captain: "Captain",
    bridge_1: "Bridge 1",
    bridge_2: "Bridge 2",
  };
  const TARGET_CLASS_OPTS = [
    { key: "any", label: "Any Target" },
    { key: "explorer", label: "Vs Explorer" },
    { key: "interceptor", label: "Vs Interceptor" },
    { key: "battleship", label: "Vs Battleship" },
  ] as const;

  let intentKey = $state("grinding");
  let shipClass = $state("");
  let targetClass = $state<"any" | "explorer" | "interceptor" | "battleship">("any");

  let selectedSlots = $state<Record<BridgeSlot, string>>({
    captain: "",
    bridge_1: "",
    bridge_2: "",
  });

  let pickerSlot = $state<BridgeSlot | null>(null);
  let pickerSearch = $state("");

  /** Effect bundle — null until loaded. */
  let effectBundle = $state<EffectBundleData | null>(null);
  let bundleError = $state(false);

  $effect(() => {
    getEffectBundleManager().load()
      .then((bundle) => { effectBundle = bundle; })
      .catch(() => { bundleError = true; });
  });

  const ownedOfficers = $derived(
    officers
      .filter((o) => o.ownershipState !== "unowned")
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  const officerById = $derived(new Map(ownedOfficers.map((o) => [o.id, o])));

  const trioComplete = $derived(
    Boolean(selectedSlots.captain && selectedSlots.bridge_1 && selectedSlots.bridge_2),
  );

  /** Run validation whenever crew or context changes. */
  const validation = $derived.by((): CrewValidation | null => {
    if (!effectBundle || !trioComplete) return null;

    const officerNames: Record<string, string> = {};
    for (const slot of SLOTS) {
      const id = selectedSlots[slot];
      if (id) officerNames[id] = officerById.get(id)?.name ?? id;
    }

    return validateCrew({
      slots: selectedSlots,
      officerNames,
      intentKey,
      shipClass: shipClass || null,
      targetClass,
      effectBundle,
    });
  });

  // ── Picker ──

  const pickerList = $derived.by(() => {
    if (!pickerSlot) return [];
    const q = pickerSearch.trim().toLowerCase();
    return ownedOfficers
      .filter((o) => {
        if (q && !o.name.toLowerCase().includes(q)) return false;
        for (const s of SLOTS) {
          if (s !== pickerSlot && selectedSlots[s] === o.id) return false;
        }
        return true;
      })
      .slice(0, 40);
  });

  function openPicker(slot: BridgeSlot) {
    pickerSlot = slot;
    pickerSearch = "";
  }

  function pickOfficer(officerId: string) {
    if (!pickerSlot) return;
    selectedSlots[pickerSlot] = officerId;
    pickerSlot = null;
  }

  function clearSlot(slot: BridgeSlot) {
    selectedSlots[slot] = "";
  }

  function officerName(id: string): string {
    return officerById.get(id)?.name ?? id;
  }

  function abilitySlotLabel(slot: string): string {
    switch (slot) {
      case "cm": return "CM";
      case "oa": return "OA";
      case "bda": return "BDA";
      default: return slot.toUpperCase();
    }
  }

  function statusIcon(status: string): string {
    switch (status) {
      case "works": return "✓";
      case "conditional": return "?";
      case "blocked": return "✗";
      default: return "·";
    }
  }

  function verdictClass(verdict: string): string {
    return `cv-verdict cv-verdict-${verdict}`;
  }

  function effectClass(status: string): string {
    return `cv-effect cv-effect-${status}`;
  }

  function issueClass(severity: string): string {
    return `cv-issue-icon cv-issue-${severity}`;
  }

  function issueSeverityIcon(severity: string): string {
    switch (severity) {
      case "blocker": return "⊘";
      case "conditional": return "◑";
      case "info": return "ℹ";
      default: return "·";
    }
  }

  function formatEffectKey(key: string): string {
    return key.replace(/_/g, " ");
  }

  function handleBackdropKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") pickerSlot = null;
  }
</script>

<section class="crew-validator">
  <div class="ws-toolbar">
    <h3>Crew Validator</h3>
  </div>

  <p class="cv-intro">
    Pick a crew and target — see exactly which abilities work, which are conditional, and which don't apply.
  </p>

  {#if bundleError}
    <p class="cv-no-bundle">Effect data unavailable. The effect catalog must be loaded before validation works.</p>
  {:else if !effectBundle}
    <p class="cv-no-bundle">Loading effect catalog…</p>
  {:else}
    <!-- Context config -->
    <div class="ws-form cv-config">
      <div class="ws-form-grid">
        <label class="ws-field">
          <span>Objective</span>
          <select bind:value={intentKey}>
            {#each INTENT_CATALOG as intent}
              <option value={intent.key}>{intent.icon} {intent.label}</option>
            {/each}
          </select>
        </label>

        <label class="ws-field">
          <span>Target Profile</span>
          <select bind:value={targetClass}>
            {#each TARGET_CLASS_OPTS as opt}
              <option value={opt.key}>{opt.label}</option>
            {/each}
          </select>
        </label>
      </div>
    </div>

    <!-- Crew slot bar -->
    <div class="cv-crew-bar">
      {#each SLOTS as slot}
        <button
          class="cv-slot-card"
          type="button"
          onclick={() => openPicker(slot)}
          aria-label={selectedSlots[slot]
            ? `Change ${SLOT_LABEL[slot]}: ${officerName(selectedSlots[slot])}`
            : `Pick ${SLOT_LABEL[slot]}`}
        >
          <div class="cv-slot-header">
            <span>{SLOT_LABEL[slot]}</span>
            {#if validation}
              {@const off = validation.officers.find((o) => o.slot === slot)}
              {#if off}
                <span class={verdictClass(off.verdict)}>{off.verdict}</span>
              {/if}
            {/if}
          </div>
          <div class="cv-slot-officer">
            <span class="cv-slot-officer-name">
              {selectedSlots[slot] ? officerName(selectedSlots[slot]) : "Unassigned"}
            </span>
            {#if selectedSlots[slot]}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span
                class="cv-slot-remove"
                role="button"
                tabindex="0"
                aria-label={`Remove ${officerName(selectedSlots[slot])} from ${SLOT_LABEL[slot]}`}
                onclick={(e) => { e.stopPropagation(); clearSlot(slot); }}
                onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); clearSlot(slot); } }}
              >×</span>
            {/if}
          </div>
        </button>
      {/each}
    </div>

    <!-- Validation results -->
    {#if validation}
      <!-- Summary -->
      <div class="cv-summary">
        <div class="cv-summary-header">
          <h4>Crew Assessment</h4>
          <span class={verdictClass(validation.verdict)}>{validation.verdict}</span>
          <span class="cv-officer-score">{validation.totalScore}</span>
        </div>
        {#if validation.summary.length > 0}
          <ul class="cv-summary-lines">
            {#each validation.summary as line}
              <li>{line}</li>
            {/each}
          </ul>
        {/if}
      </div>

      <!-- Per-officer matrix -->
      <div class="cv-matrix">
        {#each validation.officers as off}
          <div class="cv-officer-card">
            <div class="cv-officer-header">
              <span class="cv-officer-name">{off.officerName}</span>
              <span class="cv-officer-slot">{SLOT_LABEL[off.slot]}</span>
              <span class={verdictClass(off.verdict)}>{off.verdict}</span>
              <span class="cv-officer-score">{off.totalScore}</span>
            </div>

            <div class="cv-abilities">
              {#each off.evaluation.abilities as ability}
                <div class="cv-ability">
                  <div class="cv-ability-header">
                    <span class="cv-ability-slot">{abilitySlotLabel(ability.slot)}</span>
                    {#if ability.isInert}
                      <span class="cv-ability-inert">Inert (no effect)</span>
                    {:else}
                      <span class="cv-ability-name">{ability.abilityId}</span>
                    {/if}
                  </div>

                  {#if !ability.isInert && ability.effects.length > 0}
                    <div class="cv-effects">
                      {#each ability.effects as effect}
                        <span class={effectClass(effect.status)}>
                          <span class="cv-effect-status-icon">{statusIcon(effect.status)}</span>
                          <span class="cv-effect-key">{formatEffectKey(effect.effectKey)}</span>
                          {#if effect.applicabilityMultiplier < 1}
                            <span class="cv-effect-magnitude">×{effect.applicabilityMultiplier}</span>
                          {/if}
                        </span>
                      {/each}
                    </div>
                  {/if}

                  {#if !ability.isInert}
                    {@const abilityIssues = ability.effects.flatMap((e) => e.issues)}
                    {#if abilityIssues.length > 0}
                      <div class="cv-issues">
                        {#each abilityIssues as issue}
                          <div class="cv-issue">
                            <span class={issueClass(issue.severity)}>{issueSeverityIcon(issue.severity)}</span>
                            <span>{issue.message}</span>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  {/if}
                </div>
              {/each}

              {#if off.evaluation.abilities.length === 0}
                <p class="cv-ability-inert">No abilities cataloged for this officer.</p>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else if !trioComplete}
      <p class="ws-empty">Assign all three slots to see the validation matrix.</p>
    {/if}
  {/if}

  <!-- Officer picker modal -->
  {#if pickerSlot}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="cv-backdrop"
      onclick={() => { pickerSlot = null; }}
      onkeydown={handleBackdropKeydown}
    ></div>
    <div class="cv-modal" role="dialog" aria-modal="true" aria-label={`Pick ${SLOT_LABEL[pickerSlot]}`}>
      <div class="cv-modal-header">
        <h4>Pick {SLOT_LABEL[pickerSlot]}</h4>
        <button class="ws-btn ws-btn-cancel" onclick={() => { pickerSlot = null; }} aria-label="Close picker">×</button>
      </div>
      <label class="ws-field ws-wide cv-modal-search">
        <span>Search</span>
        <input
          type="text"
          value={pickerSearch}
          oninput={(event) => { pickerSearch = (event.currentTarget as HTMLInputElement).value; }}
          placeholder="Search officer"
        />
      </label>
      <div class="cv-picker-list">
        {#each pickerList as officer}
          <button class="cv-pick" onclick={() => pickOfficer(officer.id)}>
            {officer.name}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</section>
