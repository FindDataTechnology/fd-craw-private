# 垂直样板包（Vertical Packs）演示手册

四个面向客户演示的行业包：**法律-合同、法律-案件、数据-股票、数据-中国经济**。每个包 = 1 个入口技能 + 1~2 个 MCP server + 1 个对话 agent + 1 个可见角色。客户装 2~3 个条目即得到完整行业助手；入口技能按需点名调用其他 registry 技能（未装则优雅降级，不阻塞）。

技能源码在本仓库 `docs/vertical-packs/skills/`（authoring source of truth），注册进 registry 后由客户通过 Store 安装。

---

## 1. 包构成总表

| | 法律-合同 | 法律-案件 | 数据-股票 | 数据-中国经济 |
|---|---|---|---|---|
| 入口技能 | `legal-contract-workflow` | `legal-case-workflow` | `stock-research-workflow` | `china-macro-brief-workflow` |
| MCP | `law-bench` | `fd-find-data-business-mcp`（法条检索）+ `law-bench` | `fd-open-data-mcp` + `fd-cn-report` | `fd-open-data-mcp` + `fd-cn-report` |
| Agent | 合同审查官 | 案件分析师 | 行业分析师 | 行业分析师 |
| 角色 | `legal` | `legal` | `analysts` | `analysts` |
| 引用的既有技能 | `contract-review`、`contract-copilot` | `preliminary-legal-analysis`、`statute-case-retrieval`、`case-discussion-outline`、`litigation-visualization` | `akshare-stock`、`stock-analysis`、`financial-statement-analysis`、`earnings-preview`/`earnings-recap`、`dcf-model`、`comps-analysis`、`company-valuation`、`sector-overview` | `sector-overview`、`statsmodels`、`statistical-analysis` |
| 硬约束 | 不编造法条号/条款库结果 | 不编造案号/裁判结果 | 不编造财务数据/评级 | 数值必须可溯源 |

`airegistry-tools`（registry 管理工具）与 `fd-daas-mcp`（工作流/看板组，161 工具）不进演示包。

## 2. 演示动线（每包约 5 分钟）

1. 用带对应角色的账号登录 fd-prod → 左侧 Store。
2. **连接 MCP 市场**（见 §4 凭据；registry-sso-credentials 上线前为 V0：粘贴预签 token）。
3. 安装包的 MCP（勾选后无需再填 token）→ 安装入口技能（技能热加载，即装即用）。
4. 进入 Chat，选择包的 agent（合同审查官/案件分析师/行业分析师）。
5. 粘贴 §5 的演示输入 → 全流程跑完。
6. 收尾亮点：打开 Trace 页，指出法条/数据来自真实 MCP 调用（`mcp__<server>__<tool>`），不是模型幻觉。

## 3. 一次性开通（新 operator 按 §3.1→§3.5 顺序执行）

### 3.1 Logto 组（平台侧）与 registry 侧组（两条组源，各管一段）

平台的组（市场可见性 + requiredGroups）和 registry 的组（网关 MCP 调用授权）是**两个 claim 源**：

- **平台侧**（✅ 已配置，2026-09-19）：`logto-auth.js` 把 Logto ID token 的 `organizations`（组织 ID 列表）+ `organization_roles` 映射为平台 groups。由于平台只请求 `urn:logto:scope:organizations`（没有 organization_roles scope），**生效的是组织 ID**。已建两个组织（Logto 管理台 → Organizations）：
  - `legal` → 组织 ID **`hpe07qejcwk7`**（法律-合同/案件包）
  - `analysts` → 组织 ID **`sl63fy08ruh9`**（数据-股票/中国经济包）
  - 演示成员：`aloadtree@gmail.com` 已加入两个组织（验证：登录后市场正确显示 law-bench/fd-*/四个入口技能，152 技能可见）。
  - `registry-groups.json` 与云端 agents.json 的组列表都**同时含可读名和组织 ID**（交集语义，命中其一即可）——将来平台补请求 `urn:logto:scope:organization_roles` 并用角色名时无需改映射。
  - 新增演示用户：Logto 管理台把用户加入对应组织即可（无需改任何配置）。
- **registry 侧**（已配置好，2026-09-19）：auth-server 已启用 `IDP_USER_GROUP_FALLBACK_ENABLED_PROVIDERS=pingfederate,logto`——Logto 全局 roles 为空的用户会从 `idp_user_groups` 集合取组。管理员可通过 API 给用户加组（无需 Logto 权限）：

  ```bash
  curl -X POST http://127.0.0.1:18080/api/iam/user-groups \
    -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
    -d '{"username":"<registry用户名>","groups":["legal"],"description":"vertical-pack demo"}'
  ```
  已建示例记录：`aloadtree → [legal, analysts]`。注意：用户若在 Logto 有全局角色（groups claim 非空），fallback 不生效——演示账号保持无全局角色即可。

### 3.2 Registry scope 授权（registry 侧）

目的：当前 registry 只有 admin scope 有 server 访问权（这是所有非 admin 调用 401 的根源）。为 `legal`/`analysts` 组建 scope 并授予 server 访问：

- `mcp-law-bench/execute` → server `law-bench`（methods/tools: all）→ groups `["legal"]`
- `mcp-data-servers/execute` → servers `fd-open-data-mcp`, `fd-cn-report`, `fd-daas-mcp` → groups `["analysts","legal"]`

操作路径：registry 管理 UI（IAM）配置；若 IAM 列表接口异常（已知问题），cheap1 上直写 Mongo（先备份）：

```bash
ssh cheap1
# 备份
docker exec mcp-mongodb sh -c 'mongodump -u admin -p "<PASS>" --authenticationDatabase admin --db mcp_registry --collection mcp_scopes_default' 
# 写入（PASS 取 /opt/mcp-gateway-registry/.env 的 DOCUMENTDB_PASSWORD）
docker exec mcp-mongodb mongosh -u admin -p "<PASS>" --authenticationDatabase admin --eval '...insert scope docs...'
```

验证：`legal` 组用户 mint 的 JWT 调 `POST https://mcp.finddatatech.cloud/fd-open-data-mcp/mcp` initialize 返回 200；无组用户 401。

### 3.3 law-bench 后端凭据（✅ 已解决，2026-09-19 spike）

spike 结论：网关 scope 校验从来不是问题；401 的根因是 **law-bench 后端有自己的 token 鉴权**（`MCP_HTTP_TOKEN`），而 registry 的 MCP 代理只从 **egress vault** 注入上游凭据，该特性默认关闭。已执行：

1. registry `.env`：`EGRESS_AUTH_ENABLED=true`（备份 `.env.bak-egress-20260919`），`docker compose up -d --no-deps registry auth-server` 重建。
2. law-bench 已配为 egress `pat` 模式（注入头从 server 的 auth_scheme=api_key 派生为 `X-API-Key`）。
3. 端到端验证：admin 账号经 `https://mcp.finddatatech.cloud/law-bench/mcp` initialize → **HTTP 200**（v3.4.7，52 工具）。

**每个演示用户仍需一次性存 PAT**（per-user vault，30 天上限）：演示账号登录 registry 后在 Connected Accounts 页提交（或 admin 代存）：

```bash
# admin 代存（绕过 safeline 直连 registry，见下方 WAF 注意项）
curl -X PUT http://127.0.0.1:18080/api/servers/law-bench/egress-pat \
  -H "Authorization: Bearer <该用户registry JWT>" -H "Content-Type: application/json" \
  -d '{"secret":"<law-bench MCP_HTTP_TOKEN>","ttl_value":30,"ttl_unit":"days"}'
# admin 代他人存: 加 "sub":"<目标sub>","auth_method":"<目标登录方式>"
```

PAT 来源：`kubectl --context cheap -n law-bench get secret law-bench-mcp -o jsonpath='{.data.MCP_HTTP_TOKEN}' | base64 -d`。

**fd-\* server 不需要此步**——它们只校验调用方 registry JWT（2026-09-19 实测 initialize 200）。

**⚠️ WAF 注意**：safeline 的路由表尚不认识 `/api/servers/*/egress-auth`、`/egress-pat` 等新路由（公开入口 404）。要么在 safeline 控制台加白名单让用户走 Connected Accounts 页自助，要么演示前由 admin 直连 cheap1 的 127.0.0.1:18080 代存（上面命令已绕过）。

### 3.4 `registry-groups.json`（fd-prod，市场可见性门控）

fd-prod 平台容器 CWD 下的 `registry-groups.json`：

```json
{
  "servers": {
    "law-bench": ["legal"],
    "fd-open-data-mcp": ["analysts"],
    "fd-cn-report": ["analysts"],
    "fd-daas-mcp": ["analysts"]
  },
  "skills": {
    "legal-contract-workflow": ["legal"],
    "legal-case-workflow": ["legal"],
    "stock-research-workflow": ["analysts"],
    "china-macro-brief-workflow": ["analysts"]
  },
  "agents": {}
}
```

（引用的既有技能暂不门控——减少演示时"看不到条目"的排障面。）应用后 rollout，验证：两种角色登录 Store 各自只见本角色包条目。

### 3.5 技能与 agent 注册（✅ 已完成，2026-09-19）

**托管**：四份 SKILL.md + agents.json 已发布到公开仓库 **`github.com/FindDataTechnology/fd-vertical-packs`**（本仓库 `docs/vertical-packs/` 仍为创作源，**改内容后需同步推送该仓库**）。选 GitHub 的依据：registry 现有 143 技能中 121 个托管于 raw.githubusercontent.com（可达性已被持续扫描证明），实测 registry 主机 0.9s 可达。

- **技能**：四个入口技能已注册（`POST /api/skills` 全部 201，enabled/active，内容端点 `/api/skills/<name>/content` 返回完整正文）。注册命令模式：

  ```bash
  curl -X POST http://127.0.0.1:18080/api/skills \
    -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
    -d '{"name":"...","description":"...","skill_md_url":"https://raw.githubusercontent.com/FindDataTechnology/fd-vertical-packs/main/skills/<name>/SKILL.md","tags":["法律","合同审查"],"status":"active"}'
  ```

- **Agent**：云端目录文档即仓库内 `agents.json`（三条 chat entry，凭证仅 `apiKeyEnv: FD_TOKEN_API_KEY`）；fd-prod 已配 `AGENTS_CONFIG_URL`（fd-infra-deploy 147ffc6）+ `FD_TOKEN_API_KEY` secret，rollout 完成，catalog 合并验证通过。

**⚠️ 模型选择（实测结论）**：agent 用 `deepseek-v4-flash-0731`。该公开网关对 `deepseek-v4-pro`/`deepseek-v4-flash` 要求 `x-opencode-session` 头（平台的 agent 调用不带此头会 400），而 `0731` 免头直通——正好也是平台自己的默认模型。**不要把 agent 模型改回 pro，除非平台侧增加该请求头。**

### 3.6 fd-find-data-business-mcp（法条检索，✅ 2026-09-19 已接入）

FindData 商业数据 MCP（zihan 机 `100.64.0.4:30803`，Tailscale 可达），9 工具：`law_search`/`law_read`（中国法律法规）、`yearbook_search_indicators`/`yearbook_read`（统计年鉴）、`read`/`read_range`/`list_concepts`/`ai_search`/`graph_search`（FindData 指标）。接入要点（复现时参考）：

- **鉴权**：该服务器只接受 Logto JWT（`FDBIZ_ISSUER=auth.finddatatech.cloud`，aud=`https://api.finddatatech.cloud/mcp`，ES384）。gateway 的 obo_exchange 不支持 Logto，走 **egress pat**：用 registry 的 M2M client（`LOGTO_M2M_CLIENT_ID/SECRET`）client_credentials 换该 audience 的 JWT，存为 per-user PAT（注册时 `auth_scheme=bearer` → 注入头 `Authorization: Bearer`，与后端校验完全匹配）。
- **PAT 续期**：Logto token 约 1h 有效。cheap1 上 `/opt/mcp-gateway-registry/refresh-fdbiz-pat.sh`（cron 每小时 :14/:44）自动换新并 PUT 到 egress-pat；依赖 `.admin-jwt` 文件（168h 有效，**每周需在 registry UI 重签并更新该文件**，与 MARKET_REGISTRY_TOKEN 同节奏）。
- **SSRF 允许清单**：`SSRF_ALLOWED_CIDRS=100.64.0.8/32,100.64.0.4/32`（zihan 已加，.env 已备份）。
- **端到端验证**：公网网关 `law_search(title_query=劳动合同)` 返回真实法规（劳动合同法/实施条例/上海条例 + 效力状态）。
- **边界**：类案（裁判文书）检索无数据源；该服务器的法规库不含司法案例。

## 4. MCP 凭据（V0 → V1）

**V0（现状，演示日执行）**：
- 每个演示账号提前 mint 一次 registry JWT（registry UI → 登录 → Get JWT Token；TTL 168h=7 天）→ 安装 registry MCP 时粘贴进 token 表单。
- **法律-合同包额外一步**：该账号存一次 law-bench PAT（§3.3 命令，30 天有效）。
- fd-\* 包（股票/中国经济）：JWT 粘贴即可，无额外凭据。
- 7 天内同账号免重复（PAT 30 天）。

**V1（`registry-sso-credentials` 落地后）**：Store 页"连接 MCP 市场"一键静默 SSO（共享 Logto 会话）→ 安装表单不再出现 token 栏。law-bench PAT 流程另行评估是否并入。

law-bench 为 `group-restricted`：客户账号 mint 的 JWT 必须含 `legal` 组（§3.2 配好后自动带上），否则安装后调用仍 401。

## 5. 演示输入（预置料）

**法律-合同**（贴入一段采购合同节选，含 3 处埋点：违约金上限缺失、验收条款单方化、争议解决模糊）：
> 我方是买方（甲方），请审查以下采购合同节选的风险并给出修改建议：
> （此处粘贴含上述三处问题的合同文本 800~1200 字）

预期交付：五阶段报告——结构化提取表 → 风险明细表（3 处埋点全部命中，分级正确）→ 可直接替换的条款措辞 → 法条附录 + 置信度标注 + 律师复核提醒。

**法律-案件**（案情一段：员工主张违法解除赔偿，用人单位以"严重违反规章制度"抗辩但制度未经民主程序）：
> 我代理劳动者。案情：……（入职 3 年，月工资 2 万，被以"严重违反规章制度"解除，规章未经民主程序制定，未支付未休年假工资）
> 请做案件研判：争议焦点、法条依据、诉讼策略。

预期交付：争点清单（要件缺口：制度效力）→ 法条清单（`law_search`/`law_read` 实查劳动合同法及实施条例，标注效力状态）→ 攻防表 → 策略（2N 赔偿主张 + 年假时效风险提示）。类案检索暂无数据源，报告注明"类案检索未启用"。

**数据-股票**：
> 帮我研究一下贵州茅台（600519.SH）当前的投资价值。

预期交付：标的档案卡 → 财报速览（含红旗项）→ 估值汇总表（方法/假设/区间）→ 申万行业研报交叉 → 多空对照表 + 风险清单 + 免责声明。所有数字带来源。

**数据-中国经济**：
> 现在的货币信用环境对 A 股制造业意味着什么？给我一份简报。

预期交付：指标框架表（M1/M2、社融结构、LPR…）→ 关键数据表（每个数值带期数来源）→ 趋势图 ≥2 张 → 传导逻辑链 → 制造业行业含义 → 风险与观察点。

## 6. 云端 agents 目录条目（§3.5 agent 注册用）

```json
{
  "agents": [
    { "id": "pack-contract-reviewer", "type": "agent-remote", "mode": "chat",
      "name": "合同审查官", "description": "法律-合同包对话入口，配合 legal-contract-workflow 技能使用",
      "icon": "scale", "baseUrl": "https://token.finddatatech.cloud/v1", "model": "deepseek-v4-pro",
      "apiKeyEnv": "FD_TOKEN_API_KEY", "tags": ["法律", "合同"], "roles": ["legal"] },
    { "id": "pack-case-analyst", "type": "agent-remote", "mode": "chat",
      "name": "案件分析师", "description": "法律-案件包对话入口，配合 legal-case-workflow 技能使用",
      "icon": "gavel", "baseUrl": "https://token.finddatatech.cloud/v1", "model": "deepseek-v4-pro",
      "apiKeyEnv": "FD_TOKEN_API_KEY", "tags": ["法律", "诉讼"], "roles": ["legal"] },
    { "id": "pack-industry-analyst", "type": "agent-remote", "mode": "chat",
      "name": "行业分析师", "description": "数据-股票/中国经济包对话入口，配合 stock-research / china-macro-brief 技能使用",
      "icon": "line-chart", "baseUrl": "https://token.finddatatech.cloud/v1", "model": "deepseek-v4-pro",
      "apiKeyEnv": "FD_TOKEN_API_KEY", "tags": ["金融", "宏观"], "roles": ["analysts"] }
  ]
}
```

fd-prod 部署：`FD_TOKEN_API_KEY` 进 `platform-secrets`，`AGENTS_CONFIG_URL` 指 §6 文档 URL 进 `platform-config`，rollout。

## 7. 回滚

注销 registry 条目（4 技能 + 未来 1 server）/ 删除云端 agent 条目 / 还原 `registry-groups.json`。无平台状态迁移。

## 8. 已知边界（如实告知客户）

- 案件包的**法条检索已实**（`fd-find-data-business-mcp` 的 `law_search`/`law_read`，真实法规库）；**类案（裁判文书）检索仍无数据源**，演示时如实说明。
- chatlaw / fingpt 卡片是生态展示（GitHub link），对话入口用包的 chat agent。
- 168h token 到期后安装的 MCP 会 401——演示季内每日检查，或等 V1 自动化；law-bench 的 PAT 有效期 30 天（至 2026-10-18，admin 账号）。
- 公开 LLM 网关偶发 502（实测约 1/5 瞬时抖动，重试即恢复；平台 agent 调用无自动重试）——演示时若首答失败，重发一次即可。
- registry 的 egress 相关 API（Connected Accounts 自助存 PAT）被 safeline WAF 拦截（404），目前由 admin 直连 cheap1 代存（§3.3）。
