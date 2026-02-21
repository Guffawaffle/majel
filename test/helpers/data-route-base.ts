export interface QueryValidationCase {
  name: string;
  query: string;
  expectedStatus: number;
}

export interface IdValidationCase {
  name: string;
  id: string;
  expectedStatus: number;
}

export interface PayloadValidationCase<T = Record<string, unknown>> {
  name: string;
  payload: T;
  expectedStatus: number;
  expectedMessageFragment?: string;
}

export interface RouteErrorCaseShape {
  name: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  expectedStatus: number;
  expectedCode?: string;
}

export const BASE_LIMIT_QUERY_CASES: QueryValidationCase[] = [
  { name: "limit too low", query: "limit=0", expectedStatus: 400 },
  { name: "limit too high", query: "limit=201", expectedStatus: 400 },
  { name: "limit non-numeric", query: "limit=not-a-number", expectedStatus: 400 },
];

export const BASE_RECEIPT_ID_CASES: IdValidationCase[] = [
  { name: "alpha id", id: "abc", expectedStatus: 400 },
  { name: "decimal-like id", id: "1.5", expectedStatus: 404 },
];

export const BASE_RECEIPT_STORE_UNAVAILABLE_CASES: RouteErrorCaseShape[] = [
  {
    name: "list receipts",
    method: "get",
    path: "/api/import/receipts",
    expectedStatus: 503,
    expectedCode: "RECEIPT_STORE_NOT_AVAILABLE",
  },
  {
    name: "get receipt",
    method: "get",
    path: "/api/import/receipts/1",
    expectedStatus: 503,
    expectedCode: "RECEIPT_STORE_NOT_AVAILABLE",
  },
  {
    name: "undo receipt",
    method: "post",
    path: "/api/import/receipts/1/undo",
    expectedStatus: 503,
    expectedCode: "RECEIPT_STORE_NOT_AVAILABLE",
  },
  {
    name: "resolve receipt",
    method: "post",
    path: "/api/import/receipts/1/resolve",
    body: { resolvedItems: [] },
    expectedStatus: 503,
    expectedCode: "RECEIPT_STORE_NOT_AVAILABLE",
  },
];

export const BASE_PROPOSAL_STORE_UNAVAILABLE_CASES: RouteErrorCaseShape[] = [
  {
    name: "list proposals",
    method: "get",
    path: "/api/mutations/proposals",
    expectedStatus: 503,
    expectedCode: "PROPOSAL_STORE_NOT_AVAILABLE",
  },
  {
    name: "get proposal detail",
    method: "get",
    path: "/api/mutations/proposals/prop_any",
    expectedStatus: 503,
    expectedCode: "PROPOSAL_STORE_NOT_AVAILABLE",
  },
  {
    name: "create proposal",
    method: "post",
    path: "/api/mutations/proposals",
    body: { tool: "sync_overlay", args: {} },
    expectedStatus: 503,
    expectedCode: "PROPOSAL_STORE_NOT_AVAILABLE",
  },
  {
    name: "apply proposal",
    method: "post",
    path: "/api/mutations/proposals/prop_any/apply",
    body: {},
    expectedStatus: 503,
    expectedCode: "PROPOSAL_STORE_NOT_AVAILABLE",
  },
];

export const BASE_PROPOSAL_CREATE_VALIDATION_CASES: PayloadValidationCase[] = [
  {
    name: "tool missing",
    payload: { args: { export: {} } },
    expectedStatus: 400,
    expectedMessageFragment: "tool",
  },
  {
    name: "args missing",
    payload: { tool: "sync_overlay" },
    expectedStatus: 400,
    expectedMessageFragment: "args",
  },
  {
    name: "unsupported tool",
    payload: { tool: "delete_everything", args: {} },
    expectedStatus: 400,
    expectedMessageFragment: "not supported",
  },
];

export const BASE_RECEIPT_RESOLVE_PAYLOAD_CASES: PayloadValidationCase[] = [
  {
    name: "resolvedItems wrong type",
    payload: { resolvedItems: "not-an-array" },
    expectedStatus: 400,
    expectedMessageFragment: "resolvedItems must be an array",
  },
  {
    name: "resolvedItems over limit",
    payload: { resolvedItems: Array.from({ length: 501 }, (_, i) => ({ id: i })) },
    expectedStatus: 400,
    expectedMessageFragment: "500 or fewer",
  },
  {
    name: "resolvedItems has non-object",
    payload: { resolvedItems: ["not-an-object"] },
    expectedStatus: 400,
    expectedMessageFragment: "must be an object",
  },
];

export function baseImportParsePayloadCases(toBase64: (text: string) => string): PayloadValidationCase[] {
  return [
    {
      name: "missing fileName",
      payload: { fileName: "", contentBase64: "x", format: "csv" },
      expectedStatus: 400,
      expectedMessageFragment: "fileName",
    },
    {
      name: "missing contentBase64",
      payload: { fileName: "fleet.csv", contentBase64: "", format: "csv" },
      expectedStatus: 400,
      expectedMessageFragment: "contentBase64",
    },
    {
      name: "invalid format",
      payload: { fileName: "fleet.csv", contentBase64: toBase64("x"), format: "json" },
      expectedStatus: 400,
      expectedMessageFragment: "format",
    },
  ];
}

export const BASE_IMPORT_MAP_PAYLOAD_CASES: PayloadValidationCase[] = [
  {
    name: "headers wrong type",
    payload: { headers: "bad", rows: [], mapping: {} },
    expectedStatus: 400,
    expectedMessageFragment: "headers must be a string[]",
  },
  {
    name: "rows wrong type",
    payload: { headers: ["A"], rows: "bad", mapping: {} },
    expectedStatus: 400,
    expectedMessageFragment: "rows must be a string[][]",
  },
  {
    name: "mapping missing object",
    payload: { headers: ["A"], rows: [[]], mapping: null },
    expectedStatus: 400,
    expectedMessageFragment: "mapping must be an object",
  },
];

export const BASE_IMPORT_COMMIT_PAYLOAD_CASES: PayloadValidationCase[] = [
  {
    name: "resolvedRows wrong type",
    payload: { resolvedRows: "bad", unresolved: [] },
    expectedStatus: 400,
    expectedMessageFragment: "resolvedRows must be an array",
  },
  {
    name: "resolvedRows over limit",
    payload: {
      resolvedRows: Array.from({ length: 10001 }, () => ({})),
      unresolved: [],
    },
    expectedStatus: 400,
    expectedMessageFragment: "10000 or fewer",
  },
];
