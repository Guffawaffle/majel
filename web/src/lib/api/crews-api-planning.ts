import type {
  Dock,
  FleetPresetSlot,
  FleetPresetWithSlots,
  PlanItem,
  PlanSource,
  OfficerReservation,
  EffectiveDockState,
} from "../types.js";
import { apiFetch, apiDelete, apiPatch, apiPost, apiPut, pathEncode, qs } from "./fetch.js";
import { cachedFetch } from "../cache/cached-fetch.js";
import { cacheKey, TTL } from "../cache/cache-keys.js";
import { runLockedMutation } from "./mutation.js";
import type { FetchOpts } from "./crews-common.js";

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

export interface PlanFilters {
  active?: boolean;
  dockNumber?: number;
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
