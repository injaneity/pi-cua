export function preferPickerItem(items, value) {
  const index = items.findIndex((item) => item.value === value);
  if (index <= 0) return items;
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}

export function isControllerClipboardImagePath(value) {
  return (
    typeof value === "string" &&
    /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/pi-clipboard-[^/]+\.(?:png|jpe?g|gif|webp|bmp)$/i.test(
      value,
    )
  );
}

export function shouldUseControllerTool(toolName, input) {
  return (
    toolName === "read" &&
    input !== null &&
    typeof input === "object" &&
    isControllerClipboardImagePath(input.path)
  );
}

export function shouldHandoffExecutionTarget(reason) {
  return reason === "new" || reason === "fork";
}

export function shouldCleanupExecutionTarget(reason) {
  return reason !== "reload" && !shouldHandoffExecutionTarget(reason);
}
