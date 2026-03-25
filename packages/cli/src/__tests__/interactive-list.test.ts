import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createListView } from '../lib/interactive-list.js';

// Minimal renderItem: each item is 1 line
const renderItem = (item: string, _idx: number, selected: boolean) => [
  selected ? `> ${item}` : `  ${item}`,
];

describe('createListView', () => {
  test('getLines includes header, items, and footer', () => {
    const view = createListView({
      items: ['a', 'b', 'c'],
      renderItem,
      headerLines: ['Header'],
      footerLines: ['Footer'],
      viewportHeight: 10,
    });
    const lines = view.getLines();
    assert.strictEqual(lines[0], 'Header');
    assert.ok(lines.includes('Footer'));
    assert.ok(lines.some((l) => l.includes('> a'))); // first selected by default
  });

  test('first item is selected by default', () => {
    const view = createListView({
      items: ['a', 'b', 'c'],
      renderItem,
      headerLines: [],
      footerLines: [],
      viewportHeight: 10,
    });
    assert.strictEqual(view.getSelected(), 'a');
    assert.strictEqual(view.getSelectedIndex(), 0);
  });

  test('moveDown advances selection', () => {
    const view = createListView({
      items: ['a', 'b', 'c'],
      renderItem,
      headerLines: [],
      footerLines: [],
      viewportHeight: 10,
    });
    view.moveDown();
    assert.strictEqual(view.getSelected(), 'b');
    assert.strictEqual(view.getSelectedIndex(), 1);
  });

  test('moveUp wraps or clamps at top', () => {
    const view = createListView({
      items: ['a', 'b', 'c'],
      renderItem,
      headerLines: [],
      footerLines: [],
      viewportHeight: 10,
    });
    view.moveUp(); // already at 0
    assert.strictEqual(view.getSelectedIndex(), 0);
  });

  test('moveDown clamps at bottom', () => {
    const view = createListView({
      items: ['a', 'b'],
      renderItem,
      headerLines: [],
      footerLines: [],
      viewportHeight: 10,
    });
    view.moveDown();
    view.moveDown(); // past end
    assert.strictEqual(view.getSelectedIndex(), 1);
  });

  test('reset returns to first item', () => {
    const view = createListView({
      items: ['a', 'b', 'c'],
      renderItem,
      headerLines: [],
      footerLines: [],
      viewportHeight: 10,
    });
    view.moveDown();
    view.moveDown();
    view.reset();
    assert.strictEqual(view.getSelectedIndex(), 0);
  });

  test('updateItems replaces items and clamps index', () => {
    const view = createListView({
      items: ['a', 'b', 'c'],
      renderItem,
      headerLines: [],
      footerLines: [],
      viewportHeight: 10,
    });
    view.moveDown();
    view.moveDown(); // index = 2
    view.updateItems(['x']); // only 1 item now
    assert.strictEqual(view.getSelectedIndex(), 0);
    assert.strictEqual(view.getSelected(), 'x');
  });

  test('updateItems preserves index when valid', () => {
    const view = createListView({
      items: ['a', 'b', 'c'],
      renderItem,
      headerLines: [],
      footerLines: [],
      viewportHeight: 10,
    });
    view.moveDown(); // index = 1
    view.updateItems(['a', 'b', 'c', 'd']); // expanded
    assert.strictEqual(view.getSelectedIndex(), 1);
  });
});

describe('viewport scrolling', () => {
  // 2-line items to test scroll
  const tallRender = (item: string, _idx: number, selected: boolean) => [
    selected ? `> ${item}` : `  ${item}`,
    '  ---',
  ];

  test('scrolls down when selection exceeds viewport', () => {
    // 3 items x 2 lines = 6 lines needed, viewport is 4
    const view = createListView({
      items: ['a', 'b', 'c'],
      renderItem: tallRender,
      headerLines: [],
      footerLines: [],
      viewportHeight: 4, // fits 2 items
    });
    const lines1 = view.getLines();
    assert.ok(lines1.some((l) => l.includes('> a'))); // 'a' visible and selected

    view.moveDown(); // select 'b'
    view.moveDown(); // select 'c' — should scroll
    const lines2 = view.getLines();
    assert.ok(lines2.some((l) => l.includes('> c'))); // 'c' visible
  });

  test('empty items produces no crash', () => {
    const view = createListView({
      items: [] as string[],
      renderItem,
      headerLines: ['Header'],
      footerLines: ['Footer'],
      viewportHeight: 10,
    });
    const lines = view.getLines();
    assert.ok(lines.includes('Header'));
    assert.ok(lines.includes('Footer'));
  });
});
