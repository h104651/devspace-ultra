chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id;
  const url = String(tab?.url || "");
  if (!tabId || !url.startsWith("https://chatgpt.com/")) {
    if (tabId) {
      await chrome.action.setBadgeText({ tabId, text: "ERR" }).catch(() => {});
      await chrome.action.setTitle({ tabId, title: "Open a chatgpt.com worker tab first" }).catch(() => {});
    }
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await chrome.action.setBadgeText({ tabId, text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#16803c" });
    await chrome.action.setTitle({ tabId, title: "Chat Swarm Wake Bridge active on this tab" });
  } catch (error) {
    console.error("Chat Swarm Wake Bridge injection failed", error);
    await chrome.action.setBadgeText({ tabId, text: "ERR" }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b42318" }).catch(() => {});
    await chrome.action.setTitle({ tabId, title: `Injection failed: ${error?.message || error}` }).catch(() => {});
  }
});
