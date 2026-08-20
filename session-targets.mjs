export function preferPickerItem(items, value) {
  const index = items.findIndex((item) => item.value === value);
  if (index <= 0) return items;
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}
