const form = document.getElementById("project-form");
const input = document.getElementById("project-input");
const statusBox = document.getElementById("status");
const resultsBox = document.getElementById("results");
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
  setStatus("Downloading and parsing project...", "info");

  try {
    const response = await fetch("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: input.value }),
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : { error: await response.text() };

    if (!response.ok) {
      throw new Error(data.error || "Unable to process project");
    }

    setStatus(`Loaded project ${data.projectId} (${data.archiveType}). Found ${data.levels.length} entries.`, "success");
    renderEntries(data.levels);
  } catch (error) {
    if (error instanceof TypeError && /Failed to fetch/i.test(error.message)) {
      setStatus(
        "Cannot reach backend API. Start the server with 'npm start' and open http://localhost:3000.",
        "error"
      );
      return;
    }

    setStatus(error.message || "Unknown error", "error");
  }
});
