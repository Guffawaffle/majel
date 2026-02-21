export type LoadoutSortField = "name" | "ship" | "priority";
export type LoadoutSortDir = "asc" | "desc";
export type LoadoutActiveFilter = "" | "true" | "false";

export interface LoadoutsTabUiState {
  editingId: number | "new" | null;
  searchQuery: string;
  filterIntent: string;
  filterActive: LoadoutActiveFilter;
  sortField: LoadoutSortField;
  sortDir: LoadoutSortDir;
  expandedId: number | null;
  editingVariantId: number | "new" | null;
  formError: string;
  variantFormError: string;
}

export type LoadoutsTabCommand =
  | { type: "loadout/new" }
  | { type: "loadout/edit"; id: number }
  | { type: "loadout/edit-cancel" }
  | { type: "loadout/error"; message: string }
  | { type: "loadout/error-clear" }
  | { type: "search/set"; value: string }
  | { type: "filter/intent"; value: string }
  | { type: "filter/active"; value: LoadoutActiveFilter }
  | { type: "sort/field"; value: LoadoutSortField }
  | { type: "sort/toggle-dir" }
  | { type: "variant/toggle"; loadoutId: number }
  | { type: "variant/collapse" }
  | { type: "variant/new" }
  | { type: "variant/edit"; id: number }
  | { type: "variant/cancel" }
  | { type: "variant/error"; message: string }
  | { type: "variant/error-clear" };

export function createInitialLoadoutsTabUiState(): LoadoutsTabUiState {
  return {
    editingId: null,
    searchQuery: "",
    filterIntent: "",
    filterActive: "",
    sortField: "name",
    sortDir: "asc",
    expandedId: null,
    editingVariantId: null,
    formError: "",
    variantFormError: "",
  };
}

export function routeLoadoutsTabCommand(
  state: LoadoutsTabUiState,
  command: LoadoutsTabCommand,
): LoadoutsTabUiState {
  switch (command.type) {
    case "loadout/new":
      return {
        ...state,
        editingId: "new",
        formError: "",
        expandedId: null,
        editingVariantId: null,
        variantFormError: "",
      };
    case "loadout/edit":
      return {
        ...state,
        editingId: command.id,
        formError: "",
        expandedId: null,
        editingVariantId: null,
        variantFormError: "",
      };
    case "loadout/edit-cancel":
      return { ...state, editingId: null, formError: "" };
    case "loadout/error":
      return { ...state, formError: command.message };
    case "loadout/error-clear":
      return { ...state, formError: "" };
    case "search/set":
      return { ...state, searchQuery: command.value };
    case "filter/intent":
      return { ...state, filterIntent: command.value };
    case "filter/active":
      return { ...state, filterActive: command.value };
    case "sort/field":
      return { ...state, sortField: command.value };
    case "sort/toggle-dir":
      return { ...state, sortDir: state.sortDir === "asc" ? "desc" : "asc" };
    case "variant/toggle":
      if (state.expandedId === command.loadoutId) {
        return {
          ...state,
          expandedId: null,
          editingVariantId: null,
          variantFormError: "",
        };
      }
      return {
        ...state,
        expandedId: command.loadoutId,
        editingVariantId: null,
        variantFormError: "",
      };
    case "variant/collapse":
      return {
        ...state,
        expandedId: null,
        editingVariantId: null,
        variantFormError: "",
      };
    case "variant/new":
      return { ...state, editingVariantId: "new", variantFormError: "" };
    case "variant/edit":
      return { ...state, editingVariantId: command.id, variantFormError: "" };
    case "variant/cancel":
      return { ...state, editingVariantId: null, variantFormError: "" };
    case "variant/error":
      return { ...state, variantFormError: command.message };
    case "variant/error-clear":
      return { ...state, variantFormError: "" };
    default:
      return state;
  }
}
