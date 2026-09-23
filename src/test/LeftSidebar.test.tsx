import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LeftSidebar } from "../components/LeftSidebar";
import { TreeNodeItem } from "../types";

describe("LeftSidebar", () => {
  const sampleTree: TreeNodeItem[] = [
    {
      id: "projects",
      name: "projects",
      path: "projects",
      is_folder: true,
      children: [
        {
          id: "projects/payments",
          name: "payments",
          path: "projects/payments",
          is_folder: true,
          children: [
            {
              id: "projects/payments/settlement.md",
              name: "settlement.md",
              path: "projects/payments/settlement.md",
              is_folder: false,
              is_note: true,
              title: "Settlement windows",
            },
          ],
        },
      ],
    },
    {
      id: "daily.md",
      name: "daily.md",
      path: "daily.md",
      is_folder: false,
      is_note: true,
      title: "Daily Log",
    },
  ];

  const defaultProps = {
    activeTab: "tree" as const,
    onTabChange: vi.fn(),
    treeData: sampleTree,
    currentNotePath: "projects/payments/settlement.md",
    onSelectNote: vi.fn(),
    headings: [],
    onCreateNote: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameItem: vi.fn(),
    onDuplicateNote: vi.fn(),
    onDeleteItem: vi.fn(),
    onMoveItem: vi.fn(),
    onRevealInFileManager: vi.fn(),
    onCopyRelativePath: vi.fn(),
    inlineAction: null,
    onCommitInlineAction: vi.fn(),
    onCancelInlineAction: vi.fn(),
  };

  it("renders tree nodes and responds to item selection", () => {
    const onSelect = vi.fn();

    render(
      <LeftSidebar
        {...defaultProps}
        onSelectNote={onSelect}
      />
    );

    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("daily.md")).toBeInTheDocument();

    fireEvent.click(screen.getByText("daily.md"));
    expect(onSelect).toHaveBeenCalledWith("daily.md");
  });

  it("renders empty workspace state with Create button", () => {
    const onCreate = vi.fn();
    render(
      <LeftSidebar
        {...defaultProps}
        treeData={[]}
        currentNotePath=""
        isEmpty={true}
        onCreateNote={onCreate}
      />
    );

    expect(screen.getByText("Workspace is empty")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /create your first note/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("renders inline create input with live validation against invalid names", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();

    render(
      <LeftSidebar
        {...defaultProps}
        inlineAction={{
          type: "create-note",
          targetPath: "",
          initialValue: "my-note.md",
        }}
        onCommitInlineAction={onCommit}
        onCancelInlineAction={onCancel}
      />
    );

    const input = screen.getByPlaceholderText("note-name") as HTMLInputElement;
    expect(input).toBeInTheDocument();

    // Type empty name
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByText("Name cannot be empty")).toBeInTheDocument();

    // Type name with slash
    fireEvent.change(input, { target: { value: "sub/folder" } });
    expect(screen.getByText("Name cannot contain path separators (/ or \\)")).toBeInTheDocument();

    // Type reserved system name
    fireEvent.change(input, { target: { value: "CON" } });
    expect(screen.getByText('"CON" is a reserved system name')).toBeInTheDocument();

    // Type duplicate name
    fireEvent.change(input, { target: { value: "daily.md" } });
    expect(screen.getByText("An item with this name already exists in this folder")).toBeInTheDocument();

    // Valid name
    fireEvent.change(input, { target: { value: "brand-new-note.md" } });
    expect(screen.queryByText("An item with this name already exists in this folder")).not.toBeInTheDocument();
  });

  it("renders error state when error is passed", () => {
    render(
      <LeftSidebar
        {...defaultProps}
        treeData={[]}
        currentNotePath=""
        error="Permission denied accessing /secret"
      />
    );

    expect(screen.getByText("Permission denied accessing /secret")).toBeInTheDocument();
  });

  it("renders search tab controls and empty query state", () => {
    render(
      <LeftSidebar
        {...defaultProps}
        activeTab="search"
      />
    );

    expect(screen.getByPlaceholderText("Search in workspace...")).toBeInTheDocument();
    expect(screen.getByText("Type a query to search across all notes.")).toBeInTheDocument();
  });
});
