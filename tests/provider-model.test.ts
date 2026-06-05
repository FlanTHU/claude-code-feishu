import { describe, expect, it } from 'vitest';
import { parseProviderModelString } from '../src/utils/provider-model.js';

describe('parseProviderModelString', () => {
  it('按第一个冒号拆分，模型 id 可含额外冒号', () => {
    const r = parseProviderModelString('Mify-Xiaomi:xiaomi/mimo-v2-pro:extra');
    expect(r).toEqual({
      providerId: 'Mify-Xiaomi',
      modelId: 'xiaomi/mimo-v2-pro:extra',
    });
  });

  it('常见双段格式', () => {
    expect(parseProviderModelString('anthropic:claude-sonnet-4-6')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
  });

  it('无分隔符时返回 null', () => {
    expect(parseProviderModelString('claude-only')).toBeNull();
  });
});
