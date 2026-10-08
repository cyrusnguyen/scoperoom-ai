export function requirementTextError(
  value: string,
  limit: number,
  label: string,
  required = false,
) {
  if (!value.isWellFormed() || value.includes("\0"))
    return `${label} contains invalid text.`;
  if ([...value].length > limit) {
    return `${label} must be ${limit.toLocaleString("en-US")} characters or fewer.`;
  }
  if (required && !value.trim()) return `${label} is required.`;
  return "";
}
