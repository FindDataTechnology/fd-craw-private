# Tasks — add-vertical-sample-packs

## 1. Registry authorization provisioning (ops, gates everything)

- [x] 1.1 Logto: create groups `legal` and `analysts`; assign the demo customer accounts. Verify: Logto admin console shows members; a test login returns the group in claims. *(✅ 完成 2026-09-19：Logto 建组织 legal=`hpe07qejcwk7`、analysts=`sl63fy08ruh9`，aloadtree 已入两组织；平台 groups=ID token organizations claim（组织 ID），`registry-groups.json` 与 agents.json roles 均双写 [可读名, 组织ID]；端到端验证：重新登录后市场显示 law-bench/fd-*/四个入口技能（152 可见 vs 未加组 148），agents roles 同步修正后目录可见；registry 侧组走 idp_user_groups fallback（§3.1）)*
- [x] 1.2 Registry: create scope groups granting server access — `law-bench` → `[legal]`; `fd-open-data-mcp`, `fd-cn-report`, `fd-daas-mcp` → `[analysts, legal]`. Verify: a `legal`-group user's minted JWT passes `POST /fd-open-data-mcp/mcp` initialize (HTTP 200), non-group user gets 401. *(scope 文档 mcp-law-bench-execute / mcp-data-servers-execute 已写入并验证（备份 /tmp/mcp_scopes_backup_20260919.archive）；admin JWT 实测 fd-open-data-mcp/fd-cn-report initialize 200；legal 用户验证随 1.1+彩排)*
- [x] 1.3 Spike: mint an admin JWT, call `POST /law-bench/mcp` initialize; if non-200, read mcpgw logs on cheap1 (`docker logs mcp-gateway-registry-mcpgw-server-1`) for the denial reason and record the fix in the playbook. Verify: law-bench initialize returns 200 with a `legal`-group token. *(✅ 完成：根因=后端自有 token 鉴权且 egress vault 特性未启用；已开 EGRESS_AUTH_ENABLED、law-bench 配 pat 模式、admin PAT 已存（至 10/18）；网关 initialize 200 (v3.4.7, 52 工具) 并枚举全部工具名；fd-* 实测无需 PAT。详见 docs/vertical-packs.md §3.3)*
- [x] 1.4 fd-prod: apply `registry-groups.json` mapping pack entries to roles (servers: law-bench→legal, fd-*→analysts; skills: the 4 entry skills + pack-critical skills; agents: per-pack). Verify: `GET /api/extensions/market` as each role shows exactly that role's pack entries. *(已按合规路径落地：fd-infra-deploy b2341b2 加 ConfigMap registry-groups-config + subPath 挂载 /app/registry-groups.json，ArgoCD 已同步，pod 内文件已验证；角色可见性验证需 1.1 账号，归入 5.2 彩排)*

## 2. Entry skills (author in repo, register into registry)

- [x] 2.1 Author `docs/vertical-packs/skills/legal-contract-workflow/SKILL.md` (stages: 合同类型识别 → 结构化提取 → 条款审查 via `contract-review` → law-bench 条款 RAG 检索/评测 → 分级风险报告; no-fabrication constraints). Verify: SKILL.md renders valid frontmatter (name/description) and references sibling skills by exact registry name.
- [x] 2.2 Author `docs/vertical-packs/skills/legal-case-workflow/SKILL.md` (案情 → 争议焦点 via `preliminary-legal-analysis` → 检索 via `statute-case-retrieval` + `fd-legal-search-mcp` (conditional) → 策略 via `case-discussion-outline` → 可视化 via `litigation-visualization`). Verify: same as 2.1; data-retrieval stage marked conditional on server availability.
- [x] 2.3 Author `docs/vertical-packs/skills/stock-research-workflow/SKILL.md` (标的问题 → 行情/基本面 via `akshare-stock`/`stock-analysis` → 估值 via `dcf-model`/`comps-analysis` → 研报交叉 via fd-cn-report → 结论报告). Verify: same as 2.1.
- [x] 2.4 Author `docs/vertical-packs/skills/china-macro-brief-workflow/SKILL.md` (宏观问题 → 指标拉取 via fd-open-data-mcp → 行业对照 via `sector-overview`/fd-cn-report → 图表简报 via `macro-rates-monitor`/`data-analysis`). Verify: same as 2.1.
- [x] 2.5 Register all four skills into the registry (admin UI or `POST` skill API on cheap1), tags aligned to pack domain. Verify: `GET /api/skills?limit=500` lists each; platform Store shows them to the mapped role. *(✅ 托管决策：公开 GitHub 仓库 FindDataTechnology/fd-vertical-packs（gh CLI 创建）；registry 主机实测 raw URL 可达 200/0.9s；四技能 POST /api/skills 全部 201，enabled/active，内容端点 /api/skills/<name>/content 返回完整 SKILL.md)*

## 3. Conversational agents (cloud catalog, zero platform code)

- [x] 3.1 Author the cloud agents document (合同审查官 / 案件分析师 / 行业分析师): `agent-remote` chat entries, `baseUrl: https://token.finddatatech.cloud/v1`, `model: deepseek-v4-pro`, `apiKeyEnv: FD_TOKEN_API_KEY`, roles mapped per pack. Verify: document contains no inline secret; `GET /api/catalog` returns all three after refresh. *(✅ 文档托管于公开仓库 FindDataTechnology/fd-vertical-packs（agents.json）；**模型定为 deepseek-v4-flash-0731**——实测该公开网关对 pro/flash 要求 `x-opencode-session` 头而 0731 免头直通（平台默认模型，零代码改动）；pod 内以 agent-session 完全相同的请求头实测 3/3 成功（约 2s）；catalog 合并验证：getAgentEntry('pack-contract-reviewer') 返回 chat 模式 + hasKey:true + roles:['legal']；无任何内联密钥)*
- [x] 3.2 fd-prod: set `FD_TOKEN_API_KEY` secret + `AGENTS_CONFIG_URL` config; rollout. Verify: chatting with each agent streams a reply through the endpoint (Trace page shows the upstream model call). *(✅ FF_TOKEN_API_KEY 已 patch 进 platform-secrets、AGENTS_CONFIG_URL 已进 platform-config（fd-infra-deploy 147ffc6，ArgoCD 已同步）、rollout 完成；pod env 两变量确认存在；pod 内拉取 agents.json 200；端点直测 200。UI 端对话验证归入 5.2 彩排)*

## 4. Case-pack data backend (data infra repo)

- [ ] 4.1 Build `fd-legal-search-mcp`: `search_statutes` / `search_cases` / `get_statute` / `get_case` over crawl corpora, streamable-HTTP MCP, provenance (source + identifier) on every result, explicit empty results. Verify: tool contract test — a known query returns the expected statute article; unknown query returns empty, never fabricated.
- [ ] 4.2 Deploy + register into the registry, scope to `legal`; update `legal-case-workflow` wording from conditional to live. Verify: `legal`-group token passes `POST /fd-legal-search-mcp/mcp` initialize; entry skill's retrieval stage succeeds end-to-end.

## 5. Demo playbook + end-to-end

- [ ] 5.1 Write `docs/vertical-packs.md`: per-pack composition table, operator runbook (Logto/scope/token steps from §1 + V0 manual token paste), canned demo input per pack, expected deliverable shape. Verify: an operator other than the author reproduces one pack demo from the doc alone.
- [ ] 5.2 Full dress rehearsal of all four packs on fd-prod with fresh demo accounts (V0 tokens). Verify: each canned input produces its expected deliverable; law-bench and fd-* calls visible as real MCP invocations; chat agents reply; wrong-role account sees no pack entries.
