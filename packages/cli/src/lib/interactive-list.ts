/**
 * Interactive List — generic scrollable list with selection
 *
 * Manages viewport math and selection state.
 * Returns pre-formatted lines for the caller to pass to tui.render().
 * Knows nothing about spaghetti data models.
 */

export interface ListConfig<T> {
  items: T[];
  renderItem: (item: T, index: number, selected: boolean) => string[];
  headerLines: string[];
  footerLines: string[];
  viewportHeight: number;
}

export interface ListView<T> {
  getLines(): string[];
  moveUp(): void;
  moveDown(): void;
  getSelected(): T | undefined;
  getSelectedIndex(): number;
  updateItems(items: T[]): void;
  updateHeaderFooter(headerLines: string[], footerLines: string[], viewportHeight: number): void;
  reset(): void;
}

export function createListView<T>(config: ListConfig<T>): ListView<T> {
  let items = config.items;
  let selectedIndex = 0;
  let scrollOffset = 0; // index of the first visible item

  function adjustScroll(): void {
    if (items.length === 0) {
      scrollOffset = 0;
      return;
    }

    // Ensure selectedIndex is within bounds
    if (selectedIndex < 0) selectedIndex = 0;
    if (selectedIndex >= items.length) selectedIndex = items.length - 1;

    // Scroll up if selection is above viewport
    if (selectedIndex < scrollOffset) {
      scrollOffset = selectedIndex;
      return;
    }

    // Scroll down if selection is near bottom of viewport (1-item margin)
    // Count lines from scrollOffset to selectedIndex + 1 (margin item)
    const marginIndex = Math.min(selectedIndex + 1, items.length - 1);
    let usedLines = 0;
    for (let i = scrollOffset; i <= marginIndex && i < items.length; i++) {
      const itemLines = config.renderItem(items[i], i, i === selectedIndex);
      usedLines += itemLines.length;
    }
    while (usedLines > config.viewportHeight && scrollOffset < selectedIndex) {
      const removedLines = config.renderItem(items[scrollOffset], scrollOffset, scrollOffset === selectedIndex);
      usedLines -= removedLines.length;
      scrollOffset++;
    }
  }

  return {
    getLines(): string[] {
      const lines: string[] = [];

      // Header
      for (const h of config.headerLines) lines.push(h);

      if (items.length === 0) {
        // Fill viewport with empty space, footer at bottom
        for (let i = 0; i < config.viewportHeight; i++) lines.push('');
      } else {
        // Render visible items
        let usedLines = 0;
        for (let i = scrollOffset; i < items.length; i++) {
          const itemLines = config.renderItem(items[i], i, i === selectedIndex);
          if (usedLines + itemLines.length > config.viewportHeight && usedLines > 0) break;
          for (const l of itemLines) {
            lines.push(l);
            usedLines++;
          }
        }
        // Pad remaining viewport
        while (usedLines < config.viewportHeight) {
          lines.push('');
          usedLines++;
        }
      }

      // Footer
      for (const f of config.footerLines) lines.push(f);

      return lines;
    },

    moveUp(): void {
      if (selectedIndex > 0) {
        selectedIndex--;
        adjustScroll();
      }
    },

    moveDown(): void {
      if (selectedIndex < items.length - 1) {
        selectedIndex++;
        adjustScroll();
      }
    },

    getSelected(): T | undefined {
      return items[selectedIndex];
    },

    getSelectedIndex(): number {
      return selectedIndex;
    },

    updateItems(newItems: T[]): void {
      items = newItems;
      // Clamp selection
      if (selectedIndex >= items.length) {
        selectedIndex = Math.max(0, items.length - 1);
      }
      adjustScroll();
    },

    updateHeaderFooter(headerLines: string[], footerLines: string[], viewportHeight: number): void {
      config.headerLines = headerLines;
      config.footerLines = footerLines;
      config.viewportHeight = viewportHeight;
      adjustScroll();
    },

    reset(): void {
      selectedIndex = 0;
      scrollOffset = 0;
    },
  };
}
