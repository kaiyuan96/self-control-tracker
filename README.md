<div align="center">

# 自律打卡 · Self-Control Tracker

**一款隐私优先的自律 / 连续打卡追踪器**
记录破戒 · 分析诱因 · 制定预案 · AI 教练周报 · 跨设备同步

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-f7df1e)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Offline First](https://img.shields.io/badge/offline-first-blue)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4)

简体中文 | [English](./README_EN.md)

</div>

---

**自律打卡**是一个零依赖的单页 Web 应用，帮助你戒除想要摆脱的习惯（如色情、过度自慰等），
通过「记录 → 洞察 → 预案 → 复盘」的完整循环重建自控力。适合 NoFap 式连续打卡、
多巴胺排毒（dopamine detox）、习惯戒断等任何需要坚持与复盘的场景。

> 无需注册 · 无需登录 · 数据完全由你掌控

## ✨ 功能特性

### 核心记录
- ⏱️ **实时打卡计时器** —— 已坚持天数精确到秒，随时看到自己的进度
- ⚠️ **破戒记录** —— 时间（支持补记过去任意时间）/ 诱因标签 / 严重程度 / 备注，全部可编辑可删除
- 📝 **心情日记** —— 精确到分钟的心情与经历记录，帮助捕捉情绪波动

### 数据洞察
- 📊 **统计图表** —— 本周/本月次数环比、最长连续纪录、近 12 周 & 近 6 月趋势柱状图
- 🎯 **诱因分析** —— 高频诱因 Top 排行、凌晨/上午/下午/晚上时段分布
- 🤖 **AI 教练周报**（可选）—— 接入 DeepSeek，每周自动生成个性化分析：结合破戒明细、日记情绪线索与时间先后关系，给出针对性建议

### 行为改变工具
- 🛡️ **If-Then 预案卡** —— 基于执行意图（Implementation Intentions）研究："如果出现某情境，我就执行某动作"，提前决策代替临场硬扛；支持 AI 根据你的高危时段与高频诱因一键生成候选预案
- 🔄 **破戒复盘闭环** —— 每次破戒后回顾预案执行情况，数据回流让预案越用越准

### 同步与隐私
- ☁️ **跨设备云同步**（可选）—— 访问码认证，无需注册账号；手机电脑共享同一份数据
- 🔒 **隐私优先** —— 不采集任何数据；纯离线模式下数据只存在你的浏览器里
- 💾 **数据自主** —— 一键导出/导入 JSON 备份，随时带走

## 🧠 设计理念

本应用的功能设计参考了行为科学中的循证方法：

| 功能 | 依据 |
|------|------|
| 打卡计时与破戒记录 | 自我监控（Self-Monitoring）：单纯记录行为即可改变行为 |
| If-Then 预案卡 | 执行意图（Gollwitzer & Sheeran 元分析，d≈0.65） |
| 预案复盘迭代 | 复发预防（Relapse Prevention）中的情境-应对训练 |
| AI 教练不说教不评判 | 羞耻感会放大复发循环，自我关怀更有效 |

## 🚀 快速开始

```bash
git clone https://github.com/kaiyuan96/self-control-tracker.git
cd self-control-tracker
node server.js
# 浏览器打开 http://localhost:8765
```

或者直接双击 `index.html` 使用纯离线模式（云同步功能不可用，其余全部可用）。

无任何构建步骤，无 npm install —— 整个项目就是 3 个静态文件加 2 个轻量 API。

## ☁️ 启用云同步（可选）

1. 打开应用 **设置** 页 → **云端同步** → 「生成新访问码」（8 位，形如 `K7D2-9F4M`）
2. 在其他设备打开同一地址，输入访问码连接
3. 此后所有变更自动同步

同步架构：静态前端 + `/api/sync` 服务端接口 + SQLite 存储。
访问码即数据钥匙，请妥善保管。

## 🤖 配置 AI 教练周报（可选）

AI 周报需要一个 DeepSeek API Key（[platform.deepseek.com](https://platform.deepseek.com) 获取，费用极低）：

1. 将 Key 配置为运行环境的密钥变量 `DEEPSEEK_API_KEY`
2. 部署 `ai-report/` 目录下的定时任务（默认每周一早上自动分析上一周并写入数据库）
3. 用户在应用内点击「让 AI 重新分析」可即时生成

不配置也完全不影响其他功能。

## 🔧 部署自己的实例

前端为纯静态文件，可部署到任何托管服务；服务端接口位于 `functions/api/`，
采用标准 Request/Response 格式，可在主流边缘/Serverless 平台（Vercel、Netlify、Cloudflare Pages 等）
少量适配后使用。定时分析任务见 `ai-report/`。

## 📁 项目结构

```
self-control-tracker/
├── index.html              # 页面结构
├── styles.css              # 深色主题样式
├── app.js                  # 应用逻辑（数据 / 统计 / 图表 / 同步）
├── server.js               # 本地静态服务器（可选）
├── functions/api/
│   ├── sync.js             # 云端同步 API（合并冲突处理）
│   ├── generate-report.js  # AI 周报手动生成（代理）
│   └── suggest-plan.js     # AI 预案推荐（代理）
├── ai-report/
│   └── worker.js           # 定时 AI 分析任务（Cron）
└── LICENSE
```

## 🔒 隐私说明

- 页面本身**不采集任何数据**，本地模式数据仅存于浏览器 localStorage
- 启用云同步后，数据上传至你部署的数据库，仅凭访问码可读写
- AI 周报开启时，相关内容会发送给你配置的模型服务商用于生成分析
- 请妥善保管云端备份文件，其中包含你的隐私记录

## 🤝 参与贡献

欢迎 Issue 与 PR！提交前请运行应用确认核心流程（记录 → 统计 → 同步）不受影响。

## 📄 License

[MIT](./LICENSE)
