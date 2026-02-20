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

// ─── Bridge Cores ───────────────────────────────────────────

export async function fetchBridgeCores(): Promise<BridgeCoreWithMembers[]> {
  const data = await apiFetch<{ bridgeCores: BridgeCoreWithMembers[] }>("/api/bridge-cores");
  return data.bridgeCores;
}

export async function fetchBridgeCore(id: string): Promise<BridgeCoreWithMembers> {
  const data = await apiFetch<{ bridgeCore: BridgeCoreWithMembers }>(`/api/bridge-cores/${pathEncode(id)}`);
  return data.bridgeCore;
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
  return data.bridgeCore;
}

export async function updateBridgeCore(id: string, data: { name?: string; notes?: string }): Promise<BridgeCoreWithMembers> {
  const res = await apiPatch<{ bridgeCore: BridgeCoreWithMembers }>(`/api/bridge-cores/${pathEncode(id)}`, data);
  return res.bridgeCore;
}

export async function deleteBridgeCore(id: string): Promise<void> {
  await apiDelete(`/api/bridge-cores/${pathEncode(id)}`);
}

export async function setBridgeCoreMembers(id: string, members: BridgeCoreMemberInput[]): Promise<void> {
  await apiPut(`/api/bridge-cores/${pathEncode(id)}/members`, { members });
}

// ─── Below Deck Policies ────────────────────────────────────

export async function fetchBelowDeckPolicies(): Promise<BelowDeckPolicy[]> {
  const data = await apiFetch<{ belowDeckPolicies: BelowDeckPolicy[] }>("/api/below-deck-policies");
  return data.belowDeckPolicies;
}

export async function fetchBelowDeckPolicy(id: string): Promise<BelowDeckPolicy> {
  const data = await apiFetch<{ belowDeckPolicy: BelowDeckPolicy }>(`/api/below-deck-policies/${pathEncode(id)}`);
  return data.belowDeckPolicy;
}

export async function createBelowDeckPolicy(
  name: string,
  mode: BelowDeckMode,
  spec: BelowDeckPolicy["spec"],
  notes: string,
): Promise<BelowDeckPolicy> {
  const data = await apiPost<{ belowDeckPolicy: BelowDeckPolicy }>("/api/below-deck-policies", { name, mode, spec, notes });
  return data.belowDeckPolicy;
}

export async function updateBelowDeckPolicy(id: string, data: { name?: string; mode?: BelowDeckMode; spec?: BelowDeckPolicy["spec"]; notes?: string }): Promise<BelowDeckPolicy> {
  const res = await apiPatch<{ belowDeckPolicy: BelowDeckPolicy }>(`/api/below-deck-policies/${pathEncode(id)}`, data);
  return res.belowDeckPolicy;
}

export async function deleteBelowDeckPolicy(id: string): Promise<void> {
  await apiDelete(`/api/below-deck-policies/${pathEncode(id)}`);
}

// ─── Crew Loadouts ──────────────────────────────────────────

export interface LoadoutFilters {
  shipId?: string;
  intentKey?: string;
  tag?: string;
  active?: boolean;
}

export async function fetchCrewLoadouts(filters?: LoadoutFilters): Promise<Loadout[]> {
  const data = await apiFetch<{ loadouts: Loadout[] }>(`/api/crew/loadouts${qs({ ...filters })}`);
  return data.loadouts;
}

export async function fetchCrewLoadout(id: string): Promise<Loadout> {
  const data = await apiFetch<{ loadout: Loadout }>(`/api/crew/loadouts/${pathEncode(id)}`);
  return data.loadout;
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
  return res.loadout;
}

export async function updateCrewLoadout(id: string, data: Partial<LoadoutInput>): Promise<Loadout> {
  const res = await apiPatch<{ loadout: Loadout }>(`/api/crew/loadouts/${pathEncode(id)}`, data);
  return res.loadout;
}

export async function deleteCrewLoadout(id: string): Promise<void> {
  await apiDelete(`/api/crew/loadouts/${pathEncode(id)}`);
}

// ─── Loadout Variants ───────────────────────────────────────

export async function fetchVariants(loadoutId: string): Promise<LoadoutVariant[]> {
  const data = await apiFetch<{ variants: LoadoutVariant[] }>(`/api/crew/loadouts/${pathEncode(loadoutId)}/variants`);
  return data.variants;
}

export async function createVariant(
  loadoutId: string,
  name: string,
  patch: VariantPatch,
  notes: string,
): Promise<LoadoutVariant> {
  const data = await apiPost<{ variant: LoadoutVariant }>(`/api/crew/loadouts/${pathEncode(loadoutId)}/variants`, { name, patch, notes });
  return data.variant;
}

export async function updateVariant(id: string, data: { name?: string; patch?: VariantPatch; notes?: string }): Promise<LoadoutVariant> {
  const res = await apiPatch<{ variant: LoadoutVariant }>(`/api/crew/loadouts/variants/${pathEncode(id)}`, data);
  return res.variant;
}

export async function deleteVariant(id: string): Promise<void> {
  await apiDelete(`/api/crew/loadouts/variants/${pathEncode(id)}`);
}

export async function resolveVariant(loadoutId: string, variantId: string): Promise<ResolvedLoadout> {
  return apiFetch<ResolvedLoadout>(
    `/api/crew/loadouts/${pathEncode(loadoutId)}/variants/${pathEncode(variantId)}/resolve`,
  );
}

// ─── Docks ──────────────────────────────────────────────────

export async function fetchCrewDocks(): Promise<Dock[]> {
  const data = await apiFetch<{ docks: Dock[] }>("/api/crew/docks");
  return data.docks;
}

export async function fetchCrewDock(num: number): Promise<Dock> {
  const data = await apiFetch<{ dock: Dock }>(`/api/crew/docks/${pathEncode(num)}`);
  return data.dock;
}

export async function upsertCrewDock(num: number, data: { shipId?: string | null; loadoutId?: number | null; variantId?: number | null; label?: string; notes?: string }): Promise<Dock> {
  const res = await apiPut<{ dock: Dock }>(`/api/crew/docks/${pathEncode(num)}`, data);
  return res.dock;
}

export async function deleteCrewDock(num: number): Promise<void> {
  await apiDelete(`/api/crew/docks/${pathEncode(num)}`);
}

// ─── Fleet Presets ──────────────────────────────────────────

export async function fetchFleetPresets(): Promise<FleetPresetWithSlots[]> {
  const data = await apiFetch<{ fleetPresets: FleetPresetWithSlots[] }>("/api/fleet-presets");
  return data.fleetPresets;
}

export async function fetchFleetPreset(id: string): Promise<FleetPresetWithSlots> {
  const data = await apiFetch<{ fleetPreset: FleetPresetWithSlots }>(`/api/fleet-presets/${pathEncode(id)}`);
  return data.fleetPreset;
}

export async function createFleetPreset(name: string, notes: string): Promise<FleetPresetWithSlots> {
  const data = await apiPost<{ fleetPreset: FleetPresetWithSlots }>("/api/fleet-presets", { name, notes });
  return data.fleetPreset;
}

export async function updateFleetPreset(id: string, data: { name?: string; notes?: string }): Promise<FleetPresetWithSlots> {
  const res = await apiPatch<{ fleetPreset: FleetPresetWithSlots }>(`/api/fleet-presets/${pathEncode(id)}`, data);
  return res.fleetPreset;
}

export async function deleteFleetPreset(id: string): Promise<void> {
  await apiDelete(`/api/fleet-presets/${pathEncode(id)}`);
}

export async function setFleetPresetSlots(id: string, slots: FleetPresetSlot[]): Promise<void> {
  await apiPut(`/api/fleet-presets/${pathEncode(id)}/slots`, { slots });
}

export async function activateFleetPreset(id: string): Promise<void> {
  await apiPost(`/api/fleet-presets/${pathEncode(id)}/activate`, {});
}

// ─── Plan Items ─────────────────────────────────────────────

export interface PlanFilters {
  active?: boolean;
  dockNumber?: number;
}

export async function fetchCrewPlanItems(filters?: PlanFilters): Promise<PlanItem[]> {
  const data = await apiFetch<{ planItems: PlanItem[] }>(`/api/crew/plan${qs({ ...filters })}`);
  return data.planItems;
}

export async function fetchCrewPlanItem(id: string): Promise<PlanItem> {
  const data = await apiFetch<{ planItem: PlanItem }>(`/api/crew/plan/${pathEncode(id)}`);
  return data.planItem;
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
  return res.planItem;
}

export async function updateCrewPlanItem(id: string, data: Partial<PlanItemInput>): Promise<PlanItem> {
  const res = await apiPatch<{ planItem: PlanItem }>(`/api/crew/plan/${pathEncode(id)}`, data);
  return res.planItem;
}

export async function deleteCrewPlanItem(id: string): Promise<void> {
  await apiDelete(`/api/crew/plan/${pathEncode(id)}`);
}

// ─── Officer Reservations ───────────────────────────────────

export async function fetchReservations(): Promise<OfficerReservation[]> {
  const data = await apiFetch<{ reservations: OfficerReservation[] }>("/api/officer-reservations");
  return data.reservations;
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
  return data.reservation;
}

export async function deleteReservation(officerId: string): Promise<void> {
  await apiDelete(`/api/officer-reservations/${pathEncode(officerId)}`);
}

// ─── Effective State ────────────────────────────────────────

export async function fetchEffectiveState(): Promise<EffectiveDockState> {
  return apiFetch<EffectiveDockState>("/api/effective-state");
}
