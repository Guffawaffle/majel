/**
 * Crews API — bridge cores, below deck policies, crew loadouts,
 * loadout variants, docks, fleet presets, plan items,
 * officer reservations, effective state.
 *
 * All functions throw ApiError on failure — callers decide how to surface errors.
 */

import type {
  BridgeCoreWithMembers,
  BridgeSlot,
  Loadout,
  LoadoutVariant,
  VariantPatch,
  BelowDeckPolicy,
  BelowDeckMode,
  Dock,
  FleetPresetSlot,
  FleetPresetWithSlots,
  PlanItem,
  PlanSource,
  OfficerReservation,
  EffectiveDockState,
  ResolvedLoadout,
} from "../types.js";
import { apiFetch, apiDelete, apiPatch, apiPost, apiPut, pathEncode, qs } from "./fetch.js";
import { cachedFetch } from "../cache/cached-fetch.js";
import { cacheKey, TTL } from "../cache/cache-keys.js";
import { runLockedMutation } from "./mutation.js";

/** Options for cacheable fetch functions. */
export interface FetchOpts {
  /** Bypass cache and fetch fresh from network. Use after mutations. */
  forceNetwork?: boolean;
}

// ─── Bridge Cores ───────────────────────────────────────────

export async function fetchBridgeCores(opts?: FetchOpts): Promise<BridgeCoreWithMembers[]> {
  const key = cacheKey("/api/bridge-cores");
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ bridgeCores: BridgeCoreWithMembers[] }>("/api/bridge-cores").then((d) => d.bridgeCores),
    TTL.COMPOSITION,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

export async function fetchBridgeCore(id: string): Promise<BridgeCoreWithMembers> {
  const key = cacheKey(`/api/bridge-cores/${id}`);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ bridgeCore: BridgeCoreWithMembers }>(`/api/bridge-cores/${pathEncode(id)}`).then((d) => d.bridgeCore),
    TTL.COMPOSITION,
  );
  return data;
}

export interface BridgeCoreMemberInput {
  officerId: string;
  slot: BridgeSlot;
}

export async function createBridgeCore(
  name: string,
  members: BridgeCoreMemberInput[],
  notes: string,
): Promise<BridgeCoreWithMembers> {
  return runLockedMutation({
    label: "Save bridge core",
    lockKey: "bridge-core:new",
    mutationKey: "bridge-core",
    mutate: async () => {
      const data = await apiPost<{ bridgeCore: BridgeCoreWithMembers }>("/api/bridge-cores", { name, members, notes });
      return data.bridgeCore;
    },
  });
}

export async function updateBridgeCore(id: string, data: { name?: string; notes?: string }): Promise<BridgeCoreWithMembers> {
  return runLockedMutation({
    label: "Update bridge core",
    lockKey: `bridge-core:${id}`,
    mutationKey: "bridge-core",
    mutate: async () => {
      const res = await apiPatch<{ bridgeCore: BridgeCoreWithMembers }>(`/api/bridge-cores/${pathEncode(id)}`, data);
      return res.bridgeCore;
    },
  });
}

export async function deleteBridgeCore(id: string): Promise<void> {
  await runLockedMutation({
    label: "Delete bridge core",
    lockKey: `bridge-core:${id}`,
    mutationKey: "bridge-core",
    mutate: async () => {
      await apiDelete(`/api/bridge-cores/${pathEncode(id)}`);
    },
  });
}

export async function setBridgeCoreMembers(id: string, members: BridgeCoreMemberInput[]): Promise<void> {
  await runLockedMutation({
    label: "Update bridge core members",
    lockKey: `bridge-core:${id}`,
    mutationKey: "bridge-core",
    mutate: async () => {
      await apiPut(`/api/bridge-cores/${pathEncode(id)}/members`, { members });
    },
  });
}

// ─── Below Deck Policies ────────────────────────────────────

export async function fetchBelowDeckPolicies(opts?: FetchOpts): Promise<BelowDeckPolicy[]> {
  const key = cacheKey("/api/below-deck-policies");
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ belowDeckPolicies: BelowDeckPolicy[] }>("/api/below-deck-policies").then((d) => d.belowDeckPolicies),
    TTL.COMPOSITION,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

export async function fetchBelowDeckPolicy(id: string): Promise<BelowDeckPolicy> {
  const key = cacheKey(`/api/below-deck-policies/${id}`);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ belowDeckPolicy: BelowDeckPolicy }>(`/api/below-deck-policies/${pathEncode(id)}`).then((d) => d.belowDeckPolicy),
    TTL.COMPOSITION,
  );
  return data;
}

export async function createBelowDeckPolicy(
  name: string,
  mode: BelowDeckMode,
  spec: BelowDeckPolicy["spec"],
  notes: string,
): Promise<BelowDeckPolicy> {
  return runLockedMutation({
    label: "Save below deck policy",
    lockKey: "below-deck-policy:new",
    mutationKey: "below-deck-policy",
    mutate: async () => {
      const data = await apiPost<{ belowDeckPolicy: BelowDeckPolicy }>("/api/below-deck-policies", { name, mode, spec, notes });
      return data.belowDeckPolicy;
    },
  });
}

export async function updateBelowDeckPolicy(id: string, data: { name?: string; mode?: BelowDeckMode; spec?: BelowDeckPolicy["spec"]; notes?: string }): Promise<BelowDeckPolicy> {
  return runLockedMutation({
    label: "Update below deck policy",
    lockKey: `below-deck-policy:${id}`,
    mutationKey: "below-deck-policy",
    mutate: async () => {
      const res = await apiPatch<{ belowDeckPolicy: BelowDeckPolicy }>(`/api/below-deck-policies/${pathEncode(id)}`, data);
      return res.belowDeckPolicy;
    },
  });
}

export async function deleteBelowDeckPolicy(id: string): Promise<void> {
  await runLockedMutation({
    label: "Delete below deck policy",
    lockKey: `below-deck-policy:${id}`,
    mutationKey: "below-deck-policy",
    mutate: async () => {
      await apiDelete(`/api/below-deck-policies/${pathEncode(id)}`);
    },
  });
}

// ─── Crew Loadouts ──────────────────────────────────────────

export interface LoadoutFilters {
  shipId?: string;
  intentKey?: string;
  tag?: string;
  active?: boolean;
}

export async function fetchCrewLoadouts(filters?: LoadoutFilters, opts?: FetchOpts): Promise<Loadout[]> {
  const endpoint = `/api/crew/loadouts${qs({ ...filters })}`;
  const key = cacheKey("/api/crew/loadouts", filters as Record<string, unknown>);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ loadouts: Loadout[] }>(endpoint).then((d) => d.loadouts),
    TTL.COMPOSITION,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

export async function fetchCrewLoadout(id: string): Promise<Loadout> {
  const key = cacheKey(`/api/crew/loadouts/${id}`);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ loadout: Loadout }>(`/api/crew/loadouts/${pathEncode(id)}`).then((d) => d.loadout),
    TTL.COMPOSITION,
  );
  return data;
}

export interface LoadoutInput {
  name: string;
  shipId: string;
  bridgeCoreId?: number | null;
  belowDeckPolicyId?: number | null;
  intentKeys?: string[];
  tags?: string[];
  priority?: number;
  isActive?: boolean;
  notes?: string;
}

export async function createCrewLoadout(data: LoadoutInput): Promise<Loadout> {
  return runLockedMutation({
    label: "Save crew loadout",
    lockKey: "crew-loadout:new",
    mutationKey: "crew-loadout",
    mutate: async () => {
      const res = await apiPost<{ loadout: Loadout }>("/api/crew/loadouts", data);
      return res.loadout;
    },
  });
}

export async function updateCrewLoadout(id: string, data: Partial<LoadoutInput>): Promise<Loadout> {
  return runLockedMutation({
    label: "Update crew loadout",
    lockKey: `crew-loadout:${id}`,
    mutationKey: "crew-loadout",
    mutate: async () => {
      const res = await apiPatch<{ loadout: Loadout }>(`/api/crew/loadouts/${pathEncode(id)}`, data);
      return res.loadout;
    },
  });
}

export async function deleteCrewLoadout(id: string): Promise<void> {
  await runLockedMutation({
    label: "Delete crew loadout",
    lockKey: `crew-loadout:${id}`,
    mutationKey: "crew-loadout",
    mutate: async () => {
      await apiDelete(`/api/crew/loadouts/${pathEncode(id)}`);
    },
  });
}

// ─── Loadout Variants ───────────────────────────────────────

export async function fetchVariants(loadoutId: string): Promise<LoadoutVariant[]> {
  const key = cacheKey(`/api/crew/loadouts/${loadoutId}/variants`);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ variants: LoadoutVariant[] }>(`/api/crew/loadouts/${pathEncode(loadoutId)}/variants`).then((d) => d.variants),
    TTL.COMPOSITION,
  );
  return data;
}

export async function createVariant(
  loadoutId: string,
  name: string,
  patch: VariantPatch,
  notes: string,
): Promise<LoadoutVariant> {
  return runLockedMutation({
    label: "Save loadout variant",
    lockKey: `crew-variant:new:${loadoutId}`,
    mutationKey: "crew-variant",
    mutate: async () => {
      const data = await apiPost<{ variant: LoadoutVariant }>(`/api/crew/loadouts/${pathEncode(loadoutId)}/variants`, { name, patch, notes });
      return data.variant;
    },
  });
}

export async function updateVariant(id: string, data: { name?: string; patch?: VariantPatch; notes?: string }): Promise<LoadoutVariant> {
  return runLockedMutation({
    label: "Update loadout variant",
    lockKey: `crew-variant:${id}`,
    mutationKey: "crew-variant",
    mutate: async () => {
      const res = await apiPatch<{ variant: LoadoutVariant }>(`/api/crew/loadouts/variants/${pathEncode(id)}`, data);
      return res.variant;
    },
  });
}

export async function deleteVariant(id: string): Promise<void> {
  await runLockedMutation({
    label: "Delete loadout variant",
    lockKey: `crew-variant:${id}`,
    mutationKey: "crew-variant",
    mutate: async () => {
      await apiDelete(`/api/crew/loadouts/variants/${pathEncode(id)}`);
    },
  });
}

export async function resolveVariant(loadoutId: string, variantId: string): Promise<ResolvedLoadout> {
  return apiFetch<ResolvedLoadout>(
    `/api/crew/loadouts/${pathEncode(loadoutId)}/variants/${pathEncode(variantId)}/resolve`,
  );
}

// ─── Docks ──────────────────────────────────────────────────

export async function fetchCrewDocks(opts?: FetchOpts): Promise<Dock[]> {
  const key = cacheKey("/api/crew/docks");
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ docks: Dock[] }>("/api/crew/docks").then((d) => d.docks),
    TTL.COMPOSITION,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

export async function fetchCrewDock(num: number): Promise<Dock> {
  const key = cacheKey(`/api/crew/docks/${num}`);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ dock: Dock }>(`/api/crew/docks/${pathEncode(num)}`).then((d) => d.dock),
    TTL.COMPOSITION,
  );
  return data;
}

export async function upsertCrewDock(num: number, data: { shipId?: string | null; loadoutId?: number | null; variantId?: number | null; label?: string; unlocked?: boolean; notes?: string }): Promise<Dock> {
  const path = `/api/crew/docks/${pathEncode(num)}`;
  return runLockedMutation({
    label: `Upsert dock ${num}`,
    lockKey: `crew-dock:${num}`,
    mutationKey: "crew-dock",
    queueOnNetworkError: true,
    replayIntent: {
      label: `Upsert dock ${num}`,
      lockKey: `crew-dock:${num}`,
      method: "PUT",
      path,
      body: data,
      mutationKey: "crew-dock",
    },
    mutate: async () => {
      const res = await apiPut<{ dock: Dock }>(path, data);
      return res.dock;
    },
  });
}

export async function deleteCrewDock(num: number): Promise<void> {
  const path = `/api/crew/docks/${pathEncode(num)}`;
  await runLockedMutation({
    label: `Delete dock ${num}`,
    lockKey: `crew-dock:${num}`,
    mutationKey: "crew-dock",
    queueOnNetworkError: true,
    replayIntent: {
      label: `Delete dock ${num}`,
      lockKey: `crew-dock:${num}`,
      method: "DELETE",
      path,
      mutationKey: "crew-dock",
    },
    mutate: async () => {
      await apiDelete(path);
    },
  });
}

// ─── Fleet Presets ──────────────────────────────────────────

export async function fetchFleetPresets(opts?: FetchOpts): Promise<FleetPresetWithSlots[]> {
  const key = cacheKey("/api/fleet-presets");
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ fleetPresets: FleetPresetWithSlots[] }>("/api/fleet-presets").then((d) => d.fleetPresets),
    TTL.COMPOSITION,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

export async function fetchFleetPreset(id: string): Promise<FleetPresetWithSlots> {
  const key = cacheKey(`/api/fleet-presets/${id}`);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ fleetPreset: FleetPresetWithSlots }>(`/api/fleet-presets/${pathEncode(id)}`).then((d) => d.fleetPreset),
    TTL.COMPOSITION,
  );
  return data;
}

export async function createFleetPreset(name: string, notes: string): Promise<FleetPresetWithSlots> {
  return runLockedMutation({
    label: "Save fleet preset",
    lockKey: "fleet-preset:new",
    mutationKey: "fleet-preset",
    mutate: async () => {
      const data = await apiPost<{ fleetPreset: FleetPresetWithSlots }>("/api/fleet-presets", { name, notes });
      return data.fleetPreset;
    },
  });
}

export async function updateFleetPreset(id: string, data: { name?: string; notes?: string }): Promise<FleetPresetWithSlots> {
  return runLockedMutation({
    label: "Update fleet preset",
    lockKey: `fleet-preset:${id}`,
    mutationKey: "fleet-preset",
    mutate: async () => {
      const res = await apiPatch<{ fleetPreset: FleetPresetWithSlots }>(`/api/fleet-presets/${pathEncode(id)}`, data);
      return res.fleetPreset;
    },
  });
}

export async function deleteFleetPreset(id: string): Promise<void> {
  await runLockedMutation({
    label: "Delete fleet preset",
    lockKey: `fleet-preset:${id}`,
    mutationKey: "fleet-preset",
    mutate: async () => {
      await apiDelete(`/api/fleet-presets/${pathEncode(id)}`);
    },
  });
}

export async function setFleetPresetSlots(id: string, slots: FleetPresetSlot[]): Promise<void> {
  await runLockedMutation({
    label: "Update fleet preset slots",
    lockKey: `fleet-preset:${id}`,
    mutationKey: "fleet-preset",
    mutate: async () => {
      await apiPut(`/api/fleet-presets/${pathEncode(id)}/slots`, { slots });
    },
  });
}

export async function activateFleetPreset(id: string): Promise<void> {
  await runLockedMutation({
    label: "Activate fleet preset",
    lockKey: `fleet-preset:${id}`,
    mutationKey: "fleet-preset",
    mutate: async () => {
      await apiPost(`/api/fleet-presets/${pathEncode(id)}/activate`, {});
    },
  });
}

// ─── Plan Items ─────────────────────────────────────────────

export interface PlanFilters {
  active?: boolean;
  dockNumber?: number;
}

export async function fetchCrewPlanItems(filters?: PlanFilters, opts?: FetchOpts): Promise<PlanItem[]> {
  const endpoint = `/api/crew/plan${qs({ ...filters })}`;
  const key = cacheKey("/api/crew/plan", filters as Record<string, unknown>);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ planItems: PlanItem[] }>(endpoint).then((d) => d.planItems),
    TTL.COMPOSITION,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

export async function fetchCrewPlanItem(id: string): Promise<PlanItem> {
  const key = cacheKey(`/api/crew/plan/${id}`);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ planItem: PlanItem }>(`/api/crew/plan/${pathEncode(id)}`).then((d) => d.planItem),
    TTL.COMPOSITION,
  );
  return data;
}

export interface PlanItemInput {
  intentKey: string;
  loadoutId?: number | null;
  variantId?: number | null;
  dockNumber?: number | null;
  source?: PlanSource;
  priority?: number;
  isActive?: boolean;
  notes?: string;
}

export async function createCrewPlanItem(data: PlanItemInput): Promise<PlanItem> {
  return runLockedMutation({
    label: "Save crew plan item",
    lockKey: "crew-plan:new",
    mutationKey: "crew-plan",
    mutate: async () => {
      const res = await apiPost<{ planItem: PlanItem }>("/api/crew/plan", data);
      return res.planItem;
    },
  });
}

export async function updateCrewPlanItem(id: string, data: Partial<PlanItemInput>): Promise<PlanItem> {
  return runLockedMutation({
    label: "Update crew plan item",
    lockKey: `crew-plan:${id}`,
    mutationKey: "crew-plan",
    mutate: async () => {
      const res = await apiPatch<{ planItem: PlanItem }>(`/api/crew/plan/${pathEncode(id)}`, data);
      return res.planItem;
    },
  });
}

export async function deleteCrewPlanItem(id: string): Promise<void> {
  await runLockedMutation({
    label: "Delete crew plan item",
    lockKey: `crew-plan:${id}`,
    mutationKey: "crew-plan",
    mutate: async () => {
      await apiDelete(`/api/crew/plan/${pathEncode(id)}`);
    },
  });
}

// ─── Officer Reservations ───────────────────────────────────

export async function fetchReservations(opts?: FetchOpts): Promise<OfficerReservation[]> {
  const key = cacheKey("/api/officer-reservations");
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ reservations: OfficerReservation[] }>("/api/officer-reservations").then((d) => d.reservations),
    TTL.COMPOSITION,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

export async function setReservation(
  officerId: string,
  reservedFor: string,
  locked: boolean,
  notes: string,
): Promise<OfficerReservation> {
  const path = `/api/officer-reservations/${pathEncode(officerId)}`;
  const body = {
    reservedFor,
    locked,
    notes,
  };
  return runLockedMutation({
    label: "Save officer reservation",
    lockKey: `officer-reservation:${officerId}`,
    mutationKey: "officer-reservation",
    queueOnNetworkError: true,
    replayIntent: {
      label: "Save officer reservation",
      lockKey: `officer-reservation:${officerId}`,
      method: "PUT",
      path,
      body,
      mutationKey: "officer-reservation",
    },
    mutate: async () => {
      const data = await apiPut<{ reservation: OfficerReservation }>(path, body);
      return data.reservation;
    },
  });
}

export async function deleteReservation(officerId: string): Promise<void> {
  const path = `/api/officer-reservations/${pathEncode(officerId)}`;
  await runLockedMutation({
    label: "Delete officer reservation",
    lockKey: `officer-reservation:${officerId}`,
    mutationKey: "officer-reservation",
    queueOnNetworkError: true,
    replayIntent: {
      label: "Delete officer reservation",
      lockKey: `officer-reservation:${officerId}`,
      method: "DELETE",
      path,
      mutationKey: "officer-reservation",
    },
    mutate: async () => {
      await apiDelete(path);
    },
  });
}

// ─── Effective State ────────────────────────────────────────

export async function fetchEffectiveState(opts?: FetchOpts): Promise<EffectiveDockState> {
  const key = cacheKey("/api/effective-state");
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ effectiveState: EffectiveDockState }>("/api/effective-state").then((d) => d.effectiveState),
    TTL.COMPOSITION,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}
