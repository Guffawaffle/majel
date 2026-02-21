import type { Express } from "express";
import type { Test, Response } from "supertest";
import { expect } from "vitest";
import { testRequest } from "./test-request.js";

export type RouteMethod = "get" | "post" | "put" | "patch" | "delete";

export interface RouteErrorCase {
  name: string;
  method: RouteMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  expectedStatus: number;
  expectedCode?: string;
  expectedMessageFragment?: string;
}

function makeRequest(app: Express, routeCase: RouteErrorCase) {
  const agent = testRequest(app);
  const withHeaders = (request: Test): Test => {
    if (!routeCase.headers) return request;
    for (const [key, value] of Object.entries(routeCase.headers)) {
      request = request.set(key, value);
    }
    return request;
  };

  switch (routeCase.method) {
    case "get":
      return withHeaders(agent.get(routeCase.path));
    case "post":
      return withHeaders(routeCase.body === undefined
        ? agent.post(routeCase.path)
        : agent.post(routeCase.path).send(routeCase.body));
    case "put":
      return withHeaders(routeCase.body === undefined
        ? agent.put(routeCase.path)
        : agent.put(routeCase.path).send(routeCase.body));
    case "patch":
      return withHeaders(routeCase.body === undefined
        ? agent.patch(routeCase.path)
        : agent.patch(routeCase.path).send(routeCase.body));
    case "delete":
      return withHeaders(routeCase.body === undefined
        ? agent.delete(routeCase.path)
        : agent.delete(routeCase.path).send(routeCase.body));
  }
}

export async function expectRouteErrorCase(app: Express, routeCase: RouteErrorCase): Promise<Response> {
  const res = await makeRequest(app, routeCase);
  expect(res.status).toBe(routeCase.expectedStatus);
  if (routeCase.expectedCode) {
    expect(res.body.error.code).toBe(routeCase.expectedCode);
  }
  if (routeCase.expectedMessageFragment) {
    expect(String(res.body.error.message)).toContain(routeCase.expectedMessageFragment);
  }
  return res;
}
