/**
 * Shared AX-facing response contracts used by API envelope and Cloud CLI AX mode.
 */

export interface AxExecutionMeta {
  timestamp: string;
  durationMs: number;
}

export interface AxHints {
  hints?: string[];
}

export interface AxCommandOutput<TData extends Record<string, unknown> = Record<string, unknown>> extends AxExecutionMeta, AxHints {
  command: string;
  success: boolean;
  data: TData;
  errors?: string[];
}

export interface ApiMeta extends AxExecutionMeta {
  requestId: string;
}

export interface ApiSuccess<T = unknown> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: unknown;
    hints?: string[];
  };
  meta: ApiMeta;
}

export type ApiEnvelope<T = unknown> = ApiSuccess<T> | ApiErrorResponse;