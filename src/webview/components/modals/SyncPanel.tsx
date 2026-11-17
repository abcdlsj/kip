import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, FileDown, Loader2, RefreshCw } from "lucide-react";
import type { SyncConfig } from "../../../shared/types";
import { request } from "../../rpc-client";
import { useUiStore } from "../../stores/ui-store";
import { useWorkspaceStore } from "../../stores/workspace-store";

export function SyncPanel() {
  const syncState = useUiStore((state) => state.syncState);
  const activeThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    endpoint: "",
    region: "auto",
    bucket: "",
    prefix: "kip-sync/",
    accessKeyId: "",
    secretAccessKey: "",
  });
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void request("getSyncConfig", undefined).then((next) => {
      setConfig(next);
      setForm((current) => ({
        ...current,
        enabled: next.enabled,
        endpoint: next.endpoint,
        region: next.region,
        bucket: next.bucket,
        prefix: next.prefix,
      }));
    });
  }, []);

  const save = async () => {
    setBusy("save");
    try {
      const result = await request("updateSyncConfig", {
        ...form,
        accessKeyId: form.accessKeyId || undefined,
        secretAccessKey: form.secretAccessKey || undefined,
      });
      setStatus(result.connected ? "Connected to the bucket." : result.error ?? "Not connected.");
      setConfig(await request("getSyncConfig", undefined));
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    try {
      const result = await request("triggerSync", undefined);
      setStatus(`Pushed ${result.pushed} · pulled ${result.pulled}.`);
      setConfig(await request("getSyncConfig", undefined));
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
      <p className="mt-1 max-w-[420px] text-[12px] leading-relaxed text-[var(--text-secondary)]">
        Incremental backups to any S3-compatible bucket. Metadata and transcripts sync; API
        keys never leave this machine.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
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
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy === "save"}
          className="h-8 rounded-full bg-[var(--accent-action)] px-3.5 text-[12px] font-medium text-[var(--accent-action-fg)]"
        >
          {busy === "save" ? "Saving..." : "Save & test"}
        </button>
        <button
          onClick={() => void syncNow()}
          disabled={busy === "sync" || syncState === "running"}
          className="flex h-8 items-center gap-1.5 rounded-full border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
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
          className="flex h-8 items-center gap-1.5 rounded-full border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
        >
          <ArrowUpFromLine size={12} strokeWidth={1.5} />
          Export backup
        </button>
        <button
          onClick={() => void importBackup()}
          disabled={busy === "import"}
          className="flex h-8 items-center gap-1.5 rounded-full border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
        >
          <ArrowDownToLine size={12} strokeWidth={1.5} />
          Import backup
        </button>
        <button
          onClick={() => void exportThread()}
          disabled={busy === "markdown" || !activeThreadId}
          className="flex h-8 items-center gap-1.5 rounded-full border hairline px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] disabled:opacity-40"
        >
          <FileDown size={12} strokeWidth={1.5} />
          Export thread
        </button>
      </div>
      {config?.lastSyncedAt && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">
          Last synced {new Date(config.lastSyncedAt).toLocaleString()}
        </p>
      )}
      {status && <p className="mt-2 text-[11.5px] text-[var(--text-secondary)]">{status}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-[0.05em] text-[var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
