#!/usr/bin/env node
/**
 * 飞书 OAuth 用户授权回调服务
 * 用法: node scripts/feishu_oauth.js
 * 功能: 启动本地回调服务 → 打开浏览器授权 → 获取 user_access_token + refresh_token
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// 从 .env 读取配置
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
});

const APP_ID = env.FEISHU_APP_ID;
const APP_SECRET = env.FEISHU_APP_SECRET;
const REDIRECT_URI = 'http://localhost:3000/callback';
const PORT = 3000;

// 需要授权的 scope（使用官方文档确认的正确名称，offline_access 需后台开通暂不使用）
const SCOPES = [
  'auth:user.id:read',
  'calendar:calendar',
  'calendar:calendar:readonly',
  'bitable:app',
  'docx:document',
  'docx:document:readonly',
  'wiki:wiki',
  'wiki:wiki:readonly',
  'wiki:node:read',
  'task:task',
  'task:task:readonly',
  'drive:drive',
  'drive:drive:readonly',
  'im:chat',
  'im:chat:readonly',
  'im:message',
  'im:message:readonly',
].join(' ');

if (!APP_ID || !APP_SECRET) {
  console.error('Error: FEISHU_APP_ID or FEISHU_APP_SECRET not found in .env');
  process.exit(1);
}

// 生成授权 URL
function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state: Math.random().toString(36).substring(7),
  });
  return `https://passport.feishu.cn/suite/passport/oauth/authorize?${params}`;
}

// 用 code 换 token
function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'authorization_code',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    });

    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/authen/v2/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 用 refresh_token 刷新 access_token
function refreshToken(refreshTok) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'refresh_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      refresh_token: refreshTok,
    });

    const req = https.request({
      hostname: 'open.feishu.cn',
      path: '/open-apis/authen/v2/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 保存 token
function saveToken(tokenData) {
  const tokenPath = path.join(__dirname, '..', 'feishu_uat.json');
  const token = {
    user_access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    token_type: tokenData.token_type,
    scope: tokenData.scope,
    obtained_at: new Date().toISOString(),
  };
  fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2));
  console.log('\n✅ Token 已保存到:', tokenPath);
  console.log('   user_access_token:', token.user_access_token.substring(0, 20) + '...');
  console.log('   expires_in:', token.expires_in, 'seconds');
  console.log('   scope:', token.scope);
  return token;
}

// 启动 HTTP 服务
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>❌ 授权失败</h1><p>错误: ${error}</p><p>${url.searchParams.get('error_description') || ''}</p>`);
      console.error('授权失败:', error);
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>❌ 缺少授权码</h1>');
      return;
    }

    console.log('\n📨 收到授权码，正在换取 token...');

    try {
      const result = await exchangeCode(code);
      if (result.code === 0 || result.access_token) {
        const token = saveToken(result.data || result);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <h1>✅ 授权成功！</h1>
          <p>user_access_token 已保存</p>
          <p>权限范围: ${token.scope || '已授权'}</p>
          <p>可以关闭此页面了</p>
          <script>setTimeout(() => window.close(), 3000)</script>
        `);

        console.log('\n🎉 授权完成！现在可以使用日历等用户级 API 了');
        console.log('   重启 bridge 后生效');
        server.close();
        process.exit(0);
      } else {
        throw new Error(JSON.stringify(result));
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>❌ 换取 Token 失败</h1><pre>${e.message}</pre>`);
      console.error('换取 token 失败:', e.message);
    }
  } else if (url.pathname === '/refresh') {
    // 刷新 token 端点
    const tokenPath = path.join(__dirname, '..', 'feishu_uat.json');
    if (!fs.existsSync(tokenPath)) {
      res.writeHead(404);
      res.end('No token file found');
      return;
    }
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    try {
      const result = await refreshToken(token.refresh_token);
      if (result.code === 0 || result.access_token) {
        saveToken(result.data || result);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>✅ Token 已刷新</h1>');
        console.log('Token 已刷新');
      } else {
        throw new Error(JSON.stringify(result));
      }
    } catch(e) {
      res.writeHead(500);
      res.end('Refresh failed: ' + e.message);
    }
  } else {
    // 首页：显示授权链接
    const authUrl = getAuthUrl();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <h1>飞书用户授权</h1>
      <p>点击下方链接完成授权：</p>
      <p><a href="${authUrl}" target="_blank">${authUrl}</a></p>
      <p>或访问: <a href="/auth">/auth</a></p>
    `);
  }

  if (url.pathname === '/auth') {
    const authUrl = getAuthUrl();
    res.writeHead(302, { 'Location': authUrl });
    res.end();
  }
});

server.listen(PORT, () => {
  const authUrl = getAuthUrl();
  console.log(`\n🔗 飞书 OAuth 授权服务启动`);
  console.log(`   回调地址: http://localhost:${PORT}/callback`);
  console.log(`\n请在浏览器中打开以下链接完成授权：`);
  console.log(`\n${authUrl}\n`);

  // 尝试自动打开浏览器
  const opener = process.platform === 'darwin' ? 'open' :
                 process.platform === 'linux' ? 'xdg-open' : 'start';
  require('child_process').exec(`${opener} "${authUrl}"`, (err) => {
    if (err) console.log('(无法自动打开浏览器，请手动复制上面的链接)');
  });
});
