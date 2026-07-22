// Documents + collections state. Fetches REST on mount; subscribes to the
// `documents_status` WS event (forwarded by useWebSocket) for live status.
import { create } from "zustand";
import * as api from "@/lib/documents-api";
import type { DocMeta, CollectionMeta, QueryResult } from "@/lib/documents-api";
import type { ServerMessage } from "@/types/ws";

interface DocumentsState {
  documents: DocMeta[];
  collections: CollectionMeta[];
  loading: boolean;
  error: string | null;
  selectedDocId: string | null;
  selectedDocContent: string | null;
  docQuery: string;
  docAnswer: QueryResult | null;
  docQueryLoading: boolean;

  load: () => Promise<void>;
  refreshDocs: () => Promise<void>;
  selectDoc: (id: string | null) => Promise<void>;
  setDocQuery: (q: string) => void;
  runDocQuery: () => Promise<void>;
  applyEvent: (msg: ServerMessage) => void;
}

export const useDocumentsStore = create<DocumentsState>((set, get) => ({
  documents: [],
  collections: [],
  loading: false,
  error: null,
  selectedDocId: null,
  selectedDocContent: null,
  docQuery: "",
  docAnswer: null,
  docQueryLoading: false,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [documents, collections] = await Promise.all([
        api.listDocuments(),
        api.listCollections(),
      ]);
      set({ documents, collections, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  refreshDocs: async () => {
    try {
      const documents = await api.listDocuments();
      set({ documents });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  selectDoc: async (id) => {
    if (id === null) {
      set({ selectedDocId: null, selectedDocContent: null });
      return;
    }
    set({ selectedDocId: id, selectedDocContent: null });
    try {
      const content = await api.getDocumentContent(id);
      set({ selectedDocContent: content });
    } catch (err) {
      set({ selectedDocContent: `Error: ${(err as Error).message}` });
    }
  },

  setDocQuery: (q) => set({ docQuery: q }),

  runDocQuery: async () => {
    const q = get().docQuery.trim();
    if (!q) return;
    set({ docQueryLoading: true, docAnswer: null });
    try {
      const docAnswer = await api.queryDocuments(q);
      set({ docAnswer, docQueryLoading: false });
    } catch (err) {
      set({ docAnswer: { error: (err as Error).message }, docQueryLoading: false });
    }
  },

  applyEvent: (msg) => {
    if (msg.type !== "documents_status") return;
    const { id, status, error } = msg as { id: string; status: string; error?: string };
    set((s) => ({
      documents: s.documents.map((d) =>
        d.id === id ? { ...d, status: status as DocMeta["status"], error } : d,
      ),
    }));
  },
}));
