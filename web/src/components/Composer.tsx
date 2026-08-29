// Composer: textarea + send + slash-command autocomplete + file attachment.
//
// Slash commands:
//   /clear /help    - client-handled, never sent to server
//   /model /new     - server-handled
//   /skill:<name>   - server expands from loaded skills
//
// The paperclip uploads via POST /api/documents and injects an @doc:<id>
// reference the server expands into the agent's context. The slash-command
// autocomplete is delegated to <SlashCommandPicker> (sectioned popover with
// filter, keyboard nav, Esc dismiss, Enter insert).
//
// All user-visible strings resolve through the i18n bundle. Slash-command
// tokens (/model, /new, …) are identifiers and stay literal.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import { SlashCommandPicker, type SlashCommand } from "@/components/SlashCommandPicker";
import type { ClientMessage } from "@/types/ws";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/Toast";
import { uploadFile } from "@/lib/documents-api";

interface Props {
  send: (m: ClientMessage) => void;
  // Controlled draft, owned by ChatPage so it survives the welcome ↔
  // in-session branch swap and can be prefilled by suggested-prompt cards.
  value: string;
  onChange: (v: string) => void;
  // Bumped by ChatPage to focus the composer (e.g. after a card prefill).
  focusTick?: number;
}

// Command tokens (identifiers, not translated) paired with i18n keys for their
// descriptions. Built into a translated commands array inside the component.
const CMD_META = [
  { label: "/model", descKey: "composer.cmd.model" },
  { label: "/new", descKey: "composer.cmd.new" },
  { label: "/clear", descKey: "composer.cmd.clear" },
  { label: "/help", descKey: "composer.cmd.help" },
];

export function Composer({ send, value, onChange, focusTick = 0 }: Props) {
  const { t } = useTranslation();
  const status = useChatStore((s) => s.status);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const skills = useChatStore((s) => s.skills);
  const clearView = useChatStore((s) => s.clearView);

  const [acIdx, setAcIdx] = useState(0);
  // Esc "dismisses" the picker without clearing the composer (a separate
  // state from the text-derived open check so the user keeps what they
  // typed). The flag resets as soon as the text changes.
  const [pickerDismissed, setPickerDismissed] = useState(false);
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

  // Built-in commands (Commands section). Skills come from the store and are
  // rendered as the Skills section inside <SlashCommandPicker>. Memoized on
  // the locale: a per-render rebuild changed `commands` identity every render
  // and defeated the mergedItems memo below.
  const commands: SlashCommand[] = useMemo(
    () => CMD_META.map((c) => ({ label: c.label, description: t(c.descKey) })),
    [t],
  );

  // Autogrow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the deliberate trigger — resize the textarea on every keystroke
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // Focus on demand — ChatPage bumps `focusTick` when a suggested-prompt card
  // prefills the draft.
  useEffect(() => {
    if (focusTick > 0) textareaRef.current?.focus();
  }, [focusTick]);

  const submit = () => {
    if (!trimmed || disabled) return;

    // Local commands never reach the server.
    if (/^\/clear\b/i.test(trimmed)) {
      clearView();
      onChange("");
      return;
    }
    if (/^\/help\b/i.test(trimmed)) {
      const help = [
        t("composer.helpHeader"),
        ...CMD_META.map((c) => `  ${c.label} - ${t(c.descKey)}`),
        ...skills.map((s) => `  /skill:${s.name} - ${s.description || ""}`),
      ].join("\n");
      showToast(help);
      onChange("");
      return;
    }

    // Append @doc:<id> references for any attachments so the server expands
    // the ingested document content into the agent's context (design D4).
    const refs = attachments.map((a) => `@doc:${a.id}`).join(" ");
    const text = refs ? `${trimmed} ${refs}` : trimmed;

    // The server echoes the user turn back as a `user` event - no optimistic
    // append here, or it renders twice.
    send({ type: "prompt", text });
    onChange("");
    setAttachments([]);
  };

  const acceptAc = (label?: string) => {
    const pick = label;
    if (!pick) return;
    onChange(pick + " ");
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
    // IME composition (pinyin, kana, …): Enter confirms the composition and
    // arrows navigate the IME candidate list — neither may submit or drive
    // the slash picker. isComposing misses some Safari versions, hence 229.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // The slash picker derives "is open" from the text content, so we always
    // forward arrow / Enter / Tab / Esc when the picker is showing.
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIdx((i) => i + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        // The picker itself handles the pick via mouse; keyboard Enter uses
        // the same path. The flat item list lives inside the picker.
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPickerDismissed(true);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // Insert the highlighted pick rather than submit the raw `/...` text.
        e.preventDefault();
        const items = mergedItems;
        const pick = items[Math.min(acIdx, items.length - 1)];
        if (pick) acceptAc(pick.label);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Build the same flat item list the picker renders, so Enter can resolve
  // the highlighted label without the picker exposing a ref-based lookup.
  // Mirrors the filter (substring, case-insensitive, max 8/section) and the
  // Commands → Skills ordering. The picker is "open" only while a `/` token
  // is present AND the user has not dismissed it with Esc.
  const pickerOpen = useMemo(() => {
    const m = value.match(/(^|\s)(\/[^/\s]*)$/);
    if (!m) return false;
    if (pickerDismissed) return false;
    return true;
  }, [value, pickerDismissed]);
  // Reset the dismissed flag whenever the user edits the text (typing or
  // pasting), so the next `/` token re-opens the picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — resetting on `pickerDismissed` would immediately undo the Esc-dismiss; `value` is the reset trigger
  useEffect(() => {
    if (pickerDismissed) setPickerDismissed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const mergedItems = useMemo(() => {
    const m = value.match(/(^|\s)(\/[^/\s]*)$/);
    if (!m) return [];
    const query = (m[2] ?? "").slice(1).toLowerCase();
    const cmds = commands
      .filter((c) => c.label.toLowerCase().includes(query))
      .slice(0, 8);
    const sks = skills
      .map((s) => ({ label: `/skill:${s.name}`, description: s.description || "" }))
      .filter((s) => s.label.toLowerCase().includes(query))
      .slice(0, 8);
    return [...cmds, ...sks];
  }, [value, commands, skills]);

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

  // Determine the active filter index across the merged list. The picker
  // exposes its own index internally; we drive its highlight from here via
  // the `highlight` + `onHighlight` contract. The composer owns the
  // highlight state because it also drives keyboard navigation; the picker
  // clamps it on render.
  const handlePick = (label: string) => acceptAc(label);

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
      <SlashCommandPicker
        text={value}
        open={pickerOpen}
        highlight={acIdx}
        onHighlight={setAcIdx}
        onPick={handlePick}
        commands={commands}
      />
      <div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-border bg-background px-3 py-2 focus-within:border-primary">
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground" data-testid="composer-attach-count">
              {t("chat.composer.attachments", { count: attachments.length })}
            </span>
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
            onChange={(e) => onChange(e.target.value)}
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
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              aria-label={t("composer.stop")}
              data-testid="composer-stop"
              className={cn(
                "grid h-8 w-8 place-items-center rounded-full bg-primary-deep text-primary-foreground",
                "hover:opacity-90",
              )}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!trimmed || disabled}
              aria-label={t("composer.send")}
              data-testid="composer-send"
              className={cn(
                "grid h-8 w-8 place-items-center rounded-full bg-primary-deep text-primary-foreground",
                "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
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
