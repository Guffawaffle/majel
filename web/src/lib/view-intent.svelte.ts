/**
 * One-shot cross-view intents for navigation handoff.
 *
 * Used by Start/Sync hub to open specific contexts in other views without
 * coupling those views to hash query parsing.
 */

export type CatalogLaunchIntent = {
  ownership?: "unknown" | "owned" | "unowned";
};

export type WorkshopLaunchIntent = {
  tab?: "imports";
};

let pendingCatalogIntent = $state<CatalogLaunchIntent | null>(null);
let pendingWorkshopIntent = $state<WorkshopLaunchIntent | null>(null);

export function setCatalogLaunchIntent(intent: CatalogLaunchIntent): void {
  pendingCatalogIntent = intent;
}

export function consumeCatalogLaunchIntent(): CatalogLaunchIntent | null {
  const intent = pendingCatalogIntent;
  pendingCatalogIntent = null;
  return intent;
}

export function setWorkshopLaunchIntent(intent: WorkshopLaunchIntent): void {
  pendingWorkshopIntent = intent;
}

export function consumeWorkshopLaunchIntent(): WorkshopLaunchIntent | null {
  const intent = pendingWorkshopIntent;
  pendingWorkshopIntent = null;
  return intent;
}
