import type { Application } from "express";

export interface RegisteredRoute {
  method: string;
  path: string;
}

function toStack(app: Application): unknown[] {
  const maybeApp = app as unknown as { router?: { stack?: unknown[] }; _router?: { stack?: unknown[] } };
  return maybeApp.router?.stack ?? maybeApp._router?.stack ?? [];
}

function walk(stack: unknown[], output: RegisteredRoute[]): void {
  for (const item of stack) {
    const layer = item as {
      route?: {
        path?: string | string[];
        methods?: Record<string, boolean>;
      };
      handle?: { stack?: unknown[] };
    };

    if (layer.route?.path && layer.route?.methods) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        if (!path.startsWith("/api")) continue;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled) continue;
          output.push({ method: method.toUpperCase(), path });
        }
      }
      continue;
    }

    const childStack = layer.handle?.stack;
    if (Array.isArray(childStack)) {
      walk(childStack, output);
    }
  }
}

/**
 * Return all registered API routes discovered from Express internals.
 * Uses both app.router (Express 5) and app._router (compat fallback).
 */
export function collectApiRoutes(app: Application): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  walk(toStack(app), routes);

  const unique = new Map<string, RegisteredRoute>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (!unique.has(key)) unique.set(key, route);
  }

  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}