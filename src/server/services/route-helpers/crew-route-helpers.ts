import type { Response } from "express";
import type { AppState } from "../../app-context.js";

export const MAX_NAME = 200;
export const MAX_NOTES = 2000;
export const MAX_LABEL = 200;

export function getCrewStore(appState: AppState, res: Response) {
  const userId = (res.locals.userId as string) || "local";
  return appState.crewStoreFactory?.forUser(userId) ?? appState.crewStore;
}
