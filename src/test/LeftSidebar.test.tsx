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

  it("opens a note in a new tab on cmd/ctrl-click and from the context menu", () => {
    const onSelect = vi.fn();
    render(<LeftSidebar {...defaultProps} onSelectNote={onSelect} />);

    fireEvent.click(screen.getByText("daily.md"), { ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("daily.md", { newTab: true });

    fireEvent.contextMenu(screen.getByText("daily.md"));
    fireEvent.click(screen.getByText("Open in new tab"));
    expect(onSelect).toHaveBeenLastCalledWith("daily.md", { newTab: true });
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

  // A tree whose folder names aren't in LeftSidebar's hardcoded default-expanded set
  // (['projects', 'projects/payments', 'archive', 'reading', 'guides']), so these two tests can
  // rely on "docs" genuinely starting collapsed.
  const collapsibleTree: TreeNodeItem[] = [
    {
      id: "docs",
      name: "docs",
      path: "docs",
      is_folder: true,
      children: [
        {
          id: "docs/guide.md",
          name: "guide.md",
          path: "docs/guide.md",
          is_folder: false,
          is_note: true,
        },
      ],
    },
    { id: "daily.md", name: "daily.md", path: "daily.md", is_folder: false, is_note: true },
  ];

  it("auto-expands the target folder when a create-note/create-folder action starts on it", () => {
    // "docs" starts collapsed, so its child inline-create row would otherwise mount nowhere
    // until the user manually opened it first.
    render(
      <LeftSidebar
        {...defaultProps}
        treeData={collapsibleTree}
        currentNotePath="daily.md"
        inlineAction={{
          type: "create-note",
          targetPath: "docs",
          initialValue: "Untitled.md",
        }}
      />
    );

    expect(screen.getByPlaceholderText("note-name")).toBeInTheDocument();
  });

  it("supports arrow-key navigation between rows and expand/collapse via Left/Right", () => {
    render(<LeftSidebar {...defaultProps} treeData={collapsibleTree} currentNotePath="daily.md" />);

    const docsRow = screen.getByText("docs").closest('[role="treeitem"]') as HTMLElement;
    docsRow.focus();

    // "docs" starts collapsed; Right expands it, revealing its child.
    expect(screen.queryByText("guide.md")).not.toBeInTheDocument();
    fireEvent.keyDown(docsRow, { key: "ArrowRight" });
    expect(screen.getByText("guide.md")).toBeInTheDocument();

    // Down moves focus to the next visible row.
    fireEvent.keyDown(docsRow, { key: "ArrowDown" });
    const guideRow = screen.getByText("guide.md").closest('[role="treeitem"]') as HTMLElement;
    expect(guideRow).toHaveFocus();

    // Left on a note (not a folder) hops up to its parent.
    fireEvent.keyDown(guideRow, { key: "ArrowLeft" });
    expect(docsRow).toHaveFocus();

    // Left on an expanded folder collapses it.
    fireEvent.keyDown(docsRow, { key: "ArrowLeft" });
    expect(screen.queryByText("guide.md")).not.toBeInTheDocument();

    // Up from the very first row has nothing above it and doesn't throw.
    fireEvent.keyDown(docsRow, { key: "ArrowUp" });
  });

  it("opens the focused note on Enter and toggles a focused folder", () => {
    const onSelect = vi.fn();
    render(
      <LeftSidebar {...defaultProps} treeData={collapsibleTree} currentNotePath="" onSelectNote={onSelect} />
    );

    const docsRow = screen.getByText("docs").closest('[role="treeitem"]') as HTMLElement;
    fireEvent.keyDown(docsRow, { key: "Enter" });
    const guideRow = screen.getByText("guide.md").closest('[role="treeitem"]') as HTMLElement;

    fireEvent.keyDown(guideRow, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("docs/guide.md");
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

  describe("Tags tab (M10.25)", () => {
    const tagCounts = [
      { tag: "payments", count: 2 },
      { tag: "alpha", count: 1 },
    ];
    const indexedNotes = [
      {
        path: "projects/payments/settlement.md",
        title: "Settlement",
        size_bytes: 0,
        modified_ms: 0,
        headings: [],
        tags: ["payments"],
      },
      {
        path: "daily.md",
        title: "Daily Log",
        size_bytes: 0,
        modified_ms: 0,
        headings: [],
        tags: ["alpha", "payments"],
      },
    ];

    it("lists workspace tags with counts, filterable by name", () => {
      render(<LeftSidebar {...defaultProps} activeTab="tags" tagCounts={tagCounts} />);

      expect(screen.getByText("payments")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("alpha")).toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText("Filter tags..."), {
        target: { value: "pay" },
      });
      expect(screen.getByText("payments")).toBeInTheDocument();
      expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    });

    it("clicking a tag row filters and switches to the tree tab", () => {
      const onFilterByTag = vi.fn();
      render(
        <LeftSidebar
          {...defaultProps}
          activeTab="tags"
          tagCounts={tagCounts}
          onFilterByTag={onFilterByTag}
        />
      );

      fireEvent.click(screen.getByText("payments"));
      expect(onFilterByTag).toHaveBeenCalledWith("payments");
    });

    it("Enter on a keyboard-focused tag row also filters", () => {
      const onFilterByTag = vi.fn();
      render(
        <LeftSidebar
          {...defaultProps}
          activeTab="tags"
          tagCounts={tagCounts}
          onFilterByTag={onFilterByTag}
        />
      );

      fireEvent.keyDown(screen.getByText("alpha"), { key: "Enter" });
      expect(onFilterByTag).toHaveBeenCalledWith("alpha");
    });

    it("renames a tag via the row's context menu", () => {
      const onTagRename = vi.fn();
      render(
        <LeftSidebar
          {...defaultProps}
          activeTab="tags"
          tagCounts={tagCounts}
          onTagRename={onTagRename}
        />
      );

      fireEvent.contextMenu(screen.getByText("payments"));
      fireEvent.click(screen.getByText("Rename tag…"));
      const input = screen.getByDisplayValue("payments");
      fireEvent.change(input, { target: { value: "billing" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onTagRename).toHaveBeenCalledWith("payments", "billing");
    });

    it("filters the tree to notes carrying the active tag, with a dismissible chip", () => {
      const onClearTagFilter = vi.fn();
      render(
        <LeftSidebar
          {...defaultProps}
          activeTab="tree"
          indexedNotes={indexedNotes}
          activeTagFilter="alpha"
          onClearTagFilter={onClearTagFilter}
        />
      );

      expect(screen.getByText("daily.md")).toBeInTheDocument();
      expect(screen.queryByText("settlement.md")).not.toBeInTheDocument();
      expect(screen.getByText("#alpha")).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText("Clear filter for tag alpha"));
      expect(onClearTagFilter).toHaveBeenCalled();
    });
  });
});
