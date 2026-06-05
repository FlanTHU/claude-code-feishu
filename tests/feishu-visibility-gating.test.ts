import { afterEach, describe, expect, it, vi } from 'vitest';

const envKeys = [
  'FEISHU_SHOW_THINKING_CHAIN',
  'FEISHU_SHOW_TOOL_CHAIN',
  'SHOW_THINKING_CHAIN',
  'SHOW_TOOL_CHAIN',
];

const backup = new Map<string, string | undefined>();

const restoreEnv = (): void => {
  for (const key of envKeys) {
    const value = backup.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const snapshotEnv = (): void => {
  for (const key of envKeys) {
    backup.set(key, process.env[key]);
  }
};

const loadCardsModule = async () => {
  vi.resetModules();
  return await import('../src/feishu/cards-stream.js');
};

describe('Feishu visibility gating', () => {
  afterEach(() => {
    restoreEnv();
    backup.clear();
  });

  it('默认情况下应显示思考链和工具链', async () => {
    snapshotEnv();
    delete process.env.FEISHU_SHOW_THINKING_CHAIN;
    delete process.env.FEISHU_SHOW_TOOL_CHAIN;

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: '这是思考过程',
      text: '这是最终答案',
      tools: [{ name: 'Read', status: 'completed', output: '文件内容' }],
      status: 'completed',
    }) as { body: { elements: unknown[] } };

    expect(card.body.elements).toBeDefined();
    const elements = card.body.elements as object[];
    expect(elements.length).toBeGreaterThan(0);
  });

  it('chatType=group 时应强制隐藏思考链（群聊不显示思考过程）', async () => {
    snapshotEnv();
    process.env.FEISHU_SHOW_THINKING_CHAIN = 'true'; // env 开启，但群聊应强制隐藏
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'true';

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: 'The user is asking about...',
      text: '苏炳添，中国短跑名将',
      tools: [],
      status: 'completed',
      chatType: 'group',
    }) as { body: { elements: unknown[] } };

    const elements = card.body.elements as object[];
    const hasThinkingPanel = elements.some((el: object) => {
      const record = el as Record<string, unknown>;
      return record.tag === 'collapsible_panel' && JSON.stringify(record).includes('思考过程');
    });
    expect(hasThinkingPanel).toBe(false);
  });

  it('chatType=group 且 segments 含 reasoning 时应隐藏思考段', async () => {
    snapshotEnv();
    process.env.FEISHU_SHOW_THINKING_CHAIN = 'true';
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'true';

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: '',
      text: '回答内容',
      tools: [],
      segments: [
        { type: 'reasoning', text: 'The user is asking...' },
        { type: 'text', text: '回答内容' },
      ],
      status: 'completed',
      chatType: 'group',
    }) as { body: { elements: unknown[] } };

    const elements = card.body.elements as object[];
    const hasReasoningPanel = elements.some((el: object) => {
      const record = el as Record<string, unknown>;
      return record.tag === 'collapsible_panel' && JSON.stringify(record).includes('思考过程');
    });
    expect(hasReasoningPanel).toBe(false);
  });

  it('FEISHU_SHOW_THINKING_CHAIN=false 时应隐藏思考链', async () => {
    snapshotEnv();
    process.env.FEISHU_SHOW_THINKING_CHAIN = 'false';
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'true';

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: '这是思考过程',
      text: '这是最终答案',
      tools: [],
      status: 'completed',
    }) as { body: { elements: unknown[] } };

    const elements = card.body.elements as object[];
    const hasThinkingPanel = elements.some((el: object) => {
      const record = el as Record<string, unknown>;
      return record.tag === 'collapsible_panel' && 
        JSON.stringify(record).includes('思考过程');
    });
    
    expect(hasThinkingPanel).toBe(false);
  });

  it('FEISHU_SHOW_TOOL_CHAIN=false 时应隐藏工具链', async () => {
    snapshotEnv();
    process.env.FEISHU_SHOW_THINKING_CHAIN = 'true';
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'false';

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: '',
      text: '这是最终答案',
      tools: [{ name: 'Read', status: 'completed', output: '文件内容' }],
      status: 'completed',
    }) as { body: { elements: unknown[] } };

    const elements = card.body.elements as object[];
    const hasToolContent = elements.some((el: object) => {
      const record = el as Record<string, unknown>;
      const content = JSON.stringify(record);
      return content.includes('Read') || content.includes('工具');
    });
    
    expect(hasToolContent).toBe(false);
  });

  it('两个开关都为 false 时 final answer 仍然可见', async () => {
    snapshotEnv();
    process.env.FEISHU_SHOW_THINKING_CHAIN = 'false';
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'false';

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: '这是思考过程',
      text: '这是最终答案',
      tools: [{ name: 'Read', status: 'completed', output: '文件内容' }],
      status: 'completed',
    }) as { body: { elements: unknown[] } };

    const elements = card.body.elements as object[];
    const hasFinalAnswer = elements.some((el: object) => {
      const record = el as Record<string, unknown>;
      const content = JSON.stringify(record);
      return content.includes('这是最终答案');
    });
    
    expect(hasFinalAnswer).toBe(true);
  });

  it('segments 模式下 FEISHU_SHOW_THINKING_CHAIN=false 应隐藏 reasoning segment', async () => {
    snapshotEnv();
    process.env.FEISHU_SHOW_THINKING_CHAIN = 'false';
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'true';

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: '',
      text: '这是最终答案',
      segments: [
        { type: 'reasoning', text: '这是思考过程' },
        { type: 'text', text: '这是正文内容' },
      ],
      tools: [],
      status: 'completed',
    }) as { body: { elements: unknown[] } };

    const elements = card.body.elements as object[];
    const hasReasoningPanel = elements.some((el: object) => {
      const record = el as Record<string, unknown>;
      return record.tag === 'collapsible_panel' && 
        JSON.stringify(record).includes('思考过程');
    });
    
    expect(hasReasoningPanel).toBe(false);
  });

  it('segments 模式下 FEISHU_SHOW_TOOL_CHAIN=false 应隐藏 tool segment', async () => {
    snapshotEnv();
    process.env.FEISHU_SHOW_THINKING_CHAIN = 'true';
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'false';

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: '',
      text: '这是最终答案',
      segments: [
        { type: 'tool', name: 'Read', status: 'completed', output: '文件内容' },
        { type: 'text', text: '这是正文内容' },
      ],
      tools: [],
      status: 'completed',
    }) as { body: { elements: unknown[] } };

    const elements = card.body.elements as object[];
    const hasToolPanel = elements.some((el: object) => {
      const record = el as Record<string, unknown>;
      return record.tag === 'collapsible_panel' && 
        JSON.stringify(record).includes('Read');
    });
    
    expect(hasToolPanel).toBe(false);
  });

  it('两个开关都为 false 时 segments 模式仍保留 text segment', async () => {
    snapshotEnv();
    process.env.FEISHU_SHOW_THINKING_CHAIN = 'false';
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'false';

    const { buildStreamCard } = await loadCardsModule();
    const card = buildStreamCard({
      thinking: '',
      text: '',
      segments: [
        { type: 'reasoning', text: '这是思考过程' },
        { type: 'tool', name: 'Read', status: 'completed', output: '输出' },
        { type: 'text', text: '这是正文内容' },
      ],
      tools: [],
      status: 'completed',
    }) as { body: { elements: unknown[] } };

    const elements = card.body.elements as object[];
    const hasTextContent = elements.some((el: object) => {
      const record = el as Record<string, unknown>;
      const content = JSON.stringify(record);
      return content.includes('这是正文内容');
    });
    
    expect(hasTextContent).toBe(true);
  });
});

describe('buildStreamCards currentModel', () => {
  afterEach(() => {
    restoreEnv();
    backup.clear();
  });

  it('有 currentModel 时 header 应展示模型名', async () => {
    snapshotEnv();
    delete process.env.FEISHU_SHOW_THINKING_CHAIN;
    delete process.env.FEISHU_SHOW_TOOL_CHAIN;

    const { buildStreamCards } = await loadCardsModule();
    const cards = buildStreamCards({
      thinking: '',
      text: '回答内容',
      tools: [],
      status: 'completed',
      currentModel: 'gpt-4o',
    }) as { header: { title: { content: string } } }[];

    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].header.title.content).toContain('已完成');
    expect(cards[0].header.title.content).toContain(' · 模型: gpt-4o');
  });

  it('无 currentModel 时 header 不应包含模型信息', async () => {
    snapshotEnv();
    delete process.env.FEISHU_SHOW_THINKING_CHAIN;
    delete process.env.FEISHU_SHOW_TOOL_CHAIN;

    const { buildStreamCards } = await loadCardsModule();
    const cards = buildStreamCards({
      thinking: '',
      text: '回答内容',
      tools: [],
      status: 'completed',
    }) as { header: { title: { content: string } } }[];

    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].header.title.content).toContain('已完成');
    expect(cards[0].header.title.content).not.toContain(' · 模型:');
  });

  it('应去重单 segment 内重复段落，防止恶性循环刷屏', async () => {
    snapshotEnv();
    delete process.env.FEISHU_SHOW_THINKING_CHAIN;
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'true';

    const para1 = '让我检查一下 current.thinking 的值。从日志来看，消息已经被处理了，但没有看到 current.thinking 的值。';
    const para2 = '让我修改调试日志，输出更多信息。';
    const para3 = '实际上，从截图来看，thinking 内容被显示了。这说明 current.thinking 不为空。';
    const repeatedInSegment = [para1, para2, para3, para1, para2, para3, para1, para2, para3].join('\n\n');

    const { buildStreamCards } = await loadCardsModule();
    const cards = buildStreamCards({
      thinking: '',
      text: '回答',
      tools: [],
      segments: [{ type: 'reasoning', text: repeatedInSegment }, { type: 'text', text: '回答' }],
      status: 'completed',
    }) as { body: { elements: unknown[] } }[];

    const elements = cards[0].body.elements as object[];
    const reasoningPanel = elements.find(
      (el: object) =>
        (el as Record<string, unknown>).tag === 'collapsible_panel' &&
        JSON.stringify(el).includes('思考过程')
    );
    expect(reasoningPanel).toBeDefined();
    const content = JSON.stringify(reasoningPanel);
    expect(content).toContain(para1);
    expect(content).toContain(para2);
    expect(content).toContain(para3);
    // 每段只应出现一次，不应重复 3 次（恶性循环刷屏修复）
    const countPara1 = (content.match(/让我检查一下 current\.thinking 的值/g) ?? []).length;
    expect(countPara1).toBe(1);
  });

  it('应去重重复的 reasoning 段，防止恶性重复展示', async () => {
    snapshotEnv();
    delete process.env.FEISHU_SHOW_THINKING_CHAIN;
    process.env.FEISHU_SHOW_TOOL_CHAIN = 'true';

    const { buildStreamCards } = await loadCardsModule();
    const repeatedReasoning = '让我检查一下 isGroupChatSession 函数的返回值...';
    const cards = buildStreamCards({
      thinking: '',
      text: '回答',
      tools: [],
      segments: [
        { type: 'reasoning', text: repeatedReasoning },
        { type: 'reasoning', text: repeatedReasoning },
        { type: 'reasoning', text: repeatedReasoning },
        { type: 'text', text: '回答' },
      ],
      status: 'completed',
    }) as { body: { elements: unknown[] } }[];

    const elements = cards[0].body.elements as object[];
    const reasoningPanels = elements.filter(
      (el: object) =>
        (el as Record<string, unknown>).tag === 'collapsible_panel' &&
        JSON.stringify(el).includes('思考过程')
    );
    expect(reasoningPanels.length).toBe(1);
  });

  it('processing 状态时 currentModel 也应展示', async () => {
    snapshotEnv();
    delete process.env.FEISHU_SHOW_THINKING_CHAIN;
    delete process.env.FEISHU_SHOW_TOOL_CHAIN;

    const { buildStreamCards } = await loadCardsModule();
    const cards = buildStreamCards({
      thinking: '',
      text: '',
      tools: [],
      status: 'processing',
      currentModel: 'claude-3-5-sonnet',
    }) as { header: { title: { content: string } } }[];

    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0].header.title.content).toContain('处理中');
    expect(cards[0].header.title.content).toContain(' · 模型: claude-3-5-sonnet');
  });
});
