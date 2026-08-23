// Composer: textarea + send + slash-command autocomplete + file attachment.
//
// Slash commands:
//   /clear /help    - client-handled, never sent to server
//   /model /new     - server-handled
//   /skill:<name>   - server expands from loaded skills
//
// The paperclip uploads via POST /api/documents and injects an @doc:<id>
// reference the server expands into the agent's context. Autocomplete opens
// when the text starts with "/". Arrow keys navigate, Tab/Enter accepts, Esc
// closes.
//
// All user-visible strings resolve through the i18n bundle. Slash-command
// tokens (/model, /new, …) are identifiers and stay literal.

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import type { ClientMessage } from "@/types/ws";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/Toast";
import { uploadFile } from "@/lib/documents-api";

interface Props {
  send: (m: ClientMessage) => void;
}

// Command tokens (identifiers, not translated) paired with i18n keys for their
// descriptions. Built into a translated commands array inside the component.
const CMD_META = [
  { label: "/model", descKey: "composer.cmd.model" },
  { label: "/new", descKey: "composer.cmd.new" },
  { label: "/clear", descKey: "composer.cmd.clear" },
  { label: "/help", descKey: "composer.cmd.help" },
];

export function Composer({ send }: Props) {
  const { t } = useTranslation();
  const status = useChatStore((s) => s.status);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const skills = useChatStore((s) => s.skills);
  const clearView = useChatStore((s) => s.clearView);

  const [value, setValue] = useState("");
  const [acIdx, setAcIdx] = useState(0);
  const [drag, setDrag] = useState(false);
  // Attached documents: each is an ingested @doc:<id> reference (design D4).
  // The paperclip uploads via POST /api/documents (the path that already works
  // in DocumentsPage); on success the id is appended so the outgoing prompt
  // references the ingested document (server expands @doc:<id> into context).
  const [attachments, setAttachments] = useState<{ id: string; name: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const disabled = status !== "connected";
  const trimmed = value.trim();

  const commands = [
    ...CMD_META.map((c) => ({ label: c.label, description: t(c.descKey) })),
    ...skills.map((s) => ({ label: `/skill:${s.name}`, description: s.description || "" })),
  ];

  // Autogrow.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const showAc = value.startsWith("/") && commands.length > 0;
  const filter = value.toLowerCase();
  const acItems = showAc
    ? commands.filter((c) => c.label.toLowerCase().includes(filter)).slice(0, 12)
    : [];
  const acVisible = showAc && acItems.length > 0;

  const submit = () => {
    if (!trimmed || disabled) return;

    // Local commands never reach the server.
    if (/^\/clear\b/i.test(trimmed)) {
      clearView();
      setValue("");
      return;
    }
    if (/^\/help\b/i.test(trimmed)) {
      const help = [
        t("composer.helpHeader"),
        ...CMD_META.map((c) => `  ${c.label} - ${t(c.descKey)}`),
        ...skills.map((s) => `  /skill:${s.name} - ${s.description || ""}`),
      ].join("\n");
      showToast(help);
      setValue("");
      return;
    }

    // Append @doc:<id> references for any attachments so the server expands
    // the ingested document content into the agent's context (design D4).
    const refs = attachments.map((a) => `@doc:${a.id}`).join(" ");
    const text = refs ? `${trimmed} ${refs}` : trimmed;

    // The server echoes the user turn back as a `user` event - no optimistic
    // append here, or it renders twice.
    send({ type: "prompt", text });
    setValue("");
    setAttachments([]);
  };

  const acceptAc = () => {
    const pick = acItems[acIdx];
    if (!pick) return;
    setValue(pick.label + " ");
    setAcIdx(0);
    textareaRef.current?.focus();
  };

  // Paperclip: open the native file picker, upload each file via the existing
  // /api/documents ingestion path, and record an @doc:<id> reference chip.
  const onPickFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    for (const f of Array.from(files)) {
      try {
        const doc = await uploadFile(f);
        setAttachments((a) => [...a, { id: doc.id, name: doc.name || f.name }]);
      } catch (err) {
        showToast(t("composer.uploadFailed", { message: (err as Error).message.slice(0, 80) }));
      }
    }
    textareaRef.current?.focus();
  };

  const removeAttachment = (id: string) =>
    setAttachments((a) => a.filter((x) => x.id !== id));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIdx((i) => Math.min(i + 1, acItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        acceptAc();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setValue("");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && value.startsWith("/") && !value.includes(" ")) {
        // If still on just a slash-token, Enter accepts autocomplete rather than submitting.
        e.preventDefault();
        acceptAc();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Drag-drop: upload files via POST /api/documents.
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await fetch("/api/documents", { method: "POST", body: fd });
        if (!r.ok) throw new Error(await r.text());
        showToast(t("composer.uploaded", { name: f.name }));
      } catch (err) {
        showToast(t("composer.uploadFailed", { message: (err as Error).message.slice(0, 80) }));
      }
    }
  };

  return (
    <div
      className={cn("relative border-t border-border bg-card px-4 py-3", drag && "bg-primary/5")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!drag) setDrag(true);
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDrag(false);
      }}
      onDrop={onDrop}
    >
      {acVisible && (
        <ul
          role="listbox"
          className="absolute bottom-full left-4 right-4 mb-2 max-h-60 overflow-y-auto rounded-md border border-border bg-popover shadow-lg"
        >
          {acItems.map((c, i) => (
            <li
              key={c.label}
              role="option"
              aria-selected={i === acIdx}
              onMouseEnter={() => setAcIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                acceptAc();
              }}
              className={cn(
                "flex items-baseline gap-3 px-3 py-1.5 text-xs",
                i === acIdx ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <span className="font-mono text-foreground">{c.label}</span>
              <span className="truncate text-muted-foreground">{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-border bg-background px-3 py-2 focus-within:border-primary">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground"
              >
                <Paperclip className="h-3 w-3" />
                <span className="max-w-[12rem] truncate">{a.name}</span>
                <button
                  onClick={() => removeAttachment(a.id)}
                  aria-label={t("composer.removeAttachment")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label={t("composer.attach")}
            data-testid="composer-attach"
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground",
              "hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={1}
            data-testid="composer-input"
            placeholder={disabled ? t("composer.placeholderDisabled") : t("composer.placeholder")}
            className={cn(
              "min-h-[24px] flex-1 resize-none bg-transparent text-sm text-foreground outline-none",
              "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          <button
            onClick={submit}
            disabled={!trimmed || disabled || isStreaming}
            aria-label={t("composer.send")}
            data-testid="composer-send"
            className={cn(
              "grid h-8 w-8 place-items-center rounded-full bg-primary text-primary-foreground",
              "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
      {drag && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-md border-2 border-dashed border-primary bg-primary/5 text-sm text-primary">
          {t("composer.dropHint")}
        </div>
      )}
    </div>
  );
}
