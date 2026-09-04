// Runs in the browser through page.evaluate; measure words, not just overflow.
export function measureActionReadability() {
  const actions = [
    ...globalThis.document.querySelectorAll(".mi-activity__actions button"),
  ]
    .filter(
      (button) => button.getClientRects().length && button.textContent.trim(),
    )
    .map((button) => {
      const label =
        button.querySelector(".mi-activity__action-label") ?? button;
      const style = globalThis.getComputedStyle(button);
      const icon = button.querySelector("svg");
      const usableWidth = Math.min(
        label.getBoundingClientRect().width,
        button.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          (icon
            ? icon.getBoundingClientRect().width +
              (parseFloat(style.columnGap) || 0)
            : 0),
      );
      const walker = globalThis.document.createTreeWalker(
        label,
        globalThis.NodeFilter.SHOW_TEXT,
      );
      const words = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest("svg")) continue;
        for (const match of node.textContent.matchAll(/\S+/g)) {
          const range = globalThis.document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rects = [...range.getClientRects()].filter(
            (rect) => rect.width && rect.height,
          );
          words.push({
            word: match[0],
            lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
            width: rects.reduce((sum, rect) => sum + rect.width, 0),
          });
        }
      }
      const labelRange = globalThis.document.createRange();
      labelRange.selectNodeContents(label);
      return {
        label: label.textContent.trim().replace(/\s+/g, " "),
        labelLines: new Set(
          [...labelRange.getClientRects()]
            .filter((rect) => rect.width && rect.height)
            .map((rect) => Math.round(rect.top)),
        ).size,
        usableWidth,
        requiredWordWidth: Math.max(0, ...words.map((word) => word.width)),
        brokenWords: words.filter((word) => word.lines > 1),
      };
    });
  return {
    actions,
    failures: actions.filter(
      (action) =>
        action.brokenWords.length ||
        action.usableWidth + 2 < action.requiredWordWidth,
    ),
  };
}
