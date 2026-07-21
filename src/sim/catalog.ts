/* ============================================================================
   Trawl — simulation catalog (browser sim only; never used under Tauri).
   Fake Drive folder tree + fake local NAS tree + run helpers, transcribed from
   the prototype so the browser build is a faithful, clickable design surface.
   ============================================================================ */

import type { FolderNode, SourceKind } from "../types";

interface CatNode {
  name: string;
  children: string[];
}

export const NODES: Record<string, CatNode> = {
  yosh: { name: "Yosh Studios", children: ["ghoul", "t60", "nuka", "pipboy"] },
  ghoul: {
    name: "Fallout Ghoul Helmet",
    children: ["ghoul_stl", "ghoul_pre", "ghoul_bambu"],
  },
  ghoul_stl: { name: "STL Files", children: [] },
  ghoul_pre: { name: "Pre-Supported", children: [] },
  ghoul_bambu: { name: "Bambu Lab Profiles", children: [] },
  t60: { name: "Power Armor T-60", children: ["t60_helm", "t60_torso", "t60_arms"] },
  t60_helm: { name: "Helmet", children: [] },
  t60_torso: { name: "Torso", children: [] },
  t60_arms: { name: "Arms & Legs", children: [] },
  nuka: { name: "Nuka-Cola Sign", children: [] },
  pipboy: { name: "Pip-Boy 3000", children: ["pip_body", "pip_screen"] },
  pip_body: { name: "Body Shell", children: [] },
  pip_screen: { name: "Screen Insert", children: [] },
  cyber: { name: "Cyber Forge", children: ["dragon", "cpfig", "mecha"] },
  dragon: { name: "Dragon Bust 75mm", children: ["dragon_stl", "dragon_base"] },
  dragon_stl: { name: "STL Files", children: [] },
  dragon_base: { name: "Display Base", children: [] },
  cpfig: { name: "Cyberpunk Figurine", children: [] },
  mecha: { name: "Mecha Warden", children: [] },
  galactic: { name: "Galactic Props", children: ["mando", "grogu", "razor"] },
  mando: { name: "Mandalorian Helmet", children: ["mando_stl", "mando_pre"] },
  mando_stl: { name: "STL Files", children: [] },
  mando_pre: { name: "Pre-Supported", children: [] },
  grogu: { name: "Grogu (The Child)", children: [] },
  razor: { name: "Razor Crest", children: [] },
  bust: { name: "Bust Library", children: ["geralt", "medallion", "ciri"] },
  geralt: { name: "Geralt of Rivia Bust", children: [] },
  medallion: { name: "Wolf Medallion", children: [] },
  ciri: { name: "Ciri Bust", children: [] },
};

/** Top-level "Shared with me" folders. */
export const SHARED_ROOTS = ["yosh", "cyber", "galactic", "bust"];
/** The folder a pasted link resolves to in folder_id mode (its children show). */
export const ID_ROOT = "yosh";

/** Walk NODES by a name-path (relative to a set of root ids) to find a node id. */
function findIdByNamePath(rootIds: string[], subpath: string): string | null {
  const parts = subpath ? subpath.split("/") : [];
  let level = rootIds;
  let foundId: string | null = null;
  for (const part of parts) {
    foundId = level.find((id) => NODES[id]?.name === part) ?? null;
    if (!foundId) return null;
    level = NODES[foundId]?.children ?? [];
  }
  return foundId;
}

function toFolderNode(id: string, parentSubpath: string): FolderNode {
  const node = NODES[id];
  const path = parentSubpath ? parentSubpath + "/" + node.name : node.name;
  return { path, name: node.name, hasChildren: (node.children?.length ?? 0) > 0 };
}

/** Children of a source subpath ("" = the source root's direct children). */
export function simSourceChildren(kind: SourceKind, subpath: string): FolderNode[] {
  const roots = kind === "shared_with_me" ? SHARED_ROOTS : NODES[ID_ROOT].children;
  if (!subpath) return roots.map((id) => toFolderNode(id, ""));
  const id = findIdByNamePath(roots, subpath);
  if (!id) return [];
  return (NODES[id].children ?? []).map((cid) => toFolderNode(cid, subpath));
}

/** Best-effort display name of the pasted/selected source root. */
export function simResolveSourceName(kind: SourceKind): string {
  return kind === "folder_id" ? NODES[ID_ROOT].name : "Shared with me";
}

/* ---- pCloud fake public-link tree ---- */

interface PcloudNode {
  name: string;
  children: string[];
}

const PCLOUD_NODES: Record<string, PcloudNode> = {
  root: { name: "pCloud Shared Folder", children: ["photos", "projects", "invoices", "assets"] },
  photos: { name: "Shared Photos", children: ["photos_2024", "photos_2025", "raw_exports"] },
  photos_2024: { name: "2024 Shoots", children: [] },
  photos_2025: { name: "2025 Shoots", children: [] },
  raw_exports: { name: "RAW Exports", children: [] },
  projects: { name: "Project Files", children: ["proj_alpha", "proj_bravo", "proj_archive"] },
  proj_alpha: { name: "Alpha Launch", children: ["alpha_design", "alpha_dev"] },
  alpha_design: { name: "Design Assets", children: [] },
  alpha_dev: { name: "Dev Exports", children: [] },
  proj_bravo: { name: "Bravo Rebrand", children: [] },
  proj_archive: { name: "Archived Projects", children: [] },
  invoices: { name: "Invoices 2026", children: ["inv_q1", "inv_q2"] },
  inv_q1: { name: "Q1 2026", children: [] },
  inv_q2: { name: "Q2 2026", children: [] },
  assets: { name: "Marketing Assets", children: ["banners", "logos"] },
  banners: { name: "Banners", children: [] },
  logos: { name: "Logos", children: [] },
};

function pcloudFindIdByNamePath(rootIds: string[], subpath: string): string | null {
  const parts = subpath ? subpath.split("/") : [];
  let level = rootIds;
  let foundId: string | null = null;
  for (const part of parts) {
    foundId = level.find((id) => PCLOUD_NODES[id]?.name === part) ?? null;
    if (!foundId) return null;
    level = PCLOUD_NODES[foundId]?.children ?? [];
  }
  return foundId;
}

function toPcloudFolderNode(id: string, parentSubpath: string): FolderNode {
  const node = PCLOUD_NODES[id];
  const path = parentSubpath ? parentSubpath + "/" + node.name : node.name;
  return { path, name: node.name, hasChildren: (node.children?.length ?? 0) > 0 };
}

/** Immediate subfolders of a pCloud public-link subpath ("" = root's direct children). */
export function simPcloudChildren(subpath: string): FolderNode[] {
  const rootChildren = PCLOUD_NODES["root"].children;
  if (!subpath) return rootChildren.map((id) => toPcloudFolderNode(id, ""));
  const id = pcloudFindIdByNamePath(rootChildren, subpath);
  if (!id) return [];
  return (PCLOUD_NODES[id].children ?? []).map((cid) => toPcloudFolderNode(cid, subpath));
}

/** Display name for the fake pCloud public-link root. */
export function simPcloudResolveName(): string {
  return PCLOUD_NODES["root"].name;
}

/* ---- local NAS filesystem (fake) ---- */
export const NAS: Record<string, string[]> = {
  "": ["Yosh Studios", "Cyber Forge", "Galactic Props", "Bust Library", "_Archive", "_Incoming"],
  "Yosh Studios": ["Fallout Ghoul Helmet", "Power Armor T-60", "Nuka-Cola Sign"],
  "Yosh Studios/Fallout Ghoul Helmet": ["STL Files", "Pre-Supported"],
  "Cyber Forge": ["Dragon Bust 75mm", "Cyberpunk Figurine"],
  "Galactic Props": ["Mandalorian Helmet"],
  "Bust Library": ["Geralt of Rivia Bust", "Wolf Medallion"],
};

/** Local subfolders under a relative path, merged with sim-created folders. */
export function simLocalChildren(subpath: string, created: string[]): FolderNode[] {
  const base = (NAS[subpath] || []).map((n) => (subpath ? subpath + "/" + n : n));
  const mine = created.filter((p) => {
    const i = p.lastIndexOf("/");
    return (i < 0 ? "" : p.slice(0, i)) === subpath;
  });
  const all = [...new Set([...base, ...mine])].sort((a, b) => a.localeCompare(b));
  return all.map((p) => {
    const name = p.slice(p.lastIndexOf("/") + 1);
    const hasChildren =
      (NAS[p]?.length ?? 0) > 0 || created.some((c) => c.startsWith(p + "/"));
    return { path: p, name, hasChildren };
  });
}

/* ---- run simulation helpers (verbatim from prototype) ---- */
export const FILES = [
  "helmet_shell.stl", "visor_lens.stl", "jaw_vent_L.stl", "jaw_vent_R.stl",
  "neck_seal.stl", "ear_module.stl", "crown_strip.stl", "base_plate.stl",
  "chin_guard.stl", "supports.lys", "print_profile.3mf", "assembly_guide.pdf",
  "preview.png", "scale_75mm.stl", "bust_core.stl", "nameplate.stl",
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic fake totals for a folder name. */
export function genTotals(name: string): { bytes: number; files: number } {
  const h = hashStr(name);
  const gib = 3 + (h % 19) + ((h >> 5) % 10) / 10;
  return { bytes: gib * 1073741824, files: 60 + (h % 460) };
}
