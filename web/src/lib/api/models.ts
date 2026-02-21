/**
 * Models API — list available models, select active model.
 */

import type { ModelsResponse, ModelSelectResponse } from "../types.js";
import { apiFetch, apiPost } from "./fetch.js";
import { runLockedMutation } from "./mutation.js";

/**
 * Fetch available AI models and the current selection.
 * Throws ApiError on failure.
 */
export async function fetchModels(): Promise<ModelsResponse> {
  return apiFetch<ModelsResponse>("/api/models");
}

/**
 * Select an AI model as the active model.
 * Throws ApiError on failure.
 */
export async function selectModel(modelId: string): Promise<ModelSelectResponse> {
  return runLockedMutation({
    label: `Select model ${modelId}`,
    lockKey: "model:select",
    mutate: () => apiPost<ModelSelectResponse>("/api/models/select", { model: modelId }),
  });
}
