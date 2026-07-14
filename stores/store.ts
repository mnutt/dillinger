import { create } from "zustand";
import type * as Monaco from "monaco-editor";
import { Document, UserSettings, DEFAULT_SETTINGS, DEFAULT_DOCUMENT_BODY } from "@/lib/types";
import { DEFAULT_DOCUMENT_TITLE } from "@/lib/document";

interface AppState {
  // Documents
  documents: Document[];
  currentDocument: Document | null;
  editorInstance: Monaco.editor.IStandaloneCodeEditor | null;

  // Settings
  settings: UserSettings;

  // UI State
  sidebarOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  previewVisible: boolean;
  zenMode: boolean;
  isDirty: boolean;
  editorScrollPercent: number;
  editorTopLine: number;

  // Document Actions
  createDocument: () => void;
  createImportedDocument: (title: string, body: string) => void;
  selectDocument: (id: string) => void;
  deleteDocument: (id: string) => void;
  updateDocumentBody: (body: string) => void;
  updateDocumentTitle: (title: string) => void;
  setEditorInstance: (editor: Monaco.editor.IStandaloneCodeEditor | null) => void;
  insertMarkdownAtCursor: (markdown: string) => void;

  // Settings Actions
  updateSettings: (settings: Partial<UserSettings>) => void;

  // UI Actions
  toggleSidebar: () => void;
  toggleSettings: () => void;
  toggleShortcuts: () => void;
  togglePreview: () => void;
  setZenMode: (enabled: boolean) => void;
  setEditorScrollPercent: (percent: number) => void;
  setEditorTopLine: (line: number) => void;

  // Persistence
  hydrate: () => void;
  persist: () => void;
}

const createDefaultDocument = (): Document => ({
  id: Date.now().toString(),
  title: DEFAULT_DOCUMENT_TITLE,
  body: DEFAULT_DOCUMENT_BODY,
  createdAt: new Date().toISOString(),
});

const IS_SANDSTORM = process.env.NEXT_PUBLIC_SANDSTORM === "1";

interface SandstormState {
  version: 1;
  document: Document;
}

function readLocalState() {
  const filesJson = localStorage.getItem("files");
  const currentJson = localStorage.getItem("currentDocument");
  const settingsJson = localStorage.getItem("profileV3");

  const isFirstVisit = !filesJson;
  let documents: Document[] = filesJson ? JSON.parse(filesJson) : [];
  let currentDocument: Document | null = currentJson ? JSON.parse(currentJson) : null;
  const settings: UserSettings = settingsJson
    ? { ...DEFAULT_SETTINGS, ...JSON.parse(settingsJson) }
    : DEFAULT_SETTINGS;

  if (documents.length === 0) {
    const defaultDoc = createDefaultDocument();
    documents = [defaultDoc];
    currentDocument = defaultDoc;
  }

  if (!currentDocument || !documents.find((document) => document.id === currentDocument!.id)) {
    currentDocument = documents[0];
  }

  return { documents, currentDocument, settings, sidebarOpen: isFirstVisit };
}

async function saveSandstormState(state: SandstormState): Promise<void> {
  const response = await fetch("/api/sandstorm/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });

  if (!response.ok) {
    throw new Error(`Sandstorm save failed with status ${response.status}`);
  }
}

export const useStore = create<AppState>((set, get) => ({
  // Initial State
  documents: [],
  currentDocument: null,
  editorInstance: null,
  settings: DEFAULT_SETTINGS,
  sidebarOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  previewVisible: true,
  zenMode: false,
  isDirty: false,
  editorScrollPercent: 0,
  editorTopLine: 1,

  // Document Actions
  createDocument: () => {
    const newDoc = createDefaultDocument();
    set((state) => ({
      documents: IS_SANDSTORM ? [newDoc] : [...state.documents, newDoc],
      currentDocument: newDoc,
    }));
    get().persist();
  },

  createImportedDocument: (title: string, body: string) => {
    const newDoc = {
      ...createDefaultDocument(),
      title,
      body,
    };

    set((state) => ({
      documents: IS_SANDSTORM ? [newDoc] : [...state.documents, newDoc],
      currentDocument: newDoc,
    }));
    get().persist();
  },

  selectDocument: (id: string) => {
    const doc = get().documents.find((d) => d.id === id);
    if (doc) {
      set({ currentDocument: doc });
      get().persist();
    }
  },

  deleteDocument: (id: string) => {
    const { documents, currentDocument } = get();
    const filtered = documents.filter((d) => d.id !== id);

    let newCurrent = currentDocument;
    if (currentDocument?.id === id) {
      newCurrent = filtered[0] || null;
    }

    set({ documents: filtered, currentDocument: newCurrent });
    get().persist();
  },

  updateDocumentBody: (body: string) => {
    const { currentDocument, documents } = get();
    if (!currentDocument) return;

    const updated = { ...currentDocument, body };
    const updatedDocs = documents.map((d) =>
      d.id === currentDocument.id ? updated : d
    );

    set({ currentDocument: updated, documents: updatedDocs, isDirty: true });
  },

  updateDocumentTitle: (title: string) => {
    const { currentDocument, documents } = get();
    if (!currentDocument) return;

    const updated = { ...currentDocument, title };
    const updatedDocs = documents.map((d) =>
      d.id === currentDocument.id ? updated : d
    );

    set({ currentDocument: updated, documents: updatedDocs });
    get().persist();
  },

  setEditorInstance: (editor) => set({ editorInstance: editor }),

  insertMarkdownAtCursor: (markdown: string) => {
    const { editorInstance, currentDocument, documents } = get();

    if (editorInstance) {
      const selection = editorInstance.getSelection();
      if (selection) {
        editorInstance.executeEdits("dillinger-inline-insert", [
          {
            range: selection,
            text: markdown,
            forceMoveMarkers: true,
          },
        ]);
        editorInstance.focus();
        return;
      }
    }

    if (!currentDocument) return;

    const updated = { ...currentDocument, body: `${currentDocument.body}${markdown}` };
    const updatedDocs = documents.map((doc) =>
      doc.id === currentDocument.id ? updated : doc
    );

    set({ currentDocument: updated, documents: updatedDocs });
    get().persist();
  },

  // Settings Actions
  updateSettings: (newSettings: Partial<UserSettings>) => {
    set((state) => ({
      settings: { ...state.settings, ...newSettings },
    }));
    get().persist();
  },

  // UI Actions
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  toggleSettings: () => set((state) => ({ settingsOpen: !state.settingsOpen })),
  toggleShortcuts: () => set((state) => ({ shortcutsOpen: !state.shortcutsOpen })),
  togglePreview: () => set((state) => ({ previewVisible: !state.previewVisible })),
  setZenMode: (enabled) => set({ zenMode: enabled }),
  setEditorScrollPercent: (percent) => set({ editorScrollPercent: percent }),
  setEditorTopLine: (line) => set({ editorTopLine: line }),

  // Persistence
  hydrate: () => {
    if (typeof window === "undefined") return;

    try {
      const localState = readLocalState();

      if (!IS_SANDSTORM) {
        set({ ...localState, isDirty: false });
        return;
      }

      // Settings stay browser-local. Documents live in /var so the grain is
      // durable and all people with access see the same notebook.
      void fetch("/api/sandstorm/state")
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Sandstorm load failed with status ${response.status}`);
          }

          const remote = await response.json() as {
            exists: boolean;
            state?: SandstormState;
          };

          if (!remote.exists || !remote.state) {
            set({ ...localState, isDirty: false });
            await saveSandstormState({
              version: 1,
              document: localState.currentDocument!,
            });
            return;
          }

          set({
            documents: [remote.state.document],
            currentDocument: remote.state.document,
            settings: localState.settings,
            sidebarOpen: false,
            isDirty: false,
          });
        })
        .catch((error) => {
          console.error("Failed to hydrate Sandstorm state:", error);
          set({ ...localState, isDirty: false });
        });
    } catch (e) {
      console.error("Failed to hydrate state:", e);
    }
  },

  persist: () => {
    if (typeof window === "undefined") return;

    const { documents, currentDocument, settings } = get();

    try {
      localStorage.setItem("profileV3", JSON.stringify(settings));

      if (IS_SANDSTORM) {
        void saveSandstormState({
          version: 1,
          document: currentDocument ?? documents[0] ?? createDefaultDocument(),
        })
          .then(() => set({ isDirty: false }))
          .catch((error) => console.error("Failed to persist Sandstorm state:", error));
      } else {
        localStorage.setItem("files", JSON.stringify(documents));
        localStorage.setItem("currentDocument", JSON.stringify(currentDocument));
        set({ isDirty: false });
      }
    } catch (e) {
      console.error("Failed to persist state:", e);
    }
  },
}));
