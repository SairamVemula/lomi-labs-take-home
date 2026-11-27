"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiUpload } from "../lib/api";
import { DOCUMENTS_KEY } from "../lib/usePollWhileBusy";
import { inputClass, primaryButton, secondaryButton } from "../lib/focus";
import { useToast } from "./Toast";

const TYPES = [
  { value: "invoice", label: "Invoice" },
  { value: "lease", label: "Lease" },
  { value: "market_report", label: "Market report" },
] as const;

export function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const client = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<string>("invoice");
  const [file, setFile] = useState<File | null>(null);

  const upload = useMutation({
    mutationFn: (form: FormData) => apiUpload("/documents", form),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: DOCUMENTS_KEY });
      toast("Uploaded — extraction started");
      onClose();
    },
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      upload.reset();
      setFile(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.set("type", type);
    form.set("file", file);
    upload.mutate(form);
  }

  const label = "text-label font-medium";
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="upload-title"
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-md border border-border bg-surface-raised p-0 text-ink backdrop:bg-black/60"
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-6">
        <h2 id="upload-title" className="text-title font-semibold">
          Upload document
        </h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="upload-type" className={label}>
            Document type
          </label>
          <select id="upload-type" value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="upload-file" className={label}>
            PDF file
          </label>
          <input
            id="upload-file"
            type="file"
            accept="application/pdf"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className={`${inputClass} py-2.5 file:mr-3 file:rounded-sm file:border-0 file:bg-border file:px-3 file:py-1 file:text-label file:text-ink`}
          />
          <span className="text-caption text-ink-muted">PDF only, up to 5 MB.</span>
        </div>
        {upload.error && (
          <div role="alert" className="rounded-md bg-failed/15 p-3 text-label text-failed">
            {upload.error.message}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButton}>
            Cancel
          </button>
          <button type="submit" disabled={upload.isPending || !file} className={primaryButton}>
            {upload.isPending ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
