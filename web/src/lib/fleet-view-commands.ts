export type FleetTab = "officers" | "ships";
export type FleetViewMode = "cards" | "list";
export type FleetSortDir = "asc" | "desc";

export interface FleetViewUiState {
  activeTab: FleetTab;
  viewMode: FleetViewMode;
  searchQuery: string;
  sortField: string;
  sortDir: FleetSortDir;
  editingReservation: string | null;
}

export type FleetViewCommand =
  | { type: "tab/switch"; tab: FleetTab }
  | { type: "search/set"; value: string }
  | { type: "sort/toggle"; field: string }
  | { type: "view-mode/set"; mode: FleetViewMode }
  | { type: "reservation/edit-start"; officerId: string }
  | { type: "reservation/edit-cancel" };

export function createInitialFleetViewUiState(): FleetViewUiState {
  return {
    activeTab: "officers",
    viewMode: "cards",
    searchQuery: "",
    sortField: "name",
    sortDir: "asc",
    editingReservation: null,
  };
}

export function routeFleetViewCommand(state: FleetViewUiState, command: FleetViewCommand): FleetViewUiState {
  switch (command.type) {
    case "tab/switch":
      return {
        ...state,
        activeTab: command.tab,
        searchQuery: "",
        sortField: "name",
        sortDir: "asc",
      };
    case "search/set":
      return {
        ...state,
        searchQuery: command.value,
      };
    case "sort/toggle":
      if (state.sortField === command.field) {
        return {
          ...state,
          sortDir: state.sortDir === "asc" ? "desc" : "asc",
        };
      }
      return {
        ...state,
        sortField: command.field,
        sortDir: "asc",
      };
    case "view-mode/set":
      return {
        ...state,
        viewMode: command.mode,
      };
    case "reservation/edit-start":
      return {
        ...state,
        editingReservation: command.officerId,
      };
    case "reservation/edit-cancel":
      return {
        ...state,
        editingReservation: null,
      };
    default:
      return state;
  }
}
