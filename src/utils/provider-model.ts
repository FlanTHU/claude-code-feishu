/**
 * 解析 `provider:model` 或 `provider/model` 格式的模型标识。
 * 与 CommandHandler.parseProviderModel 逻辑一致：按**第一个**分隔符拆分，模型 id 可含额外 `:`。
 */
export function parseProviderModelString(raw?: string): { providerId: string; modelId: string } | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const separator = trimmed.includes(':') ? ':' : (trimmed.includes('/') ? '/' : '');
  if (!separator) {
    return null;
  }

  const splitIndex = trimmed.indexOf(separator);
  const providerId = trimmed.slice(0, splitIndex).trim();
  const modelId = trimmed.slice(splitIndex + 1).trim();
  if (!providerId || !modelId) {
    return null;
  }

  return { providerId, modelId };
}
