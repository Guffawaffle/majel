import type {
  BridgeCoreWithMembers,
  BridgeSlot,
  Loadout,
  LoadoutVariant,
  VariantPatch,
  BelowDeckPolicy,
  BelowDeckMode,
  ResolvedLoadout,
} from "../types.js";
import { apiFetch, apiDelete, apiPatch, apiPost, apiPut, pathEncode, qs } from "./fetch.js";
import { cachedFetch } from "../cache/cached-fetch.js";
import { cacheKey, TTL } from "../cache/cache-keys.js";
import { runLockedMutation } from "./mutation.js";
import type { FetchOpts } from "./crews-common.js";

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
