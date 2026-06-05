import { describe, expect, it } from 'vitest';

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

interface FeishuAttachment {
  type: 'image' | 'file';
  fileKey: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
}

function collectAttachmentsFromContent(content: unknown): FeishuAttachment[] {
  if (!content || typeof content !== 'object') return [];
  const attachments: FeishuAttachment[] = [];
  const visited = new Set<object>();
  const stack: unknown[] = [content];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current as object)) continue;
    visited.add(current as object);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    const record = current as Record<string, unknown>;

    const imageKey = getString(record.image_key) || getString(record.imageKey);
    if (imageKey) {
      attachments.push({ type: 'image', fileKey: imageKey });
    }

    const fileKey = getString(record.file_key) || getString(record.fileKey);
    if (fileKey) {
      attachments.push({
        type: 'file',
        fileKey,
        fileName: getString(record.file_name) || getString(record.fileName),
        fileType: getString(record.file_type) || getString(record.fileType),
        fileSize: getNumber(record.file_size) || getNumber(record.fileSize),
      });
    }

    for (const value of Object.values(record)) {
      stack.push(value);
    }
  }

  return attachments;
}

function extractTextFromPost(content: unknown): string {
  if (!content || typeof content !== 'object') return '';

  const outer = content as Record<string, unknown>;
  const langContent = outer.zh_cn ?? outer.en_us ?? outer.ja_jp;
  const resolved = langContent ?? content;

  const record = resolved as { content?: unknown; title?: unknown };
  const parts: string[] = [];
  const root = record.content;
  if (!root) return '';
  const stack: unknown[] = [root];
  const visited = new Set<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current as object)) continue;
    visited.add(current as object);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    const node = current as Record<string, unknown>;
    const tag = getString(node.tag);
    if ((tag === 'text' || tag === 'a') && typeof node.text === 'string') {
      parts.push(node.text);
    }

    for (const value of Object.values(node)) {
      stack.push(value);
    }
  }

  return parts.join(' ');
}

const POST_WITH_TEXT_AND_IMAGE = {
  zh_cn: {
    title: '记得打开持久化',
    content: [
      [
        { tag: 'text', text: '记得打开持久化' },
        { tag: 'img', image_key: 'img_v3_02l6_abc123' },
      ],
    ],
  },
};

const POST_TEXT_ONLY = {
  zh_cn: {
    title: '',
    content: [
      [
        { tag: 'text', text: '这是纯文字消息' },
        { tag: 'a', text: '点这里', href: 'https://example.com' },
      ],
    ],
  },
};

const POST_IMAGE_ONLY = {
  zh_cn: {
    title: '',
    content: [
      [
        { tag: 'img', image_key: 'img_v3_02l6_imageonly' },
      ],
    ],
  },
};

const POST_MULTI_PARAGRAPH = {
  zh_cn: {
    title: '',
    content: [
      [{ tag: 'text', text: '第一段' }],
      [{ tag: 'text', text: '第二段' }, { tag: 'img', image_key: 'img_v3_02l6_multi' }],
      [{ tag: 'text', text: '第三段' }],
    ],
  },
};

describe('extractTextFromPost', () => {
  it('从含图片的 post 消息中提取文字', () => {
    const text = extractTextFromPost(POST_WITH_TEXT_AND_IMAGE);
    expect(text).toBe('记得打开持久化');
  });

  it('从纯文字+链接 post 消息中提取文字', () => {
    const text = extractTextFromPost(POST_TEXT_ONLY);
    expect(text).toContain('这是纯文字消息');
    expect(text).toContain('点这里');
  });

  it('纯图片 post 消息返回空字符串', () => {
    const text = extractTextFromPost(POST_IMAGE_ONLY);
    expect(text).toBe('');
  });

  it('多段落 post 消息提取所有文字', () => {
    const text = extractTextFromPost(POST_MULTI_PARAGRAPH);
    expect(text).toContain('第一段');
    expect(text).toContain('第二段');
    expect(text).toContain('第三段');
  });

  it('旧格式（无 zh_cn 层）兼容', () => {
    const oldFormat = {
      content: [[{ tag: 'text', text: '旧格式文字' }]],
    };
    const text = extractTextFromPost(oldFormat);
    expect(text).toBe('旧格式文字');
  });

  it('空内容返回空字符串', () => {
    expect(extractTextFromPost(null)).toBe('');
    expect(extractTextFromPost({})).toBe('');
    expect(extractTextFromPost({ zh_cn: {} })).toBe('');
  });
});

describe('collectAttachmentsFromContent (post 消息)', () => {
  it('从含图片的 post 消息中提取图片附件', () => {
    const attachments = collectAttachmentsFromContent(POST_WITH_TEXT_AND_IMAGE);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].type).toBe('image');
    expect(attachments[0].fileKey).toBe('img_v3_02l6_abc123');
  });

  it('纯图片 post 消息提取图片附件', () => {
    const attachments = collectAttachmentsFromContent(POST_IMAGE_ONLY);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].fileKey).toBe('img_v3_02l6_imageonly');
  });

  it('多段落含一张图片只提取一个附件', () => {
    const attachments = collectAttachmentsFromContent(POST_MULTI_PARAGRAPH);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].fileKey).toBe('img_v3_02l6_multi');
  });

  it('纯文字 post 消息无附件', () => {
    const attachments = collectAttachmentsFromContent(POST_TEXT_ONLY);
    expect(attachments).toHaveLength(0);
  });

  it('空内容返回空数组', () => {
    expect(collectAttachmentsFromContent(null)).toHaveLength(0);
    expect(collectAttachmentsFromContent({})).toHaveLength(0);
  });
});
