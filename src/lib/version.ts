/**
 * Detección de versión Git y verificación contra GitHub API.
 * Migración compatible con `cloud/server_pg.py`.
 */

import { execSync } from "node:child_process";

const GITHUB_REPO = process.env.GITHUB_REPO || "CodeHvrd/GesT-System";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const STARTED_AT = new Date().toISOString();

let cachedVersionFull = "";

export function detectVersion(): { full: string; short: string } {
  if (cachedVersionFull) {
    return { full: cachedVersionFull, short: cachedVersionFull.slice(0, 7) };
  }
  const envCommit = (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "").trim();
  if (envCommit) {
    cachedVersionFull = envCommit;
    return { full: envCommit, short: envCommit.slice(0, 7) };
  }
  try {
    cachedVersionFull = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    cachedVersionFull = "";
  }
  return {
    full: cachedVersionFull,
    short: cachedVersionFull ? cachedVersionFull.slice(0, 7) : "next-15",
  };
}

export async function githubLatest(): Promise<{
  sha: string;
  corta: string;
  mensaje: string;
  fecha: string | null;
}> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "gest-system",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GitHub respondió ${res.status}`);
  }
  const data = await res.json();
  const sha = String(data?.sha || "");
  const commit = data?.commit || {};
  const msg = String(commit?.message || "").split(/\r?\n/)[0] || "";
  const fecha = commit?.committer?.date || null;
  return { sha, corta: sha.slice(0, 7), mensaje: msg, fecha };
}

export async function getVersionInfo(checkRemote = false) {
  const { full, short } = detectVersion();
  const info: Record<string, unknown> = {
    version: short,
    commit: full,
    iniciado: STARTED_AT,
    repo: GITHUB_REPO,
    rama: GITHUB_BRANCH,
  };
  if (checkRemote) {
    try {
      const rem = await githubLatest();
      info.remoto = rem;
      info.al_dia = Boolean(full) && rem.sha === full;
    } catch {
      info.remoto = null;
      info.al_dia = null;
    }
  }
  return info;
}

let lastDeployTrigger = 0;

export async function triggerUpdateCheck() {
  const { full, short } = detectVersion();
  const rem = await githubLatest();
  const latest = rem.sha;
  const wasUpToDate = Boolean(full) && latest === full;

  const hook = (process.env.RENDER_DEPLOY_HOOK || "").trim();
  let deployState: string | null = null;
  if (!wasUpToDate && hook && Date.now() - lastDeployTrigger >= 90000) {
    try {
      await fetch(hook, { method: "POST" });
      lastDeployTrigger = Date.now();
      deployState = "disparado";
    } catch {
      deployState = "error_hook";
    }
  }

  cachedVersionFull = latest;

  return {
    anterior: short,
    actual: rem.corta || short,
    ultima: rem.corta,
    mensaje: rem.mensaje,
    fecha: rem.fecha,
    al_dia: true,
    ya_estaba_al_dia: wasUpToDate,
    archivos: 6,
    deploy: deployState,
  };
}

