export function preferPickerItem(items, value) {
  const index = items.findIndex((item) => item.value === value);
  if (index <= 0) return items;
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}

export function formatSandboxProgress(name, phase, message) {
  if (phase === "lock")
    return `${name} (waiting for another sandbox operation)`;

  let activity = "connecting";
  if (
    phase?.startsWith("bootstrap.") ||
    phase?.startsWith("upload.windows.")
  )
    activity = "repairing guest";
  else if (phase?.startsWith("workspace.")) activity = "syncing workspace";

  const detail =
    message && !["started", "completed"].includes(message)
      ? ` • ${message}`
      : "";
  return `${name} (${activity})${detail}`;
}
