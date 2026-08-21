export function latestCustomEntryData(entries, customType) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === customType)
      return entry.data;
  }
  return undefined;
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
