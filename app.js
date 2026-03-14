const form = document.getElementById("project-form");
const input = document.getElementById("project-input");
const statusBox = document.getElementById("status");
const resultsBox = document.getElementById("results");
const CORS_PROXY_BASE = "https://cloudflare-cors-anywhere.themadpunter10.workers.dev";
let currentTransformedEntries = [];

function setStatus(text, type = "info") {
  statusBox.textContent = text;
  statusBox.className = `status ${type}`;
}

function transformLevelCode(rawCode) {
  const replaced = String(rawCode).replaceAll(" ", "Z").replaceAll("+", "B").replaceAll("-", "C");
  const lengthPrefix = String(replaced.length + 1234567);
  return `${lengthPrefix}${replaced}`;
}

function normalizeProjectId(inputValue) {
  if (!inputValue) {
    return null;
  }

  const trimmed = String(inputValue).trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(/scratch\.mit\.edu\/projects\/(\d+)/i);
  return match?.[1] ?? null;
}

function getProxyCandidates(targetUrl) {
  const proxyBase = CORS_PROXY_BASE.replace(/\/+$/, "");
  return [
    `${proxyBase}/?${targetUrl}`,
    `${proxyBase}/?uri=${encodeURIComponent(targetUrl)}`,
    `${proxyBase}/${targetUrl}`,
    `${proxyBase}/?url=${encodeURIComponent(targetUrl)}`,
  ];
}

async function fetchThroughProxy(targetUrl, options = {}) {
  const candidates = getProxyCandidates(targetUrl);
  let lastError = null;

  for (const proxiedUrl of candidates) {
    try {
      const response = await fetch(proxiedUrl, options);
      if (response.ok) {
        return response;
      }

      lastError = new Error(`Request failed (${response.status})`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Proxy request failed");
}

async function fetchProjectAsArrayBuffer(projectId) {
  let token = null;

  try {
    const metaResponse = await fetchThroughProxy(`https://api.scratch.mit.edu/projects/${projectId}`, {
      headers: { Accept: "application/json" },
    });
    const meta = await metaResponse.json();
    token = meta?.project_token ?? null;
  } catch {
    token = null;
  }

  const candidateUrls = [
    token ? `https://projects.scratch.mit.edu/${projectId}?token=${encodeURIComponent(token)}` : null,
    `https://projects.scratch.mit.edu/${projectId}`,
  ].filter(Boolean);

  let lastError = null;

  for (const sourceUrl of candidateUrls) {
    try {
      const response = await fetchThroughProxy(sourceUrl);
      const arrayBuffer = await response.arrayBuffer();

      if (arrayBuffer.byteLength === 0) {
        lastError = new Error(`Empty response for ${sourceUrl}`);
        continue;
      }

      return { arrayBuffer, sourceUrl };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Unable to download Scratch project");
}

async function extractProjectJson(arrayBuffer) {
  try {
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const projectJsonFile = zip.file("project.json");

    if (!projectJsonFile) {
      throw new Error("project.json not found in archive");
    }

    const jsonText = await projectJsonFile.async("string");
    return { jsonText, archiveType: "zip" };
  } catch {
    const text = new TextDecoder("utf-8").decode(arrayBuffer).trim();

    if (!text.startsWith("{")) {
      throw new Error("Downloaded file is not a valid Scratch .sb3 archive or JSON project");
    }

    return { jsonText: text, archiveType: "json" };
  }
}

function getLevelsListEntries(projectJson) {
  const monitors = Array.isArray(projectJson.monitors) ? projectJson.monitors : [];
  const levelsMonitor = monitors.find((monitor) => {
    const listName = monitor?.params?.LIST;
    const spriteName = monitor?.spriteName;

    return (
      monitor?.mode === "list" &&
      monitor?.opcode === "data_listcontents" &&
      String(listName).toLowerCase() === "levels" &&
      String(spriteName).toLowerCase() === "levels" &&
      typeof monitor?.id === "string"
    );
  });

  const levelsListId = levelsMonitor?.id;
  const targets = Array.isArray(projectJson.targets) ? projectJson.targets : [];

  if (levelsListId) {
    for (const target of targets) {
      const lists = target?.lists;
      if (!lists || typeof lists !== "object") {
        continue;
      }

      const listData = lists[levelsListId];
      const listName = listData?.[0];
      const listItems = listData?.[1];

      if (String(listName).toLowerCase() === "levels" && Array.isArray(listItems)) {
        return listItems.map((item, index) => ({
          index,
          value: String(item),
        }));
      }
    }
  }

  for (const target of targets) {
    const lists = target?.lists;
    if (!lists || typeof lists !== "object") {
      continue;
    }

    for (const listId of Object.keys(lists)) {
      const listData = lists[listId];
      const listName = listData?.[0];
      const listItems = listData?.[1];

      if (String(listName).toLowerCase() === "levels" && Array.isArray(listItems)) {
        return listItems.map((item, index) => ({
          index,
          value: String(item),
        }));
      }
    }
  }

  return null;
}

async function loadProjectLevels(projectInput) {
  const projectId = normalizeProjectId(projectInput);
  if (!projectId) {
    throw new Error("Enter a Scratch project ID or URL.");
  }

  const { arrayBuffer, sourceUrl } = await fetchProjectAsArrayBuffer(projectId);
  const { jsonText, archiveType } = await extractProjectJson(arrayBuffer);

  let projectJson;
  try {
    projectJson = JSON.parse(jsonText);
  } catch {
    throw new Error("project.json could not be parsed.");
  }

  const levels = getLevelsListEntries(projectJson);
  if (!levels) {
    throw new Error("No list named 'levels' was found in project.json.");
  }

  return { projectId, sourceUrl, archiveType, levels };
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function renderEntries(levels) {
  if (!levels?.length) {
    resultsBox.innerHTML = "<p>No entries found in list <code>levels</code>.</p>";
    currentTransformedEntries = [];
    return;
  }

  currentTransformedEntries = levels.map((entry) => ({
    index: entry.index,
    value: transformLevelCode(entry.value),
  }));

  const rows = currentTransformedEntries
    .map(
      (entry, listIndex) => `
      <li class="entry-row">
        <span class="entry-index">#${entry.index + 1}</span>
        <span class="entry-value" title="${escapeHtml(entry.value)}">${escapeHtml(entry.value)}</span>
        <button type="button" class="copy-btn" data-entry-index="${listIndex}">Copy</button>
      </li>`
    )
    .join("");

  resultsBox.innerHTML = `
    <h2>Levels entries (${levels.length})</h2>
    <ul class="entries-list">${rows}</ul>
  `;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

resultsBox.addEventListener("click", async (event) => {
  const button = event.target.closest(".copy-btn");
  if (!button) {
    return;
  }

  const index = Number(button.dataset.entryIndex);
  const entry = currentTransformedEntries[index];
  if (!entry) {
    setStatus("Could not find level code to copy.", "error");
    return;
  }

  try {
    await copyTextToClipboard(entry.value);
    setStatus(`Copied transformed code for level #${entry.index + 1}.`, "success");
  } catch {
    setStatus("Copy failed. Your browser may block clipboard access.", "error");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resultsBox.innerHTML = "";
  setStatus("Downloading and parsing project through CORS proxy...", "info");

  try {
    const data = await loadProjectLevels(input.value);

    setStatus(`Loaded project ${data.projectId} (${data.archiveType}). Found ${data.levels.length} entries.`, "success");
    renderEntries(data.levels);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(message, "error");
  }
});
