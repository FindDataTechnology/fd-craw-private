// Composer: textarea + send + slash-command autocomplete + drop-target.
//
// Slash commands mirror public/app.js:
//   /clear /help    — client-handled, never sent to server
//   /model /new     — server-handled
//   /skill:<name>   — server expands from loaded skills
//
// Autocomplete opens when the text starts with "/". Arrow keys navigate,
// Tab/Enter accepts, Esc closes.

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useChatStore } from "@/hooks/useChatStore";
import type { ClientMessage } from "@/types/ws";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/Toast";

interface Props {
  send: (m: ClientMessage) => void;
}

const META = [
  { label: "/model", description: "switch or show the active model" },
  { label: "/new", description: "start a new chat session" },
  { label: "/clear", description: "clear the chat view" },
  { label: "/help", description: "list available commands" },
];

export function Composer({ send }: Props) {
  const status = useChatStore((s) => s.status);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const skills = useChatStore((s) => s.skills);
  const clearView = useChatStore((s) => s.clearView);

  const [value, setValue] = useState("");
  const [acIdx, setAcIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [drag, setDrag] = useState(false);

  const disabled = status !== "connected";
  const trimmed = value.trim();

  // Autogrow.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const commands = [
    ...META,
    ...skills.map((s) => ({ label: `/skill:${s.name}`, description: s.description || "" })),
  ];
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
        "Available commands:",
        ...META.map((c) => `  ${c.label} - ${c.description}`),
        ...skills.map((s) => `  /skill:${s.name} - ${s.description || ""}`),
      ].join("\n");
      showToast(help);
      setValue("");
      return;
    }

    // The server echoes the user turn back as a `user` event — no optimistic
    // append here, or it renders twice.
    send({ type: "prompt", text: trimmed });
    setValue("");
  };

  const acceptAc = () => {
    const pick = acItems[acIdx];
    if (!pick) return;
    setValue(pick.label + " ");
    setAcIdx(0);
    textareaRef.current?.focus();
  };

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
        showToast(`Uploaded ${f.name}`);
      } catch (err) {
        showToast(`Upload failed: ${(err as Error).message.slice(0, 80)}`);
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
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border bg-background px-3 py-2 focus-within:border-primary">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          data-testid="composer-input"
          placeholder={
            disabled
              ? "Connecting…"
              : "Ask pi anything… (type / for commands, Enter to send, Shift+Enter for newline)"
          }
          className={cn(
            "min-h-[24px] flex-1 resize-none bg-transparent text-sm text-foreground outline-none",
            "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        <button
          onClick={submit}
          disabled={!trimmed || disabled || isStreaming}
          aria-label="Send"
          data-testid="composer-send"
          className={cn(
            "grid h-8 w-8 place-items-center rounded-full bg-primary text-primary-foreground",
            "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
      {drag && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-md border-2 border-dashed border-primary bg-primary/5 text-sm text-primary">
          Drop files to upload to the document collection
        </div>
      )}
    </div>
  );
}
