const endpointEl = document.getElementById("endpoint");
const labelEl = document.getElementById("label");
const pairCodeEl = document.getElementById("pairCode");
const accessModeEl = document.getElementById("accessMode");
const developerModeEl = document.getElementById("developerMode");
const pairBtn = document.getElementById("pair");
const shareBtn = document.getElementById("share");
const unshareBtn = document.getElementById("unshare");
const savePrefsBtn = document.getElementById("savePrefs");
const disconnectBtn = document.getElementById("disconnect");
const statusEl = document.getElementById("status");
const statePill = document.getElementById("statePill");

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.previousLabel = button.textContent;
    button.textContent = label || "Working…";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.previousLabel || button.textContent;
    button.disabled = false;
    delete button.dataset.previousLabel;
  }
}

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.classList.remove("ok", "bad");
  if (type) statusEl.classList.add(type);
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Browser Control Bridge request failed."));
        return;
      }
      resolve(response);
    });
  });
}

async function refresh() {
  try {
    const state = await send({ type: "status" });
    endpointEl.value = state.endpoint || "http://127.0.0.1:7676";
    labelEl.value = state.label || "Chrome";
    accessModeEl.value = state.accessMode === "all" ? "all" : "selected";
    developerModeEl.checked = Boolean(state.developerMode);

    if (state.paired) {
      statePill.textContent = "Connected";
      statePill.style.background = "#eaf8f2";
      statePill.style.color = "#198963";
      const sharing = state.currentTabShared ? "shared" : "not shared";
      setStatus(`Connected as ${state.bridgeId || "bridge"}. Current tab ${state.currentTabId ?? "—"} is ${sharing}. ${state.attachedTabs?.length || 0} tab(s) currently attached.`, "ok");
      pairBtn.textContent = "Re-pair with new code";
      shareBtn.disabled = Boolean(state.currentTabShared);
      unshareBtn.disabled = !state.currentTabShared;
      savePrefsBtn.disabled = false;
      disconnectBtn.disabled = false;
    } else {
      statePill.textContent = "Disconnected";
      statePill.style.background = "#eef4fb";
      statePill.style.color = "#47709e";
      setStatus("Not paired. Ask DevSpace for browser_control_pair, then enter the one-time code above.");
      pairBtn.textContent = "Pair with DevSpace";
      shareBtn.disabled = true;
      unshareBtn.disabled = true;
      savePrefsBtn.disabled = true;
      disconnectBtn.disabled = true;
    }
  } catch (error) {
    statePill.textContent = "Error";
    setStatus(error.message, "bad");
  }
}

pairBtn.addEventListener("click", async () => {
  const code = pairCodeEl.value.trim().toUpperCase();
  if (!code) {
    setStatus("Enter the one-time pair code returned by browser_control_pair.", "bad");
    return;
  }
  setBusy(pairBtn, true, "Pairing…");
  try {
    const result = await send({
      type: "pair",
      payload: {
        endpoint: endpointEl.value.trim(),
        pairCode: code,
        label: labelEl.value.trim(),
        accessMode: accessModeEl.value,
        developerMode: developerModeEl.checked,
      },
    });
    pairCodeEl.value = "";
    setStatus(`Paired successfully as ${result.bridgeId}.`, "ok");
    await refresh();
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    setBusy(pairBtn, false);
  }
});

shareBtn.addEventListener("click", async () => {
  setBusy(shareBtn, true, "Sharing…");
  try {
    const result = await send({ type: "share-current", shared: true });
    setStatus(`Chrome tab ${result.tabId} is now available for DevSpace agents to claim.`, "ok");
    await refresh();
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    setBusy(shareBtn, false);
  }
});

unshareBtn.addEventListener("click", async () => {
  setBusy(unshareBtn, true, "Unsharing…");
  try {
    const result = await send({ type: "share-current", shared: false });
    setStatus(`Chrome tab ${result.tabId} is no longer shared. DevSpace revokes any active claim and detaches browser control on the next sync.`, "ok");
    await refresh();
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    setBusy(unshareBtn, false);
  }
});

savePrefsBtn.addEventListener("click", async () => {
  setBusy(savePrefsBtn, true, "Saving…");
  try {
    await send({
      type: "preferences",
      payload: {
        label: labelEl.value.trim(),
        accessMode: accessModeEl.value,
        developerMode: developerModeEl.checked,
      },
    });
    setStatus("Browser Control preferences saved.", "ok");
    await refresh();
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    setBusy(savePrefsBtn, false);
  }
});

disconnectBtn.addEventListener("click", async () => {
  setBusy(disconnectBtn, true, "Disconnecting…");
  try {
    await send({ type: "disconnect" });
    pairCodeEl.value = "";
    setStatus("Browser Control Bridge disconnected. Existing DevSpace claims will expire/fail safely.", "ok");
    await refresh();
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    setBusy(disconnectBtn, false);
  }
});

void refresh();
