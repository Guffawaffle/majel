/**
 * Crews API — bridge cores, below deck policies, crew loadouts,
 * loadout variants, docks, fleet presets, plan items,
 * officer reservations, effective state.
 *
 * All functions throw ApiError on failure — callers decide how to surface errors.
 */

import type {
  BridgeCoreWithMembers,
  Loadout,
  BelowDeckPolicy,
  Dock,
  OfficerReservation,
  EffectiveDockState,
} from "../types.js";
import { apiFetch, apiDelete, apiPatch, apiPost, apiPut, pathEncode, qs } from "./fetch.js";

// ─── Bridge Cores ───────────────────────────────────────────

export async function fetchBridgeCores(): Promise<BridgeCoreWithMembers[]> {
  const data = await apiFetch<{ bridgeCores: BridgeCoreWithMembers[] }>("/api/bridge-cores");
  return data.bridgeCores;
}

export async function fetchBridgeCore(id: string): Promise<unknown> {
  return apiFetch(`/api/bridge-cores/${pathEncode(id)}`);
}

export async function createBridgeCore(
  name: string,
  members: unknown,
  notes: string,
): Promise<unknown> {
  return apiPost("/api/bridge-cores", { name, members, notes });
}

export async function updateBridgeCore(id: string, data: Record<string, unknown>): Promise<unknown> {
  return apiPatch(`/api/bridge-cores/${pathEncode(id)}`, data);
}

export async function deleteBridgeCore(id: string): Promise<unknown> {
  return apiDelete(`/api/bridge-cores/${pathEncode(id)}`);
}

export async function setBridgeCoreMembers(id: string, members: unknown): Promise<unknown> {
  return apiPut(`/api/bridge-cores/${pathEncode(id)}/members`, { members });
}

// ─── Below Deck Policies ────────────────────────────────────

export async function fetchBelowDeckPolicies(): Promise<BelowDeckPolicy[]> {
  const data = await apiFetch<{ belowDeckPolicies: BelowDeckPolicy[] }>("/api/below-deck-policies");
  return data.belowDeckPolicies;
}

export async function fetchBelowDeckPolicy(id: string): Promise<unknown> {
  return apiFetch(`/api/below-deck-policies/${pathEncode(id)}`);
}

export async function createBelowDeckPolicy(
  name: string,
  mode: string,
  spec: unknown,
  notes: string,
): Promise<unknown> {
  return apiPost("/api/below-deck-policies", { name, mode, spec, notes });
}

export async function updateBelowDeckPolicy(id: string, data: Record<string, unknown>): Promise<unknown> {
  return apiPatch(`/api/below-deck-policies/${pathEncode(id)}`, data);
}

export async function deleteBelowDeckPolicy(id: string): Promise<unknown> {
  return apiDelete(`/api/below-deck-policies/${pathEncode(id)}`);
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

export async function fetchCrewLoadout(id: string): Promise<unknown> {
  return apiFetch(`/api/crew/loadouts/${pathEncode(id)}`);
}

export async function createCrewLoadout(data: Record<string, unknown>): Promise<unknown> {
  return apiPost("/api/crew/loadouts", data);
}

export async function updateCrewLoadout(id: string, data: Record<string, unknown>): Promise<unknown> {
  return apiPatch(`/api/crew/loadouts/${pathEncode(id)}`, data);
}

export async function deleteCrewLoadout(id: string): Promise<unknown> {
  return apiDelete(`/api/crew/loadouts/${pathEncode(id)}`);
}

// ─── Loadout Variants ───────────────────────────────────────

export async function fetchVariants(loadoutId: string): Promise<unknown[]> {
  const data = await apiFetch<{ variants: unknown[] }>(`/api/crew/loadouts/${pathEncode(loadoutId)}/variants`);
  return data.variants;
}

export async function createVariant(
  loadoutId: string,
  name: string,
  patch: unknown,
  notes: string,
): Promise<unknown> {
  return apiPost(`/api/crew/loadouts/${pathEncode(loadoutId)}/variants`, { name, patch, notes });
}

export async function updateVariant(id: string, data: Record<string, unknown>): Promise<unknown> {
  return apiPatch(`/api/crew/loadouts/variants/${pathEncode(id)}`, data);
}

export async function deleteVariant(id: string): Promise<unknown> {
  return apiDelete(`/api/crew/loadouts/variants/${pathEncode(id)}`);
}

export async function resolveVariant(loadoutId: string, variantId: string): Promise<unknown> {
  return apiFetch(
    `/api/crew/loadouts/${pathEncode(loadoutId)}/variants/${pathEncode(variantId)}/resolve`,
  );
}

// ─── Docks ──────────────────────────────────────────────────

export async function fetchCrewDocks(): Promise<Dock[]> {
  const data = await apiFetch<{ docks: Dock[] }>("/api/crew/docks");
  return data.docks;
}

export async function fetchCrewDock(num: number): Promise<unknown> {
  return apiFetch(`/api/crew/docks/${pathEncode(num)}`);
}

export async function upsertCrewDock(num: number, data: Record<string, unknown>): Promise<unknown> {
  return apiPut(`/api/crew/docks/${pathEncode(num)}`, data);
}

export async function deleteCrewDock(num: number): Promise<unknown> {
  return apiDelete(`/api/crew/docks/${pathEncode(num)}`);
}

// ─── Fleet Presets ──────────────────────────────────────────

export async function fetchFleetPresets(): Promise<unknown[]> {
  const data = await apiFetch<{ fleetPresets: unknown[] }>("/api/fleet-presets");
  return data.fleetPresets;
}

export async function fetchFleetPreset(id: string): Promise<unknown> {
  return apiFetch(`/api/fleet-presets/${pathEncode(id)}`);
}

export async function createFleetPreset(name: string, notes: string): Promise<unknown> {
  return apiPost("/api/fleet-presets", { name, notes });
}

export async function updateFleetPreset(id: string, data: Record<string, unknown>): Promise<unknown> {
  return apiPatch(`/api/fleet-presets/${pathEncode(id)}`, data);
}

export async function deleteFleetPreset(id: string): Promise<unknown> {
  return apiDelete(`/api/fleet-presets/${pathEncode(id)}`);
}

export async function setFleetPresetSlots(id: string, slots: unknown): Promise<unknown> {
  return apiPut(`/api/fleet-presets/${pathEncode(id)}/slots`, { slots });
}

export async function activateFleetPreset(id: string): Promise<unknown> {
  return apiPost(`/api/fleet-presets/${pathEncode(id)}/activate`, {});
}

// ─── Plan Items ─────────────────────────────────────────────

export interface PlanFilters {
  active?: boolean;
  dockNumber?: number;
}

export async function fetchCrewPlanItems(filters?: PlanFilters): Promise<unknown[]> {
  const data = await apiFetch<{ planItems: unknown[] }>(`/api/crew/plan${qs({ ...filters })}`);
  return data.planItems;
}

export async function fetchCrewPlanItem(id: string): Promise<unknown> {
  return apiFetch(`/api/crew/plan/${pathEncode(id)}`);
}

export async function createCrewPlanItem(data: Record<string, unknown>): Promise<unknown> {
  return apiPost("/api/crew/plan", data);
}

export async function updateCrewPlanItem(id: string, data: Record<string, unknown>): Promise<unknown> {
  return apiPatch(`/api/crew/plan/${pathEncode(id)}`, data);
}

export async function deleteCrewPlanItem(id: string): Promise<unknown> {
  return apiDelete(`/api/crew/plan/${pathEncode(id)}`);
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
): Promise<unknown> {
  return apiPut(`/api/officer-reservations/${pathEncode(officerId)}`, {
    reservedFor,
    locked,
    notes,
  });
}

export async function deleteReservation(officerId: string): Promise<unknown> {
  return apiDelete(`/api/officer-reservations/${pathEncode(officerId)}`);
}

// ─── Effective State ────────────────────────────────────────

export async function fetchEffectiveState(): Promise<EffectiveDockState> {
  return apiFetch<EffectiveDockState>("/api/effective-state");
}
