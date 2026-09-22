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

  it("renders tree nodes and responds to item selection", () => {
    const onSelect = vi.fn();
    const onTabChange = vi.fn();

    render(
      <LeftSidebar
        activeTab="tree"
        onTabChange={onTabChange}
        treeData={sampleTree}
        currentNotePath="projects/payments/settlement.md"
        onSelectNote={onSelect}
        headings={[]}
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
        activeTab="tree"
        onTabChange={() => {}}
        treeData={[]}
        currentNotePath=""
        onSelectNote={() => {}}
        headings={[]}
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

  it("renders error state when error is passed", () => {
    render(
      <LeftSidebar
        activeTab="tree"
        onTabChange={() => {}}
        treeData={[]}
        currentNotePath=""
        onSelectNote={() => {}}
        headings={[]}
        error="Permission denied accessing /secret"
      />
    );

    expect(screen.getByText("Permission denied accessing /secret")).toBeInTheDocument();
  });
});
