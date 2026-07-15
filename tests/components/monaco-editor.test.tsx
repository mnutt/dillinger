import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MonacoEditor } from "@/components/editor/MonacoEditor";
import { useStore } from "@/stores/store";

const mocks = vi.hoisted(() => ({
  didMount: vi.fn(),
  executeEdits: vi.fn(),
  hasTextFocus: vi.fn(() => true),
  upload: vi.fn(),
}));

vi.mock("@/hooks/useImageUpload", () => ({
  useImageUpload: () => ({
    upload: mocks.upload,
    isUploading: false,
  }),
}));

vi.mock("@monaco-editor/react", async () => {
  const ReactModule = await import("react");

  function MockEditor({ onMount }: { onMount: (editor: unknown, monaco: unknown) => void }) {
    ReactModule.useEffect(() => {
      const editor = {
        executeEdits: mocks.executeEdits,
        focus: vi.fn(),
        getLayoutInfo: () => ({ height: 600 }),
        getScrollHeight: () => 600,
        getScrollTop: () => 0,
        getSelection: () => ({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        }),
        getVisibleRanges: () => [{ startLineNumber: 1 }],
        hasTextFocus: mocks.hasTextFocus,
        onDidScrollChange: () => ({ dispose: vi.fn() }),
        updateOptions: vi.fn(),
      };
      const timeout = setTimeout(() => {
        onMount(editor, { editor: { defineTheme: vi.fn() } });
        mocks.didMount();
      }, 0);
      return () => clearTimeout(timeout);
    }, [onMount]);

    return (
      <div data-testid="mock-monaco">
        <textarea aria-label="Monaco input" />
      </div>
    );
  }

  return {
    default: MockEditor,
    loader: { config: vi.fn() },
  };
});

const initialState = useStore.getState();

describe("MonacoEditor image paste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      ...initialState,
      documents: [{
        id: "doc-1",
        title: "Paste.md",
        body: "",
        createdAt: "2026-07-15T00:00:00.000Z",
      }],
      currentDocument: {
        id: "doc-1",
        title: "Paste.md",
        body: "",
        createdAt: "2026-07-15T00:00:00.000Z",
      },
      editorInstance: null,
      settings: { ...initialState.settings },
    });
  });

  it("captures a Firefox-style clipboard file before Monaco consumes paste", async () => {
    const file = new File(["image"], "clipboard.png", { type: "image/png" });
    mocks.upload.mockResolvedValue({
      url: "/assets/image.png",
      markdown: "![clipboard](/assets/image.png)",
      filename: file.name,
      size: file.size,
      type: file.type,
    });

    render(<MonacoEditor />);
    const textarea = await screen.findByRole("textbox", { name: "Monaco input" });
    await waitFor(() => expect(mocks.didMount).toHaveBeenCalledOnce());
    const monacoPasteHandler = vi.fn((event: Event) => event.stopPropagation());
    textarea.addEventListener("paste", monacoPasteHandler);

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { types: ["Files"], items: [], files: [file] },
    });

    act(() => {
      textarea.dispatchEvent(paste);
    });

    expect(paste.defaultPrevented).toBe(true);
    expect(monacoPasteHandler).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith(file));
    await waitFor(() => expect(mocks.executeEdits).toHaveBeenCalledWith(
      "dillinger-image-paste",
      [{
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        },
        text: "\n![clipboard](/assets/image.png)\n",
        forceMoveMarkers: true,
      }],
    ));
  });
});
