import type { ElementType } from "react";
import type { IconType } from "react-icons";
import { DiBingSmall, DiYahooSmall } from "react-icons/di";
import { FaWindows } from "react-icons/fa";
import {
  MdApps,
  MdArticle,
  MdAudioFile,
  MdCode,
  MdCoPresent,
  MdDataObject,
  MdDescription,
  MdFolder,
  MdFolderZip,
  MdImage,
  MdInsertDriveFile,
  MdLink,
  MdLock,
  MdMovie,
  MdPictureAsPdf,
  MdSearch,
  MdSettings,
  MdStorage,
  MdTableChart,
  MdTerminal,
} from "react-icons/md";
import {
  SiAlmalinux,
  SiAlpinelinux,
  SiAmazonwebservices,
  SiAndroid,
  SiApple,
  SiArchlinux,
  SiBaidu,
  SiBilibili,
  SiCentos,
  SiClaude,
  SiCss3,
  SiDebian,
  SiDocker,
  SiDuckduckgo,
  SiFedora,
  SiFreebsd,
  SiGentoo,
  SiGithub,
  SiGitlab,
  SiGo,
  SiGoogle,
  SiGooglecloud,
  SiGooglegemini,
  SiHtml5,
  SiJavascript,
  SiKalilinux,
  SiKubernetes,
  SiLinux,
  SiLinuxmint,
  SiManjaro,
  SiMongodb,
  SiMysql,
  SiNginx,
  SiNixos,
  SiNodedotjs,
  SiOpenai,
  SiOpensuse,
  SiPhp,
  SiPostgresql,
  SiPython,
  SiRaspberrypi,
  SiRedis,
  SiRockylinux,
  SiRust,
  SiTypescript,
  SiUbuntu,
  SiYoutube,
  SiZhihu,
} from "react-icons/si";
import type { FileEntry } from "@/types/global";

export interface QuickIconDef {
  icon: IconType;
  color: string;
}

export const QUICK_ICONS: Record<string, QuickIconDef> = {
  docker: { icon: SiDocker, color: "#2496ed" },
  k8s: { icon: SiKubernetes, color: "#326ce5" },
  linux: { icon: SiLinux, color: "#FCC624" },
  ubuntu: { icon: SiUbuntu, color: "#E95420" },
  debian: { icon: SiDebian, color: "#A81D33" },
  centos: { icon: SiCentos, color: "#262577" },
  fedora: { icon: SiFedora, color: "#3C4FB1" },
  apple: { icon: SiApple, color: "#A2AAAD" },
  github: { icon: SiGithub, color: "#181717" },
  gitlab: { icon: SiGitlab, color: "#FC6D26" },
  nginx: { icon: SiNginx, color: "#009639" },
  redis: { icon: SiRedis, color: "#DC382D" },
  postgres: { icon: SiPostgresql, color: "#4169E1" },
  mysql: { icon: SiMysql, color: "#4479A1" },
  mongodb: { icon: SiMongodb, color: "#47A248" },
  python: { icon: SiPython, color: "#3776AB" },
  js: { icon: SiJavascript, color: "#F7DF1E" },
  ts: { icon: SiTypescript, color: "#3178C6" },
  rust: { icon: SiRust, color: "#000000" },
  go: { icon: SiGo, color: "#00ADD8" },
  node: { icon: SiNodedotjs, color: "#339933" },
  php: { icon: SiPhp, color: "#777BB4" },
  aws: { icon: SiAmazonwebservices, color: "#232F3E" },
  gcp: { icon: SiGooglecloud, color: "#4285F4" },
};

export type QuickIconName = keyof typeof QUICK_ICONS;

/** Mainstream OS / distro icons. */
export const SYSTEM_ICONS: Record<string, QuickIconDef> = {
  windows: { icon: FaWindows, color: "#0078D4" },
  apple: { icon: SiApple, color: "#A2AAAD" },
  android: { icon: SiAndroid, color: "#3DDC84" },
  linux: { icon: SiLinux, color: "#FCC624" },
  ubuntu: { icon: SiUbuntu, color: "#E95420" },
  debian: { icon: SiDebian, color: "#A81D33" },
  centos: { icon: SiCentos, color: "#A14F8C" },
  fedora: { icon: SiFedora, color: "#3C4FB1" },
  arch: { icon: SiArchlinux, color: "#1793D1" },
  manjaro: { icon: SiManjaro, color: "#35BF5C" },
  opensuse: { icon: SiOpensuse, color: "#73BA25" },
  rocky: { icon: SiRockylinux, color: "#10B981" },
  alma: { icon: SiAlmalinux, color: "#FF4649" },
  alpine: { icon: SiAlpinelinux, color: "#0D597F" },
  kali: { icon: SiKalilinux, color: "#268BEE" },
  mint: { icon: SiLinuxmint, color: "#87CF3E" },
  nixos: { icon: SiNixos, color: "#5277C3" },
  gentoo: { icon: SiGentoo, color: "#54487A" },
  freebsd: { icon: SiFreebsd, color: "#AB2B28" },
  raspberrypi: { icon: SiRaspberrypi, color: "#A22846" },
};

export type SystemIconName = keyof typeof SYSTEM_ICONS;

/** Merged lookup for all connection icons (services + systems). */
export const CONNECTION_ICONS: Record<string, QuickIconDef> = {
  ...QUICK_ICONS,
  ...SYSTEM_ICONS,
};

export const SEARCH_ICONS: Record<string, QuickIconDef> = {
  google: { icon: SiGoogle, color: "#4285F4" },
  duckduckgo: { icon: SiDuckduckgo, color: "#DE5833" },
  baidu: { icon: SiBaidu, color: "#2932E1" },
  bilibili: { icon: SiBilibili, color: "#00A1D6" },
  zhihu: { icon: SiZhihu, color: "#0084FF" },
  youtube: { icon: SiYoutube, color: "#FF0000" },
  github: { icon: SiGithub, color: "#181717" },
  gitlab: { icon: SiGitlab, color: "#FC6D26" },
  bing: { icon: DiBingSmall, color: "#008373" },
  yahoo: { icon: DiYahooSmall, color: "#410093" },
  openai: { icon: SiOpenai, color: "#10A37F" },
  claude: { icon: SiClaude, color: "#d97757" },
  gemini: { icon: SiGooglegemini, color: "#4285F4" },
  default: { icon: MdSearch, color: "currentColor" },
};

export type SearchIconName = keyof typeof SEARCH_ICONS;

export function getFileIcon(entry: FileEntry): { icon: ElementType; color: string } {
  if (entry.is_symlink) return { icon: MdLink, color: "#67e8f9" }; // cyan-300
  if (entry.is_dir) return { icon: MdFolder, color: "#fbbf24" }; // amber-400

  const ext = entry.name.includes(".") ? (entry.name.split(".").pop()?.toLowerCase() ?? "") : "";

  switch (ext) {
    // --- Web & Scripting ---
    case "js":
    case "jsx":
      return { icon: SiJavascript, color: "#facc15" }; // yellow-400
    case "ts":
    case "tsx":
      return { icon: SiTypescript, color: "#60a5fa" }; // blue-400
    case "html":
    case "htm":
      return { icon: SiHtml5, color: "#f97316" }; // orange-500
    case "css":
    case "scss":
    case "less":
      return { icon: SiCss3, color: "#38bdf8" }; // sky-400
    case "py":
    case "pyc":
      return { icon: SiPython, color: "#3776AB" }; // python-500
    case "sh":
    case "bash":
    case "zsh":
    case "bat":
    case "ps1":
      return { icon: MdTerminal, color: "#4ade80" }; // green-400
    case "php":
      return { icon: SiPhp, color: "#777BB4" }; // php-500

    case "rs":
    case "go":
    case "c":
    case "cpp":
    case "java":
      return { icon: MdCode, color: "#f87171" }; // red-400

    // --- Data & Config ---
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "xml":
      return { icon: MdDataObject, color: "#a78bfa" }; // violet-400
    case "ini":
    case "env":
    case "conf":
    case "config":
      return { icon: MdSettings, color: "var(--df-text-muted)" };
    case "sql":
    case "db":
    case "sqlite":
      return { icon: MdStorage, color: "#94a3b8" }; // slate-400

    // --- Text & Documents ---
    case "md":
    case "mdx":
    case "txt":
    case "rtf":
      return { icon: MdArticle, color: "var(--df-text-dimmed)" };
    case "doc":
    case "docx":
      return { icon: MdDescription, color: "#3b82f6" }; // blue-500
    case "pdf":
      return { icon: MdPictureAsPdf, color: "#ef4444" }; // red-500
    case "xls":
    case "xlsx":
    case "csv":
      return { icon: MdTableChart, color: "#16a34a" }; // green-600
    case "ppt":
    case "pptx":
      return { icon: MdCoPresent, color: "#ea580c" }; // orange-600

    // --- Media ---
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "ico":
      return { icon: MdImage, color: "#ec4899" }; // pink-500
    case "mp4":
    case "mkv":
    case "avi":
    case "mov":
    case "webm":
      return { icon: MdMovie, color: "#8b5cf6" }; // violet-500
    case "mp3":
    case "wav":
    case "ogg":
    case "flac":
      return { icon: MdAudioFile, color: "#f59e0b" }; // amber-500

    // --- Archives ---
    case "zip":
    case "rar":
    case "7z":
    case "tar":
    case "gz":
    case "bz2":
    case "xz":
      return { icon: MdFolderZip, color: "#f59e0b" }; // amber-500

    // --- Misc ---
    case "exe":
    case "apk":
    case "dmg":
    case "iso":
      return { icon: MdApps, color: "#14b8a6" }; // teal-500
    case "lock":
      return { icon: MdLock, color: "var(--df-text-muted)" };

    default:
      if (entry.name.startsWith(".")) {
        return { icon: MdSettings, color: "var(--df-text-muted)" };
      }
      return { icon: MdInsertDriveFile, color: "var(--df-text-muted)" };
  }
}
