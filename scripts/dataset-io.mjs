import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MANIFEST_REPOSITORY = "LegendsUnchained/vpx-standalone-alp4k";

const GITHUB_RELEASE_API =
  `https://api.github.com/repos/${MANIFEST_REPOSITORY}/releases/latest`;

function responseDetail(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact;
}

export async function publicJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json, application/json",
      "User-Agent": "LegendsUnchained-vpx-stats",
      ...headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GET ${url} failed (${response.status}): ${responseDetail(await response.text())}`,
    );
  }
  return response.json();
}

export async function loadManifest(githubToken) {
  const headers = githubToken ? { Authorization: `Bearer ${githubToken}` } : {};
  const release = await publicJson(GITHUB_RELEASE_API, headers);
  const asset = release.assets?.find(({ name }) => name === "manifest.json");
  if (!release.tag_name || !asset?.browser_download_url) {
    throw new Error("Latest ALP4K release does not contain manifest.json");
  }

  const manifest = await publicJson(asset.browser_download_url);
  return {
    manifest,
    manifestUrl: asset.browser_download_url,
    releaseTag: release.tag_name,
  };
}

export async function writeDataset(dataset, output) {
  await mkdir(dirname(output), { recursive: true });
  const temporaryOutput = `${output}.tmp`;
  await writeFile(temporaryOutput, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  await rename(temporaryOutput, output);
}
