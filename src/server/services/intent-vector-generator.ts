import type { SeedIntentInput } from "../stores/effect-store.js";

export interface IntentVectorTargetContext {
  targetKind: string;
  engagement: string;
  targetTags: string[];
  shipContext?: {
    shipClass: string;
  };
}

export interface IntentVectorDef {
  intentKey: string;
  label: string;
  defaultTargetContext: IntentVectorTargetContext;
  weights: Record<string, number>;
}

export interface IntentVectorArtifact {
  intents: IntentVectorDef[];
}

export function buildIntentVectorArtifactFromSeed(intents: SeedIntentInput[]): IntentVectorArtifact {
  const vectors: IntentVectorDef[] = intents.map((intent) => {
    const weights: Record<string, number> = {};
    for (const entry of intent.effectWeights) {
      weights[entry.effectKey] = entry.weight;
    }

    const defaultTargetContext: IntentVectorTargetContext = {
      targetKind: intent.defaultContext?.targetKind ?? "hostile",
      engagement: intent.defaultContext?.engagement ?? "any",
      targetTags: intent.defaultContext?.targetTags ?? [],
    };

    if (intent.defaultContext?.shipClass) {
      defaultTargetContext.shipContext = { shipClass: intent.defaultContext.shipClass };
    }

    return {
      intentKey: intent.id,
      label: intent.name,
      defaultTargetContext,
      weights,
    };
  });

  return { intents: vectors };
}
