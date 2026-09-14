// Preview store: what the drawer is showing, and nothing else. Held outside the
// chat store so opening a preview never touches the message list, and so the
// drawer (loaded lazily) has no dependency on the chat surface.
//
// A local file is previewed from an object URL owned by this store; closing it
// revokes the URL so the blob is not held for the tab's lifetime.

import { create } from "zustand";

export interface PreviewTarget {
  name: string;
  url: string;
  // The URL is a blob object URL this store must revoke on close/replace.
  objectUrl?: boolean;
}

interface PreviewState {
  target: PreviewTarget | null;
  open: (target: PreviewTarget) => void;
  close: () => void;
}

function revoke(target: PreviewTarget | null) {
  if (target?.objectUrl) URL.revokeObjectURL(target.url);
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  target: null,
  open: (target) => {
    const prev = get().target;
    if (prev?.url !== target.url) revoke(prev);
    set({ target });
  },
  close: () => {
    revoke(get().target);
    set({ target: null });
  },
}));
