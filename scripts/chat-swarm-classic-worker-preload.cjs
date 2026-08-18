"use strict";

// ChatGPT Classic Worker Runtime Clone bootstrap.
//
// ChatGPT Classic (packaged Windows build) replaces Electron's userData path
// with the package LocalCache path before calling requestSingleInstanceLock().
// That makes ordinary --user-data-dir launches converge on the already-running
// instance. This preload runs before the app bundle, pins userData to a stable
// per-worker directory, and keeps subsequent app.setPath("userData", ...) calls
// on that directory. Electron's singleton lock can then be isolated per worker.

const fs = require("node:fs");
const path = require("node:path");

const workerUserData = String(process.env.CHATGPT_WORKER_USER_DATA || "").trim();
const workerId = String(process.env.CHATGPT_WORKER_ID || "worker").trim();

if (workerUserData) {
  if (!path.isAbsolute(workerUserData)) {
    throw new Error(`CHATGPT_WORKER_USER_DATA must be an absolute path: ${workerUserData}`);
  }

  fs.mkdirSync(workerUserData, { recursive: true });

  // NODE_OPTIONS --require is evaluated in the Electron main process, where
  // require("electron").app is available before ChatGPT's main bundle runs.
  const electron = require("electron");
  const app = electron && electron.app;

  if (!app || typeof app.setPath !== "function") {
    throw new Error("ChatGPT worker preload could not access electron.app.");
  }

  const originalSetPath = app.setPath.bind(app);
  originalSetPath("userData", workerUserData);

  // ChatGPT Classic calls app.setPath("userData", packageLocalCachePath) during
  // startup. Preserve all other setPath calls and override only userData.
  app.setPath = function chatSwarmWorkerSetPath(name, value) {
    if (name === "userData") {
      return originalSetPath(name, workerUserData);
    }
    return originalSetPath(name, value);
  };

  // Harmless diagnostic switch inherited by Chromium child processes. It lets
  // the launcher verify that this bootstrap actually executed without touching
  // ChatGPT account/session files.
  if (app.commandLine && typeof app.commandLine.appendSwitch === "function") {
    app.commandLine.appendSwitch("chat-swarm-worker-id", workerId);
  }
}
