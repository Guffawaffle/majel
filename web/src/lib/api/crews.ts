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
import { cachedFetch, invalidateForMutation } from "../cache/cached-fetch.js";
import { cacheKey, TTL } from "../cache/cache-keys.js";

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
  const data = await apiPost<{ bridgeCore: BridgeCoreWithMembers }>("/api/bridge-cores", { name, members, notes });
  await invalidateForMutation("bridge-core");
  return data.bridgeCore;
}

export async function updateBridgeCore(id: string, data: { name?: string; notes?: string }): Promise<BridgeCoreWithMembers> {
  const res = await apiPatch<{ bridgeCore: BridgeCoreWithMembers }>(`/api/bridge-cores/${pathEncode(id)}`, data);
  await invalidateForMutation("bridge-core");
  return res.bridgeCore;
}

export async function deleteBridgeCore(id: string): Promise<void> {
  await apiDelete(`/api/bridge-cores/${pathEncode(id)}`);
  await invalidateForMutation("bridge-core");
}

export async function setBridgeCoreMembers(id: string, members: BridgeCoreMemberInput[]): Promise<void> {
  await apiPut(`/api/bridge-cores/${pathEncode(id)}/members`, { members });
  await invalidateForMutation("bridge-core");
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
  const data = await apiPost<{ belowDeckPolicy: BelowDeckPolicy }>("/api/below-deck-policies", { name, mode, spec, notes });
  await invalidateForMutation("below-deck-policy");
  return data.belowDeckPolicy;
}

export async function updateBelowDeckPolicy(id: string, data: { name?: string; mode?: BelowDeckMode; spec?: BelowDeckPolicy["spec"]; notes?: string }): Promise<BelowDeckPolicy> {
  const res = await apiPatch<{ belowDeckPolicy: BelowDeckPolicy }>(`/api/below-deck-policies/${pathEncode(id)}`, data);
  await invalidateForMutation("below-deck-policy");
  return res.belowDeckPolicy;
}

export async function deleteBelowDeckPolicy(id: string): Promise<void> {
  await apiDelete(`/api/below-deck-policies/${pathEncode(id)}`);
  await invalidateForMutation("below-deck-policy");
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
  const res = await apiPost<{ loadout: Loadout }>("/api/crew/loadouts", data);
  await invalidateForMutation("crew-loadout");
  return res.loadout;
}

export async function updateCrewLoadout(id: string, data: Partial<LoadoutInput>): Promise<Loadout> {
  const res = await apiPatch<{ loadout: Loadout }>(`/api/crew/loadouts/${pathEncode(id)}`, data);
  await invalidateForMutation("crew-loadout");
  return res.loadout;
}

export async function deleteCrewLoadout(id: string): Promise<void> {
  await apiDelete(`/api/crew/loadouts/${pathEncode(id)}`);
  await invalidateForMutation("crew-loadout");
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
  const data = await apiPost<{ variant: LoadoutVariant }>(`/api/crew/loadouts/${pathEncode(loadoutId)}/variants`, { name, patch, notes });
  await invalidateForMutation("crew-variant");
  return data.variant;
}

export async function updateVariant(id: string, data: { name?: string; patch?: VariantPatch; notes?: string }): Promise<LoadoutVariant> {
  const res = await apiPatch<{ variant: LoadoutVariant }>(`/api/crew/loadouts/variants/${pathEncode(id)}`, data);
  await invalidateForMutation("crew-variant");
  return res.variant;
}

export async function deleteVariant(id: string): Promise<void> {
  await apiDelete(`/api/crew/loadouts/variants/${pathEncode(id)}`);
  await invalidateForMutation("crew-variant");
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

export async function upsertCrewDock(num: number, data: { shipId?: string | null; loadoutId?: number | null; variantId?: number | null; label?: string; notes?: string }): Promise<Dock> {
  const res = await apiPut<{ dock: Dock }>(`/api/crew/docks/${pathEncode(num)}`, data);
  await invalidateForMutation("crew-dock");
  return res.dock;
}

export async function deleteCrewDock(num: number): Promise<void> {
  await apiDelete(`/api/crew/docks/${pathEncode(num)}`);
  await invalidateForMutation("crew-dock");
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
  const data = await apiPost<{ fleetPreset: FleetPresetWithSlots }>("/api/fleet-presets", { name, notes });
  await invalidateForMutation("fleet-preset");
  return data.fleetPreset;
}

export async function updateFleetPreset(id: string, data: { name?: string; notes?: string }): Promise<FleetPresetWithSlots> {
  const res = await apiPatch<{ fleetPreset: FleetPresetWithSlots }>(`/api/fleet-presets/${pathEncode(id)}`, data);
  await invalidateForMutation("fleet-preset");
  return res.fleetPreset;
}

export async function deleteFleetPreset(id: string): Promise<void> {
  await apiDelete(`/api/fleet-presets/${pathEncode(id)}`);
  await invalidateForMutation("fleet-preset");
}

export async function setFleetPresetSlots(id: string, slots: FleetPresetSlot[]): Promise<void> {
  await apiPut(`/api/fleet-presets/${pathEncode(id)}/slots`, { slots });
  await invalidateForMutation("fleet-preset");
}

export async function activateFleetPreset(id: string): Promise<void> {
  await apiPost(`/api/fleet-presets/${pathEncode(id)}/activate`, {});
  await invalidateForMutation("fleet-preset");
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
  const res = await apiPost<{ planItem: PlanItem }>("/api/crew/plan", data);
  await invalidateForMutation("crew-plan");
  return res.planItem;
}

export async function updateCrewPlanItem(id: string, data: Partial<PlanItemInput>): Promise<PlanItem> {
  const res = await apiPatch<{ planItem: PlanItem }>(`/api/crew/plan/${pathEncode(id)}`, data);
  await invalidateForMutation("crew-plan");
  return res.planItem;
}

export async function deleteCrewPlanItem(id: string): Promise<void> {
  await apiDelete(`/api/crew/plan/${pathEncode(id)}`);
  await invalidateForMutation("crew-plan");
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
  const data = await apiPut<{ reservation: OfficerReservation }>(`/api/officer-reservations/${pathEncode(officerId)}`, {
    reservedFor,
    locked,
    notes,
  });
  await invalidateForMutation("officer-reservation");
  return data.reservation;
}

export async function deleteReservation(officerId: string): Promise<void> {
  await apiDelete(`/api/officer-reservations/${pathEncode(officerId)}`);
  await invalidateForMutation("officer-reservation");
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
