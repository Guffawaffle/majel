<script lang="ts">
  import "../../styles/workshop-shared.css";
  import "../../styles/quick-crew.css";
  import { createBridgeCore, type BridgeCoreMemberInput } from "../../lib/api/crews.js";
  import { INTENT_CATALOG, intentLabel } from "../../lib/intent-catalog.js";
  import type { BridgeSlot, CatalogOfficer, CatalogShip, OfficerReservation } from "../../lib/types.js";
  import {
    createInitialQuickCrewState,
    routeQuickCrewCommand,
    type QuickCrewCommand,
  } from "../../lib/quick-crew-commands.js";
  import {
    confidenceLabel,
    findOfficerName,
    recommendationSlots,
    recommendBridgeTrios,
    scoreOfficerForSlot,
    type CrewRecommendation,
  } from "../../lib/crew-recommender.js";

  interface Props {
    officers: CatalogOfficer[];
    ships: CatalogShip[];
    reservations: OfficerReservation[];
    onRefresh: () => Promise<void>;
  }

  const { officers, ships, reservations, onRefresh }: Props = $props();

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
  let shipId = $state("");
  let targetClass = $state<"any" | "explorer" | "interceptor" | "battleship">("any");
  let captainAssist = $state(false);
  let captainId = $state("");

  let ui = $state(createInitialQuickCrewState());

  let saveName = $state("");
  let saveNotes = $state("");
  let saveError = $state("");
  let saveBusy = $state(false);

  function send(command: QuickCrewCommand) {
    ui = routeQuickCrewCommand(ui, command);
  }

  const ownedOfficers = $derived(
    officers
      .filter((officer) => officer.ownershipState !== "unowned")
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  const selectedShip = $derived(ships.find((ship) => ship.id === shipId));

  const recommendations = $derived.by(() => {
    return recommendBridgeTrios({
      officers: ownedOfficers,
      reservations,
      intentKey,
      shipClass: selectedShip?.shipClass ?? null,
      targetClass,
      captainId: captainAssist ? captainId || undefined : undefined,
      limit: 5,
    });
  });

  $effect(() => {
    if (recommendations.length === 0) return;
    const safeIndex = Math.max(0, Math.min(ui.selectedRecommendation, recommendations.length - 1));
    const rec = recommendations[safeIndex];
    if (!rec) return;

    if (!ui.selectedSlots.captain && !ui.selectedSlots.bridge_1 && !ui.selectedSlots.bridge_2) {
      send({
        type: "state/sync",
        slots: recommendationSlots(rec),
        selectedRecommendation: safeIndex,
      });
      return;
    }

    const matchesAny = recommendations.some((candidate) => {
      const slots = recommendationSlots(candidate);
      return slots.captain === ui.selectedSlots.captain
        && slots.bridge_1 === ui.selectedSlots.bridge_1
        && slots.bridge_2 === ui.selectedSlots.bridge_2;
    });
    if (!matchesAny) {
      send({
        type: "state/sync",
        slots: recommendationSlots(rec),
        selectedRecommendation: safeIndex,
      });
      return;
    }

    if (safeIndex !== ui.selectedRecommendation) {
      send({
        type: "state/sync",
        slots: ui.selectedSlots,
        selectedRecommendation: safeIndex,
      });
    }
  });

  const activeRecommendation = $derived(recommendations[ui.selectedRecommendation] ?? null);

  const maxPower = $derived(Math.max(...ownedOfficers.map((officer) => officer.userPower ?? 0), 1));

  const pickerList = $derived.by(() => {
    const slot = ui.pickerSlot;
    if (!slot) return [];
    const q = ui.pickerSearch.trim().toLowerCase();
    return ownedOfficers
      .filter((officer) => {
        if (q && !officer.name.toLowerCase().includes(q)) return false;
        if (SLOTS.some((otherSlot) => otherSlot !== slot && ui.selectedSlots[otherSlot] === officer.id)) return false;
        return true;
      })
      .map((officer) => {
        const score = scoreOfficerForSlot(officer, {
          intentKey,
          shipClass: selectedShip?.shipClass ?? null,
          targetClass,
          reservations,
          maxPower,
          slot,
        });
        const total = Math.round((score.goalFit + score.shipFit + score.counterFit + score.readiness + score.reservation + score.captainBonus) * 10) / 10;
        return { officer, total, score };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 28);
  });

  function chooseRecommendation(index: number) {
    const rec = recommendations[index];
    if (!rec) return;
    send({ type: "recommendation/select", index, slots: recommendationSlots(rec) });
  }

  function openPicker(slot: BridgeSlot) {
    send({ type: "picker/open", slot });
  }

  function chooseOfficer(slot: BridgeSlot, officerId: string) {
    send({ type: "slot/choose", slot, officerId });
  }

  function clearSlot(slot: BridgeSlot) {
    send({ type: "slot/clear", slot });
  }

  function pickFromTray(officerId: string) {
    if (!ui.pickerSlot) return;
    chooseOfficer(ui.pickerSlot, officerId);
  }

  function trioValid(): boolean {
    const ids = SLOTS.map((slot) => ui.selectedSlots[slot]).filter(Boolean);
    return ids.length === 3 && new Set(ids).size === 3;
  }

  async function saveAsCore() {
    saveError = "";
    send({ type: "save/clear" });

    if (!trioValid()) {
      saveError = "Select three unique officers before saving.";
      return;
    }
    if (!saveName.trim()) {
      saveError = "Core name is required.";
      return;
    }

    const members: BridgeCoreMemberInput[] = SLOTS.map((slot) => ({
      slot,
      officerId: ui.selectedSlots[slot],
    }));

    saveBusy = true;
    try {
      await createBridgeCore(
        saveName.trim(),
        members,
        `${intentLabel(intentKey)}${saveNotes.trim() ? ` · ${saveNotes.trim()}` : ""}`,
      );
      send({ type: "save/success", message: `Saved \"${saveName.trim()}\".` });
      saveName = "";
      saveNotes = "";
      await onRefresh();
    } catch (err: unknown) {
      saveError = err instanceof Error ? err.message : "Failed to save core.";
    } finally {
      saveBusy = false;
    }
  }
</script>

<section class="quick-crew">
  <div class="ws-toolbar">
    <h3>Quick Crew (Basic)</h3>
  </div>

  <p class="qc-note">
    Goal first, then crew. Suggestions are transparent and editable — no auto-locking.
  </p>

  <p class="qc-note">
    Activation rules: Captain Maneuver (CM) only works in the Captain slot. Officer Ability (OA) applies to all bridge officers (including Captain) but not below decks. Below-Deck Ability (BDA) only applies in below-deck slots.
  </p>

  <div class="ws-form qc-config">
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
        <span>Ship</span>
        <select bind:value={shipId}>
          <option value="">Any Ship</option>
          {#each ships as ship}
            <option value={ship.id}>{ship.name}</option>
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

      <label class="ws-field ws-field-checkbox">
        <input type="checkbox" bind:checked={captainAssist} />
        <span>Captain-first assist</span>
      </label>

      {#if captainAssist}
        <label class="ws-field ws-wide">
          <span>Preferred Captain</span>
          <select bind:value={captainId}>
            <option value="">Auto pick best captain</option>
            {#each ownedOfficers as officer}
              <option value={officer.id}>{officer.name}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>
  </div>

  {#if recommendations.length === 0}
    <p class="ws-empty">No recommendations yet. Mark more officers as owned to unlock Quick Crew.</p>
  {:else}
    <div class="qc-grid">
      <div class="qc-col">
        <h4 class="qc-heading">Recommended Trios</h4>
        <div class="ws-list">
          {#each recommendations as rec, index}
            <button class="qc-rec" class:qc-rec-active={index === ui.selectedRecommendation} onclick={() => chooseRecommendation(index)}>
              <div class="qc-rec-top">
                <span class="qc-score">Score {rec.totalScore}</span>
                <span class="qc-confidence">{confidenceLabel(rec.confidence)} confidence</span>
              </div>
              <div class="qc-rec-line">
                <strong>C:</strong> {findOfficerName(officers, rec.captainId)}
              </div>
              <div class="qc-rec-line">
                <strong>B:</strong> {findOfficerName(officers, rec.bridge1Id)} · {findOfficerName(officers, rec.bridge2Id)}
              </div>
              <div class="qc-factor-row">
                {#each rec.factors as factor}
                  <span class="qc-factor">{factor.label}: {factor.score}</span>
                {/each}
              </div>
            </button>
          {/each}
        </div>
      </div>

      <div class="qc-col">
        <h4 class="qc-heading">Selected Crew</h4>
        <div class="qc-slots">
          {#each SLOTS as slot}
            <div class="qc-slot-card">
              <div class="qc-slot-header">
                <span>{SLOT_LABEL[slot]}</span>
                <div class="qc-slot-actions">
                  <button class="ws-action" onclick={() => openPicker(slot)}>Pick</button>
                  {#if ui.selectedSlots[slot]}
                    <button class="ws-action ws-action-danger" onclick={() => clearSlot(slot)}>Clear</button>
                  {/if}
                </div>
              </div>
              <div class="qc-slot-value">
                {ui.selectedSlots[slot] ? findOfficerName(officers, ui.selectedSlots[slot]) : "Unassigned"}
              </div>
            </div>
          {/each}
        </div>

        {#if activeRecommendation?.reasons?.length}
          <div class="qc-why">
            <h5>Why this crew</h5>
            <ul>
              {#each activeRecommendation.reasons as reason}
                <li>{reason}</li>
              {/each}
            </ul>
          </div>
        {/if}

        <div class="ws-form qc-save">
          <div class="ws-form-grid">
            <label class="ws-field">
              <span>Core Name</span>
              <input type="text" bind:value={saveName} maxlength="100" placeholder="e.g. Quick Hostiles A" />
            </label>
            <label class="ws-field">
              <span>Notes</span>
              <input type="text" bind:value={saveNotes} maxlength="300" placeholder="Optional" />
            </label>
          </div>
          {#if saveError}
            <p class="ws-form-error">{saveError}</p>
          {/if}
          {#if ui.saveSuccess}
            <p class="qc-success">{ui.saveSuccess}</p>
          {/if}
          <div class="ws-form-actions">
            <button class="ws-btn ws-btn-save" onclick={saveAsCore} disabled={saveBusy}>
              {saveBusy ? "Saving…" : "Save as Bridge Core"}
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if ui.pickerSlot}
    <div class="ws-form qc-picker">
      <div class="ws-toolbar qc-picker-toolbar">
        <h4>Pick {SLOT_LABEL[ui.pickerSlot]}</h4>
        <button class="ws-btn ws-btn-cancel" onclick={() => send({ type: "picker/close" })}>Close</button>
      </div>
      <label class="ws-field ws-wide">
        <span>Search</span>
        <input
          type="text"
          value={ui.pickerSearch}
          oninput={(event) => send({ type: "picker/search", value: (event.currentTarget as HTMLInputElement).value })}
          placeholder="Search officer"
        />
      </label>
      <div class="qc-picker-list">
        {#each pickerList as item}
          <button class="qc-pick" onclick={() => pickFromTray(item.officer.id)}>
            <span class="qc-pick-name">{item.officer.name}</span>
            <span class="qc-pick-score">{item.total}</span>
            <span class="qc-pick-meta">
              goal {item.score.goalFit} · ship {item.score.shipFit} · counter {item.score.counterFit} · ready {item.score.readiness} · res {item.score.reservation}
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</section>