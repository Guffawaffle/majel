export interface ImportsCompositionUiState {
  showPrompt: boolean;
  dismissed: boolean;
  generating: boolean;
  previewOpen: boolean;
}

export type ImportsCompositionCommand =
  | { type: "composition/reset" }
  | { type: "composition/after-import-commit" }
  | { type: "composition/generating"; value: boolean }
  | { type: "composition/open-preview" }
  | { type: "composition/skip" };

export function createInitialImportsCompositionUiState(): ImportsCompositionUiState {
  return {
    showPrompt: false,
    dismissed: false,
    generating: false,
    previewOpen: false,
  };
}

export function routeImportsCompositionCommand(
  state: ImportsCompositionUiState,
  command: ImportsCompositionCommand,
): ImportsCompositionUiState {
  switch (command.type) {
    case "composition/reset":
      return {
        ...state,
        showPrompt: false,
        dismissed: false,
        generating: false,
        previewOpen: false,
      };
    case "composition/after-import-commit":
      return {
        ...state,
        showPrompt: true,
        dismissed: false,
        previewOpen: false,
        generating: false,
      };
    case "composition/generating":
      return {
        ...state,
        generating: command.value,
      };
    case "composition/open-preview":
      return {
        ...state,
        previewOpen: true,
        showPrompt: false,
        generating: false,
      };
    case "composition/skip":
      return {
        ...state,
        dismissed: true,
        showPrompt: false,
        previewOpen: false,
        generating: false,
      };
    default:
      return state;
  }
}
