import express from "express";
import JSZip from "jszip";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  return next(error);
});

function normalizeProjectId(input) {
  if (!input) {
    return null;
  }

  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(/scratch\.mit\.edu\/projects\/(\d+)/i);
  return match?.[1] ?? null;
}

async function fetchProjectAsBuffer(projectId) {
  let token = null;

  try {
    const metaResponse = await fetch(`https://api.scratch.mit.edu/projects/${projectId}`, {
      headers: {
        "User-Agent": "appel-fetcher/1.0",
        Accept: "application/json",
      },
    });

    if (metaResponse.ok) {
      const meta = await metaResponse.json();
      token = meta?.project_token ?? null;
    }
  } catch {
    token = null;
  }

  const candidateUrls = [
    token ? `https://projects.scratch.mit.edu/${projectId}?token=${encodeURIComponent(token)}` : null,
    `https://projects.scratch.mit.edu/${projectId}`,
  ].filter(Boolean);

  let lastError = null;

  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "appel-fetcher/1.0",
          Accept: "*/*",
        },
      });

      if (!response.ok) {
        lastError = new Error(`Request failed (${response.status}) for ${url}`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length === 0) {
        lastError = new Error(`Empty response for ${url}`);
        continue;
      }

      return { buffer, sourceUrl: url };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Unable to download Scratch project");
}

async function extractProjectJson(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const projectJsonFile = zip.file("project.json");

    if (!projectJsonFile) {
      throw new Error("project.json not found in archive");
    }

    const jsonText = await projectJsonFile.async("string");
    return { jsonText, archiveType: "zip" };
  } catch {
    const text = buffer.toString("utf8").trim();

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

      if (listName === "levels" && Array.isArray(listItems)) {
        return listItems.map((item, index) => ({
          index,
          value: String(item),
        }));
      }
    }
  }

  return null;
}

function sanitizeFilename(input) {
  return String(input)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "entry";
}

app.post("/api/project", async (req, res) => {
  try {
    const projectId = normalizeProjectId(req.body?.project);
    if (!projectId) {
      return res.status(400).json({ error: "Enter a Scratch project ID or URL." });
    }

    const { buffer, sourceUrl } = await fetchProjectAsBuffer(projectId);
    const { jsonText, archiveType } = await extractProjectJson(buffer);
    let projectJson;

    try {
      projectJson = JSON.parse(jsonText);
    } catch {
      return res.status(500).json({ error: "project.json could not be parsed." });
    }
    const levels = getLevelsListEntries(projectJson);

    if (!levels) {
      return res.status(404).json({
        error: "No list named 'levels' was found in project.json.",
        projectId,
        sourceUrl,
        archiveType,
      });
    }

    return res.json({
      projectId,
      sourceUrl,
      archiveType,
      levels,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

app.get("/api/download-entry", async (req, res) => {
  try {
    const value = String(req.query.value ?? "");
    if (!value) {
      return res.status(400).json({ error: "Missing entry value." });
    }

    const isUrl = /^https?:\/\//i.test(value);

    if (isUrl) {
      const response = await fetch(value, {
        headers: { "User-Agent": "appel-fetcher/1.0" },
      });

      if (!response.ok) {
        return res.status(502).json({ error: `Failed to download entry URL (${response.status}).` });
      }

      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const urlPath = new URL(value).pathname;
      const rawName = urlPath.split("/").pop() || "entry.bin";
      const safeName = sanitizeFilename(rawName);

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      return res.send(Buffer.from(arrayBuffer));
    }

    const safeName = `${sanitizeFilename(value.slice(0, 32)) || "entry"}.txt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    return res.send(value);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`App running at http://localhost:${PORT}`);
  });
}

export default app;
