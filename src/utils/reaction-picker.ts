/**
 * 根据回复状态和内容选择合适的飞书 reaction 表情
 *
 * 飞书官方 emoji_type 参考：
 * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce
 *
 * 常用：DONE(完成)、BULL(牛)、LGTM、THUMBSUP、CLAP、HEART、SMILE、YouAreTheBest、
 * JIAYI(加一)、FIRE、Trophy、CheckMark、AWESOME、PARTY 等
 */

export type ReactionStatus = 'completed' | 'failed';

/**
 * 根据状态和回复文本内容，选择最合适的 reaction emoji_type
 */
export function pickCompletionReaction(status: ReactionStatus, text: string): string {
  const t = (text || '').toLowerCase().trim();
  const isFailed = status === 'failed';

  if (isFailed) {
    // 失败场景：安慰类
    return 'COMFORT'; // 抱抱/安慰
  }

  // 成功完成：根据内容语义选择
  if (/^(好的|收到|明白|了解|ok|yes|知道了)/i.test(t) || t.length < 20) {
    return 'THUMBSUP'; // 简短确认
  }
  if (/完成|搞定|done|finished|完成[了]?$/i.test(t)) {
    return 'DONE'; // 完成
  }
  if (/厉害|牛|牛逼|强|优秀|棒|赞|nice|great|awesome/i.test(t)) {
    return 'BULL'; // 牛
  }
  if (/代码|编程|script|function|实现|开发/i.test(t)) {
    return 'LGTM'; // 代码相关
  }
  if (/分析|报告|总结|汇总|统计/i.test(t)) {
    return 'CheckMark'; // 分析/核对
  }
  if (/谢谢|感谢|thx|thanks/i.test(t)) {
    return 'HEART'; // 感谢
  }
  if (/可爱|萌|喵|哈哈|嘿嘿/i.test(t)) {
    return 'MeMeMe'; // 可爱/卖萌（类似喵喵妙）
  }
  if (/创意|想法|建议|灵感/i.test(t)) {
    return 'FIRE'; // 创意/火热
  }
  if (/庆祝|🎉|恭喜|喜/i.test(t)) {
    return 'PARTY'; // 庆祝
  }
  if (/加油|努力|冲|go/i.test(t)) {
    return 'JIAYI'; // 加一/加油
  }
  if (/正确|对|没错|是的/i.test(t)) {
    return 'CheckMark'; // 正确
  }
  if (/错误|bug|问题|失败|报错/i.test(t) && !isFailed) {
    return 'THINKING'; // 讨论问题
  }

  // 默认：完成/认可
  return 'DONE';
}
