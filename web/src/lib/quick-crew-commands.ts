import type { BridgeSlot } from "./types.js";

export interface QuickCrewUiState {
  selectedRecommendation: number;
  selectedSlots: Record<BridgeSlot, string>;
  pickerSlot: BridgeSlot | null;
  pickerSearch: string;
  saveSuccess: string;
}

export type QuickCrewCommand =
  | { type: "recommendation/select"; index: number; slots: Record<BridgeSlot, string> }
  | { type: "picker/open"; slot: BridgeSlot }
  | { type: "picker/close" }
  | { type: "picker/search"; value: string }
  | { type: "slot/choose"; slot: BridgeSlot; officerId: string }
  | { type: "slot/clear"; slot: BridgeSlot }
  | { type: "save/success"; message: string }
  | { type: "save/clear" }
  | { type: "state/sync"; slots: Record<BridgeSlot, string>; selectedRecommendation: number };

export function createInitialQuickCrewState(): QuickCrewUiState {
  return {
    selectedRecommendation: 0,
    selectedSlots: {
      captain: "",
      bridge_1: "",
      bridge_2: "",
    },
    pickerSlot: null,
    pickerSearch: "",
    saveSuccess: "",
  };
}

export function routeQuickCrewCommand(
  state: QuickCrewUiState,
  command: QuickCrewCommand,
): QuickCrewUiState {
  switch (command.type) {
    case "recommendation/select":
      return {
        ...state,
        selectedRecommendation: command.index,
        selectedSlots: {
          ...command.slots,
        },
        pickerSlot: null,
        pickerSearch: "",
        saveSuccess: "",
      };

    case "picker/open":
      return {
        ...state,
        pickerSlot: command.slot,
        pickerSearch: "",
      };

    case "picker/close":
      return {
        ...state,
        pickerSlot: null,
      };

    case "picker/search":
      return {
        ...state,
        pickerSearch: command.value,
      };

    case "slot/choose":
      return {
        ...state,
        selectedSlots: {
          ...state.selectedSlots,
          [command.slot]: command.officerId,
        },
        pickerSlot: null,
        saveSuccess: "",
      };

    case "slot/clear":
      return {
        ...state,
        selectedSlots: {
          ...state.selectedSlots,
          [command.slot]: "",
        },
        saveSuccess: "",
      };

    case "save/success":
      return {
        ...state,
        saveSuccess: command.message,
      };

    case "save/clear":
      return {
        ...state,
        saveSuccess: "",
      };

    case "state/sync":
      return {
        ...state,
        selectedSlots: command.slots,
        selectedRecommendation: command.selectedRecommendation,
      };

    default:
      return state;
  }
}
