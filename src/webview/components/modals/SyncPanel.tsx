import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  FileDown,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
} from "lucide-react";
import type { SyncConfig, SyncProvider } from "../../../shared/types";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

export function SyncPanel() {
  const syncState = useUiStore((state) => state.syncState);
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [form, setForm] = useState({
    provider: "s3" as SyncProvider,
    enabled: false,
    endpoint: "",
    region: "auto",
    bucket: "",
    prefix: "kip-sync/",
    accessKeyId: "",
    secretAccessKey: "",
    googleClientId: "",
    googleClientSecret: "",
    googleFolderName: "Kip Sync",
  });
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reloadConfig = async () => {
    const next = await request("getSyncConfig", undefined);
    setConfig(next);
    setForm((current) => ({
      ...current,
      provider: next.provider,
      enabled: next.enabled,
      endpoint: next.endpoint,
      region: next.region,
      bucket: next.bucket,
      prefix: next.prefix,
      googleClientId: next.googleClientId,
      googleFolderName: next.googleFolderName || "Kip Sync",
    }));
  };

  useEffect(() => {
    void reloadConfig();
  }, []);

  const save = async () => {
    setBusy("save");
    try {
      const result = await request("updateSyncConfig", {
        provider: form.provider,
        enabled: form.enabled,
        endpoint: form.endpoint,
        region: form.region,
        bucket: form.bucket,
        prefix: form.prefix,
        accessKeyId: form.accessKeyId || undefined,
        secretAccessKey: form.secretAccessKey || undefined,
        googleClientId: form.googleClientId,
        googleClientSecret: form.googleClientSecret || undefined,
        googleFolderName: form.googleFolderName,
      });
      setStatus(
        result.connected
          ? form.provider === "google-drive"
            ? "Connected to Google Drive."
            : "Connected to the bucket."
          : result.error ?? "Not connected.",
      );
      setForm((current) => ({ ...current, googleClientSecret: "" }));
      await reloadConfig();
    } finally {
      setBusy(null);
    }
  };

  const connectGoogle = async () => {
    setBusy("google-connect");
    setStatus("Waiting for Google sign-in in your browser…");
    try {
      const result = await request("connectGoogleDrive", {
        clientId: form.googleClientId,
        clientSecret: form.googleClientSecret || undefined,
        folderName: form.googleFolderName,
      });
      if (result.connected) {
        await request("updateSyncConfig", {
          provider: "google-drive",
          enabled: form.enabled,
          googleClientId: form.googleClientId,
          googleFolderName: form.googleFolderName,
        });
        setStatus(
          result.email
            ? `Connected to Google Drive as ${result.email}.`
            : "Connected to Google Drive.",
        );
        setForm((current) => ({ ...current, googleClientSecret: "" }));
        await reloadConfig();
      } else {
        setStatus(result.error ?? "Google sign-in failed.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Google sign-in failed.");
    } finally {
      setBusy(null);
    }
  };

  const disconnectGoogle = async () => {
    setBusy("google-disconnect");
    try {
      await request("disconnectGoogleDrive", undefined);
      setStatus("Disconnected from Google Drive.");
      await reloadConfig();
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    try {
      const result = await request("triggerSync", undefined);
      setStatus(`Pushed ${result.pushed} · pulled ${result.pulled}.`);
      await reloadConfig();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setBusy(null);
    }
  };

  const exportBackup = async () => {
    setBusy("export");
    try {
      const result = await request("exportFullBackupBundle", undefined);
      setStatus(result.savedPath ? `Backup saved to ${result.savedPath}` : "Export cancelled.");
    } finally {
      setBusy(null);
    }
  };

  const importBackup = async () => {
    setBusy("import");
    try {
      const result = await request("importBackupBundle", undefined);
      setStatus(`Imported ${result.importedThreads} threads.`);
    } finally {
      setBusy(null);
    }
  };

  const exportThread = async () => {
    if (!activeThreadId) return;
    setBusy("markdown");
    try {
      const result = await request("exportThreadMarkdown", { threadId: activeThreadId });
      setStatus(result.savedPath ? `Saved to ${result.savedPath}` : "Export cancelled.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h2 className="text-[15px] font-semibold">Sync &amp; backup</h2>
      <p className="mt-1 max-w-[440px] text-[12px] leading-relaxed text-[var(--text-secondary)]">
        Incremental backups to S3-compatible storage or Google Drive. Metadata and transcripts
        sync; API keys never leave this machine.
      </p>

      <div className="mt-3.5 inline-flex rounded-[9px] border hairline bg-[var(--bg-sidebar)] p-0.5">
        {(
          [
            { id: "s3", label: "S3" },
            { id: "google-drive", label: "Google Drive" },
          ] as Array<{ id: SyncProvider; label: string }>
        ).map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setForm((current) => ({ ...current, provider: item.id }));
              setStatus(null);
            }}
            className={`h-7 rounded-[7px] px-3 text-[12px] transition-colors ${
              form.provider === item.id
                ? "bg-[var(--bg-elevated)] font-medium text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-3.5 grid grid-cols-2 gap-2.5">
        <div className="col-span-2">
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              className="h-3.5 w-3.5 accent-[var(--accent-ink)]"
            />
            Enable automatic sync after a completed turn
          </label>
        </div>

        {form.provider === "s3" ? (
          <>
            <Field label="Endpoint">
              <input
                value={form.endpoint}
                onChange={(event) => setForm({ ...form, endpoint: event.target.value })}
                placeholder="https://s3.us-east-1.amazonaws.com"
                className="settings-input font-[var(--font-mono)]"
              />
            </Field>
            <Field label="Region">
              <input
                value={form.region}
                onChange={(event) => setForm({ ...form, region: event.target.value })}
                placeholder="auto"
                className="settings-input font-[var(--font-mono)]"
              />
            </Field>
            <Field label="Bucket">
              <input
                value={form.bucket}
                onChange={(event) => setForm({ ...form, bucket: event.target.value })}
                className="settings-input font-[var(--font-mono)]"
              />
            </Field>
            <Field label="Prefix">
              <input
                value={form.prefix}
                onChange={(event) => setForm({ ...form, prefix: event.target.value })}
                className="settings-input font-[var(--font-mono)]"
              />
            </Field>
            <Field label="Access key ID">
              <input
                value={form.accessKeyId}
                onChange={(event) => setForm({ ...form, accessKeyId: event.target.value })}
                placeholder={config?.hasCredentials ? "Stored — leave blank to keep" : ""}
                className="settings-input font-[var(--font-mono)]"
              />
            </Field>
            <Field label="Secret access key">
              <input
                type="password"
                value={form.secretAccessKey}
                onChange={(event) => setForm({ ...form, secretAccessKey: event.target.value })}
                placeholder={config?.hasCredentials ? "Stored — leave blank to keep" : ""}
                className="settings-input font-[var(--font-mono)]"
              />
            </Field>
          </>
        ) : (
          <>
            <div className="col-span-2">
              <Field label="OAuth Client ID (Desktop app)">
                <input
                  value={form.googleClientId}
                  onChange={(event) => setForm({ ...form, googleClientId: event.target.value })}
                  placeholder="1234567890-xxxx.apps.googleusercontent.com"
                  className="settings-input font-[var(--font-mono)]"
                />
              </Field>
            </div>
            <Field label="Client Secret (optional)">
              <input
                type="password"
                value={form.googleClientSecret}
                onChange={(event) => setForm({ ...form, googleClientSecret: event.target.value })}
                placeholder={config?.googleConnected ? "Stored — leave blank to keep" : ""}
                className="settings-input font-[var(--font-mono)]"
              />
            </Field>
            <Field label="Drive folder name">
              <input
                value={form.googleFolderName}
                onChange={(event) => setForm({ ...form, googleFolderName: event.target.value })}
                placeholder="Kip Sync"
                className="settings-input"
              />
            </Field>
            <div className="col-span-2 flex items-center justify-between rounded-[10px] border hairline bg-[var(--bg-subtle)] px-3 py-2">
              <div className="min-w-0 text-[12px]">
                {config?.googleConnected ? (
                  <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
                    <CheckCircle2 size={13} strokeWidth={1.6} className="shrink-0 text-[var(--status-ok)]" />
                    <span className="truncate">
                      Connected{config.googleEmail ? ` as ${config.googleEmail}` : ""}
                    </span>
                  </span>
                ) : (
                  <span className="text-[var(--text-secondary)]">
                    Not signed in. Uses <span className="font-[var(--font-mono)]">drive.file</span> scope only.
                  </span>
                )}
              </div>
              {config?.googleConnected ? (
                <button
                  onClick={() => void disconnectGoogle()}
                  disabled={busy === "google-disconnect"}
                  className="ml-3 flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] border hairline bg-[var(--bg-elevated)] px-2.5 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-active)]"
                >
                  <LogOut size={11} strokeWidth={1.5} />
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() => void connectGoogle()}
                  disabled={busy === "google-connect" || !form.googleClientId.trim()}
                  className="ml-3 flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] bg-[var(--accent-ink)] px-2.5 text-[11.5px] font-medium text-[var(--accent-ink-fg)] disabled:opacity-40"
                >
                  {busy === "google-connect" ? (
                    <Loader2 size={11} strokeWidth={1.5} className="animate-spin" />
                  ) : (
                    <LogIn size={11} strokeWidth={1.5} />
                  )}
                  {busy === "google-connect" ? "Signing in..." : "Sign in with Google"}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy === "save"}
          className="h-8 rounded-[8px] bg-[var(--accent-ink)] px-3.5 text-[12px] font-medium text-[var(--accent-ink-fg)]"
        >
          {busy === "save" ? "Saving..." : "Save & test"}
        </button>
        <button
          onClick={() => void syncNow()}
          disabled={busy === "sync" || syncState === "running"}
          className="flex h-8 items-center gap-1.5 rounded-[8px] border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
        >
          {busy === "sync" ? (
            <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
          ) : (
            <RefreshCw size={12} strokeWidth={1.5} />
          )}
          Sync now
        </button>
        <button
          onClick={() => void exportBackup()}
          disabled={busy === "export"}
          className="flex h-8 items-center gap-1.5 rounded-[8px] border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
        >
          <ArrowUpFromLine size={12} strokeWidth={1.5} />
          Export backup
        </button>
        <button
          onClick={() => void importBackup()}
          disabled={busy === "import"}
          className="flex h-8 items-center gap-1.5 rounded-[8px] border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
        >
          <ArrowDownToLine size={12} strokeWidth={1.5} />
          Import backup
        </button>
        <button
          onClick={() => void exportThread()}
          disabled={busy === "markdown" || !activeThreadId}
          className="flex h-8 items-center gap-1.5 rounded-[8px] border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] disabled:opacity-40"
        >
          <FileDown size={12} strokeWidth={1.5} />
          Export thread
        </button>
      </div>
      {config?.lastSyncedAt && (
        <p className="mt-2 text-[11.5px] text-[var(--text-muted)]">
          Last synced {new Date(config.lastSyncedAt).toLocaleString()}
        </p>
      )}
      {status && <p className="mt-2 text-[12px] text-[var(--text-secondary)]">{status}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      {children}
    </label>
  );
}
