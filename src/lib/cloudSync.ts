import type {
  CloudConflictPreview,
  CloudSyncSettings,
  CloudSyncStatus,
  RemoteBackupEntry,
} from "@/types/global";

export type CloudSyncValidationCode =
  | "webdavEndpointRequired"
  | "s3EndpointRequired"
  | "s3BucketRequired"
  | "s3CredentialsIncomplete";

export const MASKED_CLOUD_SECRET_VALUE = "__SET__";

export const DEFAULT_CLOUD_SYNC_SETTINGS: CloudSyncSettings = {
  enabled: false,
  provider: "webdav",
  remote_root: "dragonfly",
  device_name: "This Device",
  auto_check_on_startup: true,
  auto_push_on_change: true,
  sync_debounce_seconds: 15,
  scheduled_backup_enabled: true,
  backup_interval_hours: 24,
  backup_retention_count: 30,
  webdav: {
    endpoint: "",
    root: "",
    username: "",
    password: null,
  },
  s3: {
    endpoint: "",
    bucket: "",
    region: "",
    root: "",
    access_key_id: null,
    secret_access_key: null,
    session_token: null,
    virtual_host_style: false,
  },
};

export const DEFAULT_CLOUD_SYNC_STATUS: CloudSyncStatus = {
  enabled: false,
  provider: "webdav",
  state: "idle",
  message: "",
  current_operation: null,
  last_checked_at_ms: null,
  last_synced_at_ms: null,
  last_backup_at_ms: null,
  conflict: null,
};

export function isCloudSecretMasked(value?: string | null) {
  return value === MASKED_CLOUD_SECRET_VALUE;
}

export function secretInputValue(value?: string | null) {
  return isCloudSecretMasked(value) ? "" : (value ?? "");
}

export function secretPlaceholder(value: string | null | undefined, fallback: string) {
  return isCloudSecretMasked(value) ? "••••••••" : fallback;
}

export function canUseCloudProvider(settings: CloudSyncSettings) {
  return getCloudSyncValidationErrors(settings).length === 0;
}

export function getCloudSyncValidationErrors(
  settings: CloudSyncSettings,
): CloudSyncValidationCode[] {
  const errors: CloudSyncValidationCode[] = [];

  if (settings.provider === "webdav") {
    if (settings.webdav.endpoint.trim().length === 0) {
      errors.push("webdavEndpointRequired");
    }
    return errors;
  }

  if (settings.provider === "s3") {
    if (settings.s3.endpoint.trim().length === 0) {
      errors.push("s3EndpointRequired");
    }

    if (settings.s3.bucket.trim().length === 0) {
      errors.push("s3BucketRequired");
    }

    const hasAccessKeyId = Boolean(settings.s3.access_key_id?.trim());
    const hasSecretAccessKey = Boolean(settings.s3.secret_access_key?.trim());
    if (hasAccessKeyId !== hasSecretAccessKey) {
      errors.push("s3CredentialsIncomplete");
    }
  }

  return errors;
}

export function formatCloudProvider(provider?: string | null) {
  switch (provider) {
    case "webdav":
      return "WebDAV";
    case "s3":
      return "S3";
    default:
      return provider || "-";
  }
}

export function formatTimestamp(timestamp?: number | null) {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleString();
}

export function formatDuration(durationMs?: number | null) {
  if (!durationMs && durationMs !== 0) return null;
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function shortValue(value?: string | null, size = 8) {
  if (!value) return "-";
  if (value.length <= size * 2 + 1) return value;
  return `${value.slice(0, size)}...${value.slice(-size)}`;
}

export function hasConflict(conflict?: CloudConflictPreview | null) {
  return Boolean(conflict?.remote_revision);
}

export function sortRemoteBackups(entries: RemoteBackupEntry[]) {
  return [...entries].sort((a, b) => b.created_at_ms - a.created_at_ms);
}
