#!/usr/bin/env node
/**
 * feishu-comment —— 给飞书文档加/读全文评论的 CLI 工具
 *
 * 复用官方 SDK(@larksuiteoapi/node-sdk)+ .env 里的 app 凭证,
 * tenant_access_token 由 SDK 自动缓存,无需手动换取。
 *
 * 用法:
 *   node scripts/feishu-comment.mjs add  <file_token> <file_type> <评论内容>
 *   node scripts/feishu-comment.mjs list <file_token> <file_type>
 *
 * file_type: docx | doc（全文评论仅支持文档类型,飞书 API 限制）
 * 例:
 *   node scripts/feishu-comment.mjs add ABCdocxToken docx "这段结论需要补数据来源"
 *   node scripts/feishu-comment.mjs list ABCdocxToken docx
 */
import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

if (!appId || !appSecret) {
  console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET(检查 .env)');
  process.exit(1);
}

// SDK 默认会把 4xx 业务错误当 error 打整坨 axios 对象到 stderr(纯噪音);
// loggerLevel 在此版本不生效,直接传 no-op logger 彻底静音。
// 业务 code/msg 已在 reportError 里提取,不丢信息。
const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const client = new lark.Client({
  appId,
  appSecret,
  disableTokenCache: false,
  logger: silentLogger,
});

function usage() {
  console.error('用法:');
  console.error('  node scripts/feishu-comment.mjs add  <file_token> <file_type> <评论内容>');
  console.error('  node scripts/feishu-comment.mjs list <file_token> <file_type>');
  console.error('  file_type: docx | doc（全文评论仅支持文档类型）');
  process.exit(1);
}

// SDK 对 4xx/业务错误会 throw(AxiosError),统一在此提取飞书 code/msg。
function reportError(action, err) {
  const biz = err?.response?.data;
  if (biz?.code) {
    console.error(`${action}失败: code=${biz.code} msg=${biz.msg} log_id=${biz.log_id ?? '-'}`);
  } else {
    console.error(`${action}失败: ${err?.message ?? err}`);
  }
  process.exit(1);
}

async function add(fileToken, fileType, text) {
  let res;
  try {
    res = await client.drive.v1.fileComment.create({
      path: { file_token: fileToken },
      params: { file_type: fileType },
      data: {
        reply_list: {
          replies: [{ content: { elements: [{ type: 'text_run', text_run: { text } }] } }],
        },
      },
    });
  } catch (err) {
    reportError('加评论', err);
  }
  console.log(`✅ 已加评论 comment_id=${res.data?.comment_id}`);
}

async function list(fileToken, fileType) {
  let res;
  try {
    res = await client.drive.v1.fileComment.list({
      path: { file_token: fileToken },
      params: { file_type: fileType, page_size: 50 },
    });
  } catch (err) {
    reportError('读评论', err);
  }
  const items = res.data?.items ?? [];
  if (items.length === 0) {
    console.log('(无评论)');
    return;
  }
  for (const c of items) {
    const replies = c.reply_list?.replies ?? [];
    const txt = replies
      .flatMap((r) => (r.content?.elements ?? []).map((e) => e.text_run?.text ?? ''))
      .join('');
    const flag = c.is_solved ? '[已解决]' : '';
    console.log(`- ${c.comment_id} ${flag} ${txt}`);
  }
}

const [cmd, fileToken, fileType, ...rest] = process.argv.slice(2);

if (!cmd || !fileToken || !fileType) usage();

if (cmd === 'add') {
  const text = rest.join(' ').trim();
  if (!text) usage();
  await add(fileToken, fileType, text);
} else if (cmd === 'list') {
  await list(fileToken, fileType);
} else {
  usage();
}
