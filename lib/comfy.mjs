import { OFFLINE_MESSAGE } from "./http.mjs";
import { assetName } from "./workflow.mjs";

function offline() {
  return new Error(OFFLINE_MESSAGE);
}

async function drain(res) {
  if (!res) return;
  try {
    await res.arrayBuffer();
  } catch {
    // Ignore a body we will not surface.
  }
}

export async function uploadAsset({ endpoint, key, bytes, filename, contentType, fetchImpl }) {
  const form = new FormData();
  form.append("content_type", contentType);
  form.append("file_path", filename);
  form.append("file", new Blob([bytes], { type: contentType }), filename);
  let res;
  try {
    res = await fetchImpl(`${endpoint}/api/v2/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch {
    throw offline();
  }
  if (res.status !== 200 && res.status !== 201) {
    await drain(res);
    throw offline();
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw offline();
  }
  const name = assetName(data, filename);
  if (!name) throw offline();
  return { name };
}

export async function submitWorkflow({ endpoint, key, workflow, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${endpoint}/api/v2/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workflow }),
    });
  } catch {
    throw offline();
  }
  if (res.status !== 200 && res.status !== 201) {
    await drain(res);
    throw offline();
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw offline();
  }
  if (!data || typeof data.id !== "string" || !data.id) throw offline();
  return data;
}

export async function fetchJob({ endpoint, key, id, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${endpoint}/api/v2/jobs/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    throw offline();
  }
  if (!res.ok) {
    await drain(res);
    throw offline();
  }
  try {
    return await res.json();
  } catch {
    throw offline();
  }
}

export function outputFetchUrl(endpoint, output) {
  const raw = output && typeof output.url === "string" ? output.url : "";
  if (raw.startsWith("https://") || raw.startsWith("http://")) return raw;
  if (raw.startsWith("/")) return `${endpoint}${raw}`;
  if (output && output.id) return `${endpoint}/api/v2/assets/${encodeURIComponent(output.id)}/content`;
  return "";
}

export async function fetchAssetResponse({ endpoint, key, url, fetchImpl }) {
  const absolute = url.startsWith("/") ? `${endpoint}${url}` : url;
  const authed = absolute.startsWith(endpoint);
  let res;
  try {
    res = await fetchImpl(absolute, {
      headers: authed ? { Authorization: `Bearer ${key}` } : undefined,
      redirect: "manual",
    });
  } catch {
    throw offline();
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    await drain(res);
    if (!loc) throw offline();
    try {
      res = await fetchImpl(loc);
    } catch {
      throw offline();
    }
  }
  if (!res.ok) {
    await drain(res);
    throw offline();
  }
  return res;
}
