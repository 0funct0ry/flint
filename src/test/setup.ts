import '@testing-library/jest-dom';

// jsdom has no layout, so Range lacks the geometry APIs CodeMirror's drawn selection layer uses.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
