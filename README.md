# 导航页 Daohang

一个简洁的个人导航页，支持云同步、AI 助理、多便笺等功能。

**[在线演示](https://daohang.diaoyudao110.workers.dev)**

## 功能特性

- 📌 书签管理：分类、置顶、拖拽排序、右键菜单
- ☁️ 云同步：基于 Cloudflare Workers + KV，多设备数据同步
- 🔑 账户系统：注册/登录，一次性邀请码机制
- 🤖 AI 助理：自动填写书签描述、批量补全，支持 OpenAI / Claude / Gemini 等
- 📝 多便笺：支持多个便笺，云端同步
- 🎨 主题：亮/暗模式、自定义强调色、背景图
- 🔖 书签导入：支持导入浏览器书签 HTML 文件
- 🔍 多引擎搜索：Google / Bing / 百度 / B站 / GitHub

## 部署步骤

### 前置条件

- [Cloudflare 账户](https://dash.cloudflare.com)
- Node.js 18+
- `npm install -g wrangler`

### 1. 克隆仓库

```bash
git clone https://github.com/diaoyudao100/daohang.git
cd daohang
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 KV 命名空间

```bash
wrangler kv namespace create NAV_KV
```

将输出的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "NAV_KV"
id = "你的KV命名空间ID"
```

### 4. 设置管理员用户名

```bash
echo '你的用户名' | wrangler secret put ADMIN_USER
```

### 5. 部署

```bash
wrangler deploy
```

### 6. 创建初始邀请码

```bash
wrangler kv key put --binding=NAV_KV 'invite:ADMIN001' '1' --remote
```

然后访问你的 Worker 地址，用邀请码 `ADMIN001` 注册管理员账户。

## GitHub Actions 自动部署

在仓库 Settings → Secrets 中添加：

- `CLOUDFLARE_API_TOKEN`：Cloudflare API Token（需要 Workers 编辑权限）
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账户 ID

之后每次 push 到 `main` 分支会自动部署。

## AI 助理配置

在页面设置 → 🤖 AI助理 中填写：

- **Base URL**：如 `https://api.openai.com/v1`
- **API Key**：你的 API Key（仅存储在本地浏览器，不上传服务器）
- 点击**拉取模型**选择模型
- 点击**测试连接**验证配置

支持所有兼容 OpenAI 格式的 API，以及 Claude 原生 API。

## 技术栈

- 前端：纯 HTML/CSS/JS 单文件，无构建工具
- 后端：Cloudflare Workers
- 存储：Cloudflare KV
- 部署：GitHub Actions + wrangler-action
