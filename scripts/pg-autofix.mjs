#!/usr/bin/env node

import { execSync } from "node:child_process";

function run(command) {
  return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeRun(command) {
  try {
    return run(command);
  } catch {
    return "";
  }
}

function getContainerId() {
  return safeRun("docker compose ps -q postgres");
}

function main() {
  const dockerReady = safeRun("docker info --format '{{.ServerVersion}}'");
  if (!dockerReady) {
    console.error("Docker daemon is not available. Start Docker Desktop first.");
    process.exit(1);
  }

  let containerId = getContainerId();
  if (!containerId) {
    console.log("postgres service not found yet; creating it now...");
    run("docker compose up -d postgres");
    containerId = getContainerId();
  } else {
    run("docker compose up -d postgres");
  }

  if (!containerId) {
    console.error("Unable to resolve postgres container ID from docker compose.");
    process.exit(1);
  }

  run(`docker update --restart unless-stopped ${containerId}`);

  const restartPolicy = run(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${containerId}`);
  const runningName = run(`docker inspect -f '{{.Name}}' ${containerId}`).replace(/^\//, "");

  console.log("Postgres autofix applied.");
  console.log(`container=${runningName}`);
  console.log(`restartPolicy=${restartPolicy}`);

  if (restartPolicy !== "unless-stopped") {
    console.error("Restart policy verification failed.");
    process.exit(1);
  }
}

main();
